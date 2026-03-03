import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const oauthSuccessPath = fileURLToPath(
	new URL("../lib/oauth-success.html", import.meta.url),
);
const normalizeLineEndings = (value: string) => value.replace(/\r\n/g, "\n");

describe("copy-oauth-success script", () => {
	it("exports copyOAuthSuccessHtml() for reuse/testing", async () => {
		vi.resetModules();
		const mod = await import("../scripts/copy-oauth-success.js");
		expect(typeof mod.copyOAuthSuccessHtml).toBe("function");
	});

	it("copies oauth-success.html to the requested destination and matches snapshot", async () => {
		vi.resetModules();
		const mod = await import("../scripts/copy-oauth-success.js");

		const root = await mkdtemp(join(tmpdir(), "codex-oauth-success-"));
		const dest = join(root, "dist", "lib", "oauth-success.html");

		try {
			await mod.copyOAuthSuccessHtml({ src: oauthSuccessPath, dest });

			const copied = await readFile(dest, "utf-8");
			const source = await readFile(oauthSuccessPath, "utf-8");
			expect(copied).toBe(source);
			expect(normalizeLineEndings(copied)).toMatchSnapshot();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("retries when copyFile hits transient lock errors", async () => {
		const retryableCodes = ["EBUSY", "EPERM", "EACCES"];
		for (const code of retryableCodes) {
			vi.resetModules();
			const actualFs =
				await vi.importActual<typeof import("node:fs/promises")>(
					"node:fs/promises",
				);
			let attempt = 0;
			const transientError = Object.assign(new Error(`transient ${code}`), { code });
			const mockCopyFile = vi.fn(
				(...args: Parameters<typeof actualFs.copyFile>) => {
					attempt += 1;
					if (attempt === 1) {
						return Promise.reject(transientError);
					}
					return actualFs.copyFile(...args);
				},
			);
			vi.doMock("node:fs/promises", () => ({
				...actualFs,
				copyFile: mockCopyFile,
			}));

			const mod = await import("../scripts/copy-oauth-success.js");
			const root = await mkdtemp(join(tmpdir(), `codex-oauth-success-${code.toLowerCase()}-`));
			const dest = join(root, "dist", "lib", "oauth-success.html");

			try {
				await mod.copyOAuthSuccessHtml({ src: oauthSuccessPath, dest });
				expect(mockCopyFile).toHaveBeenCalledTimes(2);
			} finally {
				await rm(root, { recursive: true, force: true });
				vi.doUnmock("node:fs/promises");
				vi.resetModules();
			}
		}
	});

	it("throws immediately for non-retryable copy errors", async () => {
		vi.resetModules();
		const actualFs =
			await vi.importActual<typeof import("node:fs/promises")>(
				"node:fs/promises",
			);
		const error = Object.assign(new Error("missing file"), { code: "ENOENT" });
		const mockCopyFile = vi.fn().mockRejectedValue(error);
		vi.doMock("node:fs/promises", () => ({
			...actualFs,
			copyFile: mockCopyFile,
		}));

		const mod = await import("../scripts/copy-oauth-success.js");
		const root = await mkdtemp(join(tmpdir(), "codex-oauth-success-enoent-"));
		const dest = join(root, "dist", "lib", "oauth-success.html");

		try {
			await expect(mod.copyOAuthSuccessHtml({ src: oauthSuccessPath, dest })).rejects.toMatchObject({
				code: "ENOENT",
			});
			expect(mockCopyFile).toHaveBeenCalledTimes(1);
		} finally {
			await rm(root, { recursive: true, force: true });
			vi.doUnmock("node:fs/promises");
			vi.resetModules();
		}
	});
});
