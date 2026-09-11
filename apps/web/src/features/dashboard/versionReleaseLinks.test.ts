import { describe, expect, it } from 'vitest';
import {
  buildDashboardVersionReleaseURL,
  normalizeDashboardReleaseTag,
} from './versionReleaseLinks';

describe('dashboard version release links', () => {
  it('builds the Manager release URL from a tagged version', () => {
    expect(buildDashboardVersionReleaseURL('manager', 'v1.12.0')).toBe(
      'https://github.com/86669666/cpamp-maintained/releases/tag/v1.12.0'
    );
  });

  it('builds the CLIProxyAPI release URL and adds a missing v prefix', () => {
    expect(buildDashboardVersionReleaseURL('core', '7.2.130')).toBe(
      'https://github.com/86669666/CLIProxyAPI-plugin-lockdown/releases/tag/v7.2.130'
    );
  });

  it('preserves valid prerelease identifiers while normalizing the v prefix', () => {
    expect(normalizeDashboardReleaseTag(' V1.12.0-rc.1 ')).toBe('v1.12.0-rc.1');
    expect(normalizeDashboardReleaseTag('1.12.0-beta3')).toBe('v1.12.0-beta3');
  });

  it.each([
    '',
    'dev',
    'unknown',
    'v1.12',
    'v01.2.3',
    'v1.2.3+build.1',
    'v1.2.3-5-gabcdef',
    'release/v1.2.3',
  ])('does not link non-release version %j', (version) => {
    expect(normalizeDashboardReleaseTag(version)).toBe('');
    expect(buildDashboardVersionReleaseURL('manager', version)).toBe('');
  });
});
