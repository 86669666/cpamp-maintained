import { describe, expect, test } from 'vitest';
import {
  buildMergedSub2ApiDocument,
  buildMergedApiKeyConfig,
  maskApiKey,
  convertCPARecord,
  convertSub2ApiDocument,
  parseJwtPayload,
} from '../apps/web/src/features/tools/cpaSub2api/converter.mjs';
import { buildZipArchive } from '../apps/web/src/features/tools/cpaSub2api/archive.mjs';
import {
  buildPastedInputItems,
  parsePastedJsonDocuments,
} from '../apps/web/src/features/tools/cpaSub2api/paste-input.mjs';
import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_IMPORT,
  exceedsPasteLimit,
  validateImportCandidates,
} from '../apps/web/src/features/tools/cpaSub2api/limits';

const base64Url = (value: string) =>
  btoa(value).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

const jwt = (payload: Record<string, unknown>) =>
  `header.${base64Url(JSON.stringify(payload))}.signature`;

const now = new Date('2026-07-18T00:00:00.000Z');

const fixtures = {
  codex: {
    type: 'codex',
    access_token: jwt({
      exp: 1784505600,
      email: 'codex@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-codex',
        chatgpt_plan_type: 'plus',
      },
      'https://api.openai.com/profile': { email: 'codex@example.com' },
    }),
    id_token: jwt({ email: 'codex@example.com' }),
    refresh_token: 'refresh-codex',
  },
  claude: {
    type: 'claude',
    access_token: 'access-claude',
    refresh_token: 'refresh-claude',
    email: 'claude@example.com',
    expired: '2026-07-20T00:00:00.000Z',
  },
  antigravity: {
    type: 'antigravity',
    access_token: 'access-antigravity',
    refresh_token: 'refresh-antigravity',
    email: 'antigravity@example.com',
    project_id: 'project-1',
    expired: '2026-07-20T00:00:00.000Z',
  },
  gemini: {
    type: 'gemini',
    email: 'gemini@example.com',
    project_id: 'project-2',
    token: {
      access_token: 'access-gemini',
      refresh_token: 'refresh-gemini',
      expiry: '2026-07-20T00:00:00.000Z',
    },
  },
};

describe('CPA ↔ sub2api converter', () => {
  test('converts all supported CPA provider records into sub2api accounts', () => {
    const results = Object.entries(fixtures).map(([name, document]) =>
      convertCPARecord(document, { sourceName: `${name}.json`, now })
    );

    expect(results.map((result) => result.account.platform)).toEqual([
      'openai',
      'anthropic',
      'antigravity',
      'gemini',
    ]);
    expect(results.every((result) => result.account.concurrency === 10)).toBe(true);
    expect(results.every((result) => result.account.priority === 1)).toBe(true);
    expect(results.map((result) => result.email)).toEqual([
      'codex@example.com',
      'claude@example.com',
      'antigravity@example.com',
      'gemini@example.com',
    ]);

    const merged = buildMergedSub2ApiDocument(results, { now });
    expect(merged.accounts).toHaveLength(4);
    expect(merged.proxies).toEqual([]);
  });

  test('round-trips supported sub2api accounts back into CPA records', () => {
    for (const [name, document] of Object.entries(fixtures)) {
      const converted = convertCPARecord(document, { sourceName: `${name}.json`, now });
      const result = convertSub2ApiDocument(converted.document, { sourceName: 'merged.json', now });
      expect(result.skipped).toEqual([]);
      expect(result.converted).toHaveLength(1);
      expect(result.converted[0].document.type).toBe(document.type);
    }
  });

  test('skips unsupported sub2api entries without rejecting supported entries', () => {
    const supported = convertCPARecord(fixtures.claude, { sourceName: 'claude.json', now }).account;
    const result = convertSub2ApiDocument({
      accounts: [supported, { name: 'bad', platform: 'other', type: 'oauth', credentials: {} }],
    });
    expect(result.converted).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].entryLabel).toBe('bad');
  });

  test('parses JWT payload safely', () => {
    expect(parseJwtPayload(jwt({ email: 'person@example.com' }))).toEqual({
      email: 'person@example.com',
    });
    expect(parseJwtPayload('not-a-jwt')).toBeUndefined();
  });

  test('parses concatenated JSON, JSONL, strings containing braces and trailing issues', () => {
    const parsed = parsePastedJsonDocuments(
      '{"type":"claude","value":"brace } stays"}\n{"type":"gemini"}\n{"broken":'
    );
    expect(parsed.documents).toHaveLength(2);
    expect(parsed.issues).toHaveLength(1);
    expect((parsed.documents[0] as { value: string }).value).toBe('brace } stays');
    expect(buildPastedInputItems([[{ type: 'claude' }, { type: 'gemini' }]], 'cpaToSub2Api')).toHaveLength(2);
    expect(buildPastedInputItems([[{ type: 'claude' }]], 'sub2apiToCpa')).toHaveLength(1);
  });

  test('builds a valid UTF-8 ZIP with named entries', async () => {
    const zip = buildZipArchive(
      [
        { fileName: 'claude.json', text: '{"type":"claude"}' },
        { fileName: 'gemini.json', text: '{"type":"gemini"}' },
      ],
      { modifiedAt: now }
    );
    const bytes = new Uint8Array(await zip.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('claude.json');
    expect(text).toContain('gemini.json');
  });
});

describe('converter import limits', () => {
  test('rejects non-JSON, oversized, over-count and over-total candidates', () => {
    const candidates = [
      { name: 'ok.json', size: 100, json: true },
      { name: 'not.txt', size: 100, json: false },
      { name: 'large.json', size: MAX_FILE_BYTES + 1, json: true },
      { name: 'total-base-a.json', size: 8 * 1024 * 1024, json: true },
      { name: 'total-base-b.json', size: 8 * 1024 * 1024, json: true },
      { name: 'total-base-c.json', size: 8 * 1024 * 1024, json: true },
      { name: 'total-base-d.json', size: 8 * 1024 * 1024, json: true },
      { name: 'total-base-e.json', size: 8 * 1024 * 1024, json: true },
      { name: 'total-base-f.json', size: 8 * 1024 * 1024, json: true },
      { name: 'total-overflow.json', size: 3 * 1024 * 1024, json: true },
      ...Array.from({ length: MAX_FILES_PER_IMPORT }, (_, index) => ({
        name: `extra-${index}.json`,
        size: 1,
        json: true,
      })),
    ];
    const result = validateImportCandidates(candidates);
    expect(result.accepted[0]).toBe(0);
    expect(result.accepted).not.toContain(1);
    expect(result.accepted).not.toContain(2);
    expect(result.accepted).not.toContain(9);
    expect(result.rejected.map((item) => item.code)).toContain('notJson');
    expect(result.rejected.map((item) => item.code)).toContain('tooLarge');
    expect(result.rejected.map((item) => item.code)).toContain('totalTooLarge');
    expect(result.rejected.map((item) => item.code)).toContain('tooMany');
  });

  test('enforces the pasted text size cap', () => {
    expect(exceedsPasteLimit('{}')).toBe(false);
    expect(exceedsPasteLimit('a'.repeat(10 * 1024 * 1024 + 1))).toBe(true);
  });
});

describe('API Key conversion support', () => {
  test('converts API Key accounts for all supported platforms', () => {
    const apiKeyAccounts = [
      { platform: 'claude', type: 'apikey', credentials: { api_key: 'sk-ant-test123' }, name: 'Claude Key' },
      { platform: 'anthropic', type: 'api-key', credentials: { 'api-key': 'sk-ant-test456' }, name: 'Anthropic Key' },
      { platform: 'codex', type: 'api_key', credentials: { apiKey: 'sk-test789' }, name: 'Codex Key' },
      { platform: 'openai', type: 'apikey', credentials: { key: 'sk-proj-test' }, name: 'OpenAI Key' },
      { platform: 'gemini', type: 'apikey', credentials: { api_key: 'AIzaSy-test' }, name: 'Gemini Key' },
      { platform: 'vertex', type: 'apikey', credentials: { api_key: 'vertex-test-key' }, name: 'Vertex Key' },
    ];

    const result = convertSub2ApiDocument({ accounts: apiKeyAccounts });

    expect(result.convertedApiKeys).toHaveLength(6);
    expect(result.converted).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);

    expect(result.convertedApiKeys.map((r) => r.providerKey)).toEqual([
      'claude-api-key',
      'claude-api-key',
      'codex-api-key',
      'codex-api-key',
      'gemini-api-key',
      'vertex-api-key',
    ]);

    expect(result.convertedApiKeys.map((r) => r.apiKey)).toEqual([
      'sk-ant-test123',
      'sk-ant-test456',
      'sk-test789',
      'sk-proj-test',
      'AIzaSy-test',
      'vertex-test-key',
    ]);
  });

  test('supports multiple api_key field name variants with correct priority', () => {
    const accountWithMultipleFields = {
      platform: 'claude',
      type: 'apikey',
      credentials: {
        api_key: 'priority-1',
        'api-key': 'priority-2',
        apiKey: 'priority-3',
        key: 'priority-4',
      },
      extra: {
        api_key: 'extra-priority-5',
      },
    };

    const result = convertSub2ApiDocument({ accounts: [accountWithMultipleFields] });
    expect(result.convertedApiKeys[0].apiKey).toBe('priority-1');

    const accountWithSecondPriority = {
      platform: 'claude',
      type: 'apikey',
      credentials: {
        'api-key': 'priority-2',
        apiKey: 'priority-3',
        key: 'priority-4',
      },
    };

    const result2 = convertSub2ApiDocument({ accounts: [accountWithSecondPriority] });
    expect(result2.convertedApiKeys[0].apiKey).toBe('priority-2');

    const accountFromExtra = {
      platform: 'claude',
      type: 'apikey',
      credentials: {},
      extra: {
        api_key: 'from-extra',
      },
    };

    const result3 = convertSub2ApiDocument({ accounts: [accountFromExtra] });
    expect(result3.convertedApiKeys[0].apiKey).toBe('from-extra');

    const accountWithoutCredentials = {
      platform: 'claude',
      type: 'apikey',
      extra: {
        apiKey: 'from-extra-without-credentials',
      },
    };

    const result4 = convertSub2ApiDocument({ accounts: [accountWithoutCredentials] });
    expect(result4.convertedApiKeys[0].apiKey).toBe('from-extra-without-credentials');
  });

  test('skips API Key accounts with unsupported platforms', () => {
    const unsupportedAccount = {
      platform: 'unknown-provider',
      type: 'apikey',
      credentials: { api_key: 'test-key' },
      name: 'Unsupported',
    };

    const result = convertSub2ApiDocument({ accounts: [unsupportedAccount] });
    expect(result.convertedApiKeys).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('暂不支持');
    expect(result.skipped[0].reason).toContain('unknown-provider');
  });

  test('skips API Key accounts missing api_key field', () => {
    const missingKeyAccount = {
      platform: 'claude',
      type: 'apikey',
      credentials: { some_other_field: 'value' },
      name: 'No Key',
    };

    const result = convertSub2ApiDocument({ accounts: [missingKeyAccount] });
    expect(result.convertedApiKeys).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('未找到');
  });

  test('handles mixed OAuth and API Key accounts separately', () => {
    const supported = convertCPARecord(fixtures.claude, { sourceName: 'claude.json', now }).account;
    const apiKeyAccount = {
      platform: 'claude',
      type: 'apikey',
      credentials: { api_key: 'sk-ant-mixed' },
      name: 'Mixed API Key',
    };

    const result = convertSub2ApiDocument({ accounts: [supported, apiKeyAccount] });
    expect(result.converted).toHaveLength(1);
    expect(result.convertedApiKeys).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  test('builds merged API Key config grouped by provider key', () => {
    const apiKeys = [
      { providerKey: 'claude-api-key', apiKey: 'sk-ant-1', kind: 'providerApiKey' as const, sourceType: 'apikey', providerLabel: 'Claude', platform: 'claude' },
      { providerKey: 'claude-api-key', apiKey: 'sk-ant-2', kind: 'providerApiKey' as const, sourceType: 'apikey', providerLabel: 'Claude', platform: 'claude' },
      { providerKey: 'codex-api-key', apiKey: 'sk-3', kind: 'providerApiKey' as const, sourceType: 'apikey', providerLabel: 'Codex', platform: 'codex' },
    ];

    const merged = buildMergedApiKeyConfig(apiKeys);
    expect(merged['claude-api-key']).toHaveLength(2);
    expect(merged['codex-api-key']).toHaveLength(1);
    expect(merged['claude-api-key'][0]['api-key']).toBe('sk-ant-1');
    expect(merged['claude-api-key'][1]['api-key']).toBe('sk-ant-2');
    expect(merged['codex-api-key'][0]['api-key']).toBe('sk-3');
  });

  test('masks API keys correctly', () => {
    expect(maskApiKey('sk-ant-api03-1234567890abcdef')).toBe('sk-a...cdef');
    expect(maskApiKey('short')).toBe('***');
    expect(maskApiKey('12345678')).toBe('1234...5678');
    expect(maskApiKey('')).toBe('***');
  });
});
