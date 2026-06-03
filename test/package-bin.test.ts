import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("package bin entries", () => {
	it("exposes expected CLI bins", () => {
		const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
			bin?: Record<string, string>;
			files?: string[];
			bundleDependencies?: string[];
		};
		expect(pkg.bin).toBeDefined();
		expect(pkg.bin?.codex).toBeUndefined();
		expect(pkg.bin?.["codex-multi-auth-codex"]).toBe("scripts/codex.js");
		expect(pkg.bin?.["codex-multi-auth-app-launcher"]).toBe("scripts/codex-app-launcher.js");
		expect(pkg.bin?.["codex-multi-auth"]).toBe("scripts/codex-multi-auth.js");
		expect(pkg.bin?.["codex-multi-auth-opencode-install"]).toBeUndefined();
		expect(pkg.files).toEqual(
			expect.arrayContaining([
				".codex-plugin/plugin.json",
				"vendor/codex-ai-plugin/",
				"vendor/codex-ai-sdk/",
			]),
		);
		expect(pkg.bundleDependencies).toEqual(expect.arrayContaining(["@codex-ai/plugin"]));
	});

	// Regression (docs-supplychain-01): the published .d.ts files re-export types
	// from @codex-ai/sdk, so a consumer running `tsc` must be able to resolve it.
	// A vendored (`file:vendor/*`) dependency that ships in `files[]` must therefore
	// live in `dependencies` + `bundleDependencies`, never `devDependencies` (which
	// a consumer install does not fetch).
	it("bundles every shipped vendored workspace dependency", () => {
		const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			bundleDependencies?: string[];
		};
		const bundled = new Set(pkg.bundleDependencies ?? []);
		const vendoredDeps = Object.entries(pkg.dependencies ?? {}).filter(([, spec]) =>
			spec.startsWith("file:vendor/"),
		);
		// @codex-ai/sdk and @codex-ai/plugin are both vendored and published.
		expect(vendoredDeps.map(([name]) => name).sort()).toEqual([
			"@codex-ai/plugin",
			"@codex-ai/sdk",
		]);
		for (const [name] of vendoredDeps) {
			expect(bundled.has(name)).toBe(true);
		}
		// And none of them may hide in devDependencies (consumer tsc would break).
		expect(pkg.devDependencies?.["@codex-ai/sdk"]).toBeUndefined();
		expect(pkg.devDependencies?.["@codex-ai/plugin"]).toBeUndefined();
	});

	// install-scripts-02: npm@7+ no longer fires the `preuninstall` lifecycle hook
	// (see lib/codex-manager/commands/uninstall.ts), so wiring it would be dead
	// config that misleads readers into thinking cleanup runs on `npm uninstall`.
	// The real cleanup path is the explicit `codex-multi-auth uninstall` command,
	// which reuses the same logic. The script stays shipped (invokable + tested via
	// runPreuninstallCleanup), but must NOT be registered as the npm hook.
	it("does NOT wire a preuninstall lifecycle hook (npm@7+ never runs it)", () => {
		const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
			scripts?: Record<string, string>;
			files?: string[];
		};
		expect(pkg.scripts?.preuninstall).toBeUndefined();
		// The script is still shipped so the explicit uninstall command can use it.
		expect(pkg.files).toEqual(
			expect.arrayContaining(["scripts/preuninstall.js"]),
		);
	});
});

