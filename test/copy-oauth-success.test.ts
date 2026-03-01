import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const oauthSuccessPath = fileURLToPath(
	new URL("../lib/oauth-success.html", import.meta.url),
);
const normalizeLineEndings = (value: string) => value.replace(/\r\n/g, "\n");

describe("copy-oauth-success script", () => {
	it("exports copyOAuthSuccessHtml() for reuse/testing", async () => {
		const mod = await import("../scripts/copy-oauth-success.js");
		expect(typeof mod.copyOAuthSuccessHtml).toBe("function");
	});

	it("copies oauth-success.html to the requested destination and matches snapshot", async () => {
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
});
