import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8');
const marker = (...parts) => parts.join('');

const forbiddenMarkers = [
  marker('APIKEY', '.FUN'),
  marker('apikey', '.fun'),
  marker('APIKEY', '_FUN'),
  marker('apikey', 'Fun'),
  marker('aff=', 'AKCPA'),
];

describe('maintained lightweight variant', () => {
  it('pins the exact stable upstream baseline and variant revision', () => {
    const manifest = JSON.parse(read('maintained', 'manifest.json'));
    expect(manifest).toEqual({
      upstream: {
        repository: 'https://github.com/seakee/CPA-Manager-Plus.git',
        tag: 'v1.11.12',
        commit: '68b57da8c206c023120a3e7597e5d729eac2760f',
      },
      revision: 1,
      variant: 'lightweight-plugin-lockdown-local-tools',
    });
  });

  it('provides a fail-closed repeatable maintained build script', () => {
    const scriptPath = path.join(repoRoot, 'scripts', 'build-maintained-lightweight.sh');
    const script = read('scripts', 'build-maintained-lightweight.sh');
    expect(existsSync(scriptPath)).toBe(true);
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('git merge-base HEAD');
    expect(script).toContain('npm run type-check');
    expect(script).toContain('npm run lint');
    expect(script).toContain('npm run test');
    expect(script).toContain('npm run build');
    expect(script).toContain('output-maintained');
    expect(script).toContain('management.html');
    expect(script).toContain('SHA256SUMS');
    expect(script).toContain('metadata.json');
    expect(script).not.toMatch(/rm\s+-rf\s+(?:\.\/)?(?:apps|src|maintained|scripts)\b/);
  });

  it('keeps plugin fields behind the server capability without changing YAML semantics', () => {
    const editor = read('apps', 'web', 'src', 'components', 'config', 'VisualConfigEditor.tsx');
    const configPage = read('apps', 'web', 'src', 'features', 'config', 'ConfigPage.tsx');
    const yamlHook = read('apps', 'web', 'src', 'hooks', 'useVisualConfig.ts');
    expect(configPage).toContain('supportsPlugin={supportsPlugin}');
    expect(editor).toContain('shouldShowPluginVisualConfig(supportsPlugin)');
    expect(editor).toContain('plugins_enabled');
    expect(editor).toContain('plugins_dir');
    expect(editor).toContain('plugin_store_sources');
    expect(editor).toContain('plugin_store_auth');
    expect(yamlHook).toContain("const plugins = asRecord(parsed.plugins)");
    expect(yamlHook).toContain("shouldWritePluginsEnabled = isDirty('pluginsEnabled')");
  });

  it('contains no commercial markers in production source inputs', () => {
    const productionInputs = [
      read('apps', 'web', 'src', 'router', 'MainRoutes.tsx'),
      read('apps', 'web', 'src', 'components', 'layout', 'MainLayout.tsx'),
      read('apps', 'web', 'src', 'features', 'tools', 'cpaSub2api', 'CpaSub2apiToolPage.tsx'),
      read('apps', 'web', 'src', 'features', 'tools', 'cpaSub2api', 'converter.mjs'),
    ].join('\n');
    for (const forbidden of forbiddenMarkers) {
      expect(productionInputs).not.toContain(forbidden);
    }
  });

  it('does not import the deprecated embedded documentation blob', () => {
    expect(existsSync(path.join(repoRoot, 'apps', 'web', 'src', 'embeddedDocs.generated.ts'))).toBe(
      false
    );
    expect(read('tests', 'cpaSub2apiIntegration.test.ts')).not.toContain(
      'embeddedDocs.generated.ts'
    );
  });
});
