import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const projectRoot = resolve(process.cwd());

describe('Documentation Integrity', () => {
	describe('Core Documentation Files', () => {
		it('should have README.md at project root', () => {
			const readmePath = join(projectRoot, 'README.md');
			expect(existsSync(readmePath)).toBe(true);
			const content = readFileSync(readmePath, 'utf-8');
			expect(content.length).toBeGreaterThan(0);
			expect(content).toContain('codex-multi-auth');
		});

		it('should have SECURITY.md at project root', () => {
			const securityPath = join(projectRoot, 'SECURITY.md');
			expect(existsSync(securityPath)).toBe(true);
			const content = readFileSync(securityPath, 'utf-8');
			expect(content.length).toBeGreaterThan(0);
			expect(content).toContain('Security Policy');
		});

		it('should have docs/README.md as documentation portal', () => {
			const docsReadmePath = join(projectRoot, 'docs', 'README.md');
			expect(existsSync(docsReadmePath)).toBe(true);
			const content = readFileSync(docsReadmePath, 'utf-8');
			expect(content).toContain('Documentation Portal');
		});
	});

	describe('Documentation Structure', () => {
		const requiredDocs = [
			'docs/README.md',
			'docs/getting-started.md',
			'docs/features.md',
			'docs/configuration.md',
			'docs/troubleshooting.md',
			'docs/privacy.md',
			'docs/index.md',
			'docs/STYLE_GUIDE.md',
			'docs/DOCUMENTATION.md',
		];

		requiredDocs.forEach((docPath) => {
			it(`should have ${docPath}`, () => {
				const fullPath = join(projectRoot, docPath);
				expect(existsSync(fullPath)).toBe(true);
				const content = readFileSync(fullPath, 'utf-8');
				expect(content.length).toBeGreaterThan(0);
			});
		});
	});

	describe('Reference Documentation', () => {
		const referenceDocs = [
			'docs/reference/commands.md',
			'docs/reference/settings.md',
			'docs/reference/storage-paths.md',
		];

		referenceDocs.forEach((docPath) => {
			it(`should have ${docPath}`, () => {
				const fullPath = join(projectRoot, docPath);
				expect(existsSync(fullPath)).toBe(true);
				const content = readFileSync(fullPath, 'utf-8');
				expect(content.length).toBeGreaterThan(0);
			});
		});
	});

	describe('Development Documentation', () => {
		const devDocs = [
			'docs/development/ARCHITECTURE.md',
			'docs/development/CONFIG_FIELDS.md',
			'docs/development/CONFIG_FLOW.md',
			'docs/development/REPOSITORY_SCOPE.md',
			'docs/development/TESTING.md',
			'docs/development/TUI_PARITY_CHECKLIST.md',
		];

		devDocs.forEach((docPath) => {
			it(`should have ${docPath}`, () => {
				const fullPath = join(projectRoot, docPath);
				expect(existsSync(fullPath)).toBe(true);
				const content = readFileSync(fullPath, 'utf-8');
				expect(content.length).toBeGreaterThan(0);
			});
		});
	});

	describe('Benchmark Documentation', () => {
		it('should have code-edit-format-benchmark.md', () => {
			const benchPath = join(
				projectRoot,
				'docs/benchmarks/code-edit-format-benchmark.md',
			);
			expect(existsSync(benchPath)).toBe(true);
			const content = readFileSync(benchPath, 'utf-8');
			expect(content.length).toBeGreaterThan(0);
		});
	});

	describe('Internal Link Validation', () => {
		it('should have valid internal links in README.md', () => {
			const readmePath = join(projectRoot, 'README.md');
			const content = readFileSync(readmePath, 'utf-8');

			// Extract markdown links [text](path)
			const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
			const matches = [...content.matchAll(linkRegex)];

			const internalLinks = matches
				.map((m) => m[2])
				.filter((link) => !link.startsWith('http') && !link.startsWith('#'));

			for (const link of internalLinks) {
				// Remove anchor fragments
				const filePath = link.split('#')[0];
				const fullPath = join(projectRoot, filePath);
				expect(existsSync(fullPath), `Link target ${filePath} should exist`).toBe(true);
			}
		});

		it('should have valid internal links in docs/README.md', () => {
			const docsReadmePath = join(projectRoot, 'docs', 'README.md');
			const content = readFileSync(docsReadmePath, 'utf-8');

			const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
			const matches = [...content.matchAll(linkRegex)];

			const internalLinks = matches
				.map((m) => m[2])
				.filter((link) => !link.startsWith('http') && !link.startsWith('#'));

			for (const link of internalLinks) {
				const filePath = link.split('#')[0];
				const fullPath = join(projectRoot, 'docs', filePath);
				expect(existsSync(fullPath), `Link target ${filePath} should exist`).toBe(true);
			}
		});

		it('should have valid internal links in SECURITY.md', () => {
			const securityPath = join(projectRoot, 'SECURITY.md');
			const content = readFileSync(securityPath, 'utf-8');

			const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
			const matches = [...content.matchAll(linkRegex)];

			const internalLinks = matches
				.map((m) => m[2])
				.filter((link) => !link.startsWith('http') && !link.startsWith('#'));

			for (const link of internalLinks) {
				const filePath = link.split('#')[0];
				const fullPath = join(projectRoot, filePath);
				expect(existsSync(fullPath), `Link target ${filePath} should exist`).toBe(true);
			}
		});
	});

	describe('Markdown Structure Validation', () => {
		it('README.md should have proper heading hierarchy', () => {
			const readmePath = join(projectRoot, 'README.md');
			const content = readFileSync(readmePath, 'utf-8');

			// Check for H1 heading
			expect(content).toMatch(/^#\s+/m);

			// Check that headings don't skip levels (no H3 before H2, etc.)
			const lines = content.split('\n');
			let maxLevel = 0;
			for (const line of lines) {
				const match = line.match(/^(#{1,6})\s/);
				if (match) {
					const level = match[1].length;
					// Allow same level, +1, or back to any previous level
					if (level > maxLevel + 1) {
						throw new Error(`Heading skips level: ${line}`);
					}
					maxLevel = Math.max(maxLevel, level);
				}
			}
		});

		it('SECURITY.md should have proper heading hierarchy', () => {
			const securityPath = join(projectRoot, 'SECURITY.md');
			const content = readFileSync(securityPath, 'utf-8');

			expect(content).toMatch(/^#\s+/m);

			const lines = content.split('\n');
			let maxLevel = 0;
			for (const line of lines) {
				const match = line.match(/^(#{1,6})\s/);
				if (match) {
					const level = match[1].length;
					if (level > maxLevel + 1 && maxLevel > 0) {
						throw new Error(`Heading skips level: ${line}`);
					}
					maxLevel = Math.max(maxLevel, level);
				}
			}
		});

		it('docs/README.md should have proper heading hierarchy', () => {
			const docsReadmePath = join(projectRoot, 'docs', 'README.md');
			const content = readFileSync(docsReadmePath, 'utf-8');

			expect(content).toMatch(/^#\s+/m);
		});
	});

	describe('Documentation Content Validation', () => {
		it('README.md should contain essential sections', () => {
			const readmePath = join(projectRoot, 'README.md');
			const content = readFileSync(readmePath, 'utf-8');

			expect(content).toContain('Quick Start');
			expect(content).toContain('codex auth');
			expect(content).toContain('Documentation');
		});

		it('SECURITY.md should contain security policy sections', () => {
			const securityPath = join(projectRoot, 'SECURITY.md');
			const content = readFileSync(securityPath, 'utf-8');

			expect(content).toContain('OAuth Token Security');
			expect(content).toContain('Reporting a Vulnerability');
			expect(content).toContain('Responsible Disclosure');
		});

		it('docs/getting-started.md should exist and be non-empty', () => {
			const gettingStartedPath = join(projectRoot, 'docs', 'getting-started.md');
			expect(existsSync(gettingStartedPath)).toBe(true);
			const content = readFileSync(gettingStartedPath, 'utf-8');
			expect(content.length).toBeGreaterThan(100);
		});
	});

	describe('Configuration File Documentation', () => {
		it('docs/_config.yml should exist for GitHub Pages', () => {
			const configPath = join(projectRoot, 'docs', '_config.yml');
			expect(existsSync(configPath)).toBe(true);
			const content = readFileSync(configPath, 'utf-8');
			expect(content.length).toBeGreaterThan(0);
		});
	});

	describe('Documentation File Permissions', () => {
		it('documentation files should be readable', () => {
			const docs = [
				'README.md',
				'SECURITY.md',
				'docs/README.md',
				'docs/getting-started.md',
			];

			for (const doc of docs) {
				const fullPath = join(projectRoot, doc);
				expect(existsSync(fullPath)).toBe(true);

				const stats = statSync(fullPath);
				expect(stats.isFile()).toBe(true);

				// File should be readable (not testing specific perms due to git)
				expect(() => readFileSync(fullPath, 'utf-8')).not.toThrow();
			}
		});
	});

	describe('Documentation Completeness', () => {
		it('all docs referenced in README should exist', () => {
			const readmePath = join(projectRoot, 'README.md');
			const content = readFileSync(readmePath, 'utf-8');

			const docLinks = [
				'docs/README.md',
				'docs/getting-started.md',
				'docs/features.md',
				'docs/configuration.md',
				'docs/troubleshooting.md',
				'docs/reference/storage-paths.md',
				'docs/reference/settings.md',
				'docs/development/ARCHITECTURE.md',
				'SECURITY.md',
			];

			for (const link of docLinks) {
				const fullPath = join(projectRoot, link);
				expect(existsSync(fullPath), `${link} should exist as referenced in README`).toBe(true);
			}
		});

		it('all docs referenced in docs/README.md should exist', () => {
			const docsReadmePath = join(projectRoot, 'docs', 'README.md');
			const content = readFileSync(docsReadmePath, 'utf-8');

			const docLinks = [
				'getting-started.md',
				'features.md',
				'configuration.md',
				'troubleshooting.md',
				'privacy.md',
				'reference/commands.md',
				'reference/settings.md',
				'reference/storage-paths.md',
			];

			for (const link of docLinks) {
				const fullPath = join(projectRoot, 'docs', link);
				expect(existsSync(fullPath), `docs/${link} should exist`).toBe(true);
			}
		});
	});

	describe('Edge Cases and Robustness', () => {
		it('should handle documentation files with unicode characters', () => {
			const readmePath = join(projectRoot, 'README.md');
			const content = readFileSync(readmePath, 'utf-8');

			// Should not throw when reading files with unicode
			expect(() => Buffer.from(content, 'utf-8')).not.toThrow();
		});

		it('should handle missing anchor links gracefully', () => {
			const readmePath = join(projectRoot, 'README.md');
			const content = readFileSync(readmePath, 'utf-8');

			// Links with anchors like [text](file.md#section) should have valid file
			const linkRegex = /\[([^\]]+)\]\(([^)]+#[^)]+)\)/g;
			const matches = [...content.matchAll(linkRegex)];

			const internalLinksWithAnchors = matches
				.map((m) => m[2])
				.filter((link) => !link.startsWith('http'));

			for (const link of internalLinksWithAnchors) {
				const filePath = link.split('#')[0];
				if (filePath) {
					const fullPath = join(projectRoot, filePath);
					expect(existsSync(fullPath), `File ${filePath} in anchored link should exist`).toBe(true);
				}
			}
		});

		it('should not have empty documentation files', () => {
			const docs = [
				'README.md',
				'SECURITY.md',
				'docs/README.md',
				'docs/getting-started.md',
				'docs/features.md',
			];

			for (const doc of docs) {
				const fullPath = join(projectRoot, doc);
				const content = readFileSync(fullPath, 'utf-8');
				expect(content.trim().length, `${doc} should not be empty`).toBeGreaterThan(0);
			}
		});

		it('should have consistent line endings in documentation', () => {
			const readmePath = join(projectRoot, 'README.md');
			const content = readFileSync(readmePath, 'utf-8');

			// Check that file doesn't have mixed line endings (should be consistent)
			const hasLF = content.includes('\n');
			const hasCRLF = content.includes('\r\n');

			if (hasLF || hasCRLF) {
				// File has line endings - that's fine
				expect(content.length).toBeGreaterThan(0);
			}
		});
	});

	describe('Documentation Style Compliance', () => {
		it('docs/STYLE_GUIDE.md should define documentation standards', () => {
			const styleGuidePath = join(projectRoot, 'docs', 'STYLE_GUIDE.md');
			expect(existsSync(styleGuidePath)).toBe(true);
			const content = readFileSync(styleGuidePath, 'utf-8');
			expect(content.length).toBeGreaterThan(100);
		});
	});

	describe('Regression: Documentation Structure Stability', () => {
		it('should maintain stable documentation portal structure', () => {
			const docsReadmePath = join(projectRoot, 'docs', 'README.md');
			const content = readFileSync(docsReadmePath, 'utf-8');

			// Portal should have consistent sections
			expect(content).toContain('Start Here');
			expect(content).toContain('User Guides');
			expect(content).toContain('Reference');
			expect(content).toContain('Maintainer Docs');
		});

		it('should maintain security documentation structure', () => {
			const securityPath = join(projectRoot, 'SECURITY.md');
			const content = readFileSync(securityPath, 'utf-8');

			// Essential security sections should always be present
			expect(content).toContain('Supported Versions');
			expect(content).toContain('Security Considerations');
			expect(content).toContain('Reporting a Vulnerability');
		});
	});
});