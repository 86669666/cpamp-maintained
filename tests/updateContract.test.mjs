import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  parseVersion,
  resolveChannels,
  validateInfo,
} from '../bin/release/update-contract.mjs';
import { generateReleaseInfo } from '../bin/release/generate-release-info.mjs';
const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/update-versions.json', import.meta.url), 'utf8')
);
const makeInfo = (tag) =>
  generateReleaseInfo(
    tag,
    'a'.repeat(40),
    '<!-- cpamp-update\n' +
      JSON.stringify({
        summary: { zh: '更新', en: 'Update' },
        update: {
          breaking: false,
          migration_required: false,
          minimum_direct_upgrade_version: null,
          upgrade_guide_url: 'https://github.com/86669666/cpamp-maintained/releases/tag/' + tag,
        },
        compatibility: { minimum_cpa_version: null },
      }) +
      '\n-->'
  );
describe('update contract', () => {
  it('uses the same semantic ordering as the server', () => {
    corpus.ordered
      .slice(1)
      .forEach((tag, i) => expect(compareVersions(corpus.ordered[i], tag)).toBe(-1));
    corpus.equal.forEach(([a, b]) => expect(compareVersions(a, b)).toBe(0));
    corpus.invalid.forEach((tag) => expect(() => parseVersion(tag)).toThrow());
  });
  it('keeps stage and channel distinct and treats maintained releases as stable', () => {
    const infos = ['v2.0.0-maintained.1', 'v2.1.0-beta.1', 'v1.13.10-maintained.2'].map(
      makeInfo
    );
    expect(resolveChannels(infos)).toEqual({
      stable: { version: 'v2.0.0-maintained.1' },
      rc: { version: 'v2.0.0-maintained.1' },
      beta: { version: 'v2.1.0-beta.1' },
    });
    expect(parseVersion('v1.12.11-maintained.1').stage).toBe('stable');
    expect(parseVersion('v1.12.11-maintained.0').stage).toBe('');
    expect(() => makeInfo('v1.12.11-maintained.0')).toThrow('Invalid release identity');
  });
  it('fails closed on invalid identity, distribution and incomplete release', () => {
    const info = makeInfo('v2.0.0');
    expect(() =>
      validateInfo({ ...info, release: { ...info.release, stage: 'rc' } }, 'v2.0.0')
    ).toThrow();
    expect(() => generateReleaseInfo('v2.0.0', 'a'.repeat(40), 'No metadata')).toThrow();
  });
  it('generates recovery metadata from the explicit release SHA independently of the checkout', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'cpamp-release-info-'));
    try {
      const tag = 'v2.0.0',
        sha = 'b'.repeat(40),
        expected = makeInfo(tag);
      mkdirSync(path.join(cwd, 'docs/release-notes'), { recursive: true });
      writeFileSync(
        path.join(cwd, `docs/release-notes/${tag}-zh.md`),
        '<!-- cpamp-update\n' +
          JSON.stringify({
            summary: expected.content.summary,
            update: expected.update,
            compatibility: expected.compatibility,
          }) +
          '\n-->'
      );
      const output = path.join(cwd, 'release-info.json');
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL('../bin/release/generate-release-info.mjs', import.meta.url)),
          tag,
          output,
          sha,
        ],
        { cwd }
      );
      expect(JSON.parse(readFileSync(output, 'utf8')).release.source_commit).toBe(sha);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
