import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(process.cwd());

const userDocs = [
  'docs/index.md',
  'docs/README.md',
  'docs/getting-started.md',
  'docs/features.md',
  'docs/configuration.md',
  'docs/troubleshooting.md',
  'docs/privacy.md',
  'docs/upgrade.md',
  'docs/reference/commands.md',
  'docs/reference/public-api.md',
  'docs/reference/error-contracts.md',
  'docs/reference/settings.md',
  'docs/reference/storage-paths.md',
  'docs/releases/v0.1.1.md',
  'docs/releases/v0.1.0.md',
  'docs/releases/v0.1.0-beta.0.md',
  'docs/releases/legacy-pre-0.1-history.md',
];

const scopedLegacyAllowedFiles = new Set([
  'README.md',
  'docs/getting-started.md',
  'docs/troubleshooting.md',
  'docs/upgrade.md',
  'docs/releases/v0.1.0.md',
  'docs/releases/v0.1.0-beta.0.md',
]);

function read(filePath: string): string {
  return readFileSync(join(projectRoot, filePath), 'utf-8');
}

function extractInternalLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((link) => !link.startsWith('http') && !link.startsWith('#'));
}

function compareSemverDescending(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10));
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }
  return 0;
}

describe('Documentation Integrity', () => {
  it('has all required user docs and release notes', () => {
    for (const docPath of userDocs) {
      const fullPath = join(projectRoot, docPath);
      expect(existsSync(fullPath), `${docPath} should exist`).toBe(true);
      expect(read(docPath).trim().length, `${docPath} should not be empty`).toBeGreaterThan(0);
    }
  });

  it('docs portal links to stable, beta, and archived release history', () => {
    const portal = read('docs/README.md');
    expect(portal).toContain('reference/public-api.md');
    expect(portal).toContain('reference/error-contracts.md');
    expect(portal).toContain('releases/v0.1.1.md');
    expect(portal).toContain('releases/v0.1.0.md');
    expect(portal).toContain('releases/v0.1.0-beta.0.md');
    expect(portal).toContain('releases/legacy-pre-0.1-history.md');

    const beta = read('docs/releases/v0.1.0-beta.0.md');
    expect(beta).toContain('Archived');
    expect(beta).toContain('superseded by [v0.1.0]');
  });

  it('uses codex-multi-auth as canonical package name', () => {
    const canonicalPackageDocs = [
      'README.md',
      'docs/index.md',
      'docs/getting-started.md',
      'docs/troubleshooting.md',
      'docs/upgrade.md',
      'docs/releases/v0.1.1.md',
      'docs/releases/v0.1.0.md',
    ];

    for (const filePath of canonicalPackageDocs) {
      const content = read(filePath);
      expect(content).toContain('codex-multi-auth');
    }
  });

  it('uses scoped package only in explicit legacy migration notes', () => {
    const files = ['README.md', ...userDocs];

    for (const filePath of files) {
      const content = read(filePath);
      const hasScopedLegacyPackage = content.includes('@ndycode/codex-multi-auth');
      if (hasScopedLegacyPackage) {
        expect(
          scopedLegacyAllowedFiles.has(filePath),
          `${filePath} should not mention @ndycode/codex-multi-auth`,
        ).toBe(true);
      }
    }
  });

  it('does not include opencode wording in user docs', () => {
    for (const filePath of userDocs) {
      const content = read(filePath).toLowerCase();
      const hasLegacyHostWord = content.includes('opencode');
      expect(hasLegacyHostWord, `${filePath} should not include opencode references`).toBe(false);
    }
  });

  it('keeps codex auth as the command standard in key docs', () => {
    const keyDocs = [
      'README.md',
      'docs/index.md',
      'docs/getting-started.md',
      'docs/reference/commands.md',
      'docs/troubleshooting.md',
      'docs/upgrade.md',
    ];

    for (const filePath of keyDocs) {
      expect(read(filePath), `${filePath} must include codex auth command examples`).toContain(
        'codex auth',
      );
    }
  });

  it('documents public API stability tiers and error contracts', () => {
    const publicApi = read('docs/reference/public-api.md').toLowerCase();
    const errorContracts = read('docs/reference/error-contracts.md').toLowerCase();

    expect(publicApi).toContain('tier a');
    expect(publicApi).toContain('tier b');
    expect(publicApi).toContain('tier c');
    expect(publicApi).toContain('options-object');
    expect(publicApi).toContain('semver');

    expect(errorContracts).toContain('exit codes');
    expect(errorContracts).toContain('json mode contract');
    expect(errorContracts).toContain('entitlement');
    expect(errorContracts).toContain('rate-limit');
  });

  it('keeps fix command flag docs aligned across README, reference, and CLI usage text', () => {
    const readme = read('README.md');
    const commandRef = read('docs/reference/commands.md');
    const managerPath = 'lib/codex-manager.ts';
    expect(existsSync(join(projectRoot, managerPath)), `${managerPath} should exist`).toBe(true);
    const manager = read(managerPath);

    expect(readme).toContain('codex auth fix --live --model gpt-5-codex');
    expect(commandRef).toContain('| `--live` | forecast, report, fix |');
    expect(commandRef).toContain('| `--model <model>` | forecast, report, fix |');
    expect(manager).toContain('codex-multi-auth auth fix [--dry-run] [--json] [--live] [--model <model>]');
  });

  it('documents stable overrides separately from advanced and internal overrides', () => {
    const configGuide = read('docs/configuration.md').toLowerCase();
    const settingsRef = read('docs/reference/settings.md').toLowerCase();
    const fieldInventoryPath = 'docs/development/CONFIG_FIELDS.md';
    expect(existsSync(join(projectRoot, fieldInventoryPath)), `${fieldInventoryPath} should exist`).toBe(
      true,
    );
    const fieldInventory = read(fieldInventoryPath).toLowerCase();

    expect(configGuide).toContain('stable environment overrides');
    expect(configGuide).toContain('advanced and internal overrides');
    expect(settingsRef).toContain('stable environment overrides');
    expect(settingsRef).toContain('advanced and internal overrides');

    expect(fieldInventory).toContain('concurrency and windows notes');
    expect(fieldInventory).toContain('eperm');
    expect(fieldInventory).toContain('ebusy');
    expect(fieldInventory).toContain('cross-process refresh');
    expect(fieldInventory).toContain('tokenrefreshskewms');
  });

  it('keeps changelog aligned with canonical 0.x release policy', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toContain('## [0.1.0] - 2026-02-27');
    expect(changelog).toContain('docs/releases/legacy-pre-0.1-history.md');
    expect(changelog).not.toContain('## [5.');
    expect(changelog).not.toContain('## [4.');
  });

  it('keeps legacy pre-0.1 archive headings in descending semver order', () => {
    const archive = read('docs/releases/legacy-pre-0.1-history.md');
    const versions = [...archive.matchAll(/^## \[(\d+\.\d+\.\d+)\] - /gm)].map((match) => match[1]);
    expect(versions.length).toBeGreaterThan(0);

    for (let index = 1; index < versions.length; index += 1) {
      const previous = versions[index - 1];
      const current = versions[index];
      const comparison = compareSemverDescending(previous, current);
      if (comparison <= 0) {
        throw new Error(
          `Release heading order must be strictly descending semver, but found ${previous} before ${current}.`,
        );
      }
    }
  });

  it('keeps CODEX_MULTI_AUTH_CONFIG_PATH fallback and env override precedence aligned with docs', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'codex-doc-config-'));
    const fallbackConfigPath = join(tempRoot, 'fallback-config.json');

    try {
      writeFileSync(
        fallbackConfigPath,
        `${JSON.stringify({ codexMode: false, toastDurationMs: 7777 }, null, 2)}\n`,
        'utf-8',
      );
      const script = [
        "import { loadPluginConfig, getCodexMode } from './dist/lib/config.js';",
        'const loaded = loadPluginConfig();',
        "process.stdout.write(JSON.stringify({ raw: loaded.codexMode, resolved: getCodexMode(loaded) }));",
      ].join('\n');
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CODEX_MULTI_AUTH_DIR: tempRoot,
          CODEX_MULTI_AUTH_CONFIG_PATH: fallbackConfigPath,
          CODEX_MODE: '1',
          HOME: tempRoot,
          USERPROFILE: tempRoot,
        },
        encoding: 'utf-8',
      });
      const parsed = JSON.parse(output) as { raw: boolean; resolved: boolean };
      expect(parsed.raw).toBe(false);
      expect(parsed.resolved).toBe(true);

      const configFlow = read('docs/development/CONFIG_FLOW.md');
      const configGuide = read('docs/configuration.md');
      expect(configFlow).toContain('Fallback file from `CODEX_MULTI_AUTH_CONFIG_PATH`');
      expect(configFlow).toContain('After source selection, environment variables apply per-setting overrides.');
      expect(configGuide).toContain('CODEX_MULTI_AUTH_CONFIG_PATH');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps governance templates and security reporting guidance present', () => {
    const prTemplate = '.github/pull_request_template.md';
    const issueConfig = '.github/ISSUE_TEMPLATE/config.yml';
    const bugTemplate = '.github/ISSUE_TEMPLATE/bug_report.md';
    const featureTemplate = '.github/ISSUE_TEMPLATE/feature_request.md';

    expect(existsSync(join(projectRoot, prTemplate)), `${prTemplate} should exist`).toBe(true);
    expect(existsSync(join(projectRoot, issueConfig)), `${issueConfig} should exist`).toBe(true);
    expect(existsSync(join(projectRoot, bugTemplate)), `${bugTemplate} should exist`).toBe(true);
    expect(existsSync(join(projectRoot, featureTemplate)), `${featureTemplate} should exist`).toBe(true);

    const prBody = read(prTemplate);
    expect(prBody).toContain('npm run lint');
    expect(prBody).toContain('npm run typecheck');
    expect(prBody).toContain('npm test');
    expect(prBody).toContain('npm test -- test/documentation.test.ts');
    expect(prBody).toContain('npm run build');

    const security = read('SECURITY.md').toLowerCase();
    expect(security).toContain('do not open a public issue');
    expect(security).toContain('enable_plugin_request_logging=1');
    expect(security).toContain('codex_plugin_log_bodies=1');

    const contributing = read('CONTRIBUTING.md').toLowerCase();
    expect(contributing).toContain('pull request process');
    expect(contributing).toContain('npm run typecheck');
    expect(contributing).toContain('npm run lint');
    expect(contributing).toContain('npm test');
    expect(contributing).toContain('npm run build');
  });

  it('has valid internal links in README.md', () => {
    const content = read('README.md');
    const links = extractInternalLinks(content);

    for (const link of links) {
      const cleanPath = link.split('#')[0];
      if (!cleanPath) {
        continue;
      }
      expect(existsSync(join(projectRoot, cleanPath)), `Missing link target: ${cleanPath}`).toBe(
        true,
      );
    }
  });

  it('has valid internal links in docs/README.md', () => {
    const content = read('docs/README.md');
    const links = extractInternalLinks(content);

    for (const link of links) {
      const cleanPath = link.split('#')[0];
      if (!cleanPath) {
        continue;
      }
      expect(existsSync(join(projectRoot, 'docs', cleanPath)), `Missing docs link: ${cleanPath}`).toBe(
        true,
      );
    }
  });
});
