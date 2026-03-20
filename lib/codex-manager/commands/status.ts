import {
	formatAccountLabel,
	formatCooldown,
	formatWaitTime,
} from "../../accounts.js";
import type { ModelFamily } from "../../prompts/codex.js";
import type { AccountStorageV3 } from "../../storage.js";

type LoadedStorage = AccountStorageV3 | null;

export interface StatusCommandDeps {
	setStoragePath: (path: string | null) => void;
	getStoragePath: () => string | null;
	loadAccounts: () => Promise<LoadedStorage>;
	resolveActiveIndex: (
		storage: AccountStorageV3,
		family?: ModelFamily,
	) => number;
	formatRateLimitEntry: (
		account: AccountStorageV3["accounts"][number],
		now: number,
		family: ModelFamily,
	) => string | null;
	getNow?: () => number;
	logInfo?: (message: string) => void;
}

export async function runStatusCommand(
	deps: StatusCommandDeps,
): Promise<number> {
	deps.setStoragePath(null);
	const storage = await deps.loadAccounts();
	const path = deps.getStoragePath();
	const logInfo = deps.logInfo ?? console.log;
	if (!storage || storage.accounts.length === 0) {
		logInfo("No accounts configured.");
		logInfo(`Storage: ${path}`);
		return 0;
	}

	const now = deps.getNow?.() ?? Date.now();
	const activeIndex = deps.resolveActiveIndex(storage, "codex");
	logInfo(`Accounts (${storage.accounts.length})`);
	logInfo(`Storage: ${path}`);
	logInfo("");

	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account) continue;
		const label = formatAccountLabel(account, i);
		const markers: string[] = [];
		if (i === activeIndex) markers.push("current");
		if (account.enabled === false) markers.push("disabled");
		const rateLimit = deps.formatRateLimitEntry(account, now, "codex");
		if (rateLimit) markers.push("rate-limited");
		const cooldown = formatCooldown(account, now);
		if (cooldown) markers.push(`cooldown:${cooldown}`);
		const markerLabel = markers.length > 0 ? ` [${markers.join(", ")}]` : "";
		const lastUsed =
			typeof account.lastUsed === "number" && account.lastUsed > 0
				? `used ${formatWaitTime(now - account.lastUsed)} ago`
				: "never used";
		logInfo(`${i + 1}. ${label}${markerLabel} ${lastUsed}`);
	}

	return 0;
}

export interface FeaturesCommandDeps {
	implementedFeatures: ReadonlyArray<{ id: number; name: string }>;
	logInfo?: (message: string) => void;
}

export function runFeaturesCommand(deps: FeaturesCommandDeps): number {
	const logInfo = deps.logInfo ?? console.log;
	logInfo(`Implemented features (${deps.implementedFeatures.length})`);
	logInfo("");
	for (const feature of deps.implementedFeatures) {
		logInfo(`${feature.id}. ${feature.name}`);
	}
	return 0;
}
