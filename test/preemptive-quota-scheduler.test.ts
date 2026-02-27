import { describe, expect, it } from "vitest";
import {
	PreemptiveQuotaScheduler,
	readQuotaSchedulerSnapshot,
} from "../lib/preemptive-quota-scheduler.js";

describe("preemptive quota scheduler", () => {
	it("reads quota snapshot from codex headers", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "99",
			"x-codex-primary-reset-after-seconds": "120",
			"x-codex-secondary-used-percent": "10",
		});

		const snapshot = readQuotaSchedulerSnapshot(headers, 200, 1_000);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.status).toBe(200);
		expect(snapshot?.primary.usedPercent).toBe(99);
		expect(snapshot?.primary.resetAtMs).toBeGreaterThan(1_000);
	});

	it("uses provided now when parsing reset-after seconds", () => {
		const headers = new Headers({
			"x-codex-primary-reset-after-seconds": "120",
		});
		const snapshot = readQuotaSchedulerSnapshot(headers, 200, 5_000);
		expect(snapshot?.primary.resetAtMs).toBe(125_000);
	});

	it("defers requests for known 429 window", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.markRateLimited("acc:model", 30_000, 1_000);

		const decision = scheduler.getDeferral("acc:model", 2_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("rate-limit");
		expect(decision.waitMs).toBeGreaterThan(0);
	});

	it("sanitizes non-finite retry-after values", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.markRateLimited("acc:model", Number.NaN, 1_000);
		const nanDecision = scheduler.getDeferral("acc:model", 1_000);
		expect(nanDecision.defer).toBe(false);

		scheduler.markRateLimited("acc:model", Number.POSITIVE_INFINITY, 2_000);
		const infDecision = scheduler.getDeferral("acc:model", 2_000);
		expect(infDecision.defer).toBe(false);

		scheduler.markRateLimited("acc:model", -1234, 3_000);
		const negativeDecision = scheduler.getDeferral("acc:model", 3_000);
		expect(negativeDecision.defer).toBe(false);
	});

	it("defers when usage is near exhaustion and reset is pending", () => {
		const scheduler = new PreemptiveQuotaScheduler({ usedPercentThreshold: 95 });
		scheduler.update("acc:model", {
			status: 200,
			primary: {
				usedPercent: 97,
				resetAtMs: 70_000,
			},
			secondary: {},
			updatedAt: 10_000,
		});

		const decision = scheduler.getDeferral("acc:model", 20_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("quota-near-exhaustion");
	});

	it("prunes expired snapshots", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.update("a", {
			status: 200,
			primary: { resetAtMs: 1_500 },
			secondary: {},
			updatedAt: 1_000,
		});
		scheduler.update("b", {
			status: 200,
			primary: { resetAtMs: 20_000 },
			secondary: {},
			updatedAt: 1_000,
		});

		const removed = scheduler.prune(2_000);
		expect(removed).toBe(1);
		expect(scheduler.getDeferral("a", 2_100).defer).toBe(false);
		expect(scheduler.getDeferral("b", 2_100).defer).toBe(false);
	});

	it("uses separate 5h/7d remaining thresholds", () => {
		const scheduler = new PreemptiveQuotaScheduler({
			remainingPercentThresholdPrimary: 10,
			remainingPercentThresholdSecondary: 2,
		});
		scheduler.update("acc:model", {
			status: 200,
			primary: { usedPercent: 91, resetAtMs: 65_000 },
			secondary: { usedPercent: 97, resetAtMs: 66_000 },
			updatedAt: 1_000,
		});

		const decision = scheduler.getDeferral("acc:model", 5_000);
		expect(decision.defer).toBe(true);
		expect(decision.reason).toBe("quota-near-exhaustion");
	});

	it("can disable preemptive deferral without clearing snapshots", () => {
		const scheduler = new PreemptiveQuotaScheduler();
		scheduler.markRateLimited("acc:model", 30_000, 1_000);
		expect(scheduler.getDeferral("acc:model", 2_000).defer).toBe(true);

		scheduler.configure({ enabled: false });
		expect(scheduler.getDeferral("acc:model", 2_000).defer).toBe(false);

		scheduler.configure({ enabled: true });
		expect(scheduler.getDeferral("acc:model", 2_000).defer).toBe(true);
	});
});
