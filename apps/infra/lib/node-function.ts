import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, RemovalPolicy, aws_logs as logs, type aws_iam as iam } from 'aws-cdk-lib';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

export interface NodeFunctionOptions {
  functionName: string;
  entry: string;
  environment?: Record<string, string>;
  role?: iam.IRole;
  timeout?: Duration;
  memorySize?: number;
}

/**
 * Ported verbatim from paco-troubleshoot-agent's `createNodeFunction` —
 * esbuild-bundled (via `NodejsFunction`) Node.js 22 handler, ESM output with
 * a `require` shim since the AWS SDK v3 clients this codebase uses are
 * resolved from a `"type": "module"` package.
 */
export function createNodeFunction(
  scope: Construct,
  id: string,
  options: NodeFunctionOptions,
): NodejsFunction {
  const logGroup = new logs.LogGroup(scope, `${id}LogGroup`, {
    logGroupName: `/aws/lambda/${options.functionName}`,
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.RETAIN,
  });
  return new NodejsFunction(scope, id, {
    functionName: options.functionName,
    entry: path.join(repoRoot, options.entry),
    handler: 'handler',
    runtime: Runtime.NODEJS_22_X,
    timeout: options.timeout ?? Duration.seconds(30),
    memorySize: options.memorySize ?? 256,
    environment: options.environment ?? {},
    ...(options.role ? { role: options.role } : {}),
    logGroup,
    bundling: {
      format: OutputFormat.ESM,
      target: 'node22',
      mainFields: ['module', 'main'],
      banner:
        "import { createRequire } from 'module';const require = createRequire(import.meta.url);",
      minify: true,
    },
  });
}
