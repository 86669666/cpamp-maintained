interface CpaSub2apiConvertedRecord {
  sourceName: string;
  sourceType: string;
  providerLabel: string;
  email?: string;
  planType?: string;
  expiresAt?: string;
  entryLabel?: string;
  account?: Record<string, unknown>;
  document: Record<string, unknown>;
  outputFileName: string;
}

interface CpaSub2apiConvertedApiKey {
  sourceName: string;
  kind: 'providerApiKey';
  sourceType: string;
  providerKey: string;
  providerLabel: string;
  platform: string;
  accountName?: string;
  email?: string;
  apiKey: string;
  entryLabel?: string;
}

interface CpaSub2apiSkippedRecord {
  sourceName: string;
  entryLabel?: string;
  reason: string;
}

declare module '*.mjs' {
  export function parseJwtPayload(token: string): Record<string, unknown> | undefined;
  export function maskApiKey(value: string): string;
  export function convertCPARecord(
    document: unknown,
    options?: { sourceName?: string; now?: Date }
  ): CpaSub2apiConvertedRecord;
  export function convertSub2ApiDocument(
    document: unknown,
    options?: { sourceName?: string; now?: Date }
  ): {
    converted: CpaSub2apiConvertedRecord[];
    convertedApiKeys: CpaSub2apiConvertedApiKey[];
    skipped: CpaSub2apiSkippedRecord[];
  };
  export function buildMergedSub2ApiDocument(
    records: CpaSub2apiConvertedRecord[],
    options?: { now?: Date }
  ): { accounts: Array<Record<string, unknown>>; proxies: unknown[] };
  export function buildMergedApiKeyConfig(
    records: CpaSub2apiConvertedApiKey[]
  ): Record<string, Array<Record<string, unknown>>>;
  export function buildZipArchive(
    entries: Array<{ fileName: string; text: string }>,
    options?: { modifiedAt?: Date }
  ): Blob;
  export function parsePastedJsonDocuments(text: string): {
    documents: unknown[];
    issues: Array<{ label: string; reason: string }>;
  };
  export function buildPastedInputItems(
    documents: unknown[],
    mode: 'cpaToSub2Api' | 'sub2apiToCpa'
  ): Array<{ document: unknown; sourceName: string }>;
}
