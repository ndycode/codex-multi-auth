import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { buildAuthDashboardViewModel } from "../../lib/codex-manager/auth-ui-controller.js";
import { startOpenTuiAuthShell } from "../../runtime/opentui/bootstrap.js";

const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdoutColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const stdoutRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");

function setInteractiveTTY(): void {
	Object.defineProperty(process.stdin, "isTTY", {
		value: true,
		configurable: true,
	});
	Object.defineProperty(process.stdout, "isTTY", {
		value: true,
		configurable: true,
	});
	Object.defineProperty(process.stdout, "columns", {
		value: 120,
		configurable: true,
	});
	Object.defineProperty(process.stdout, "rows", {
		value: 40,
		configurable: true,
	});
}

function restoreTTYDescriptors(): void {
	if (stdinIsTTYDescriptor) {
		Object.defineProperty(process.stdin, "isTTY", stdinIsTTYDescriptor);
	} else {
		delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
	}
	if (stdoutIsTTYDescriptor) {
		Object.defineProperty(process.stdout, "isTTY", stdoutIsTTYDescriptor);
	} else {
		delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
	}
	if (stdoutColumnsDescriptor) {
		Object.defineProperty(process.stdout, "columns", stdoutColumnsDescriptor);
	} else {
		delete (process.stdout as NodeJS.WriteStream & { columns?: number }).columns;
	}
	if (stdoutRowsDescriptor) {
		Object.defineProperty(process.stdout, "rows", stdoutRowsDescriptor);
	} else {
		delete (process.stdout as NodeJS.WriteStream & { rows?: number }).rows;
	}
}

function loadFixtureDashboard() {
	const storage = JSON.parse(
		readFileSync(resolve(process.cwd(), "test/fixtures/v3-storage.json"), "utf-8"),
	) as {
		version: number;
		activeIndex: number;
		accounts: Array<Record<string, unknown>>;
	};

	return buildAuthDashboardViewModel({
		storage: {
			...storage,
			activeIndexByFamily: { codex: storage.activeIndex },
		},
		quotaCache: {
			byAccountId: {},
			byEmail: {},
		},
		displaySettings: {
			showPerAccountRows: true,
			showQuotaDetails: true,
			showForecastReasons: true,
			showRecommendations: true,
			showLiveProbeNotes: true,
			menuAutoFetchLimits: true,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: true,
			menuSortQuickSwitchVisibleRow: true,
		},
		flaggedCount: 0,
		statusMessage: "Fixture-backed OpenTUI smoke",
	});
}

afterEach(() => {
	restoreTTYDescriptors();
});

describe("OpenTUI auth login smoke", () => {
	test("renders the auth shell in supported interactive conditions", async () => {
		setInteractiveTTY();
		const dashboard = loadFixtureDashboard();
		let ready = false;
		let statusLine = "";

		const renderResult = await startOpenTuiAuthShell({
			dashboard,
			onReady: ({ renderer, statusLineRef }) => {
				ready = true;
				statusLine = statusLineRef.plainText;
				renderer.destroy();
			},
		});

		expect(renderResult).not.toBeNull();
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
		expect(ready).toBe(true);
		expect(statusLine).toContain("accounts");
	});
});
