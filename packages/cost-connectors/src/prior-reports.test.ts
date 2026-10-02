import { describe, expect, it, vi } from 'vitest';
import { PriorReportsConnector, type PriorReportsCommandClient } from './prior-reports.js';

describe('PriorReportsConnector', () => {
  it('looks up the preceding N calendar dates and returns only the ones found', async () => {
    const send = vi.fn(({ input }: { input: { Key: { reportDate: string } } }) =>
      Promise.resolve(
        input.Key.reportDate === '2026-09-23'
          ? { Item: { reportDate: '2026-09-23', report: { reportDate: '2026-09-23', lines: [] } } }
          : {},
      ),
    );
    const client: PriorReportsCommandClient = { send: send as PriorReportsCommandClient['send'] };
    const connector = new PriorReportsConnector(client, 'CostReportsTable');
    const result = await connector.getPriorReports({ reportDate: '2026-09-24', limit: 3 });
    expect(send).toHaveBeenCalledTimes(3);
    expect(result.type).toBe('historical');
    expect(result.summary).toContain('1 prior report(s)');
    expect(result.data).toEqual([{ reportDate: '2026-09-23', lines: [] }]);
  });
});
