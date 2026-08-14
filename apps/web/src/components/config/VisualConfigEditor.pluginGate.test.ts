import { describe, expect, it } from 'vitest';
import { shouldShowPluginVisualConfig } from './pluginVisualConfigGate';

describe('visual plugin configuration capability gate', () => {
  it('hides every plugin visual field when the server disables plugin support', () => {
    expect(shouldShowPluginVisualConfig(false)).toBe(false);
  });

  it('shows plugin visual fields when the server advertises plugin support', () => {
    expect(shouldShowPluginVisualConfig(true)).toBe(true);
  });
});
