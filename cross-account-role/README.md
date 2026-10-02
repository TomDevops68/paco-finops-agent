# Cross-account read-only role for the cost agent

Not deployed by this repo's CDK app on purpose — `docs/adr/0001-dedicated-bot-and-readonly-boundary.md`
and `docs/adr/0003-public-subnets-no-nat.md` both note this repo never creates IAM resources in another
account. This is applied **once, by hand, by someone with IAM access in each linked account** —
PACO-Production (`510825518696`) and PACO-Non-Production (`680099409919`).

## What it's for

`packages/cost-connectors/src/resource-describe.ts` correlates a cost-report line with the resource
that actually scaled (which ECS service, RDS instance, EC2 fleet, or Lambda function). It calls exactly
four read-only APIs — nothing else — via a role assumed cross-account from the management account's
ECS worker task role:

- `ecs:DescribeServices`
- `rds:DescribeDBInstances`
- `ec2:DescribeInstances`
- `lambda:GetFunctionConfiguration`

No `List*`/`Get*` beyond that, and no write/mutation action of any kind — see
`permissions-policy.json`, which is the exact and complete permission set, not a starting point to
broaden.

## What to create

**Role name: `PacoCostAgentReadOnly`** (must match exactly — `config/harness.yaml`'s
`crossAccountRoleName` and `apps/infra/lib/iam-policies.ts`'s `crossAccountAssumeRoleStatement` build
the ARN from this name).

### Trust policy — two phases, because of a real IAM chicken-and-egg problem

The role that should ultimately be trusted is the management account's ECS worker task role,
`arn:aws:iam::025031850414:role/CostAgent-staging-worker-task-role` (an explicit, predictable name set
in `apps/infra/lib/harness-state-machine.ts`, not CDK's auto-generated one). **That role doesn't exist
yet** — it's only created by the first real `cdk deploy` to the management account, which hasn't
happened. IAM's `CreateRole` validates that a specific role ARN referenced as a trust-policy principal
actually exists at creation time (confirmed live, 2026-09-27:
`MalformedPolicyDocument: Invalid principal`) — an account-root principal is the only way to create
this role before that first deploy.

1. **Now**: `trust-policy.json` trusts the management account's root
   (`arn:aws:iam::025031850414:root`). This is broader than ideal — in principle any principal in that
   account _could_ be granted `sts:AssumeRole` on this exact ARN by someone else with IAM rights there
   — but in practice only the cost agent's own CDK-managed task role will ever have that specific grant,
   since `apps/infra/lib/iam-policies.ts`'s `crossAccountAssumeRoleStatement` is the only thing that
   creates it, scoped to this exact role ARN.
2. **After the first real `cdk deploy`** to the management account (once
   `CostAgent-staging-worker-task-role` actually exists): narrow the trust to that exact role using
   `trust-policy-narrowed.json` — run `aws iam update-assume-role-policy --role-name
PacoCostAgentReadOnly --policy-document file://trust-policy-narrowed.json` in **both** linked
   accounts. Don't skip this step; the broad root trust is a deliberate, temporary bootstrap, not the
   intended end state.

If/when a `prod` environment is deployed, add a second principal for
`arn:aws:iam::025031850414:role/CostAgent-prod-worker-task-role` to the narrowed policy — a one-line
update, not a new role.

Permissions policy (`permissions-policy.json`): the four actions above, `Resource: "*"` — none of
them support resource-level ARN restriction in AWS's IAM model, so `*` is the ceiling of least
privilege here, not a broadened grant.

## Commands

Run once in **each** linked account (switch AWS credentials/profile between the two runs):

```bash
aws iam create-role \
  --role-name PacoCostAgentReadOnly \
  --assume-role-policy-document file://trust-policy.json \
  --description "Read-only ECS/RDS/EC2/Lambda describe access for the cost-investigation agent (paco-saving-agent). TEMP TRUST: currently trusts management-account root pending first real deploy — see this README to narrow."

aws iam put-role-policy \
  --role-name PacoCostAgentReadOnly \
  --policy-name describe-only \
  --policy-document file://permissions-policy.json
```

Then, **after** the management account's first real `cdk deploy` (so `CostAgent-staging-worker-task-role`
exists), in each linked account:

```bash
aws iam update-assume-role-policy \
  --role-name PacoCostAgentReadOnly \
  --policy-document file://trust-policy-narrowed.json
```

## After applying to both accounts

Update `config/harness.yaml`'s `staging` block (still fail-closed until these are set — see
`docs/adr/0003`'s note on why `allowlists`/`crossAccountRoleName` weren't filled in alongside the VPC
values):

```yaml
allowlists:
  awsAccounts: ['510825518696', '680099409919']
crossAccountRoleName: PacoCostAgentReadOnly
```
