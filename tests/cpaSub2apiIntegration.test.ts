import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(root, 'apps', 'web');
const source = (...parts: string[]) => readFileSync(join(webRoot, ...parts), 'utf8');
const featureDir = join(webRoot, 'src', 'features', 'tools', 'cpaSub2api');

describe('built-in CPA ↔ sub2api tool integration', () => {
  test('registers the exact route and visible Tools navigation without weakening plugin lockdown', () => {
    const routes = source('src', 'router', 'MainRoutes.tsx');
    const layout = source('src', 'components', 'layout', 'MainLayout.tsx');
    expect(routes).toContain("path: '/tools/cpa-sub2api'");
    expect(routes).toContain('<CpaSub2apiToolPage />');
    expect(layout).toContain("path: '/tools/cpa-sub2api'");
    expect(layout).toContain("label: t('nav.cpa_sub2api')");
    expect(routes).toContain("path: '/plugins'");
    expect(routes).toContain('<PluginGate>');
  });

  test('has complete locale keys in every supported CPAMC language', () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru']) {
      const messages = JSON.parse(source('src', 'i18n', 'locales', `${locale}.json`));
      expect(messages.nav.cpa_sub2api).toBeTruthy();
      expect(messages.cpa_sub2api.title).toBeTruthy();
      expect(messages.cpa_sub2api.privacy_description).toBeTruthy();
      expect(messages.cpa_sub2api.modes.cpaToSub2Api.download_merged).toBeTruthy();
      expect(messages.cpa_sub2api.modes.sub2apiToCpa.download_merged).toBeTruthy();
    }
  });

  test('pins and attributes the MIT upstream source', () => {
    const converter = source(
      'src',
      'features',
      'tools',
      'cpaSub2api',
      'converter.mjs'
    );
    const page = source(
      'src',
      'features',
      'tools',
      'cpaSub2api',
      'CpaSub2apiToolPage.tsx'
    );
    expect(converter).toContain('https://github.com/gtxx3600/CPA2sub2API');
    expect(converter).toContain('42ff785d5f3527e4050c02a0da51d4f7eb4f1180');
    expect(page).toContain('https://github.com/gtxx3600/CPA2sub2API');
    expect(page).toContain('rel="noopener noreferrer"');
    const license = join(featureDir, 'UPSTREAM_LICENSE.txt');
    expect(existsSync(license)).toBe(true);
    expect(readFileSync(license, 'utf8')).toContain('MIT License');
    expect(readFileSync(license, 'utf8')).toContain('Copyright (c) 2026 Hanhaofu');
  });

  test('uses no network, persistence, iframe, or dynamic HTML execution primitives', () => {
    const featureSource = readdirSync(featureDir)
      .filter((name) => /\.(?:ts|tsx|mjs)$/.test(name))
      .map((name) => source('src', 'features', 'tools', 'cpaSub2api', name))
      .join('\n');
    for (const forbidden of [
      /\bfetch\s*\(/,
      /\baxios\b/,
      /XMLHttpRequest/,
      /WebSocket/,
      /sendBeacon/,
      /localStorage/,
      /sessionStorage/,
      /indexedDB/,
      /dangerouslySetInnerHTML/,
      /\.innerHTML\s*=/,
      /\beval\s*\(/,
      /new Function/,
      /<iframe/,
    ]) {
      expect(featureSource).not.toMatch(forbidden);
    }
  });

  test('declares local-only limits and does not display credential fields in result columns', () => {
    const limits = source('src', 'features', 'tools', 'cpaSub2api', 'limits.ts');
    const page = source(
      'src',
      'features',
      'tools',
      'cpaSub2api',
      'CpaSub2apiToolPage.tsx'
    );
    expect(limits).toContain('MAX_FILES_PER_IMPORT = 100');
    expect(limits).toContain('MAX_FILE_BYTES = 10 * 1024 * 1024');
    expect(limits).toContain('MAX_TOTAL_BYTES = 50 * 1024 * 1024');
    expect(limits).toContain('MAX_PASTE_BYTES = 10 * 1024 * 1024');
    expect(page).not.toContain('record.account.credentials');
    expect(page).not.toContain('record.document.access_token');
    expect(page).not.toContain('record.document.refresh_token');
    expect(page).toContain('maskApiKey(record.apiKey)');
  });
});
