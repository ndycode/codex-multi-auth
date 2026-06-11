import { describe, it, expect, vi } from "vitest";
import { tempFileNonce, tempPathFor } from "../lib/temp-path.js";

const cryptoControl = vi.hoisted(() => ({ failure: null as Error | null }));

vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return {
		...actual,
		randomBytes: (size: number) => {
			if (cryptoControl.failure) {
				throw cryptoControl.failure;
			}
			return actual.randomBytes(size);
		},
	};
});

describe("temp-path", () => {
	describe("tempFileNonce", () => {
		it("produces <pid>.<epochMs>.<hex8> shaped nonces", () => {
			const nonce = tempFileNonce();
			expect(nonce).toMatch(/^\d+\.\d+\.[0-9a-f]{8}$/);
			expect(nonce.startsWith(`${process.pid}.`)).toBe(true);
		});

		it("does not repeat across rapid successive calls", () => {
			const seen = new Set<string>();
			for (let i = 0; i < 200; i += 1) {
				seen.add(tempFileNonce());
			}
			// pid + timestamp collide within the same millisecond, so uniqueness
			// rests on the crypto suffix; 200 draws must never collide.
			expect(seen.size).toBe(200);
		});

		it("propagates randomBytes failures instead of falling back to weak randomness", () => {
			// FIPS-restricted or entropy-starved Node builds make randomBytes throw;
			// the intended failure mode is a loud error, never a Math.random fallback.
			cryptoControl.failure = new Error("entropy unavailable");
			try {
				expect(() => tempFileNonce()).toThrow("entropy unavailable");
				expect(() => tempPathFor("/data/accounts.json")).toThrow("entropy unavailable");
			} finally {
				cryptoControl.failure = null;
			}
		});
	});

	describe("tempPathFor", () => {
		it("stages next to the target and keeps the .tmp extension for sweepers", () => {
			const tempPath = tempPathFor("/data/accounts.json");
			expect(tempPath.startsWith("/data/accounts.json.")).toBe(true);
			expect(tempPath.endsWith(".tmp")).toBe(true);
			expect(tempPath).toMatch(/^\/data\/accounts\.json\.\d+\.\d+\.[0-9a-f]{8}\.tmp$/);
		});

		it("handles Windows-style targets (drive letter and backslashes)", () => {
			const tempPath = tempPathFor("C:\\Users\\dev\\.codex\\accounts.json");
			expect(tempPath.startsWith("C:\\Users\\dev\\.codex\\accounts.json.")).toBe(true);
			expect(tempPath.endsWith(".tmp")).toBe(true);
			expect(tempPath).toMatch(
				/^C:\\Users\\dev\\\.codex\\accounts\.json\.\d+\.\d+\.[0-9a-f]{8}\.tmp$/,
			);
		});

		it("never collides for the same target across rapid calls", () => {
			const seen = new Set<string>();
			for (let i = 0; i < 200; i += 1) {
				seen.add(tempPathFor("/data/accounts.json"));
			}
			expect(seen.size).toBe(200);
		});
	});
});
