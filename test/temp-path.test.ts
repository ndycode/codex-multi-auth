import { describe, it, expect } from "vitest";
import { tempFileNonce, tempPathFor } from "../lib/temp-path.js";

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
	});

	describe("tempPathFor", () => {
		it("stages next to the target and keeps the .tmp extension for sweepers", () => {
			const tempPath = tempPathFor("/data/accounts.json");
			expect(tempPath.startsWith("/data/accounts.json.")).toBe(true);
			expect(tempPath.endsWith(".tmp")).toBe(true);
			expect(tempPath).toMatch(/^\/data\/accounts\.json\.\d+\.\d+\.[0-9a-f]{8}\.tmp$/);
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
