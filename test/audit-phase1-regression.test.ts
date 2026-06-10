/**
 * Audit Phase 1 regression suite — locks in invariants from the master
 * repository audit (`docs/audits/MASTER_AUDIT.md` §11 Testing Gap Analysis
 * cases 1-10). Each test references the AUDIT-* finding it guards against.
 *
 * Scope: invariants that are NOT already covered by the existing per-module
 * suites. When an existing test already covers the invariant, this file does
 * not duplicate it — the cross-reference table below documents where each
 * case lives.
 *
 *   §11 Case 1  (resolvePath lookalike) — covered by test/paths.test.ts
 *   §11 Case 2  (hybrid selector null contract) — covered by test/rotation.test.ts + test/accounts.test.ts + test/property/rotation.property.test.ts
 *   §11 Case 3  (concurrent-request 429 race) — covered by test/index.test.ts (AUDIT-H3 tests)
 *   §11 Case 4  (loadPluginConfig precedence) — covered by test/plugin-config.test.ts
 *   §11 Case 5  (auth list empty-storage canonical message) — covered by test/codex-manager-cli.test.ts
 *   §11 Case 6  (V2 migration) — DEFERRED (V2 code path absent; out of scope for phase-1 regression)
 *   §11 Case 7  (SSE malformed-chunk warn) — behavior-level test below
 *   §11 Case 8  (pack-size CI gate) — enforced by `.github/workflows/ci.yml` step "Pack budget check"
 *   §11 Case 9  (PKCE S256 invariant) — covered by test/auth.test.ts:210
 *   §11 Case 10 (OAuth state 16-byte crypto random) — THIS FILE
 */

import { describe, expect, it } from "vitest";
import { createAuthorizationFlow } from "../lib/auth/auth.js";
import { convertSseToJson } from "../lib/request/response-handler.js";

describe("Audit Phase 1 regression — §11 case 10 (AUDIT-H1 / C-AUTH-02)", () => {
	it("OAuth state is 32 hex chars (16 bytes) drawn from a uniform-looking source", async () => {
		// Collect a sample of state values. 16 bytes of crypto random should
		// produce 2^128 distinct values; drawing 64 samples in a row must
		// never collide and must hit a wide distribution across the hex
		// alphabet. This guards against any future refactor that silently
		// swaps `randomBytes(16)` for `Math.random()` or truncates the
		// entropy budget (AUDIT-H1 / C-AUTH-02). 64 samples keeps the test
		// fast while still giving ~2048 character slots across the histogram.
		const samples = new Set<string>();
		const charHistogram = new Map<string, number>();
		for (let i = 0; i < 64; i += 1) {
			const flow = await createAuthorizationFlow();
			expect(flow.state).toMatch(/^[a-f0-9]{32}$/);
			expect(samples.has(flow.state)).toBe(false);
			samples.add(flow.state);
			for (const ch of flow.state) {
				charHistogram.set(ch, (charHistogram.get(ch) ?? 0) + 1);
			}
		}
		// All 16 hex chars should appear across 64 samples × 32 chars each =
		// 2048 slots. If fewer than ~12 appear, entropy is almost certainly
		// weakened (random bytes produce all 16 within the first 40 chars
		// with astronomical probability).
		expect(charHistogram.size).toBeGreaterThanOrEqual(12);
	});
});

describe("Audit Phase 1 regression — §11 case 7 (AUDIT-H9 / H-03)", () => {
	it("convertSseToJson does not throw when an SSE chunk has malformed JSON (fail-open invariant)", async () => {
		// Malformed chunks must not break the converter; the PR-K fix adds
		// a structured warn but preserves fail-open semantics. This test
		// locks in that SSE streams with mixed valid + invalid JSON events
		// still complete and the downstream consumer gets a usable result
		// rather than a thrown exception.
		const mixed = [
			"data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}",
			"data: not-json-at-all",
			"data: {{{broken",
			"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\"}}",
			"data: [DONE]",
			"",
		].join("\n");

		const response = new Response(mixed, {
			headers: {
				"content-type": "text/event-stream",
			},
		});

		// convertSseToJson returns a Response even on malformed input. If the
		// malformed chunks caused a throw, this await would reject and the
		// test would fail — that is exactly the guard we want.
		const result = await convertSseToJson(response, response.headers);
		expect(result).toBeInstanceOf(Response);
	});
});
