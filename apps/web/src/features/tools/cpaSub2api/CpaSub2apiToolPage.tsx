import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import {
  IconDownload,
  IconFileText,
  IconGithub,
  IconShield,
  IconTrash2,
} from '@/components/ui/icons';
import {
  buildMergedSub2ApiDocument,
  buildMergedApiKeyConfig,
  maskApiKey,
  convertCPARecord,
  convertSub2ApiDocument,
} from './converter.mjs';

interface ConvertedRecord {
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

interface ConvertedApiKey {
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

interface SkippedRecord {
  sourceName: string;
  entryLabel?: string;
  reason: string;
}

interface PasteIssue {
  label: string;
  reason: string;
}
import { buildZipArchive } from './archive.mjs';
import { buildPastedInputItems, parsePastedJsonDocuments } from './paste-input.mjs';
import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_IMPORT,
  MAX_PASTE_BYTES,
  MAX_TOTAL_BYTES,
  exceedsPasteLimit,
  validateImportCandidates,
  type ImportRejection,
} from './limits';
import styles from './CpaSub2apiToolPage.module.scss';

type Mode = 'cpaToSub2Api' | 'sub2apiToCpa';
type ImportMethod = 'files' | 'paste';

type Issue = SkippedRecord & { code?: string; values?: Record<string, unknown> };

interface PageState {
  seen: Set<string>;
  imported: number;
  converted: ConvertedRecord[];
  convertedApiKeys: ConvertedApiKey[];
  skipped: Issue[];
}

const createPageState = (): PageState => ({
  seen: new Set(),
  imported: 0,
  converted: [],
  convertedApiKeys: [],
  skipped: [],
});

const createPages = (): Record<Mode, PageState> => ({
  cpaToSub2Api: createPageState(),
  sub2apiToCpa: createPageState(),
});

const timestampToken = (date = new Date()) => {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
};

const downloadBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const downloadJson = (document: unknown, fileName: string) => {
  downloadBlob(
    new Blob([JSON.stringify(document, null, 2)], { type: 'application/json;charset=utf-8' }),
    fileName
  );
};

const recordsZip = (records: ConvertedRecord[]) =>
  buildZipArchive(
    records.map((record) => ({
      fileName: record.outputFileName,
      text: JSON.stringify(record.document, null, 2),
    }))
  );

const sourceLabel = (record: ConvertedRecord) => {
  switch (record.sourceType) {
    case 'codex':
    case 'openai':
      return 'Codex';
    case 'claude':
    case 'anthropic':
      return 'Claude';
    case 'antigravity':
      return 'Antigravity';
    case 'gemini':
      return 'Gemini';
    default:
      return record.providerLabel || record.sourceType;
  }
};

const formatDate = (value: string | undefined, locale: string) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
};

const sourceName = (file: File) =>
  (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;

export function CpaSub2apiToolPage() {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<Mode>('cpaToSub2Api');
  const [method, setMethod] = useState<ImportMethod>('files');
  const [pages, setPages] = useState(createPages);
  const [paste, setPaste] = useState('');
  const [pasteStatus, setPasteStatus] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const page = pages[mode];

  const copy = useMemo(
    () => ({
      input: t(`cpa_sub2api.modes.${mode}.input`),
      output: t(`cpa_sub2api.modes.${mode}.output`),
      importTitle: t(`cpa_sub2api.modes.${mode}.import_title`),
      importDescription: t(`cpa_sub2api.modes.${mode}.import_description`),
      drop: t(`cpa_sub2api.modes.${mode}.drop`),
      empty: t(`cpa_sub2api.modes.${mode}.empty`),
    }),
    [mode, t]
  );

  const translateIssue = useCallback(
    (issue: Issue) => {
      if (!issue.code) return issue.reason;
      return t(`cpa_sub2api.issues.${issue.code}`, issue.values ?? {});
    },
    [t]
  );

  const rejectionIssue = useCallback(
    (rejection: ImportRejection): Issue => ({
      sourceName: rejection.name,
      reason: '',
      code: rejection.code,
      values: {
        maxFiles: MAX_FILES_PER_IMPORT,
        maxFileMb: MAX_FILE_BYTES / 1024 / 1024,
        maxTotalMb: MAX_TOTAL_BYTES / 1024 / 1024,
      },
    }),
    []
  );

  const applyDocuments = useCallback(
    (items: Array<{ document: unknown; sourceName: string }>, imported: number, issues: Issue[] = []) => {
      setPages((current) => {
        const active = current[mode];
        const next: PageState = {
          seen: new Set(active.seen),
          imported: active.imported + imported,
          converted: [...active.converted],
          convertedApiKeys: [...active.convertedApiKeys],
          skipped: [...active.skipped, ...issues],
        };

        items.forEach((item) => {
          const key = `content|${mode}|${JSON.stringify(item.document)}`;
          if (next.seen.has(key)) {
            next.skipped.push({ sourceName: item.sourceName, reason: '', code: 'duplicate' });
            return;
          }
          next.seen.add(key);
          try {
            if (mode === 'cpaToSub2Api') {
              next.converted.push(convertCPARecord(item.document, { sourceName: item.sourceName }));
            } else {
              const result = convertSub2ApiDocument(item.document, { sourceName: item.sourceName });
              next.converted.push(...result.converted);
              next.convertedApiKeys.push(...(result.convertedApiKeys || []));
              next.skipped.push(
                ...result.skipped.map((issue: SkippedRecord) => ({
                  ...issue,
                  reason: i18n.language.toLowerCase().startsWith('zh') ? issue.reason : '',
                  code: i18n.language.toLowerCase().startsWith('zh') ? undefined : 'invalid',
                }))
              );
            }
          } catch (error) {
            next.skipped.push({
              sourceName: item.sourceName,
              reason:
                error instanceof Error && i18n.language.toLowerCase().startsWith('zh')
                  ? error.message
                  : '',
              code: i18n.language.toLowerCase().startsWith('zh') ? undefined : 'invalid',
            });
          }
        });
        return { ...current, [mode]: next };
      });
    },
    [i18n.language, mode]
  );

  const processFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (!files.length) return;
      const validated = validateImportCandidates(
        files.map((file) => ({
          name: sourceName(file),
          size: file.size,
          json:
            file.name.toLowerCase().endsWith('.json') ||
            file.type === 'application/json' ||
            file.type === 'text/json',
        }))
      );
      const initialIssues = validated.rejected.map(rejectionIssue);
      const items: Array<{ document: unknown; sourceName: string }> = [];
      const parseIssues: Issue[] = [];

      for (const index of validated.accepted) {
        const file = files[index];
        const name = sourceName(file);
        try {
          const text = await file.text();
          const document = JSON.parse(text) as unknown;
          if (mode === 'cpaToSub2Api' && Array.isArray(document)) {
            document.forEach((entry, entryIndex) =>
              items.push({ document: entry, sourceName: `${name}.${entryIndex + 1}` })
            );
          } else {
            items.push({ document, sourceName: name });
          }
        } catch (error) {
          parseIssues.push({
            sourceName: name,
            reason: error instanceof Error ? error.message : t('cpa_sub2api.issues.invalid_json'),
          });
        }
      }

      applyDocuments(items, files.length, [...initialIssues, ...parseIssues]);
      setDragging(false);
    },
    [applyDocuments, mode, rejectionIssue, t]
  );

  const processPaste = useCallback(() => {
    if (!paste.trim()) {
      setPasteStatus(t('cpa_sub2api.paste_required'));
      return;
    }
    if (exceedsPasteLimit(paste)) {
      setPasteStatus(
        t('cpa_sub2api.issues.paste_too_large', { maxPasteMb: MAX_PASTE_BYTES / 1024 / 1024 })
      );
      return;
    }
    const parsed = parsePastedJsonDocuments(paste);
    const items = buildPastedInputItems(parsed.documents, mode).map((item, index) => ({
      ...item,
      sourceName: t('cpa_sub2api.paste_item', { index: index + 1 }),
    }));
    const issues: Issue[] = parsed.issues.map((issue: PasteIssue, index: number) => ({
      sourceName: t('cpa_sub2api.paste_item', { index: parsed.documents.length + index + 1 }),
      reason: i18n.language.toLowerCase().startsWith('zh') ? issue.reason : '',
      code: i18n.language.toLowerCase().startsWith('zh') ? undefined : 'invalid_json',
    }));
    applyDocuments(items, items.length + issues.length, issues);
    setPasteStatus(
      t('cpa_sub2api.paste_result', {
        read: items.length + issues.length,
        issues: issues.length,
      })
    );
    if (!issues.length) setPaste('');
  }, [applyDocuments, i18n.language, mode, paste, t]);

  const clearCurrent = useCallback(() => {
    setPages((current) => ({ ...current, [mode]: createPageState() }));
    setPaste('');
    setPasteStatus('');
    if (fileInput.current) fileInput.current.value = '';
    if (folderInput.current) folderInput.current.value = '';
  }, [mode]);

  const downloadAll = useCallback(async () => {
    if (!page.converted.length) return;
    if (mode === 'cpaToSub2Api' && page.converted.length > 3) {
      downloadBlob(recordsZip(page.converted), `sub2api-${timestampToken()}.zip`);
      return;
    }
    const picker = (window as Window & {
      showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<{
        getFileHandle: (name: string, options: { create: boolean }) => Promise<{
          createWritable: () => Promise<{ write: (text: string) => Promise<void>; close: () => Promise<void> }>;
        }>;
      }>;
    }).showDirectoryPicker;
    if (picker) {
      try {
        const directory = await picker({ mode: 'readwrite' });
        for (const record of page.converted) {
          const handle = await directory.getFileHandle(record.outputFileName, { create: true });
          const writer = await handle.createWritable();
          await writer.write(JSON.stringify(record.document, null, 2));
          await writer.close();
        }
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    page.converted.forEach((record, index) =>
      window.setTimeout(() => downloadJson(record.document, record.outputFileName), index * 120)
    );
  }, [mode, page.converted]);

  const downloadMerged = useCallback(() => {
    if (!page.converted.length) return;
    if (mode === 'sub2apiToCpa') {
      downloadBlob(recordsZip(page.converted), `cpa-${timestampToken()}.zip`);
      return;
    }
    downloadJson(
      buildMergedSub2ApiDocument(page.converted),
      `sub2api-${timestampToken()}.json`
    );
  }, [mode, page.converted]);

  const downloadMergedApiKeys = useCallback(() => {
    if (!page.convertedApiKeys.length) return;
    const config = buildMergedApiKeyConfig(page.convertedApiKeys);
    downloadJson(config, `cliproxyapi-provider-keys-${timestampToken()}.json`);
  }, [page.convertedApiKeys]);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    void processFiles(event.dataTransfer.files);
  };

  return (
    <div className={styles.container}>
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>{t('cpa_sub2api.title')}</h1>
          <p className={styles.description}>{t('cpa_sub2api.description')}</p>
        </div>
        <a
          className={styles.sourceLink}
          href="https://github.com/gtxx3600/CPA2sub2API"
          target="_blank"
          rel="noopener noreferrer"
        >
          <IconGithub size={18} />
          <span>{t('cpa_sub2api.source')}</span>
        </a>
      </header>

      <div className={styles.privacyBanner} role="status">
        <IconShield size={22} />
        <div>
          <strong>{t('cpa_sub2api.privacy_title')}</strong>
          <p>{t('cpa_sub2api.privacy_description')}</p>
        </div>
      </div>

      <Card className={styles.workspaceCard}>
        <div className={styles.modeTabs} role="tablist" aria-label={t('cpa_sub2api.direction')}>
          {(['cpaToSub2Api', 'sub2apiToCpa'] as Mode[]).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={mode === item}
              className={`${styles.tab} ${mode === item ? styles.activeTab : ''}`}
              onClick={() => setMode(item)}
            >
              {t(`cpa_sub2api.modes.${item}.tab`)}
            </button>
          ))}
        </div>

        <div className={styles.flowSummary}>
          <span>{copy.input}</span><b aria-hidden="true">→</b><span>{copy.output}</span>
        </div>

        <div className={styles.providerChips} aria-label={t('cpa_sub2api.providers')}>
          {['Codex', 'Claude', 'Antigravity', 'Gemini'].map((provider) => (
            <span key={provider}>{provider}</span>
          ))}
        </div>

        <div className={styles.importTabs} role="tablist" aria-label={t('cpa_sub2api.import_method')}>
          {(['files', 'paste'] as ImportMethod[]).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={method === item}
              className={`${styles.importTab} ${method === item ? styles.activeImportTab : ''}`}
              onClick={() => setMethod(item)}
            >
              {t(`cpa_sub2api.import_${item}`)}
            </button>
          ))}
        </div>

        <h2 className={styles.importTitle}>{copy.importTitle}</h2>
        <p className={styles.importDescription}>{copy.importDescription}</p>

        {method === 'files' ? (
          <div
            className={`${styles.dropzone} ${dragging ? styles.dragging : ''}`}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <IconFileText size={30} />
            <strong>{copy.drop}</strong>
            <span>
              {t('cpa_sub2api.limits', {
                maxFiles: MAX_FILES_PER_IMPORT,
                maxFileMb: MAX_FILE_BYTES / 1024 / 1024,
                maxTotalMb: MAX_TOTAL_BYTES / 1024 / 1024,
              })}
            </span>
            <div className={styles.dropActions}>
              <Button type="button" onClick={() => fileInput.current?.click()}>
                {t('cpa_sub2api.choose_files')}
              </Button>
              <Button type="button" variant="secondary" onClick={() => folderInput.current?.click()}>
                {t('cpa_sub2api.choose_folder')}
              </Button>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              multiple
              hidden
              onChange={(event) => { void processFiles(event.target.files ?? []); event.target.value = ''; }}
            />
            <input
              ref={folderInput}
              type="file"
              accept=".json,application/json"
              multiple
              hidden
              {...({ webkitdirectory: '' } as Record<string, string>)}
              onChange={(event) => { void processFiles(event.target.files ?? []); event.target.value = ''; }}
            />
          </div>
        ) : (
          <div className={styles.pastePanel}>
            <label htmlFor="cpa-sub2api-paste">{t('cpa_sub2api.paste_label')}</label>
            <textarea
              id="cpa-sub2api-paste"
              value={paste}
              spellCheck={false}
              placeholder={t('cpa_sub2api.paste_placeholder')}
              onChange={(event) => setPaste(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  processPaste();
                }
              }}
            />
            <div className={styles.pasteFooter}>
              <span>{pasteStatus || t('cpa_sub2api.paste_hint', { maxPasteMb: MAX_PASTE_BYTES / 1024 / 1024 })}</span>
              <div>
                <Button type="button" onClick={processPaste}>{t('cpa_sub2api.convert')}</Button>
                <Button type="button" variant="secondary" onClick={() => { setPaste(''); setPasteStatus(''); }}>
                  {t('cpa_sub2api.clear')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Card>

      <div className={styles.stats}>
        <div><strong>{page.converted.length}</strong><span>{t('cpa_sub2api.success')}</span></div>
        <div><strong>{page.convertedApiKeys.length}</strong><span>{t('cpa_sub2api.api_keys')}</span></div>
        <div><strong>{page.skipped.length}</strong><span>{t('cpa_sub2api.skipped')}</span></div>
        <div><strong>{page.imported}</strong><span>{t('cpa_sub2api.imported')}</span></div>
      </div>

      <Card className={styles.resultsCard}>
        <div className={styles.resultsHeader}>
          <div>
            <h2>{t('cpa_sub2api.results')}</h2>
            <p>{page.imported ? t('cpa_sub2api.summary', { imported: page.imported, converted: page.converted.length, skipped: page.skipped.length }) : copy.empty}</p>
          </div>
          <div className={styles.resultActions}>
            <Button type="button" variant="ghost" onClick={clearCurrent}>
              <IconTrash2 size={16} /> {t('cpa_sub2api.clear')}
            </Button>
            <Button type="button" variant="secondary" disabled={!page.converted.length} onClick={() => void downloadAll()}>
              <IconDownload size={16} /> {t('cpa_sub2api.download_individual')}
            </Button>
            <Button type="button" disabled={!page.converted.length} onClick={downloadMerged}>
              <IconDownload size={16} /> {t(`cpa_sub2api.modes.${mode}.download_merged`)}
            </Button>
          </div>
        </div>

        {page.converted.length ? (
          <div className={styles.tableWrap}>
            <table>
              <thead><tr>
                <th>{t('cpa_sub2api.columns.source')}</th>
                <th>{t('cpa_sub2api.columns.output')}</th>
                <th>{t('cpa_sub2api.columns.provider')}</th>
                <th>{t('cpa_sub2api.columns.email')}</th>
                <th>{t('cpa_sub2api.columns.expiry')}</th>
                <th>{t('cpa_sub2api.columns.action')}</th>
              </tr></thead>
              <tbody>
                {page.converted.map((record, index) => (
                  <tr key={`${record.outputFileName}|${index}`}>
                    <td title={record.sourceName}>{record.sourceName || t('cpa_sub2api.unnamed')}</td>
                    <td title={record.outputFileName}>{record.outputFileName}</td>
                    <td><span className={styles.providerBadge}>{sourceLabel(record)}</span>{record.planType ? <small>{record.planType}</small> : null}</td>
                    <td>{record.email || '—'}</td>
                    <td>{formatDate(record.expiresAt, i18n.language) || '—'}</td>
                    <td><button type="button" className={styles.inlineButton} onClick={() => downloadJson(record.document, record.outputFileName)}>{t('cpa_sub2api.download')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className={styles.empty}>{copy.empty}</div>}
      </Card>

      {page.convertedApiKeys.length > 0 && (
        <Card className={styles.resultsCard}>
          <div className={styles.resultsHeader}>
            <div>
              <h2>{t('cpa_sub2api.api_key_results')}</h2>
              <p className={styles.warningText}>
                <IconShield size={16} /> {t('cpa_sub2api.api_key_warning')}
              </p>
            </div>
            <div className={styles.resultActions}>
              <Button type="button" disabled={!page.convertedApiKeys.length} onClick={downloadMergedApiKeys}>
                <IconDownload size={16} /> {t('cpa_sub2api.download_api_keys')}
              </Button>
            </div>
          </div>

          <div className={styles.tableWrap}>
            <table>
              <thead><tr>
                <th>{t('cpa_sub2api.columns.source')}</th>
                <th>{t('cpa_sub2api.columns.provider_key')}</th>
                <th>{t('cpa_sub2api.columns.account_name')}</th>
                <th>{t('cpa_sub2api.columns.email')}</th>
                <th>{t('cpa_sub2api.columns.key_preview')}</th>
              </tr></thead>
              <tbody>
                {page.convertedApiKeys.map((record, index) => (
                  <tr key={`${record.providerKey}|${index}`}>
                    <td title={record.sourceName}>{record.sourceName || t('cpa_sub2api.unnamed')}</td>
                    <td><code>{record.providerKey}</code></td>
                    <td>{record.accountName || '—'}</td>
                    <td>{record.email || '—'}</td>
                    <td><code>{maskApiKey(record.apiKey)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className={styles.issuesCard}>
        <h2>{t('cpa_sub2api.issues_title')}</h2>
        {page.skipped.length ? (
          <ul>{page.skipped.map((issue, index) => (
            <li key={`${issue.sourceName}|${index}`}>
              <strong>{issue.sourceName}{issue.entryLabel ? ` · ${issue.entryLabel}` : ''}</strong>
              <span>{translateIssue(issue)}</span>
            </li>
          ))}</ul>
        ) : <p>{t('cpa_sub2api.no_issues')}</p>}
      </Card>
    </div>
  );
}
