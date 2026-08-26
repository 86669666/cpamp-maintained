import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseReleaseTag,
  validateChangedReleaseContent,
  validateMaintainedReleaseTopology,
  validateReleaseContent,
  validateReleaseNotes,
  validateReleaseTopology,
  validateTelegramHtml,
} from '../bin/release/validate-release.mjs';

const releaseTag = 'v1.2.3';
const upstreamRepositoryUrl = 'https://github.com/seakee/CPA-Manager-Plus';
const releasePaths = {
  chinese: `docs/release-notes/${releaseTag}-zh.md`,
  english: `docs/release-notes/${releaseTag}-en.md`,
  telegram: `docs/release-posts/${releaseTag}-telegram.html`,
};

const chineseNotes = `# CPA Manager Plus ${releaseTag}

[English ->](https://github.com/seakee/CPA-Manager-Plus/blob/${releaseTag}/docs/release-notes/${releaseTag}-en.md)
`;
const englishNotes = `# CPA Manager Plus ${releaseTag}

[中文 ->](https://github.com/seakee/CPA-Manager-Plus/blob/${releaseTag}/docs/release-notes/${releaseTag}-zh.md)
`;
const telegramPost = '<b>v1.2.3</b>\n\n• Release update';

describe('release tag validation', () => {
  it('accepts stable and prerelease SemVer tags', () => {
    expect(parseReleaseTag('v1.2.3')).toEqual({ tag: 'v1.2.3', prerelease: false });
    expect(parseReleaseTag('v1.2.3-rc.1')).toEqual({ tag: 'v1.2.3-rc.1', prerelease: true });
  });

  it.each([
    '1.2.3',
    'v1.2',
    'v01.2.3',
    'v1.2.3-',
    'v1.2.3-01',
    'v1.2.3-rc.01',
    'v1.2.3+build.1',
    'vfoo',
  ])('rejects invalid tag %s', (tag) => {
    expect(() => parseReleaseTag(tag)).toThrow();
  });
});

describe('release content validation', () => {
  it('requires reciprocal tag-pinned language links', () => {
    expect(
      validateReleaseNotes({ tag: releaseTag, chinese: chineseNotes, english: englishNotes })
    ).toMatchObject({
      chineseCharacters: expect.any(Number),
      englishCharacters: expect.any(Number),
    });
    expect(() =>
      validateReleaseNotes({
        tag: releaseTag,
        chinese: chineseNotes,
        english: englishNotes.replace(`/blob/${releaseTag}/`, '/blob/v0.0.0/'),
      })
    ).toThrow('English release notes must link');
  });

  it('accepts reciprocal tag-pinned links for the maintained repository', () => {
    const repositoryUrl = 'https://github.com/86669666/cpamp-maintained';
    const maintainedChinese = chineseNotes.replace(
      'https://github.com/seakee/CPA-Manager-Plus',
      repositoryUrl
    );
    const maintainedEnglish = englishNotes.replace(
      'https://github.com/seakee/CPA-Manager-Plus',
      repositoryUrl
    );

    expect(
      validateReleaseNotes({
        tag: releaseTag,
        chinese: maintainedChinese,
        english: maintainedEnglish,
        repositoryUrl,
      })
    ).toMatchObject({
      chineseCharacters: expect.any(Number),
      englishCharacters: expect.any(Number),
    });
  });

  it('rejects unsupported Telegram markup and Markdown-only sections', () => {
    expect(validateTelegramHtml(telegramPost)).toEqual({ characters: expect.any(Number) });
    expect(validateTelegramHtml('<b>R&amp;D &#62; &#X3E; baseline</b>')).toEqual({
      characters: expect.any(Number),
    });
    expect(() => validateTelegramHtml('<script>alert(1)</script>')).toThrow('unsupported HTML');
    expect(() => validateTelegramHtml('<b>发布截图</b>')).toThrow('Markdown-only');
    expect(() => validateTelegramHtml('<a href="http://example.com">link</a>')).toThrow('HTTPS');
    expect(() => validateTelegramHtml('<b>R&D</b>')).toThrow('invalid or unescaped');
    expect(() => validateTelegramHtml('<b>A > B</b>')).toThrow('unescaped >');
    expect(() => validateTelegramHtml('<b>&bogus;</b>')).toThrow('invalid or unescaped');
  });

  it('requires all three release files before publishing', () => {
    const contents = new Map([
      [releasePaths.chinese, chineseNotes],
      [releasePaths.english, englishNotes],
      [releasePaths.telegram, telegramPost],
    ]);
    const readFile = (filePath) => contents.get(filePath.split('/').slice(-3).join('/'));
    const fileExists = (filePath) => contents.has(filePath.split('/').slice(-3).join('/'));

    expect(validateReleaseContent({ tag: releaseTag, readFile, fileExists })).toMatchObject({
      paths: releasePaths,
    });
    contents.delete(releasePaths.telegram);
    expect(() => validateReleaseContent({ tag: releaseTag, readFile, fileExists })).toThrow(
      'Missing required release files'
    );
  });

  it('validates every release tag represented by changed release paths', () => {
    const contents = new Map([
      [releasePaths.chinese, chineseNotes],
      [releasePaths.english, englishNotes],
      [releasePaths.telegram, telegramPost],
    ]);
    const readFile = (filePath) => contents.get(filePath.split('/').slice(-3).join('/'));
    const fileExists = (filePath) => contents.has(filePath.split('/').slice(-3).join('/'));

    expect(
      validateChangedReleaseContent({
        changedFiles: Object.values(releasePaths),
        readFile,
        fileExists,
      })
    ).toMatchObject({
      tags: [releaseTag],
      releases: [expect.objectContaining({ paths: releasePaths })],
    });
    expect(() =>
      validateChangedReleaseContent({
        changedFiles: ['docs/release-notes/README.md'],
        readFile,
        fileExists,
      })
    ).toThrow('Unexpected release content path');
  });

  it('validates changed maintained release content against the maintained repository URL', () => {
    const repositoryUrl = 'https://github.com/86669666/cpamp-maintained';
    const maintainedTag = 'v1.2.3-maintained.1';
    const maintainedPaths = {
      chinese: `docs/release-notes/${maintainedTag}-zh.md`,
      english: `docs/release-notes/${maintainedTag}-en.md`,
      telegram: `docs/release-posts/${maintainedTag}-telegram.html`,
    };
    const contents = new Map([
      [
        maintainedPaths.chinese,
        chineseNotes
          .replaceAll(releaseTag, maintainedTag)
          .replace('https://github.com/seakee/CPA-Manager-Plus', repositoryUrl),
      ],
      [
        maintainedPaths.english,
        englishNotes
          .replaceAll(releaseTag, maintainedTag)
          .replace('https://github.com/seakee/CPA-Manager-Plus', repositoryUrl),
      ],
      [maintainedPaths.telegram, telegramPost],
    ]);
    const readFile = (filePath) => contents.get(filePath.split('/').slice(-3).join('/'));
    const fileExists = (filePath) => contents.has(filePath.split('/').slice(-3).join('/'));

    expect(
      validateChangedReleaseContent({
        changedFiles: Object.values(maintainedPaths),
        repositoryUrl,
        readFile,
        fileExists,
      })
    ).toMatchObject({ tags: [maintainedTag] });
  });

  it('keeps upstream release-note links upstream when a maintained merge adds both releases', () => {
    const repositoryUrl = 'https://github.com/86669666/cpamp-maintained';
    const maintainedTag = 'v1.12.5-maintained.1';
    const maintainedPaths = {
      chinese: `docs/release-notes/${maintainedTag}-zh.md`,
      english: `docs/release-notes/${maintainedTag}-en.md`,
      telegram: `docs/release-posts/${maintainedTag}-telegram.html`,
    };
    const upstreamPaths = {
      chinese: 'docs/release-notes/v1.12.5-zh.md',
      english: 'docs/release-notes/v1.12.5-en.md',
      telegram: 'docs/release-posts/v1.12.5-telegram.html',
    };
    const contents = new Map([
      [
        upstreamPaths.chinese,
        chineseNotes
          .replaceAll(releaseTag, 'v1.12.5')
          .replace('https://github.com/seakee/CPA-Manager-Plus', upstreamRepositoryUrl),
      ],
      [
        upstreamPaths.english,
        englishNotes
          .replaceAll(releaseTag, 'v1.12.5')
          .replace('https://github.com/seakee/CPA-Manager-Plus', upstreamRepositoryUrl),
      ],
      [upstreamPaths.telegram, telegramPost],
      [
        maintainedPaths.chinese,
        chineseNotes
          .replaceAll(releaseTag, maintainedTag)
          .replace('https://github.com/seakee/CPA-Manager-Plus', repositoryUrl),
      ],
      [
        maintainedPaths.english,
        englishNotes
          .replaceAll(releaseTag, maintainedTag)
          .replace('https://github.com/seakee/CPA-Manager-Plus', repositoryUrl),
      ],
      [maintainedPaths.telegram, telegramPost],
    ]);
    const readFile = (filePath) => contents.get(filePath.split('/').slice(-3).join('/'));
    const fileExists = (filePath) => contents.has(filePath.split('/').slice(-3).join('/'));

    expect(
      validateChangedReleaseContent({
        changedFiles: [...Object.values(upstreamPaths), ...Object.values(maintainedPaths)],
        repositoryUrl,
        readFile,
        fileExists,
      })
    ).toMatchObject({ tags: ['v1.12.5', maintainedTag] });
  });
});

const makeTopologyGit = ({ extraDevChange = false, promotionTreeDrift = false, tagSha } = {}) => {
  const mainSha = 'a'.repeat(40);
  const previousMainSha = 'b'.repeat(40);
  const devSha = 'c'.repeat(40);
  const releaseParentSha = 'd'.repeat(40);
  const tagTarget = tagSha || mainSha;
  const mainTree = '1'.repeat(40);
  const devTree = promotionTreeDrift ? '2'.repeat(40) : mainTree;
  return {
    mainSha,
    devSha,
    git: (args) => {
      if (args[0] === 'rev-parse' && args[2] === 'origin/main^{commit}') return mainSha;
      if (args[0] === 'rev-parse' && args[2] === 'origin/dev^{commit}') return devSha;
      if (args[0] === 'rev-parse' && args[2] === 'refs/tags/v1.2.3^{commit}') return tagTarget;
      if (args[0] === 'rev-parse' && args[2] === `${mainSha}^{tree}`) return mainTree;
      if (args[0] === 'rev-parse' && args[2] === `${devSha}^{tree}`) return devTree;
      if (args[0] === 'rev-list' && args.at(-1) === mainSha)
        return `${mainSha} ${previousMainSha} ${devSha}`;
      if (args[0] === 'rev-list' && args.at(-1) === devSha)
        return `${devSha} ${releaseParentSha} ${'e'.repeat(40)}`;
      if (args[0] === 'diff') {
        const changes = Object.values(releasePaths).map((filePath) => `A\t${filePath}`);
        if (extraDevChange) changes.push('A\tREADME.md');
        return changes.join('\n');
      }
      throw new Error(`Unexpected git call: ${args.join(' ')}`);
    },
  };
};

describe('release topology validation', () => {
  it('requires the tag to point to the current main promotion merge', () => {
    const topology = makeTopologyGit();
    expect(
      validateReleaseTopology({ tag: releaseTag, sha: topology.mainSha, git: topology.git })
    ).toMatchObject({
      mainSha: topology.mainSha,
      devSha: topology.devSha,
    });
  });

  it('rejects a tag that points to an older or unrelated commit', () => {
    const topology = makeTopologyGit({ tagSha: 'f'.repeat(40) });
    expect(() =>
      validateReleaseTopology({ tag: releaseTag, sha: topology.mainSha, git: topology.git })
    ).toThrow('does not point to the candidate');
  });

  it('rejects dev advancement or extra changes after the release PR', () => {
    const topology = makeTopologyGit({ extraDevChange: true });
    expect(() =>
      validateReleaseTopology({ tag: releaseTag, sha: topology.mainSha, git: topology.git })
    ).toThrow('not the exact release PR merge');
  });

  it('rejects a promotion merge whose final tree differs from dev', () => {
    const topology = makeTopologyGit({ promotionTreeDrift: true });
    expect(() =>
      validateReleaseTopology({ tag: releaseTag, sha: topology.mainSha, git: topology.git })
    ).toThrow('tree must exactly match');
  });

  it('validates a complete topology using real Git commands', () => {
    const repository = mkdtempSync(path.join(tmpdir(), 'cpamp-release-topology-'));
    const git = (args) =>
      execFileSync('git', args, {
        cwd: repository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();

    try {
      git(['init', '--quiet', '--initial-branch=main']);
      git(['config', 'user.name', 'CI Test']);
      git(['config', 'user.email', 'ci-test@example.invalid']);
      git(['config', 'commit.gpgsign', 'false']);
      writeFileSync(path.join(repository, 'base.txt'), 'base\n');
      git(['add', 'base.txt']);
      git(['commit', '--quiet', '-m', 'base']);

      git(['switch', '--quiet', '-c', 'dev']);
      git(['switch', '--quiet', '-c', `release/${releaseTag}`]);
      mkdirSync(path.join(repository, 'docs', 'release-notes'), { recursive: true });
      mkdirSync(path.join(repository, 'docs', 'release-posts'), { recursive: true });
      for (const filePath of Object.values(releasePaths)) {
        writeFileSync(path.join(repository, filePath), `${filePath}\n`);
      }
      git(['add', 'docs']);
      git(['commit', '--quiet', '-m', 'release content']);

      git(['switch', '--quiet', 'dev']);
      git(['merge', '--quiet', '--no-ff', `release/${releaseTag}`, '-m', 'merge release']);
      const devSha = git(['rev-parse', 'HEAD']);
      git(['switch', '--quiet', 'main']);
      git(['merge', '--quiet', '--no-ff', 'dev', '-m', 'promote dev']);
      const mainSha = git(['rev-parse', 'HEAD']);
      git(['tag', releaseTag, mainSha]);

      expect(
        validateReleaseTopology({
          tag: releaseTag,
          sha: mainSha,
          mainRef: 'refs/heads/main',
          devRef: 'refs/heads/dev',
          git,
        })
      ).toMatchObject({ mainSha, devSha });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});

describe('maintained release topology validation', () => {
  it('accepts a tag on the current maintained main commit without a dev branch', () => {
    const mainSha = 'a'.repeat(40);
    const git = (args) => {
      if (args[0] === 'rev-parse' && args[2] === 'origin/main^{commit}') return mainSha;
      if (args[0] === 'rev-parse' && args[2] === 'refs/tags/v1.2.3^{commit}') return mainSha;
      throw new Error(`Unexpected git call: ${args.join(' ')}`);
    };

    expect(
      validateMaintainedReleaseTopology({ tag: releaseTag, sha: mainSha, git })
    ).toEqual({ tag: releaseTag, candidateSha: mainSha, mainSha });
  });

  it('rejects a maintained candidate that is not the current main commit', () => {
    const mainSha = 'a'.repeat(40);
    const candidateSha = 'b'.repeat(40);
    const git = (args) => {
      if (args[0] === 'rev-parse' && args[2] === 'origin/main^{commit}') return mainSha;
      if (args[0] === 'rev-parse' && args[2] === 'refs/tags/v1.2.3^{commit}') return candidateSha;
      throw new Error(`Unexpected git call: ${args.join(' ')}`);
    };

    expect(() =>
      validateMaintainedReleaseTopology({ tag: releaseTag, sha: candidateSha, git })
    ).toThrow('not the current origin/main');
  });

  it('rejects a maintained tag that does not point to the candidate commit', () => {
    const mainSha = 'a'.repeat(40);
    const otherSha = 'b'.repeat(40);
    const git = (args) => {
      if (args[0] === 'rev-parse' && args[2] === 'origin/main^{commit}') return mainSha;
      if (args[0] === 'rev-parse' && args[2] === 'refs/tags/v1.2.3^{commit}') return otherSha;
      throw new Error(`Unexpected git call: ${args.join(' ')}`);
    };

    expect(() =>
      validateMaintainedReleaseTopology({ tag: releaseTag, sha: mainSha, git })
    ).toThrow('does not point to the candidate');
  });

  it('allows dry-run validation without a pre-existing tag', () => {
    const mainSha = 'a'.repeat(40);
    const git = (args) => {
      if (args[0] === 'rev-parse' && args[2] === 'origin/main^{commit}') return mainSha;
      throw new Error(`Unexpected git call: ${args.join(' ')}`);
    };

    expect(
      validateMaintainedReleaseTopology({
        tag: releaseTag,
        sha: mainSha,
        requireTagRef: false,
        git,
      })
    ).toEqual({ tag: releaseTag, candidateSha: mainSha, mainSha });
  });
});
