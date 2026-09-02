import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import type { MonitoringAccountHistoryItem } from '@/services/api';
import {
  buildAntigravityQuotaMatrix,
  formatHistorySuccessRate,
  formatMoney,
  formatQuotaResetDisplay,
  formatQuotaResetTimestamp,
  formatQuotaResetTooltipParams,
  formatTimestamp,
  formatTimestampTitle,
  getAccountHistoryTitle,
  parsePriorityValue,
  quotaStatusLabelKey,
} from './accountsPagePresentation';
import type { AccountRow } from './accountRows';
import type { AccountQuotaDisplayWindow } from './accountQuotaDisplayWindows';

describe('accountsPagePresentation', () => {
  it('keeps account sort and metric formatting semantics stable', () => {
    expect(parsePriorityValue(' -12 ')).toBe(-12);
    expect(parsePriorityValue('1.2')).toBeNull();
    expect(formatHistorySuccessRate(0.975)).toBe('97.5%');
    expect(formatMoney(12.34)).toBe('$12.34');
    expect(quotaStatusLabelKey('exhausted')).toBe('accounts.quota_status_exhausted');
  });

  it('uses exact values in the account history summary title', () => {
    const item = {
      matched: true,
      total_requests: 1_234_567,
      total_tokens: 1_000_190_000,
      total_cost: 12_345.67,
      success_rate: 0.98321,
      sync_status: 'ready',
    } as MonitoringAccountHistoryItem;
    const t = ((key: string, options?: Record<string, unknown>) =>
      `${key}:${options?.requests ?? ''}:${options?.tokens ?? ''}:${options?.cost ?? ''}:${options?.rate ?? ''}`) as TFunction;

    const title = getAccountHistoryTitle(t, item, false, '', 'en-US');

    expect(title).toContain('1,234,567');
    expect(title).toContain('1,000,190,000');
    expect(title).toContain('$12,345.67');
    expect(title).toContain('98.32%');
    expect(title).not.toContain('1.2M');
    expect(title).not.toContain('1000.2M');
  });

  it('formats detail timestamps with optional seconds using a numeric local format', () => {
    const timestamp = new Date(2026, 7, 26, 17, 44, 5, 0).getTime();

    expect(formatTimestamp(timestamp, 'zh-CN')).toBe('08/26 17:44');
    expect(formatTimestamp(timestamp, 'en', true)).toBe('08/26 17:44:05');
  });

  it('formats normalized quota resets consistently and preserves legacy text fallbacks', () => {
    const resetAtMs = new Date(2026, 6, 30, 10, 5, 0, 0).getTime();
    const recoverAtMs = new Date(2026, 6, 31, 11, 15, 0, 0).getTime();

    expect(formatQuotaResetTimestamp(resetAtMs, 'zh-CN')).toBe('07/30 10:05');
    expect(formatQuotaResetDisplay(resetAtMs, '2h', 'en')).toBe('07/30 10:05');
    expect(formatQuotaResetTimestamp(new Date(2026, 0, 1, 1, 1, 0, 0).getTime(), 'en')).toBe(
      '01/01 01:01'
    );
    expect(formatQuotaResetDisplay(null, 'resets in 2d', 'en')).toBe('resets in 2d');
    expect(
      formatQuotaResetTooltipParams(
        { resetAt: '2h', recoverAt: 'later' },
        resetAtMs,
        'en',
        recoverAtMs
      )
    ).toEqual({ resetAt: '07/30 10:05', recoverAt: '07/31 11:15' });
  });

  it('rejects timestamps outside the JavaScript date range', () => {
    expect(formatTimestamp(Number.MAX_VALUE, 'en')).toBe('-');
    expect(formatTimestampTitle(Number.MAX_VALUE, 'en')).toBeUndefined();
  });

  it('builds the two-provider-group Antigravity quota matrix in stable order', () => {
    const row = { provider: 'antigravity' } as AccountRow;
    const windows = [
      ['weekly-gemini', 'weekly', 'Gemini models'],
      ['five-gemini', 'five_hour', 'Gemini models'],
      ['weekly-claude', 'weekly', 'Claude and GPT models'],
      ['five-claude', 'five_hour', 'Claude and GPT models'],
    ].map(
      ([key, kind, groupLabel]) =>
        ({
          key,
          kind,
          groupLabel,
          source: 'antigravity',
          label: kind,
        }) as AccountQuotaDisplayWindow
    );

    const matrix = buildAntigravityQuotaMatrix(row, windows);

    expect(matrix?.rows).toHaveLength(2);
    expect(matrix?.rows[0]?.cells.map((cell) => cell.displayLabel)).toEqual(['Claude', 'Gemini']);
    expect(matrix?.windowKeys).toEqual(
      new Set(['five-claude', 'five-gemini', 'weekly-claude', 'weekly-gemini'])
    );
  });
});
