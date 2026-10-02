# ADR 0003: Deploy into public, IGW-routed subnets — no NAT Gateway, and not `vpn-vpc`

- Status: Accepted
- Date: 2026-09-27

## Context

`config/harness.yaml`'s `environments.<env>.network` needs a real, pre-existing VPC/subnet
configuration before the Harness stack (ECS cluster, the investigation worker, the LiteLLM gateway)
can deploy — per `docs/adr/0001`, this project never creates a fresh VPC, only imports one by fixed
attributes.

A live, read-only inventory of the management account (`025031850414`, `eu-west-2`) — `aws sts
get-caller-identity` confirmed this is the target account — found:

- This is a **shared/MSP-style account**: alongside Blinx's own environments it also hosts VPCs for
  unrelated client workloads (`Speedy Freight VPC`, `Stobart Biomass`, `CRM-NP_terraformed`,
  `TMS-NP_terraformed`), which ruled out picking a VPC by convenient naming alone.
- Only **one** NAT Gateway exists in the entire account in `eu-west-2`, in a VPC named `vpn-vpc`
  (`vpc-0b53cf3ba3d8281b5`). None of the Blinx application VPCs (`{MGMT}VPC`, `BLINX-DEV`,
  `Blinx-NP_terraformed`) have outbound internet access configured at all.
- `vpn-vpc` is **not** a VPN-endpoint-only network as its name suggests. It's a Transit Gateway hub
  (`tgw-0e4c699e9aa63d8a0`) with routes to `172.40.0.0/16` (**`NHS-PROD_terraformed`** — the main
  production VPC: `nhs-prod` Aurora with patient data, Comms Hub, everything), `192.168.244.0/25`
  (**`blinx-hscn`**, the HSCN NHS-network VPC with the EMIS processor fleet), `192.168.18.128/25`
  (**`prod-blinx-hscn`**), and several other environments. Placing this agent's tasks there would put
  them on a network fabric with a routable path toward clinical/NHS production systems, regardless of
  how tightly this agent's own security groups are scoped.
- `{MGMT}VPC` (`vpc-00aad6298f2cf1b27`, `10.0.0.0/16`) is the smallest, most isolated candidate: two
  subnets (`{MGMT}SubnetA`/`B`, both in `eu-west-2a` — no multi-AZ redundancy as provisioned), no other
  workloads found in it, and **already has an Internet Gateway attached** (`igw-00401611d91b4f61b`)
  with both subnets routing `0.0.0.0/0 → igw-...` directly. They're public-capable subnets, just not
  auto-assigning public IPs by default (`MapPublicIpOnLaunch: false`).

Cost Explorer's API (`ce:GetCostAndUsage` etc.) has no VPC endpoint/PrivateLink support at all, so
whatever VPC is used needs real internet egress — a NAT Gateway or a public subnet, no third option.

## Decision

Deploy into **`{MGMT}VPC`'s existing public subnets**, with `assignPublicIp: true` on both the
investigation worker's `EcsRunTask` and the LiteLLM gateway's `FargateService` — not `vpn-vpc`, and
not a new NAT Gateway:

- **Not `vpn-vpc`**: its Transit Gateway routes to `NHS-PROD_terraformed` and the HSCN VPCs are a
  materially larger blast radius than a cost-reporting tool needs, independent of how well its own
  security groups are written.
- **No NAT Gateway**: `{MGMT}VPC` already has a usable IGW route; adding a NAT Gateway there would
  cost ~$35-40/month (hourly + data processing) for no security benefit over the alternative, since
  ECS Fargate's `assignPublicIp` is set per-task independent of the subnet's own
  `MapPublicIpOnLaunch` default, and inbound traffic is blocked entirely by security groups either
  way — no security group in this project ever has an inbound rule from `0.0.0.0/0`. A public IP on
  a task's ENI only matters for outbound sourcing (irrelevant here: Cost Explorer, Bedrock, DynamoDB,
  S3, and Secrets Manager are all IAM-gated, not IP-allowlisted) and would matter for inbound only if
  a security group allowed it, which none do.

`config/harness.yaml`'s `NetworkSchema` accordingly names this field `publicSubnetIds`, not
`privateSubnetIds` — the earlier field name was written before this investigation and would have been
misleading once real values were filled in.

## Consequences

- Zero new AWS resources needed for networking — this was a CDK code change only
  (`subnets`/`vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }` + `assignPublicIp: true` on the two
  ECS constructs), verified via `cdk synth` against the real account/VPC/subnet values (confirmed no
  `AWS::EC2::NatGateway` resource anywhere, `AssignPublicIp: ENABLED` present on both ECS network
  configurations).
- Each investigation worker task and the always-on LiteLLM gateway task get a public IP for the
  duration they run. This is a deliberate, security-group-mediated tradeoff (see above), not an
  oversight — revisit if this project's security posture requirements change (e.g. a future compliance
  requirement for no public IPs on any task, at which point a NAT Gateway would need to be added to
  `{MGMT}VPC`, which is a two-line CDK change plus the AWS cost, not an architecture change).
- `{MGMT}VPC`'s two subnets are both in `eu-west-2a` — no multi-AZ redundancy. Acceptable for now
  given the ECS worker is invoked per-investigation (not a constantly-running critical path) and the
  LiteLLM gateway is a single-task internal service already tolerant of brief downtime
  (`docs/adr/0002`'s `minHealthyPercent: 0`). Revisit if uptime requirements tighten.
- `config/harness.yaml`'s `staging` block now has real, non-secret facts filled in
  (`awsAccountId`, `awsRegion`, `network`) from this investigation. `targetConfirmation` and
  `allowlists.awsAccounts`/`crossAccountRoleName` remain deliberately `null` — those are separate,
  later decisions (the human confirmation gate, and the cross-account role not yet being provisioned),
  not something to fill in just because the VPC question got answered.

## Verification

- `cdk synth --context environment=staging --context account=025031850414 --context region=eu-west-2`
  succeeded against the real account (with `targetConfirmation`/`allowlists` temporarily set for the
  synth check only, then reverted — no `cdk deploy` was run).
- Confirmed in the synthesized `CostAgent-staging-Harness` template: `AssignPublicIp: ENABLED` present
  on both the LiteLLM `FargateService` and the Step Functions `EcsRunTask` network configuration; the
  imported subnets render as `SharedVpc/PublicSubnet1`/`PublicSubnet2`; no `AWS::EC2::NatGateway`
  resource in any of the six stacks' templates.
