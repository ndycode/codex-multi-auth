import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

async function removeWithRetry(
	targetPath: string,
	options: { recursive?: boolean; force?: boolean },
): Promise<void> {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await fs.rm(targetPath, options);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt === 5) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

describe("license policy check", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-license-policy-"));
	});

	afterEach(async () => {
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it.each([
		{ denyList: "GPL-2.0+", license: "GPL-2.0+" },
		{ denyList: "LGPL-2.1+", license: "MIT OR LGPL-2.1+" },
	])("blocks denylisted SPDX plus-form (%o)", async ({ denyList, license }) => {
		const lock = {
			name: "license-test",
			lockfileVersion: 3,
			packages: {
				"": {
					name: "license-test",
					version: "1.0.0",
				},
				"node_modules/blocked-package": {
					name: "blocked-package",
					version: "1.0.0",
					license,
				},
			},
		};

		await fs.writeFile(join(tempDir, "package-lock.json"), JSON.stringify(lock, null, 2), "utf8");
		const scriptPath = join(process.cwd(), "scripts", "license-policy-check.js");
		const result = spawnSync(process.execPath, [scriptPath], {
			cwd: tempDir,
			encoding: "utf8",
			env: {
				...process.env,
				CODEX_LICENSE_DENYLIST: denyList,
			},
		});

		expect(result.status).toBe(1);
		const stderr = String(result.stderr ?? "");
		expect(stderr).toContain("License policy violations detected:");
		expect(stderr).toContain("blocked-package@1.0.0");
	});
});
