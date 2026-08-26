import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(repoRoot, '.github', 'workflows');
const readWorkflow = (name) => readFileSync(path.join(workflowDir, name), 'utf8');
const dependabotConfig = readFileSync(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
const managerServerDockerfile = readFileSync(
  path.join(repoRoot, 'Dockerfile.manager-server'),
  'utf8'
);

const externalActions = (workflow) =>
  [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)@([^\s#]+)/gm)]
    .map(([, action, ref]) => ({ action, ref }))
    .filter(({ action }) => !action.startsWith('./'));

const jobBlock = (workflow, jobName) => {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start === -1) throw new Error(`Missing workflow job: ${jobName}`);
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^  \S/.test(line));
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start + 1, end).join('\n');
};

describe('GitHub Actions workflow integrity', () => {
  it('pins every external action to a full commit SHA', () => {
    const workflowFiles = readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file));
    const actions = workflowFiles.flatMap((file) => externalActions(readWorkflow(file)));

    expect(actions.length).toBeGreaterThan(0);
    for (const { action, ref } of actions) {
      expect(ref, `${action} must be pinned to a 40-character commit SHA`).toMatch(
        /^[0-9a-f]{40}$/
      );
    }
  });

  it('keeps Demo and Docs inside the stable required-check aggregate', () => {
    const workflow = readWorkflow('pr-check.yml');
    const demoJob = jobBlock(workflow, 'demo-docs');
    const requiredJob = jobBlock(workflow, 'required');

    expect(demoJob).toContain('name: Demo and Docs');
    expect(requiredJob).toContain('- demo-docs');
    expect(requiredJob).toContain("DEMO_DOCS_RESULT: ${{ needs['demo-docs'].result }}");
    expect(requiredJob).toContain('"Demo and Docs:${DEMO_DOCS_RESULT}"');
  });

  it('keeps release content validation inside the stable required-check aggregate', () => {
    const workflow = readWorkflow('pr-check.yml');
    const releaseJob = jobBlock(workflow, 'release-content');
    const requiredJob = jobBlock(workflow, 'required');

    expect(releaseJob).toContain('name: Release Content');
    expect(releaseJob).toContain('--changed-content');
    expect(releaseJob).toContain('--repository-url "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}"');
    expect(releaseJob).toContain('--null < "${changed_files}"');
    expect(releaseJob).toContain('--diff-filter=A -z');
    expect(requiredJob).toContain('- release-content');
    expect(requiredJob).toContain("RELEASE_CONTENT_RESULT: ${{ needs['release-content'].result }}");
    expect(requiredJob).toContain('"Release Content:${RELEASE_CONTENT_RESULT}"');
  });

  it('uses NUL-delimited Git paths before classification and release validation', () => {
    const workflow = readWorkflow('pr-check.yml');

    expect(workflow).toContain('git diff --name-only --no-renames -z');
    expect(workflow).toContain('git show --pretty=format: --name-only --no-renames -z');
    expect(workflow).toContain('bun bin/ci/classify-pr-checks.mjs --null');
    expect(workflow).not.toContain('node bin/ci/classify-pr-checks.mjs');
  });

  it('serializes every publishing stage behind release preflight', () => {
    const workflow = readWorkflow('release.yml');
    for (const jobName of ['build_release_assets', 'publish_github_release', 'notify_telegram']) {
      const job = jobBlock(workflow, jobName);
      expect(
        /needs:\s*preflight|needs:[\s\S]*?\n\s+- preflight/.test(job),
        `${jobName} must depend on preflight`
      ).toBe(true);
    }
  });

  it('installs the pinned Bun runtime before release preflight executes Bun', () => {
    const workflow = readWorkflow('release.yml');
    const preflightJob = jobBlock(workflow, 'preflight');

    expect(preflightJob).toContain(
      'oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76'
    );
    expect(preflightJob).toContain('bun-version: 1.3.14');
    expect(preflightJob.indexOf('- name: Setup Bun')).toBeLessThan(
      preflightJob.indexOf('- name: Resolve release context')
    );
  });

  it('publishes the maintained lightweight artifact with complete provenance', () => {
    const workflow = readWorkflow('release.yml');
    const buildJob = jobBlock(workflow, 'build_release_assets');
    const publishJob = jobBlock(workflow, 'publish_github_release');

    expect(buildJob).toContain('scripts/build-maintained-lightweight.sh');
    expect(workflow).toContain('prerelease="$(bun - "${release_tag}"');
    expect(workflow).not.toMatch(/\bnode\s+--input-type=module\b/);
    expect(buildJob).toContain('RELEASE_TAG: ${{ needs.preflight.outputs.release_tag }}');
    expect(buildJob).toContain('DRY_RUN: ${{ needs.preflight.outputs.dry_run }}');
    expect(buildJob).toContain('if [ "${DRY_RUN}" = "true" ]');
    expect(buildJob).toContain('git tag --force "${RELEASE_TAG}" "${GITHUB_SHA}"');
    expect(buildJob).toContain('git fetch --force origin "refs/tags/${RELEASE_TAG}:refs/tags/${RELEASE_TAG}"');
    expect(buildJob).toContain('refs/tags/${RELEASE_TAG}^{commit}');
    expect(buildJob).toContain('cp output-maintained/management.html dist/release/management.html');
    expect(buildJob).toContain('cp output-maintained/metadata.json dist/release/metadata.json');
    expect(buildJob).toContain('cp output-maintained/SOURCE_COMMIT dist/release/SOURCE_COMMIT');
    expect(buildJob).toContain('cp output-maintained/SHA256SUMS dist/release/SHA256SUMS');
    expect(buildJob).toContain('sha256sum -c SHA256SUMS');
    expect(buildJob).toContain('test "$(find . -maxdepth 1 -type f \\( -name \'*.tar.gz\' -o -name \'*.zip\' \\) | wc -l)" -eq 6');
    expect(buildJob).toContain('sha256sum -c checksums.txt');
    expect(buildJob).not.toContain('find native -maxdepth 1 -type f -print0');
    expect(buildJob).not.toContain('sha256sum release-notes.md >> SHA256SUMS');
    expect(buildJob).not.toContain('cp apps/web/dist/index.html dist/release/management.html');

    expect(publishJob).toContain('test -s dist/release/metadata.json');
    expect(publishJob).toContain('test -s dist/release/SOURCE_COMMIT');
    expect(publishJob).toContain('test -s dist/release/SHA256SUMS');
    expect(publishJob).toContain('test -s dist/release/native/checksums.txt');
    expect(publishJob).toContain('(cd dist/release && sha256sum -c SHA256SUMS)');
    expect(publishJob).toContain('sha256sum -c checksums.txt');
    expect(publishJob).toContain('git fetch --force origin "refs/tags/${RELEASE_TAG}:refs/tags/${RELEASE_TAG}"');
    expect(publishJob).toContain('release_commit="$(git rev-parse --verify "refs/tags/${RELEASE_TAG}^{commit}")"');
    expect(publishJob).toContain('test "${release_commit}" = "${GITHUB_SHA}"');
    expect(publishJob).toContain('metadata["sourceHead"] == sys.argv[2]');
    expect(publishJob).toContain('metadata["sourceTag"] == sys.argv[3]');
    expect(publishJob).toContain('metadata["buildVersion"] == sys.argv[3]');
    expect(publishJob).toContain('dist/release/metadata.json');
    expect(publishJob).toContain('dist/release/SOURCE_COMMIT');
    expect(publishJob).toContain('dist/release/SHA256SUMS');
    expect(publishJob).toContain('dist/release/native/checksums.txt');
  });

  it('exposes a serialized dry-run path and rejects legacy release-note fallback', () => {
    const workflow = readWorkflow('release.yml');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('version:');
    expect(workflow).toContain('dry_run=true');
    expect(workflow).toContain('--maintained-branch');
    expect(workflow).toContain('--repository-url "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}"');
    expect(workflow).not.toContain('+refs/heads/dev:refs/remotes/origin/dev');
    expect(workflow).not.toContain('build_and_push_docker:');
    expect(workflow).not.toContain('ghcr.io/seakee/cpa-manager-plus');
    expect(workflow).not.toContain('DOCKERHUB_IMAGE: seakee/cpa-manager-plus');
    expect(workflow).toContain(
      "import { parseReleaseTag } from './bin/release/validate-release.mjs'"
    );
    expect(workflow).toContain('group: release-publish');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).not.toContain('Generate release notes');
    expect(workflow).not.toContain('git log --pretty');
    expect(workflow).not.toContain('previous_tag');
  });

  it('scopes Telegram secrets to the delivery step', () => {
    const workflow = readWorkflow('release.yml');
    const notifyJob = jobBlock(workflow, 'notify_telegram');
    const stepsOffset = notifyJob.indexOf('\n    steps:');
    const jobConfiguration = notifyJob.slice(0, stepsOffset);
    const deliveryStep = notifyJob.slice(notifyJob.indexOf('- name: Send Telegram'));

    expect(jobConfiguration).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(jobConfiguration).not.toContain('TELEGRAM_CHAT_ID');
    expect(deliveryStep).toContain('TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}');
    expect(deliveryStep).toContain('TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}');
  });

  it('does not retain the main-only standalone Demo and Docs workflow', () => {
    expect(existsSync(path.join(workflowDir, 'demo-docs-check.yml'))).toBe(false);
  });

  it('keeps the Manager Server image build on the pinned Bun-only toolchain', () => {
    expect(managerServerDockerfile).toContain('oven/bun:1.3.14-alpine');
    expect(managerServerDockerfile).toContain('COPY package.json bun.lock ./');
    expect(managerServerDockerfile).toContain('bun install --frozen-lockfile');
    expect(managerServerDockerfile).toContain('VERSION=$VERSION bun run --cwd apps/web build');
    expect(managerServerDockerfile).not.toMatch(/\bnpm\b|\bnpx\b|\bpnpm\b|\byarn\b/);
    expect(managerServerDockerfile).not.toContain('package*.json');
  });

  it('keeps GitHub Actions dependency updates on the integration branch', () => {
    expect(dependabotConfig).toContain('package-ecosystem: github-actions');
    expect(dependabotConfig).toContain('target-branch: dev');
    expect(dependabotConfig).toContain('interval: weekly');
  });
});
