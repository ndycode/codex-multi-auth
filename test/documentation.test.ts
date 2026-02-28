import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
  'docs/reference/settings.md',
  'docs/reference/storage-paths.md',
  'docs/releases/v0.1.1.md',
  'docs/releases/v0.1.0.md',
  'docs/releases/v0.1.0-beta.0.md',
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

describe('Documentation Integrity', () => {
  it('has all required user docs and release notes', () => {
    for (const docPath of userDocs) {
      const fullPath = join(projectRoot, docPath);
      expect(existsSync(fullPath), `${docPath} should exist`).toBe(true);
      expect(read(docPath).trim().length, `${docPath} should not be empty`).toBeGreaterThan(
        0,
      );
    }
  });

  it('docs portal links to stable release notes and archived beta notes', () => {
    const portal = read('docs/README.md');
    expect(portal).toContain('releases/v0.1.1.md');
    expect(portal).toContain('releases/v0.1.0.md');
    expect(portal).toContain('releases/v0.1.0-beta.0.md');

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
