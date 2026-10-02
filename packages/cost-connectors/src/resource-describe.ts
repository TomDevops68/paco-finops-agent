import { DescribeServicesCommand, type ECSClient } from '@aws-sdk/client-ecs';
import { DescribeDBInstancesCommand, type RDSClient } from '@aws-sdk/client-rds';
import { DescribeInstancesCommand, type EC2Client } from '@aws-sdk/client-ec2';
import { GetFunctionConfigurationCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import type { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import type { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import type { ConnectorResult } from '../../agent-sdk-runtime/src/tool-server.js';

export interface AccountClients {
  ecs?: ECSClient;
  rds?: RDSClient;
  ec2?: EC2Client;
  lambda?: LambdaClient;
  cloudwatch?: CloudWatchClient;
  cloudtrail?: CloudTrailClient;
}

export type AccountClientFactory = (accountId: string) => Promise<AccountClients>;

export interface DescribeResourcesInput {
  accountId: string;
  resourceType: 'ecs_service' | 'rds_instance' | 'ec2_instance' | 'lambda_function';
  resourceIds: string[];
}

/**
 * Describe-only resource correlation for a report line (which ECS
 * service/RDS instance/EC2 fleet/Lambda function actually scaled). Every
 * command here is a `Describe*`/`Get*Configuration` read — no client in this
 * file is ever used for `Update*`/`Start*`/`Stop*`. `resourceIds` for
 * `ecs_service` are `"cluster|service"` pairs (matching
 * `paco-saving-lambda`'s own ECS resource-id convention, so evidence and any
 * future cross-reference use the same shape); every other resource type
 * takes the resource's own identifier/ARN directly.
 */
export class ResourceDescribeConnector {
  public constructor(private readonly clientFactory: AccountClientFactory) {}

  public async describeResources(input: DescribeResourcesInput): Promise<ConnectorResult> {
    const clients = await this.clientFactory(input.accountId);
    switch (input.resourceType) {
      case 'ecs_service':
        return this.describeEcsServices(clients, input.resourceIds);
      case 'rds_instance':
        return this.describeRdsInstances(clients, input.resourceIds);
      case 'ec2_instance':
        return this.describeEc2Instances(clients, input.resourceIds);
      case 'lambda_function':
        return this.describeLambdaFunctions(clients, input.resourceIds);
    }
  }

  private async describeEcsServices(
    clients: AccountClients,
    resourceIds: string[],
  ): Promise<ConnectorResult> {
    if (!clients.ecs) throw new Error('ECS_CONNECTOR_DISABLED');
    const byCluster = new Map<string, string[]>();
    for (const id of resourceIds) {
      const [cluster, service] = id.split('|');
      if (!cluster || !service) throw new Error(`INVALID_ECS_RESOURCE_ID: ${id}`);
      byCluster.set(cluster, [...(byCluster.get(cluster) ?? []), service]);
    }
    const services = [];
    for (const [cluster, serviceNames] of byCluster) {
      const response = await clients.ecs.send(
        new DescribeServicesCommand({ cluster, services: serviceNames }),
      );
      services.push(...(response.services ?? []));
    }
    return {
      type: 'resource',
      summary: `${String(services.length)} ECS service(s) described: ${services.map((s) => `${s.serviceName ?? '?'} (desired=${String(s.desiredCount ?? '?')})`).join(', ')}.`,
      data: services,
    };
  }

  private async describeRdsInstances(
    clients: AccountClients,
    resourceIds: string[],
  ): Promise<ConnectorResult> {
    if (!clients.rds) throw new Error('RDS_CONNECTOR_DISABLED');
    const instances = [];
    for (const id of resourceIds) {
      const response = await clients.rds.send(
        new DescribeDBInstancesCommand({ DBInstanceIdentifier: id }),
      );
      instances.push(...(response.DBInstances ?? []));
    }
    return {
      type: 'resource',
      summary: `${String(instances.length)} RDS instance(s) described: ${instances.map((i) => `${i.DBInstanceIdentifier ?? '?'} (${i.DBInstanceClass ?? '?'})`).join(', ')}.`,
      data: instances,
    };
  }

  private async describeEc2Instances(
    clients: AccountClients,
    resourceIds: string[],
  ): Promise<ConnectorResult> {
    if (!clients.ec2) throw new Error('EC2_CONNECTOR_DISABLED');
    const response = await clients.ec2.send(
      new DescribeInstancesCommand({ InstanceIds: resourceIds }),
    );
    const instances = (response.Reservations ?? []).flatMap(
      (reservation) => reservation.Instances ?? [],
    );
    return {
      type: 'resource',
      summary: `${String(instances.length)} EC2 instance(s) described: ${instances.map((i) => `${i.InstanceId ?? '?'} (${i.InstanceType ?? '?'}, ${i.State?.Name ?? '?'})`).join(', ')}.`,
      data: instances,
    };
  }

  private async describeLambdaFunctions(
    clients: AccountClients,
    resourceIds: string[],
  ): Promise<ConnectorResult> {
    if (!clients.lambda) throw new Error('LAMBDA_CONNECTOR_DISABLED');
    const functions = [];
    for (const id of resourceIds) {
      const response = await clients.lambda.send(
        new GetFunctionConfigurationCommand({ FunctionName: id }),
      );
      functions.push(response);
    }
    return {
      type: 'resource',
      summary: `${String(functions.length)} Lambda function(s) described: ${functions.map((f) => `${f.FunctionName ?? '?'} (mem=${String(f.MemorySize ?? '?')}MB)`).join(', ')}.`,
      data: functions,
    };
  }
}
