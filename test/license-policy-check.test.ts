import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

function createRetryableFsError(code: string): NodeJS.ErrnoException {
	const error = new Error(code.toLowerCase()) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("license policy check", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-license-policy-"));
	});

	afterEach(async () => {
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it("retries transient windows rm errors before succeeding", async () => {
		vi.useFakeTimers();
		const rmSpy = vi.spyOn(fs, "rm");
		rmSpy
			.mockRejectedValueOnce(createRetryableFsError("EBUSY"))
			.mockRejectedValueOnce(createRetryableFsError("EPERM"))
			.mockResolvedValueOnce(undefined);
		try {
			const cleanupPromise = removeWithRetry("C:\\temp\\codex-license-policy", {
				recursive: true,
				force: true,
			});
			await vi.runAllTimersAsync();
			await expect(cleanupPromise).resolves.toBeUndefined();
			expect(rmSpy).toHaveBeenCalledTimes(3);
		} finally {
			rmSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it.each([
		{ denyList: "GPL-2.0+", metadata: { license: "GPL-2.0+" } },
		{ denyList: "LGPL-2.1+", metadata: { license: "MIT OR LGPL-2.1+" } },
		{ denyList: "GPL-2.0+", metadata: { license: { type: "GPL-2.0+" } } },
		{
			denyList: "LGPL-2.1+",
			metadata: { licenses: [{ type: "MIT OR LGPL-2.1+" }] },
		},
	])("blocks denylisted SPDX plus-form (%o)", async ({ denyList, metadata }) => {
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
						...metadata,
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
