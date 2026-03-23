import { describe, expect, it, vi } from "vitest";
import { ensureSessionAffinityEntry } from "../lib/runtime/session-affinity-entry.js";

describe("session affinity entry", () => {
	it("delegates config-derived arguments into the session affinity state helper", () => {
		const ensureSessionAffinityState = vi.fn(() => ({
			sessionAffinityStore: { id: 1 },
			sessionAffinityConfigKey: "1000:10",
		}));

		const result = ensureSessionAffinityEntry({
			pluginConfig: {} as never,
			currentStore: null,
			currentConfigKey: null,
			getSessionAffinity: () => true,
			getSessionAffinityTtlMs: () => 1000,
			getSessionAffinityMaxEntries: () => 10,
			createStore: vi.fn(() => ({ id: 1 })),
			ensureSessionAffinityState,
		});

		expect(ensureSessionAffinityState).toHaveBeenCalledWith({
			enabled: true,
			ttlMs: 1000,
			maxEntries: 10,
			currentStore: null,
			currentConfigKey: null,
			createStore: expect.any(Function),
		});
		expect(result).toEqual({
			sessionAffinityStore: { id: 1 },
			sessionAffinityConfigKey: "1000:10",
		});
	});
});
