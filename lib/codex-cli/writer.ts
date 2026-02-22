import { existsSync, promises as fs } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../logger.js";
import { clearCodexCliStateCache, getCodexCliAccountsPath, isCodexCliSyncEnabled } from "./state.js";
import {
	incrementCodexCliMetric,
	makeAccountFingerprint,
} from "./observability.js";

const log = createLogger("codex-cli-writer");

interface ActiveSelection {
	accountId?: string;
	email?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeEmail(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().toLowerCase();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readAccountId(record: Record<string, unknown>): string | undefined {
	const keys = ["accountId", "account_id", "workspace_id", "organization_id", "id"];
	for (const key of keys) {
		const value = record[key];
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return undefined;
}

function resolveMatchIndex(
	accounts: unknown[],
	selection: ActiveSelection,
): number {
	const desiredId = selection.accountId?.trim();
	const desiredEmail = normalizeEmail(selection.email);

	if (desiredId) {
		const byId = accounts.findIndex((entry) => {
			if (!isRecord(entry)) return false;
			return readAccountId(entry) === desiredId;
		});
		if (byId >= 0) return byId;
	}

	if (desiredEmail) {
		const byEmail = accounts.findIndex((entry) => {
			if (!isRecord(entry)) return false;
			return normalizeEmail(entry.email) === desiredEmail;
		});
		if (byEmail >= 0) return byEmail;
	}

	return -1;
}

export async function setCodexCliActiveSelection(
	selection: ActiveSelection,
): Promise<boolean> {
	if (!isCodexCliSyncEnabled()) return false;

	const path = getCodexCliAccountsPath();
	if (!existsSync(path)) return false;
	incrementCodexCliMetric("writeAttempts");

	try {
		const raw = await fs.readFile(path, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed) || !Array.isArray(parsed.accounts)) {
			incrementCodexCliMetric("writeFailures");
			log.warn("Failed to persist Codex CLI active selection", {
				operation: "write-active-selection",
				outcome: "malformed",
				path,
			});
			return false;
		}

		const matchIndex = resolveMatchIndex(parsed.accounts, selection);
		if (matchIndex < 0) {
			incrementCodexCliMetric("writeFailures");
			log.warn("Failed to persist Codex CLI active selection", {
				operation: "write-active-selection",
				outcome: "no-match",
				path,
				accountRef: makeAccountFingerprint({
					accountId: selection.accountId,
					email: selection.email,
				}),
			});
			return false;
		}

		const chosen = parsed.accounts[matchIndex];
		if (!isRecord(chosen)) {
			incrementCodexCliMetric("writeFailures");
			log.warn("Failed to persist Codex CLI active selection", {
				operation: "write-active-selection",
				outcome: "invalid-account-record",
				path,
			});
			return false;
		}

		const next = { ...parsed };
		const chosenAccountId = readAccountId(chosen) ?? selection.accountId?.trim();
		const chosenEmail = normalizeEmail(chosen.email) ?? normalizeEmail(selection.email);

		if (chosenAccountId) {
			next.activeAccountId = chosenAccountId;
			next.active_account_id = chosenAccountId;
		}
		if (chosenEmail) {
			next.activeEmail = chosenEmail;
			next.active_email = chosenEmail;
		}

		next.accounts = parsed.accounts.map((entry, index) => {
			if (!isRecord(entry)) return entry;
			const updated = { ...entry };
			updated.active = index === matchIndex;
			updated.isActive = index === matchIndex;
			updated.is_active = index === matchIndex;
			return updated;
		});

		const tempPath = `${path}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
		await fs.mkdir(dirname(path), { recursive: true });
		await fs.writeFile(tempPath, JSON.stringify(next, null, 2), {
			encoding: "utf-8",
			mode: 0o600,
		});
		await fs.rename(tempPath, path);
		clearCodexCliStateCache();
		incrementCodexCliMetric("writeSuccesses");
		log.debug("Persisted Codex CLI active selection", {
			operation: "write-active-selection",
			outcome: "success",
			path,
			accountRef: makeAccountFingerprint({
				accountId: chosenAccountId,
				email: chosenEmail,
			}),
		});
		return true;
	} catch (error) {
		incrementCodexCliMetric("writeFailures");
		log.warn("Failed to persist Codex CLI active selection", {
			operation: "write-active-selection",
			outcome: "error",
			path,
			accountRef: makeAccountFingerprint({
				accountId: selection.accountId,
				email: selection.email,
			}),
			error: String(error),
		});
		return false;
	}
}
