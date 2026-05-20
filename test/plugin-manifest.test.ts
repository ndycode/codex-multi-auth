import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type PluginManifest = {
	version?: string;
	interface?: {
		composerIcon?: string;
	};
};

type PackageManifest = {
	version?: string;
};

const pluginManifestPath = path.join(".codex-plugin", "plugin.json");

const readJson = <T>(filePath: string): T => JSON.parse(readFileSync(filePath, "utf8")) as T;

describe("Codex plugin manifest", () => {
	it("declares an existing marketplace composer icon and matches the package version", () => {
		const manifest = readJson<PluginManifest>(pluginManifestPath);
		const pkg = readJson<PackageManifest>("package.json");

		expect(manifest.interface?.composerIcon).toBe("./assets/codex-multi-auth-icon.svg");
		expect(manifest.version).toBe(pkg.version);

		const iconPath = manifest.interface?.composerIcon;
		expect(iconPath).toBeDefined();
		expect(iconPath?.startsWith("./")).toBe(true);
		expect(existsSync(path.join(path.dirname(pluginManifestPath), "..", iconPath ?? ""))).toBe(true);
	});
});
