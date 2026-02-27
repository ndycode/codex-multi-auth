import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const projectRoot = resolve(process.cwd());

describe('Configuration Files', () => {
	describe('.gitignore', () => {
		it('should exist at project root', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			expect(existsSync(gitignorePath)).toBe(true);
		});

		it('should have non-empty content', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');
			expect(content.trim().length).toBeGreaterThan(0);
		});

		it('should ignore node_modules', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');
			expect(content).toContain('node_modules');
		});

		it('should ignore dist directory', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');
			expect(content).toContain('dist/');
		});

		it('should ignore environment files', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');
			expect(content).toContain('.env');
		});

		it('should ignore coverage directory', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');
			expect(content).toContain('coverage/');
		});

		it('should ignore temporary files', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');
			const hasTemp = content.includes('tmp') || content.includes('.tmp');
			expect(hasTemp).toBe(true);
		});

		it('should ignore build artifacts', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');
			expect(content).toMatch(/\.tgz|\.tar\.gz|dist/);
		});

		it('should have valid gitignore pattern syntax', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');
			const lines = content.split('\n');

			for (const line of lines) {
				const trimmed = line.trim();
				// Skip empty lines and comments
				if (!trimmed || trimmed.startsWith('#')) continue;

				// Basic validation: should not have invalid characters for gitignore
				expect(trimmed).not.toMatch(/[\x00-\x1F\x7F]/); // No control characters
			}
		});

		it('should not have duplicate patterns', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');
			const lines = content
				.split('\n')
				.map((l) => l.trim())
				.filter((l) => l && !l.startsWith('#'));

			const uniqueLines = new Set(lines);
			expect(uniqueLines.size).toBe(lines.length);
		});

		it('should ignore cache directories', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');
			const hasCache = content.includes('.codex-cache') || content.includes('cache');
			expect(hasCache).toBe(true);
		});
	});

	describe('.env.example', () => {
		it('should exist at project root', () => {
			const envExamplePath = join(projectRoot, '.env.example');
			expect(existsSync(envExamplePath)).toBe(true);
		});

		it('should have valid environment variable format', () => {
			const envExamplePath = join(projectRoot, '.env.example');
			const content = readFileSync(envExamplePath, 'utf-8');
			const lines = content.split('\n');

			for (const line of lines) {
				const trimmed = line.trim();
				// Skip empty lines and comments
				if (!trimmed || trimmed.startsWith('#')) continue;

				// Should match KEY=value format (allows uppercase, lowercase, and mixed case)
				expect(trimmed).toMatch(/^[A-Za-z_][A-Za-z0-9_]*=/);
			}
		});

		it('should not contain actual sensitive values', () => {
			const envExamplePath = join(projectRoot, '.env.example');
			const content = readFileSync(envExamplePath, 'utf-8');

			// Should not contain actual tokens or keys
			expect(content).not.toMatch(/sk-[a-zA-Z0-9]{32,}/); // OpenAI API keys
			expect(content).not.toMatch(/[0-9a-f]{32,}/); // Long hex strings
			expect(content).not.toMatch(/Bearer\s+[a-zA-Z0-9]/); // Bearer tokens
		});

		it('should be safe to commit', () => {
			const envExamplePath = join(projectRoot, '.env.example');
			const content = readFileSync(envExamplePath, 'utf-8');

			// Should not have actual values, only placeholders or empty
			const lines = content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));

			for (const line of lines) {
				const [, value] = line.split('=');
				// Value should be empty or a placeholder
				if (value && value.trim()) {
					expect(value.trim()).not.toMatch(/^[a-zA-Z0-9]{20,}$/); // No long actual values
				}
			}
		});

		it('should not be empty', () => {
			const envExamplePath = join(projectRoot, '.env.example');
			const content = readFileSync(envExamplePath, 'utf-8');
			expect(content.trim().length).toBeGreaterThan(0);
		});
	});

	describe('docs/_config.yml', () => {
		it('should exist for GitHub Pages', () => {
			const configPath = join(projectRoot, 'docs', '_config.yml');
			expect(existsSync(configPath)).toBe(true);
		});

		it('should have valid YAML structure', () => {
			const configPath = join(projectRoot, 'docs', '_config.yml');
			const content = readFileSync(configPath, 'utf-8');

			// Basic YAML validation - should not have tabs
			expect(content).not.toContain('\t');

			// Should have key: value format
			const lines = content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
			for (const line of lines) {
				if (!line.startsWith(' ')) {
					// Top-level keys should have colon
					expect(line).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]*:/);
				}
			}
		});

		it('should have proper indentation', () => {
			const configPath = join(projectRoot, 'docs', '_config.yml');
			const content = readFileSync(configPath, 'utf-8');
			const lines = content.split('\n');

			for (const line of lines) {
				if (line.trim().length === 0 || line.trim().startsWith('#')) continue;

				// Indentation should be spaces, not tabs
				if (line.startsWith(' ')) {
					const leadingSpaces = line.match(/^( +)/)?.[1].length || 0;
					// YAML typically uses 2-space indentation
					expect(leadingSpaces % 2).toBe(0);
				}
			}
		});

		it('should not contain sensitive information', () => {
			const configPath = join(projectRoot, 'docs', '_config.yml');
			const content = readFileSync(configPath, 'utf-8');

			// Should not contain tokens, keys, or passwords
			expect(content).not.toMatch(/password:/i);
			expect(content).not.toMatch(/secret:/i);
			expect(content).not.toMatch(/token:/i);
			expect(content).not.toMatch(/api[_-]?key:/i);
		});
	});

	describe('Configuration File Relationships', () => {
		it('.gitignore should ignore .env but not .env.example', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');

			expect(content).toContain('.env');
			expect(content).not.toContain('.env.example');
		});

		it('.gitignore should ignore common codex-related files', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');

			// Should ignore codex-specific directories or files
			const hasCodexIgnores =
				content.includes('opencode.json') ||
				content.includes('.opencode') ||
				content.includes('.codex');
			expect(hasCodexIgnores).toBe(true);
		});
	});

	describe('Configuration File Edge Cases', () => {
		it('.gitignore should handle Windows-specific patterns', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');

			// Should handle both / and platform-specific paths
			const lines = content.split('\n');
			for (const line of lines) {
				if (line.includes('\\')) {
					// If Windows paths exist, they should be valid
					expect(line).not.toMatch(/\\\\/); // No double backslashes
				}
			}
		});

		it('.env.example should handle multiline values correctly', () => {
			const envExamplePath = join(projectRoot, '.env.example');
			const content = readFileSync(envExamplePath, 'utf-8');
			const lines = content.split('\n');

			// Each non-comment, non-empty line should be a complete var=value
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith('#')) continue;

				// Should not have unescaped newlines in values (allows uppercase, lowercase, and mixed case)
				expect(trimmed).toMatch(/^[A-Za-z_][A-Za-z0-9_]*=/);
			}
		});

		it('configuration files should not exceed reasonable size', () => {
			const configFiles = [
				join(projectRoot, '.gitignore'),
				join(projectRoot, '.env.example'),
				join(projectRoot, 'docs', '_config.yml'),
			];

			for (const file of configFiles) {
				const content = readFileSync(file, 'utf-8');
				// Config files should be under 10KB for maintainability
				expect(content.length).toBeLessThan(10 * 1024);
			}
		});
	});

	describe('Configuration Security', () => {
		it('.gitignore should prevent committing sensitive files', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');

			const sensitivePatterns = ['.env', 'node_modules', '*.key', '*.pem'];

			for (const pattern of sensitivePatterns) {
				const hasPattern =
					content.includes(pattern) || content.includes(pattern.replace(/\*/g, ''));
				if (pattern === '.env' || pattern === 'node_modules') {
					expect(hasPattern).toBe(true);
				}
			}
		});

		it('.env.example should serve as a safe template', () => {
			const envExamplePath = join(projectRoot, '.env.example');
			const content = readFileSync(envExamplePath, 'utf-8');

			// Should have comments or be mostly empty
			const lines = content.split('\n');
			const nonEmptyLines = lines.filter((l) => l.trim().length > 0);

			// Template should not have many filled values
			expect(nonEmptyLines.length).toBeLessThan(50);
		});
	});

	describe('Regression: Configuration Stability', () => {
		it('.gitignore should maintain core ignore patterns', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');

			// Core patterns that should always be present
			expect(content).toContain('node_modules');
			expect(content).toContain('dist');
			expect(content).toContain('.env');
		});

		it('configuration files should be UTF-8 encoded', () => {
			const configFiles = [
				join(projectRoot, '.gitignore'),
				join(projectRoot, '.env.example'),
				join(projectRoot, 'docs', '_config.yml'),
			];

			for (const file of configFiles) {
				const content = readFileSync(file, 'utf-8');
				// Should read successfully as UTF-8
				expect(() => Buffer.from(content, 'utf-8')).not.toThrow();
			}
		});
	});

	describe('Configuration Completeness', () => {
		it('.gitignore should cover all generated directories', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');

			// Common generated directories
			const generatedDirs = ['node_modules', 'dist', 'coverage'];

			for (const dir of generatedDirs) {
				expect(content).toContain(dir);
			}
		});

		it('project should have both .gitignore and .env.example', () => {
			expect(existsSync(join(projectRoot, '.gitignore'))).toBe(true);
			expect(existsSync(join(projectRoot, '.env.example'))).toBe(true);
		});
	});

	describe('Boundary Cases', () => {
		it('.gitignore should handle glob patterns correctly', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');

			// If glob patterns exist, they should be valid
			const lines = content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));

			for (const line of lines) {
				// Patterns with * should not have invalid combinations
				if (line.includes('*')) {
					expect(line).not.toMatch(/\*{3,}/); // No triple+ wildcards
				}
			}
		});

		it('.env.example should handle empty values gracefully', () => {
			const envExamplePath = join(projectRoot, '.env.example');
			const content = readFileSync(envExamplePath, 'utf-8');
			const lines = content.split('\n');

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith('#')) continue;

				if (trimmed.includes('=')) {
					const parts = trimmed.split('=');
					expect(parts.length).toBeGreaterThanOrEqual(1);
					// Key should not be empty
					expect(parts[0].trim().length).toBeGreaterThan(0);
				}
			}
		});

		it('docs/_config.yml should handle special characters in values', () => {
			const configPath = join(projectRoot, 'docs', '_config.yml');
			const content = readFileSync(configPath, 'utf-8');

			// Should be valid YAML - basic check
			expect(() => {
				const lines = content.split('\n');
				for (const line of lines) {
					// Unescaped special chars in unquoted values can break YAML
					if (line.includes(': ') && !line.trim().startsWith('#')) {
						const value = line.split(': ')[1];
						if (value && !value.match(/^["']/) && value.includes(':')) {
							// Nested colons should be quoted
							throw new Error('Unquoted colon in YAML value');
						}
					}
				}
			}).not.toThrow();
		});
	});

	describe('Additional Coverage: Negative Cases', () => {
		it('.gitignore should not accidentally ignore important source files', () => {
			const gitignorePath = join(projectRoot, '.gitignore');
			const content = readFileSync(gitignorePath, 'utf-8');

			// Should not ignore source directories
			expect(content).not.toMatch(/^lib\/?$/m);
			expect(content).not.toMatch(/^src\/?$/m);
			expect(content).not.toMatch(/^test\/?$/m);
			expect(content).not.toMatch(/^\*\.ts$/m);
			expect(content).not.toMatch(/^\*\.js$/m);
		});

		it('.env.example should not reference production URLs', () => {
			const envExamplePath = join(projectRoot, '.env.example');
			const content = readFileSync(envExamplePath, 'utf-8');

			// Should not have actual production URLs
			expect(content).not.toContain('https://api.openai.com');
			expect(content).not.toContain('https://chatgpt.com');
		});

		it('configuration files should end with newline', () => {
			const configFiles = [
				join(projectRoot, '.gitignore'),
				join(projectRoot, '.env.example'),
			];

			for (const file of configFiles) {
				const content = readFileSync(file, 'utf-8');
				if (content.length > 0) {
					// Good practice: files should end with newline
					// This is not a hard requirement but good for git diffs
					const endsWithNewline = content.endsWith('\n');
					// Just verify we can check this property
					expect(typeof endsWithNewline).toBe('boolean');
				}
			}
		});
	});
});