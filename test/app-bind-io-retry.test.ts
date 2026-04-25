import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppBindPaths } from "../lib/runtime/app-bind.js";
import { withFileOperationRetry } from "../scripts/install-codex-auth-utils.js";

const fsFaults = vi.hoisted(() => ({
	renameFailures: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
			if (fsFaults.renameFailures > 0) {
				fsFaults.renameFailures -= 1;
				throw Object.assign(new Error("busy"), { code: "EBUSY" });
			}
			return actual.rename(...args);
		}),
	};
});

const tempRoots: string[] = [];

async function createTempRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	fsFaults.renameFailures = 0;
	await Promise.all(
		tempRoots.splice(0).map((root) =>
			withFileOperationRetry(() => rm(root, { recursive: true, force: true })),
		),
	);
});

async function seedExistingState(params: {
	home: string;
	env: NodeJS.ProcessEnv;
	nodePath: string;
	routerScriptPath: string;
}): Promise<AppBindPaths> {
	const { resolveAppBindPaths } = await import("../lib/runtime/app-bind.js");
	const paths = resolveAppBindPaths({
		platform: "linux",
		home: params.home,
		env: params.env,
		nodePath: params.nodePath,
		routerScriptPath: params.routerScriptPath,
	});
	await mkdir(paths.bindDir, { recursive: true });
	await writeFile(
		paths.statePath,
		`${JSON.stringify(
			{
				version: 1,
				platform: "linux",
				host: "127.0.0.1",
				port: 4567,
				baseUrl: "http://127.0.0.1:4567",
				configPath: paths.configPath,
				statePath: paths.statePath,
				backupPath: paths.backupPath,
				statusPath: paths.statusPath,
				logPath: paths.logPath,
				nodePath: params.nodePath,
				routerScriptPath: params.routerScriptPath,
				clientApiKey: "existing-secret",
				startupPath: paths.startupPath,
				launchAgentPath: paths.launchAgentPath,
				boundConfigHash: "existing-hash",
				updatedAt: 1,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	return paths;
}

describe("Codex app bind filesystem retry behavior", () => {
	it("retries transient EBUSY during bind and unbind atomic renames", async () => {
		const { bindCodexAppRuntimeRotation, unbindCodexAppRuntimeRotation } =
			await import("../lib/runtime/app-bind.js");
		const root = await createTempRoot("codex-app-bind-io-");
		const codexHome = join(root, "codex-home");
		const env = {
			CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome,
		};
		const paths = await seedExistingState({
			home: root,
			env,
			nodePath: "node",
			routerScriptPath: join(root, "codex-app-router.js"),
		});
		await mkdir(codexHome, { recursive: true });
		await writeFile(paths.configPath, 'model_provider = "openai"\n', "utf8");

		fsFaults.renameFailures = 2;
		const result = await bindCodexAppRuntimeRotation({
			platform: "linux",
			home: root,
			env,
			nodePath: "node",
			routerScriptPath: join(root, "codex-app-router.js"),
			spawnDetached: false,
		});

		expect(result.status.bound).toBe(true);
		expect(await readFile(paths.configPath, "utf8")).toContain(
			'base_url = "http://127.0.0.1:4567"',
		);

		fsFaults.renameFailures = 2;
		await expect(
			unbindCodexAppRuntimeRotation({
				platform: "linux",
				home: root,
				env,
				spawnDetached: false,
			}),
		).resolves.toMatchObject({ status: { bound: false } });
		expect(await readFile(paths.configPath, "utf8")).toBe(
			'model_provider = "openai"\n',
		);
	});

	it("surfaces persistent EBUSY without truncating config.toml", async () => {
		const { bindCodexAppRuntimeRotation } = await import(
			"../lib/runtime/app-bind.js"
		);
		const root = await createTempRoot("codex-app-bind-io-fail-");
		const codexHome = join(root, "codex-home");
		const env = {
			CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome,
		};
		const paths = await seedExistingState({
			home: root,
			env,
			nodePath: "node",
			routerScriptPath: join(root, "codex-app-router.js"),
		});
		await mkdir(codexHome, { recursive: true });
		await writeFile(paths.configPath, 'model_provider = "openai"\n', "utf8");

		fsFaults.renameFailures = 20;
		await expect(
			bindCodexAppRuntimeRotation({
				platform: "linux",
				home: root,
				env,
				nodePath: "node",
				routerScriptPath: join(root, "codex-app-router.js"),
				spawnDetached: false,
			}),
		).rejects.toThrow("busy");
		expect(existsSync(paths.configPath)).toBe(true);
		expect(await readFile(paths.configPath, "utf8")).toBe(
			'model_provider = "openai"\n',
		);
	});
});
