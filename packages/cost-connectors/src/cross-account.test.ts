import { describe, expect, it, vi } from 'vitest';
import { buildCrossAccountClientFactory } from './cross-account.js';
import type { STSClient } from '@aws-sdk/client-sts';

describe('buildCrossAccountClientFactory', () => {
  it('assumes the configured role in the target account and returns credentialed clients', async () => {
    const send = vi.fn().mockResolvedValue({
      Credentials: { AccessKeyId: 'AKIA...', SecretAccessKey: 'secret', SessionToken: 'token' },
    });
    const sts = { send } as unknown as STSClient;
    const factory = buildCrossAccountClientFactory(sts, {
      roleName: 'PacoCostAgentReadOnly',
      region: 'eu-west-2',
    });
    const clients = await factory('510825518696');
    expect(clients.ecs).toBeDefined();
    expect(clients.rds).toBeDefined();
    expect(clients.ec2).toBeDefined();
    expect(clients.lambda).toBeDefined();
    const calls = send.mock.calls as unknown as [{ input: { RoleArn: string } }][];
    expect(calls[0]?.[0]?.input.RoleArn).toBe(
      'arn:aws:iam::510825518696:role/PacoCostAgentReadOnly',
    );
  });

  it('throws a safe error when the assumed role returns no usable credentials', async () => {
    const sts = { send: vi.fn().mockResolvedValue({}) } as unknown as STSClient;
    const factory = buildCrossAccountClientFactory(sts, {
      roleName: 'PacoCostAgentReadOnly',
      region: 'eu-west-2',
    });
    await expect(factory('680099409919')).rejects.toThrow('ASSUME_ROLE_CREDENTIALS_MISSING');
  });
});
