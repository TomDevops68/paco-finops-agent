import { AssumeRoleCommand, type STSClient } from '@aws-sdk/client-sts';
import { ECSClient } from '@aws-sdk/client-ecs';
import { RDSClient } from '@aws-sdk/client-rds';
import { EC2Client } from '@aws-sdk/client-ec2';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import type { AccountClientFactory, AccountClients } from './resource-describe.js';

export interface CrossAccountRoleConfig {
  /** Same role name expected to exist (deployed out of band) in every allowlisted linked account. */
  roleName: string;
  region: string;
  sessionDurationSeconds?: number;
}

/**
 * Assumes a read-only role in a linked account (PACO-Production,
 * PACO-Non-Production) so `ResourceDescribeConnector` can describe ECS/RDS/
 * EC2/Lambda resources outside the management account CE queries run from.
 * The assumed role itself must be provisioned out of band with only
 * `Describe*`/`List*`/`Get*Configuration` permissions — this factory has no
 * say over what the role can do, only which account it authenticates into.
 */
export function buildCrossAccountClientFactory(
  sts: STSClient,
  config: CrossAccountRoleConfig,
): AccountClientFactory {
  return async (accountId: string): Promise<AccountClients> => {
    const roleArn = `arn:aws:iam::${accountId}:role/${config.roleName}`;
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `paco-cost-agent-${accountId}`,
        DurationSeconds: config.sessionDurationSeconds ?? 900,
      }),
    );
    const creds = response.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
      throw new Error('ASSUME_ROLE_CREDENTIALS_MISSING');
    }
    const credentials = {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    };
    return {
      ecs: new ECSClient({ region: config.region, credentials }),
      rds: new RDSClient({ region: config.region, credentials }),
      ec2: new EC2Client({ region: config.region, credentials }),
      lambda: new LambdaClient({ region: config.region, credentials }),
      cloudwatch: new CloudWatchClient({ region: config.region, credentials }),
      cloudtrail: new CloudTrailClient({ region: config.region, credentials }),
    };
  };
}
