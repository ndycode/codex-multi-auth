import { describe, expect, it, vi } from "vitest";
import { ensureRefreshGuardianEntry } from "../lib/runtime/refresh-guardian-entry.js";

describe("refresh guardian entry", () => {
	it("delegates config-derived arguments into the refresh guardian state helper", () => {
		const ensureRefreshGuardianState = vi.fn(() => ({
			refreshGuardian: { id: 1 },
			refreshGuardianConfigKey: "1000:100",
		}));

		const result = ensureRefreshGuardianEntry({
			pluginConfig: {} as never,
			currentGuardian: null,
			currentConfigKey: null,
			getProactiveRefreshGuardian: () => true,
			getProactiveRefreshIntervalMs: () => 1000,
			getProactiveRefreshBufferMs: () => 100,
			createGuardian: vi.fn(() => ({ id: 1 })),
			registerCleanup: vi.fn(),
			ensureRefreshGuardianState,
		});

		expect(ensureRefreshGuardianState).toHaveBeenCalledWith({
			enabled: true,
			intervalMs: 1000,
			bufferMs: 100,
			currentGuardian: null,
			currentConfigKey: null,
			createGuardian: expect.any(Function),
			registerCleanup: expect.any(Function),
		});
		expect(result).toEqual({
			refreshGuardian: { id: 1 },
			refreshGuardianConfigKey: "1000:100",
		});
	});
});
