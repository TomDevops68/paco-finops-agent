import { GetObjectCommand } from '@aws-sdk/client-s3';
import { parse } from 'yaml';

export interface S3ConfigCommandClient {
  send(command: unknown): Promise<unknown>;
}

/**
 * Ported verbatim from paco-troubleshoot-agent's `readYamlFromS3`/
 * `readJsonFromS3` — reads config (`account-map.yaml`, `harness.yaml`,
 * `playbooks.yaml`) from the config bucket at cold start, so it stays
 * updateable without a code change.
 */
export async function readYamlFromS3(
  client: S3ConfigCommandClient,
  bucket: string,
  key: string,
): Promise<unknown> {
  const response = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))) as {
    Body?: { transformToString?: () => Promise<string> };
  };
  if (!response.Body?.transformToString)
    throw new Error(`CONFIG_OBJECT_EMPTY: s3://${bucket}/${key}`);
  return parse(await response.Body.transformToString());
}

export async function readJsonFromS3(
  client: S3ConfigCommandClient,
  bucket: string,
  key: string,
): Promise<unknown> {
  const response = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))) as {
    Body?: { transformToString?: () => Promise<string> };
  };
  if (!response.Body?.transformToString)
    throw new Error(`CONFIG_OBJECT_EMPTY: s3://${bucket}/${key}`);
  return JSON.parse(await response.Body.transformToString()) as unknown;
}
