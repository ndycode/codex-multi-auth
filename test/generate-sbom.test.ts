import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const scriptPath = path.resolve(process.cwd(), "scripts", "generate-sbom.js");

async function removeWithRetry(targetPath: string): Promise<void> {
	const retryableCodes = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await fs.rm(targetPath, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (!code || !retryableCodes.has(code) || attempt === 5) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

function createFakeNpmScript(root: string): string {
	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const fakeNpmPath = path.join(binDir, "fake-npm.js");
	const fakeNpmSource = `
const args = process.argv.slice(2);
if (args[0] === "sbom") {
  process.stdout.write(JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", metadata: "x".repeat(1_500_000), components: [] }));
  process.exit(0);
}
process.stdout.write("ok\\n");
`.trimStart();
	writeFileSync(fakeNpmPath, fakeNpmSource, "utf8");
	if (process.platform !== "win32") {
		chmodSync(fakeNpmPath, 0o755);
	}
	return fakeNpmPath;
}

describe("generate-sbom script", () => {
	const fixtures: string[] = [];

	afterEach(async () => {
		while (fixtures.length > 0) {
			const fixture = fixtures.pop();
			if (!fixture) continue;
			await removeWithRetry(fixture);
		}
	});

	it("writes large sbom output without hitting child-process maxBuffer", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "generate-sbom-"));
		fixtures.push(root);
		const fakeNpmPath = createFakeNpmScript(root);

		const result = spawnSync(process.execPath, [scriptPath], {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				npm_execpath: fakeNpmPath,
				NPM_EXECPATH: fakeNpmPath,
			},
		});

		expect(
			result.status,
			`stderr: ${result.stderr}\nstdout: ${String(result.stdout).slice(0, 200)}`,
		).toBe(0);
		const payload = JSON.parse(result.stdout) as { status?: string; outputPath?: string };
		expect(payload.status).toBe("pass");

		const sbomPath = path.join(root, ".tmp", "sbom.cdx.json");
		const raw = await fs.readFile(sbomPath, "utf8");
		expect(raw.length).toBeGreaterThan(1_000_000);
		expect(() => JSON.parse(raw)).not.toThrow();
	});
});
