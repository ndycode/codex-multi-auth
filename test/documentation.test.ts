import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UI_COPY } from "../lib/ui/copy.js";

const projectRoot = resolve(process.cwd());

const userDocs = [
	"docs/index.md",
	"docs/README.md",
	"docs/getting-started.md",
	"docs/faq.md",
	"docs/architecture.md",
	"docs/features.md",
	"docs/configuration.md",
	"docs/troubleshooting.md",
	"docs/privacy.md",
	"docs/upgrade.md",
	"docs/reference/commands.md",
	"docs/reference/public-api.md",
	"docs/reference/error-contracts.md",
	"docs/reference/settings.md",
	"docs/reference/storage-paths.md",
	"docs/releases/v0.1.7.md",
	"docs/releases/v0.1.6.md",
	"docs/releases/v0.1.5.md",
	"docs/releases/v0.1.4.md",
	"docs/releases/v0.1.3.md",
	"docs/releases/v0.1.1.md",
	"docs/releases/v0.1.0.md",
	"docs/releases/v0.1.0-beta.0.md",
	"docs/releases/legacy-pre-0.1-history.md",
];

const scopedLegacyAllowedFiles = new Set([
	"README.md",
	"docs/getting-started.md",
	"docs/troubleshooting.md",
	"docs/upgrade.md",
	"docs/releases/v0.1.0.md",
	"docs/releases/v0.1.0-beta.0.md",
]);

const compatibilityAliasAllowedFiles = new Set([
	"docs/reference/commands.md",
	"docs/troubleshooting.md",
	"docs/upgrade.md",
]);

function read(filePath: string): string {
	return readFileSync(join(projectRoot, filePath), "utf-8");
}

function extractInternalLinks(markdown: string): string[] {
	return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
		.map((match) => match[1])
		.filter((link) => !link.startsWith("http") && !link.startsWith("#"));
}

function listMarkdownFiles(rootDir: string): string[] {
	const entries = readdirSync(rootDir, { withFileTypes: true }).sort(
		(left, right) => left.name.localeCompare(right.name),
	);
	const markdownFiles: string[] = [];
	for (const entry of entries) {
		const absolutePath = join(rootDir, entry.name);
		if (entry.isDirectory()) {
			markdownFiles.push(...listMarkdownFiles(absolutePath));
			continue;
		}
		if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
			markdownFiles.push(absolutePath);
		}
	}
	return markdownFiles.sort((left, right) => left.localeCompare(right));
}

function isExternalOrUriSchemeLink(linkPath: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(linkPath) || linkPath.startsWith("//");
}

function compareSemverDescending(left: string, right: string): number {
	const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
	const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
	for (let index = 0; index < 3; index += 1) {
		const leftPart = leftParts[index] ?? 0;
		const rightPart = rightParts[index] ?? 0;
		if (leftPart !== rightPart) {
			return leftPart - rightPart;
		}
	}
	return 0;
}

describe("Documentation Integrity", () => {
	it("has all required user docs and release notes", () => {
		for (const docPath of userDocs) {
			const fullPath = join(projectRoot, docPath);
			expect(existsSync(fullPath), `${docPath} should exist`).toBe(true);
			expect(
				read(docPath).trim().length,
				`${docPath} should not be empty`,
			).toBeGreaterThan(0);
		}
	});

	it("docs portal links to stable, beta, and archived release history", () => {
		const portal = read("docs/README.md");
		expect(portal).toContain("reference/public-api.md");
		expect(portal).toContain("reference/error-contracts.md");
		expect(portal).toContain("releases/v0.1.7.md");
		expect(portal).toContain("releases/v0.1.6.md");
		expect(portal).toContain("releases/v0.1.5.md");
		expect(portal).toContain("releases/v0.1.0-beta.0.md");
		expect(portal).toContain("releases/legacy-pre-0.1-history.md");
		expect(portal).toContain(
			"| [User Guides release notes](#user-guides) | Stable, previous, and archived release notes |",
		);

		const beta = read("docs/releases/v0.1.0-beta.0.md");
		expect(beta).toContain("Archived");
		expect(beta).toContain("superseded by [v0.1.0]");
	});

	it("uses codex-multi-auth as canonical package name", () => {
		const canonicalPackageDocs = [
			"README.md",
			"docs/index.md",
			"docs/getting-started.md",
			"docs/troubleshooting.md",
			"docs/upgrade.md",
			"docs/releases/v0.1.1.md",
			"docs/releases/v0.1.0.md",
		];

		for (const filePath of canonicalPackageDocs) {
			const content = read(filePath);
			expect(content).toContain("codex-multi-auth");
		}
	});

	it("uses scoped package only in explicit legacy migration notes", () => {
		const files = ["README.md", ...userDocs];

		for (const filePath of files) {
			const content = read(filePath);
			const hasScopedLegacyPackage = content.includes(
				"@ndycode/codex-multi-auth",
			);
			if (hasScopedLegacyPackage) {
				expect(
					scopedLegacyAllowedFiles.has(filePath),
					`${filePath} should not mention @ndycode/codex-multi-auth`,
				).toBe(true);
			}
		}
	});

	it("does not include opencode wording in user docs", () => {
		const allowedOpencodeFiles = new Set(["docs/reference/storage-paths.md"]);
		for (const filePath of userDocs) {
			const content = read(filePath).toLowerCase();
			const hasLegacyHostWord = content.includes("opencode");
			if (hasLegacyHostWord) {
				expect(
					allowedOpencodeFiles.has(filePath),
					`${filePath} should not include opencode references`,
				).toBe(true);
			}
		}
	});

	it("keeps compatibility command aliases scoped to reference, troubleshooting, or migration docs", () => {
		const files = ["README.md", ...userDocs];
		const aliasPattern = /\bcodex (multi auth|multi-auth|multiauth)\b/i;

		for (const filePath of files) {
			const content = read(filePath);
			const hasAlias = aliasPattern.test(content);
			if (hasAlias) {
				expect(
					compatibilityAliasAllowedFiles.has(filePath),
					`${filePath} should not include compatibility alias commands`,
				).toBe(true);
			}
		}
	});

	it("keeps codex auth as the command standard in key docs", () => {
		const keyDocs = [
			"README.md",
			"docs/index.md",
			"docs/getting-started.md",
			"docs/reference/commands.md",
			"docs/troubleshooting.md",
			"docs/upgrade.md",
		];

		for (const filePath of keyDocs) {
			expect(
				read(filePath),
				`${filePath} must include codex auth command examples`,
			).toContain("codex auth");
		}
	});

	it("keeps default onboarding docs host-optional and cleanup/install docs aligned with current paths", () => {
		const readme = read("README.md");
		const gettingStarted = read("docs/getting-started.md");
		const privacy = read("docs/privacy.md");
		const troubleshooting = read("docs/troubleshooting.md");
		const upgrade = read("docs/upgrade.md");
		const advancedInstall = read("docs/advanced-plugin-install.md");
		const contributing = read("CONTRIBUTING.md");

		expect(gettingStarted).toContain(
			"This installs the local account manager for `codex auth ...`.",
		);
		expect(gettingStarted).not.toContain(
			"Verify that the wrapper is active:\n\n```bash\ncodex --version",
		);
		expect(readme).not.toContain(
			"### Option D: Verify account-manager wiring\n\n```bash\ncodex --version",
		);

		expect(privacy).toContain('$CODEX_MULTI_AUTH_DIR/settings.json');
		expect(privacy).toContain('$CODEX_MULTI_AUTH_DIR/openai-codex-accounts.json');
		expect(privacy).toContain('$CODEX_MULTI_AUTH_DIR/openai-codex-flagged-accounts.json');
		expect(privacy).toContain('$CODEX_MULTI_AUTH_DIR/quota-cache.json');
		expect(privacy).toContain('$CODEX_MULTI_AUTH_DIR/cache');
		expect(privacy).toContain("foreach ($relativePath in @(");
		expect(privacy).toContain("Join-Path $env:CODEX_MULTI_AUTH_DIR $relativePath");

		expect(advancedInstall).toContain("%APPDATA%\\Codex\\Codex.json");
		expect(troubleshooting).toContain(
			"If you also installed the official Codex host/runtime, run `codex --version` as an extra routing check.",
		);
		expect(upgrade).toContain(
			"If you also need the official Codex host/runtime for forwarded non-auth commands or plugin-host setup",
		);
		expect(contributing).toContain(
			"`codex --version` if the official Codex host/runtime is installed or part of the failing path",
		);
	});

	it("uses platform-specific command lookup guidance in onboarding and troubleshooting docs", () => {
		const readme = read("README.md");
		const gettingStarted = read("docs/getting-started.md");
		const troubleshooting = read("docs/troubleshooting.md");
		const advancedInstall = read("docs/advanced-plugin-install.md");

		for (const content of [gettingStarted, troubleshooting, advancedInstall]) {
			expect(content).toContain("Get-Command codex");
			expect(content).toContain("command -v codex");
			expect(content).not.toContain("```bash\nwhere codex\nwhich codex");
		}

		expect(readme).toContain("Get-Command codex` (PowerShell) or `command -v codex` (POSIX)");
		expect(readme).toContain("needs non-auth `codex` commands to be forwarded");
		expect(advancedInstall).toContain("`scripts/install-codex-auth.js` does the following:");
		expect(advancedInstall).not.toContain(
			"> It should be treated as an operator action, not something an LLM agent runs automatically.\n\n> [!NOTE]",
		);
	});

	it("documents public API stability tiers and error contracts", () => {
		const publicApi = read("docs/reference/public-api.md").toLowerCase();
		const errorContracts = read(
			"docs/reference/error-contracts.md",
		).toLowerCase();

		expect(publicApi).toContain("tier a");
		expect(publicApi).toContain("tier b");
		expect(publicApi).toContain("tier c");
		expect(publicApi).toContain("options-object");
		expect(publicApi).toContain("semver");

		expect(errorContracts).toContain("exit codes");
		expect(errorContracts).toContain("json mode contract");
		expect(errorContracts).toContain("entitlement");
		expect(errorContracts).toContain("rate-limit");
		expect(errorContracts).toContain("options-object compatibility contract");
		expect(errorContracts).toContain("selecthybridaccount");
		expect(errorContracts).toContain("exponentialbackoff");
		expect(errorContracts).toContain("gettopcandidates");
		expect(errorContracts).toContain("createcodexheaders");
		expect(errorContracts).toContain("getratelimitbackoffwithreason");
		expect(errorContracts).toContain("transformrequestbody");
	});

	it("keeps fix command flag docs aligned across README, reference, and CLI usage text", () => {
		const readme = read("README.md");
		const commandRef = read("docs/reference/commands.md");
		const managerPath = "lib/codex-manager.ts";
		expect(
			existsSync(join(projectRoot, managerPath)),
			`${managerPath} should exist`,
		).toBe(true);
		const manager = read(managerPath);

		expect(readme).toContain("codex auth fix --live --model gpt-5-codex");
		expect(commandRef).toContain("| `--live` | forecast, report, fix |");
		expect(commandRef).toContain(
			"| `--model <model>` | forecast, report, fix |",
		);
		expect(manager).toContain("codex auth login");
		expect(manager).toContain(
			"codex auth fix [--dry-run] [--json] [--live] [--model <model>]",
		);
		expect(manager).toContain(
			"Missing index. Usage: codex auth switch <index>",
		);
		expect(manager).not.toContain("codex-multi-auth auth switch <index>");
	});

	it("documents stable overrides separately from advanced and internal overrides", () => {
		const configGuide = read("docs/configuration.md").toLowerCase();
		const settingsRef = read("docs/reference/settings.md").toLowerCase();
		const fieldInventoryPath = "docs/development/CONFIG_FIELDS.md";
		expect(
			existsSync(join(projectRoot, fieldInventoryPath)),
			`${fieldInventoryPath} should exist`,
		).toBe(true);
		const fieldInventory = read(fieldInventoryPath).toLowerCase();

		expect(configGuide).toContain("stable environment overrides");
		expect(configGuide).toContain("advanced and internal overrides");
		expect(settingsRef).toContain("stable environment overrides");
		expect(settingsRef).toContain("advanced and internal overrides");

		expect(fieldInventory).toContain("concurrency and windows notes");
		expect(fieldInventory).toContain("eperm");
		expect(fieldInventory).toContain("ebusy");
		expect(fieldInventory).toContain("cross-process refresh");
		expect(fieldInventory).toContain("tokenrefreshskewms");
	});

	it("locks the current Experimental settings menu labels and help text", () => {
		expect(UI_COPY.settings.title).toBe("Settings");
		expect(UI_COPY.settings.subtitle).toBe(
			"Customize menu, behavior, backend, and experiments",
		);
		expect(UI_COPY.settings.help).toBe("↑↓ Move | Enter Select | Q Back");
		expect(UI_COPY.settings.accountList).toBe("Account List View");
		expect(UI_COPY.settings.summaryFields).toBe("Summary Line");
		expect(UI_COPY.settings.behavior).toBe("Menu Behavior");
		expect(UI_COPY.settings.theme).toBe("Color Theme");
		expect(UI_COPY.settings.experimental).toBe("Experimental");
		expect(UI_COPY.settings.backend).toBe("Backend Controls");
		expect(UI_COPY.settings.accountListHelp).toBe(
			"Enter Toggle | Number Toggle | M Sort | L Layout | S Save | Q Back (No Save)",
		);
		expect(UI_COPY.settings.summaryHelp).toBe(
			"Enter Toggle | 1-3 Toggle | [ ] Reorder | S Save | Q Back (No Save)",
		);
		expect(UI_COPY.settings.behaviorHelp).toBe(
			"Enter Select | 1-3 Delay | P Pause | L AutoFetch | F Status | T TTL | S Save | Q Back (No Save)",
		);
		expect(UI_COPY.settings.themeHelp).toBe(
			"Enter Select | 1-2 Base | S Save | Q Back (No Save)",
		);
		expect(UI_COPY.settings.backendHelp).toBe(
			"Enter Open | 1-4 Category | S Save | R Reset | Q Back (No Save)",
		);
	});

	it("keeps settings reference sections aligned with current menu labels and backend categories", () => {
		const settingsRef = read("docs/reference/settings.md");

		expect(settingsRef).toContain(`## ${UI_COPY.settings.accountList}`);
		expect(settingsRef).toContain(`## ${UI_COPY.settings.summaryFields}`);
		expect(settingsRef).toContain(`## ${UI_COPY.settings.behavior}`);
		expect(settingsRef).toContain(`## ${UI_COPY.settings.theme}`);
		expect(settingsRef).toContain(`## ${UI_COPY.settings.experimental}`);
		expect(settingsRef).toContain(`## ${UI_COPY.settings.backend}`);
		expect(settingsRef).toContain("### Session & Sync");
		expect(settingsRef).toContain("### Rotation & Quota");
		expect(settingsRef).toContain("### Refresh & Recovery");
		expect(settingsRef).toContain("preview is always shown before apply");
		expect(settingsRef).toContain("Named backup behavior:");
		expect(settingsRef).toContain("### Performance & Timeouts");
		expect(settingsRef).toContain("- `menuShowLastUsed`");
		expect(settingsRef).toContain("- `menuShowQuotaSummary`");
		expect(settingsRef).toContain("- `menuShowFetchStatus`");
		expect(settingsRef).toContain("- `menuStatuslineFields`");
	});

	it("keeps changelog aligned with canonical 0.x release policy", () => {
		const changelog = read("CHANGELOG.md");
		expect(changelog).toContain("## [0.1.8] - 2026-03-11");
		expect(changelog).toContain("## [0.1.7] - 2026-03-03");
		expect(changelog).toContain("## [0.1.6] - 2026-03-03");
		expect(changelog).toContain("## [0.1.0] - 2026-02-27");
		expect(changelog).toContain("docs/releases/legacy-pre-0.1-history.md");
		expect(changelog).not.toContain("## [5.");
		expect(changelog).not.toContain("## [4.");
	});

	it("keeps legacy pre-0.1 archive headings in descending semver order", () => {
		const archive = read("docs/releases/legacy-pre-0.1-history.md");
		const versions = [...archive.matchAll(/^## \[(\d+\.\d+\.\d+)\] - /gm)].map(
			(match) => match[1],
		);
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

	it("keeps CODEX_MULTI_AUTH_CONFIG_PATH fallback and env override precedence aligned with docs", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "codex-doc-config-"));
		const fallbackConfigPath = join(tempRoot, "fallback-config.json");

		try {
			writeFileSync(
				fallbackConfigPath,
				`${JSON.stringify({ codexMode: false, toastDurationMs: 7777 }, null, 2)}\n`,
				"utf-8",
			);
			vi.resetModules();
			vi.stubEnv("CODEX_MULTI_AUTH_DIR", tempRoot);
			vi.stubEnv("CODEX_MULTI_AUTH_CONFIG_PATH", fallbackConfigPath);
			vi.stubEnv("CODEX_MODE", "1");
			vi.stubEnv("HOME", tempRoot);
			vi.stubEnv("USERPROFILE", tempRoot);

			const { loadPluginConfig, getCodexMode } = await import(
				"../lib/config.js"
			);
			const loaded = loadPluginConfig();
			expect(loaded.codexMode).toBe(false);
			expect(getCodexMode(loaded)).toBe(true);

			const configFlow = read("docs/development/CONFIG_FLOW.md");
			const configGuide = read("docs/configuration.md");
			expect(configFlow).toContain(
				"Fallback file from `CODEX_MULTI_AUTH_CONFIG_PATH`",
			);
			expect(configFlow).toContain(
				"After source selection, environment variables apply per-setting overrides.",
			);
			expect(configGuide).toContain("CODEX_MULTI_AUTH_CONFIG_PATH");
		} finally {
			vi.unstubAllEnvs();
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("keeps governance templates and security reporting guidance present", () => {
		const prTemplate = ".github/pull_request_template.md";
		const issueConfig = ".github/ISSUE_TEMPLATE/config.yml";
		const bugTemplate = ".github/ISSUE_TEMPLATE/bug_report.md";
		const featureTemplate = ".github/ISSUE_TEMPLATE/feature_request.md";
		const codeOfConduct = "CODE_OF_CONDUCT.md";

		expect(
			existsSync(join(projectRoot, prTemplate)),
			`${prTemplate} should exist`,
		).toBe(true);
		expect(
			existsSync(join(projectRoot, issueConfig)),
			`${issueConfig} should exist`,
		).toBe(true);
		expect(
			existsSync(join(projectRoot, bugTemplate)),
			`${bugTemplate} should exist`,
		).toBe(true);
		expect(
			existsSync(join(projectRoot, featureTemplate)),
			`${featureTemplate} should exist`,
		).toBe(true);
		expect(
			existsSync(join(projectRoot, codeOfConduct)),
			`${codeOfConduct} should exist`,
		).toBe(true);

		const prBody = read(prTemplate);
		expect(prBody).toContain("npm run lint");
		expect(prBody).toContain("npm run typecheck");
		expect(prBody).toContain("npm test");
		expect(prBody).toContain("npm test -- test/documentation.test.ts");
		expect(prBody).toContain("npm run build");

		const security = read("SECURITY.md").toLowerCase();
		expect(security).toContain("do not open a public issue");
		expect(security).toContain("enable_plugin_request_logging=1");
		expect(security).toContain("codex_plugin_log_bodies=1");

		const contributing = read("CONTRIBUTING.md").toLowerCase();
		expect(contributing).toContain("pull request process");
		expect(contributing).toContain("npm run typecheck");
		expect(contributing).toContain("npm run lint");
		expect(contributing).toContain("npm test");
		expect(contributing).toContain("npm run build");

		const conduct = read("CODE_OF_CONDUCT.md").toLowerCase();
		expect(conduct).toContain("respectful");
		expect(conduct).toContain("security.md");
	});

	it("has valid internal links in README.md", () => {
		const content = read("README.md");
		const links = extractInternalLinks(content);

		for (const link of links) {
			const cleanPath = link.split("#")[0];
			if (!cleanPath) {
				continue;
			}
			expect(
				existsSync(join(projectRoot, cleanPath)),
				`Missing link target: ${cleanPath}`,
			).toBe(true);
		}
	});

	it("ignores URI scheme links during docs link validation", () => {
		const tempDocsRoot = mkdtempSync(join(tmpdir(), "codex-doc-links-"));

		try {
			const nestedDir = join(tempDocsRoot, "nested");
			mkdirSync(nestedDir, { recursive: true });
			writeFileSync(
				join(tempDocsRoot, "index.md"),
				[
					"# Temporary docs",
					"[Guide](./nested/guide.md)",
					"[Mail](mailto:support@example.com)",
					"[Phone](tel:+1234567890)",
					"[Scheme relative](//example.com/path)",
				].join("\n"),
				"utf-8",
			);
			writeFileSync(join(nestedDir, "guide.md"), "# Guide\n", "utf-8");

			const docsMarkdownFiles = listMarkdownFiles(tempDocsRoot);
			const missingTargets: string[] = [];

			for (const filePath of docsMarkdownFiles) {
				const content = readFileSync(filePath, "utf-8");
				const links = extractInternalLinks(content);
				for (const link of links) {
					const cleanPath = link.split("#")[0];
					if (!cleanPath || isExternalOrUriSchemeLink(cleanPath)) {
						continue;
					}
					const targetPath = resolve(dirname(filePath), cleanPath);
					if (!existsSync(targetPath)) {
						missingTargets.push(`${filePath}: ${cleanPath}`);
					}
				}
			}

			expect(missingTargets).toEqual([]);
		} finally {
			rmSync(tempDocsRoot, { recursive: true, force: true });
		}
	});

	it("has valid internal links in markdown files under docs/", () => {
		const docsRoot = join(projectRoot, "docs");
		const docsMarkdownFiles = listMarkdownFiles(docsRoot);

		for (const filePath of docsMarkdownFiles) {
			const content = readFileSync(filePath, "utf-8");
			const links = extractInternalLinks(content);
			for (const link of links) {
				const cleanPath = link.split("#")[0];
				if (!cleanPath) {
					continue;
				}
				if (isExternalOrUriSchemeLink(cleanPath)) {
					continue;
				}
				const targetPath = resolve(dirname(filePath), cleanPath);
				expect(
					existsSync(targetPath),
					`Missing docs link in ${filePath.replace(projectRoot, "")}: ${cleanPath}`,
				).toBe(true);
			}
		}
	});
});
