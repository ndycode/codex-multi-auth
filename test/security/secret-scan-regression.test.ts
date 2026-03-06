import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { removeWithRetry } from "../helpers/remove-with-retry.js";

const secretPattern = /OPENAI_API_KEY=sk-[A-Za-z0-9-]{10,}/;
const allowlistedFixture = /test[\\/]+security[\\/]+fixtures[\\/]+fixture\.txt$/i;

async function collectSyntheticFindings(root: string): Promise<Array<{ File: string }>> {
	const findings: Array<{ File: string }> = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		const entries = await fs.readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			const rel = path.relative(root, fullPath).replace(/\\/g, "/");
			const content = await fs.readFile(fullPath, "utf8");
			if (!secretPattern.test(content)) continue;
			if (allowlistedFixture.test(rel)) continue;
			findings.push({ File: rel });
		}
	}
	return findings;
}

describe("secret scan regression harness", () => {
	const fixtures: string[] = [];

	afterEach(async () => {
		while (fixtures.length > 0) {
			const fixture = fixtures.pop();
			if (!fixture) continue;
			await removeWithRetry(fixture);
		}
	});

	it("fixture allowlist regex handles windows paths", () => {
		expect(/^test[\\/]security[\\/]fixtures[\\/]/i.test("test\\security\\fixtures\\fixture.txt")).toBe(
			true,
		);
		expect("test\\security\\fixtures\\fixture.txt".replace(/\\/g, "/")).toBe(
			"test/security/fixtures/fixture.txt",
		);
	});

	it("keeps fixture allowlist behavior and flags only non-allowlisted secrets", async () => {
		const repoRoot = process.cwd();
		const gitleaksConfig = await fs.readFile(path.join(repoRoot, ".gitleaks.toml"), "utf8");
		expect(gitleaksConfig).toContain("^test[\\\\/]security[\\\\/]fixtures[\\\\/]");

		const root = mkdtempSync(path.join(tmpdir(), "secret-scan-regression-"));
		fixtures.push(root);
		const failCase = path.join(root, "fail-case");
		const passCase = path.join(root, "pass-case");
		await fs.mkdir(path.join(failCase, "src"), { recursive: true });
		await fs.mkdir(path.join(failCase, "test", "security", "fixtures"), { recursive: true });
		await fs.mkdir(path.join(passCase, "test", "security", "fixtures"), { recursive: true });

		await fs.writeFile(
			path.join(failCase, "src", "leak.txt"),
			"OPENAI_API_KEY=sk-test-placeholder-leak-12345678901234567890\n",
			"utf8",
		);
		await fs.writeFile(
			path.join(failCase, "test", "security", "fixtures", "fixture.txt"),
			"OPENAI_API_KEY=sk-test-allowlist-should-exclude-1234567890\n",
			"utf8",
		);
		await fs.writeFile(
			path.join(failCase, "test", "security", "fixtures", "real-secret.txt"),
			"OPENAI_API_KEY=sk-test-placeholder-in-fixture-12345678901234567890\n",
			"utf8",
		);
		await fs.writeFile(path.join(passCase, "test", "security", "fixtures", "fixture.txt"), "fake_refresh_token_67890\n", "utf8");

		const failFindings = await collectSyntheticFindings(failCase);
		expect(failFindings.some((finding) => finding.File.includes("src/leak.txt"))).toBe(true);
		expect(failFindings.some((finding) => finding.File.includes("test/security/fixtures/real-secret.txt"))).toBe(true);
		expect(failFindings.some((finding) => finding.File.includes("test/security/fixtures/fixture.txt"))).toBe(false);

		const passFindings = await collectSyntheticFindings(passCase);
		expect(passFindings).toEqual([]);
	});
});
