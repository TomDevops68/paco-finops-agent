import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { ConnectorResult } from '../../agent-sdk-runtime/src/tool-server.js';
import type { CostReportRecord } from '../../aws-repositories/src/dynamodb.js';

export interface PriorReportsCommandClient {
  send(command: unknown): Promise<{ Item?: Record<string, unknown> }>;
}

function priorDates(reportDate: string, limit: number): string[] {
  const base = new Date(`${reportDate}T00:00:00Z`);
  const dates: string[] = [];
  for (let i = 1; i <= limit; i += 1) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * `CostReportsTable` is keyed only by `reportDate` (one item/day, no sort
 * key) — a range query would need a GSI this domain doesn't otherwise need.
 * Since reports are daily and dates are predictable, bounded direct
 * `GetItem` lookups for the preceding N calendar dates is simpler and cheap
 * at this table's real scale (one write/day).
 */
export class PriorReportsConnector {
  public constructor(
    private readonly client: PriorReportsCommandClient,
    private readonly tableName: string,
  ) {}

  public async getPriorReports(input: {
    reportDate: string;
    limit: number;
  }): Promise<ConnectorResult> {
    const records: CostReportRecord[] = [];
    for (const date of priorDates(input.reportDate, input.limit)) {
      const result = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { reportDate: date },
          ConsistentRead: false,
        }),
      );
      if (result.Item) records.push(result.Item as unknown as CostReportRecord);
    }
    return {
      type: 'historical',
      summary: `${String(records.length)} prior report(s) found in the ${String(input.limit)} day(s) before ${input.reportDate}.`,
      data: records.map((record) => ({
        reportDate: record.reportDate,
        lines: record.report.lines,
      })),
    };
  }
}
