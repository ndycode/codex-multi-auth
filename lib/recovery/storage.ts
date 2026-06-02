/**
 * Storage utilities for reading host runtime session data.
 *
 * Based on Codex-antigravity-auth recovery module.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	MESSAGE_STORAGE,
	PART_STORAGE,
	THINKING_TYPES,
	META_TYPES,
} from "./constants.js";
import { createLogger } from "../logger.js";
import type { StoredMessageMeta, StoredPart, StoredTextPart } from "./types.js";

const recoveryLog = createLogger("recovery-storage");

/**
 * recovery-10: corrupt session files were silently skipped (`continue`) with no
 * signal, so a user could never tell recovery had dropped data. We now quarantine
 * the unreadable file (rename to a `.corrupt-<ts>` sibling, preserving it for
 * inspection rather than deleting) and track a count surfaced via
 * {@link getRecoveryCorruptionStats} so callers can report it.
 */
let corruptFileCount = 0;
const quarantinedPaths: string[] = [];

// Transient read-side faults that are NOT corruption: a Windows lock from
// antivirus / file-indexer / concurrent writer (EBUSY/EPERM/EACCES/EAGAIN) or a
// file that vanished mid-scan (ENOENT) from a concurrent rotation. Quarantining
// (renaming) on these would hide healthy recovery state behind a transient race.
const TRANSIENT_READ_CODES = new Set([
	"EBUSY",
	"EPERM",
	"EACCES",
	"EAGAIN",
	"ENOENT",
]);

function isTransientReadError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && TRANSIENT_READ_CODES.has(code);
}

/**
 * Decide what to do with a file whose read+parse failed (recovery-10).
 *
 * Only a *successful read followed by a parse/validation failure* is treated as
 * corruption and quarantined. A transient FS-lock or ENOENT read error is a
 * race, not corruption, so we leave the file in place and skip it this pass
 * (a later pass reads it cleanly). Returns true when the caller should count it
 * as quarantined corruption, false when it was a transient skip.
 */
function handleUnreadableFile(filePath: string, error: unknown): void {
	if (isTransientReadError(error)) {
		// Transient lock / concurrent-rotation race: do not quarantine, just skip.
		recoveryLog.debug("skipping recovery file on transient read error", {
			path: filePath,
			reason: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	quarantineCorruptFile(filePath, error);
}

function quarantineCorruptFile(filePath: string, error: unknown): void {
	corruptFileCount += 1;
	const reason = error instanceof Error ? error.message : String(error);
	try {
		const target = `${filePath}.corrupt-${Date.now()}`;
		// Route through renameSyncWithRetry so a transient Windows EBUSY/EPERM/
		// ENOTEMPTY/EAGAIN lock on the quarantine move is retried with backoff
		// rather than abandoning a genuinely-corrupt file in place.
		renameSyncWithRetry(filePath, target);
		quarantinedPaths.push(target);
		recoveryLog.warn("quarantined corrupt recovery file", { path: target, reason });
	} catch (renameError) {
		// If we cannot move it (e.g. Windows lock), still record that it was corrupt
		// so the count and log reflect reality; leave the file in place.
		recoveryLog.warn("failed to quarantine corrupt recovery file", {
			path: filePath,
			reason,
			renameError:
				renameError instanceof Error ? renameError.message : String(renameError),
		});
	}
}

/** Snapshot of corrupt-file quarantine activity for this process (recovery-10). */
export function getRecoveryCorruptionStats(): {
	corruptFileCount: number;
	quarantinedPaths: string[];
} {
	return { corruptFileCount, quarantinedPaths: [...quarantinedPaths] };
}

/** Test-only reset of the corruption counters. */
export function __resetRecoveryCorruptionStats(): void {
	corruptFileCount = 0;
	quarantinedPaths.length = 0;
}

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * recovery-02: a file can parse as JSON yet be structurally invalid (missing or
 * non-string `id`/`type`). Such a record must not survive into `messages`/`parts`
 * — downstream code sorts on `part.id.localeCompare(...)` and indexes by id, so a
 * malformed record would crash a later pass instead of being quarantined now.
 * Validate the minimal shape each reader relies on and treat a failure exactly
 * like a parse failure (quarantine via handleUnreadableFile).
 */
function isValidStoredMessage(value: unknown): value is StoredMessageMeta {
	if (typeof value !== "object" || value === null) return false;
	const id = (value as { id?: unknown }).id;
	if (typeof id !== "string" || !SAFE_ID_PATTERN.test(id)) {
		// recovery-02: the id is later used to build filesystem paths (readParts(
		// msg.id)), so a parseable-but-string id like "../poison" must be rejected
		// here and quarantined, not allowed to escape into a path-traversal read.
		return false;
	}
	// recovery-02: readMessages sorts on time.created; a parseable record with a
	// non-numeric created (e.g. "oops") makes the comparator return NaN and falls
	// back to scan order, mis-pointing the index-based recovery paths. When time is
	// present it must carry a finite numeric `created`.
	const time = (value as { time?: unknown }).time;
	if (time !== undefined) {
		if (typeof time !== "object" || time === null) return false;
		const created = (time as { created?: unknown }).created;
		if (created !== undefined && (typeof created !== "number" || !Number.isFinite(created))) {
			return false;
		}
	}
	return true;
}

function isValidStoredPart(value: unknown): value is StoredPart {
	const id = (value as { id?: unknown } | null)?.id;
	return (
		typeof value === "object" &&
		value !== null &&
		typeof id === "string" &&
		SAFE_ID_PATTERN.test(id) &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

/** Error thrown for a parseable-but-structurally-invalid recovery record. */
class InvalidRecoveryRecordError extends Error {
	constructor(detail: string) {
		super(`invalid recovery record: ${detail}`);
		this.name = "InvalidRecoveryRecordError";
	}
}

function validatePathId(id: string, name: string): void {
	if (!SAFE_ID_PATTERN.test(id)) {
		throw new Error(`Invalid ${name}: contains unsafe characters`);
	}
}

// Codes that indicate transient Windows filesystem locks (antivirus,
// file-indexing, concurrent reader) rather than real failures. Align with the
// retry taxonomy already used by scripts/repo-hygiene.js and lib/storage.ts.
const RETRYABLE_FS_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EAGAIN"]);

/**
 * Rename `source` over `target` with bounded retry on transient Windows
 * filesystem lock errors (AV, indexer, concurrent reader). Matches the
 * retry convention used by `renameFileWithRetry` in lib/storage.ts:281
 * (max 4 attempts, exponential backoff 10/20/40/80ms).
 *
 * Uses a synchronous wait budget because atomicWriteFileSync is called from
 * synchronous recovery code paths where async rename is not available.
 */
function renameSyncWithRetry(source: string, target: string): void {
	const maxAttempts = 4;
	let lastError: unknown;
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		try {
			renameSync(source, target);
			return;
		} catch (error) {
			lastError = error;
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			if (!code || !RETRYABLE_FS_CODES.has(code)) {
				throw error;
			}
			if (attempt === maxAttempts - 1) {
				break;
			}
			// Exponential backoff: 10, 20, 40 ms before the next attempt.
			// Synchronous wait is acceptable here because the recovery helper
			// is already on a sync code path and retries only fire on genuine
			// Windows lock contention.
			const waitUntil = Date.now() + 10 * 2 ** attempt;
			while (Date.now() < waitUntil) {
				// busy-wait within budget (cumulative max ~70ms across attempts)
			}
		}
	}
	throw lastError as Error;
}

/**
 * Atomic write: stage the payload to a sibling temp file, then `rename` over
 * the target. Readers either see the old file or the new file — never a
 * partially-written payload.
 *
 * Cleans up the staged file on failure so retries do not accumulate
 * `*.tmp.<rand>` droppings next to the target. Closes AUDIT-M01 / E-03 for
 * the recovery module, matching the pattern already in use by lib/storage.ts.
 *
 * The rename step uses `renameSyncWithRetry` so that transient Windows
 * EBUSY/EPERM/ENOTEMPTY/EAGAIN faults from antivirus or file-indexer locks
 * do not silently drop the payload. See AUDIT-M01 HIGH-2.
 */
function atomicWriteFileSync(
	path: string,
	data: string,
	options: { mode?: number } = {},
): void {
	const tempSuffix = `.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
	const tempPath = `${path}${tempSuffix}`;
	try {
		writeFileSync(tempPath, data, { mode: options.mode ?? 0o600 });
		renameSyncWithRetry(tempPath, path);
	} catch (error) {
		try {
			unlinkSync(tempPath);
		} catch {
			// Ignore cleanup failure: the original write error is more useful to
			// callers than a secondary ENOENT from an already-gone temp file.
		}
		throw error;
	}
}

/**
 * Best-effort delete with bounded retry for transient Windows lock errors.
 * Returns true on successful removal, false on missing file or exhausted
 * retries. Never throws.
 */
function safeUnlinkWithRetry(filePath: string, maxAttempts = 4): boolean {
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		try {
			unlinkSync(filePath);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			if (code === "ENOENT") return false;
			if (
				!code ||
				!RETRYABLE_FS_CODES.has(code) ||
				attempt === maxAttempts - 1
			) {
				return false;
			}
			// Small synchronous backoff; recovery storage is not on a hot path, so
			// a handful of milliseconds here is cheaper than leaving orphan files.
			const waitUntil = Date.now() + 2 ** attempt * 5;
			while (Date.now() < waitUntil) {
				// busy-wait within budget (max ~40ms across four attempts)
			}
		}
	}
	return false;
}

// =============================================================================
// ID Generation
// =============================================================================

export function generatePartId(): string {
	const timestamp = Date.now().toString(16);
	const random = Math.random().toString(36).substring(2, 10);
	return `prt_${timestamp}${random}`;
}

/**
 * Counter used to disambiguate synthetic thinking-part ids produced within
 * the same millisecond. Combined with the millisecond timestamp and a random
 * suffix, this guarantees each invocation of `prependThinkingPart` writes a
 * distinct file instead of clobbering a prior synthetic part (RPTU-001).
 */
let thinkingPartCounter = 0;

/**
 * Generate a unique id for a synthetic thinking part.
 *
 * The id keeps the `prt_0000000000_thinking` prefix so it still sorts
 * lexicographically before any id produced by `generatePartId()` (those
 * start with a non-zero hex timestamp), which preserves the "prepend"
 * ordering relied on by `findMessagesWithOrphanThinking` and
 * `findMessageByIndexNeedingThinking`. The suffix — millisecond timestamp
 * (hex), monotonic counter, and short random token — makes the id unique
 * per invocation so that repeat recovery passes on the same message do not
 * overwrite the prior synthetic part (RPTU-001).
 */
export function generateThinkingPartId(): string {
	const timestamp = Date.now().toString(16);
	const counter = (thinkingPartCounter++).toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `prt_0000000000_thinking_${timestamp}_${counter}_${random}`;
}

// =============================================================================
// Directory Helpers
// =============================================================================

export function getMessageDir(sessionID: string): string {
	validatePathId(sessionID, "sessionID");
	if (!existsSync(MESSAGE_STORAGE)) return "";

	const directPath = join(MESSAGE_STORAGE, sessionID);
	if (existsSync(directPath)) {
		return directPath;
	}

	// Search in subdirectories
	try {
		for (const dir of readdirSync(MESSAGE_STORAGE)) {
			const sessionPath = join(MESSAGE_STORAGE, dir, sessionID);
			if (existsSync(sessionPath)) {
				return sessionPath;
			}
		}
	} catch {
		// Ignore read errors
	}

	return "";
}

// =============================================================================
// Message Reading
// =============================================================================

export function readMessages(sessionID: string): StoredMessageMeta[] {
	const messageDir = getMessageDir(sessionID);
	if (!messageDir || !existsSync(messageDir)) return [];

	const messages: StoredMessageMeta[] = [];
	try {
		for (const file of readdirSync(messageDir)) {
			if (!file.endsWith(".json")) continue;
			const filePath = join(messageDir, file);
			try {
				const content = readFileSync(filePath, "utf-8");
				const parsed: unknown = JSON.parse(content);
				if (!isValidStoredMessage(parsed)) {
					throw new InvalidRecoveryRecordError("message missing string id");
				}
				messages.push(parsed);
			} catch (error) {
				// recovery-10: quarantine genuine corruption; skip transient FS-lock /
				// ENOENT races (handleUnreadableFile classifies) instead of renaming a
				// healthy file that was momentarily locked or concurrently rotated.
				// recovery-02: a parseable-but-structurally-invalid record (no string
				// id) is corruption too — quarantine it here rather than letting it
				// crash a later id-based sort/index pass.
				handleUnreadableFile(filePath, error);
				continue;
			}
		}
	} catch {
		return [];
	}

	return messages.sort((a, b) => {
		const aTime = a?.time?.created ?? 0;
		const bTime = b?.time?.created ?? 0;
		if (aTime !== bTime) return aTime - bTime;
		// recovery-02: a parseable-but-malformed record can lack `id`; guard the
		// comparator so a missing/non-string id cannot throw out of the sort (which
		// runs outside the per-file try/catch above) and crash readMessages.
		const aId = typeof a?.id === "string" ? a.id : "";
		const bId = typeof b?.id === "string" ? b.id : "";
		return aId.localeCompare(bId);
	});
}

// =============================================================================
// Part Reading
// =============================================================================

export function readParts(messageID: string): StoredPart[] {
	validatePathId(messageID, "messageID");
	const partDir = join(PART_STORAGE, messageID);
	if (!existsSync(partDir)) return [];

	const parts: StoredPart[] = [];
	try {
		for (const file of readdirSync(partDir)) {
			if (!file.endsWith(".json")) continue;
			const filePath = join(partDir, file);
			try {
				const content = readFileSync(filePath, "utf-8");
				const parsed: unknown = JSON.parse(content);
				if (!isValidStoredPart(parsed)) {
					throw new InvalidRecoveryRecordError("part missing string id/type");
				}
				parts.push(parsed);
			} catch (error) {
				// recovery-10: quarantine genuine corruption; skip transient FS-lock /
				// ENOENT races (handleUnreadableFile classifies) instead of renaming a
				// healthy file that was momentarily locked or concurrently rotated.
				// recovery-02: a parseable record missing a string id/type is corruption
				// too — quarantine here so the id-sort in findMessagesWithOrphanThinking
				// (and type checks elsewhere) can't crash on it.
				handleUnreadableFile(filePath, error);
				continue;
			}
		}
	} catch {
		return [];
	}

	return parts;
}

// =============================================================================
// Content Helpers
// =============================================================================

export function hasContent(part: StoredPart): boolean {
	if (THINKING_TYPES.has(part.type)) return false;
	if (META_TYPES.has(part.type)) return false;

	if (part.type === "text") {
		const textPart = part as StoredTextPart;
		return !!textPart.text?.trim();
	}

	if (part.type === "tool" || part.type === "tool_use") {
		return true;
	}

	if (part.type === "tool_result") {
		return true;
	}

	return false;
}

export function messageHasContent(messageID: string): boolean {
	const parts = readParts(messageID);
	return parts.some(hasContent);
}

// =============================================================================
// Part Injection (for recovery)
// =============================================================================

export function injectTextPart(
	sessionID: string,
	messageID: string,
	text: string,
): boolean {
	// recovery-03: validate before joining into a filesystem path, matching the
	// read path. Without this, a crafted messageID could escape PART_STORAGE.
	validatePathId(messageID, "messageID");
	const partDir = join(PART_STORAGE, messageID);

	try {
		if (!existsSync(partDir)) {
			mkdirSync(partDir, { recursive: true });
		}

		const partId = generatePartId();
		const part: StoredTextPart = {
			id: partId,
			sessionID,
			messageID,
			type: "text",
			text,
			synthetic: true,
		};

		atomicWriteFileSync(
			join(partDir, `${partId}.json`),
			JSON.stringify(part, null, 2),
			{ mode: 0o600 },
		);
		return true;
	} catch {
		return false;
	}
}

// =============================================================================
// Thinking Block Recovery
// =============================================================================

export function findMessagesWithThinkingBlocks(sessionID: string): string[] {
	const messages = readMessages(sessionID);
	const result: string[] = [];

	for (const msg of messages) {
		if (msg.role !== "assistant") continue;

		const parts = readParts(msg.id);
		const hasThinking = parts.some((p) => THINKING_TYPES.has(p.type));
		if (hasThinking) {
			result.push(msg.id);
		}
	}

	return result;
}

export function findMessagesWithThinkingOnly(sessionID: string): string[] {
	const messages = readMessages(sessionID);
	const result: string[] = [];

	for (const msg of messages) {
		if (msg.role !== "assistant") continue;

		const parts = readParts(msg.id);
		if (parts.length === 0) continue;

		const hasThinking = parts.some((p) => THINKING_TYPES.has(p.type));
		const hasTextContent = parts.some(hasContent);

		// Has thinking but no text content = orphan thinking
		if (hasThinking && !hasTextContent) {
			result.push(msg.id);
		}
	}

	return result;
}

export function findMessagesWithOrphanThinking(sessionID: string): string[] {
	const messages = readMessages(sessionID);
	const result: string[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg || msg.role !== "assistant") continue;

		const parts = readParts(msg.id);
		if (parts.length === 0) continue;

		const sortedParts = [...parts].sort((a, b) => a.id.localeCompare(b.id));
		const firstPart = sortedParts[0];
		if (!firstPart) continue;

		const firstIsThinking = THINKING_TYPES.has(firstPart.type);

		// If first part is not thinking, it's orphan
		if (!firstIsThinking) {
			result.push(msg.id);
		}
	}

	return result;
}

export function prependThinkingPart(
	sessionID: string,
	messageID: string,
): boolean {
	validatePathId(messageID, "messageID"); // recovery-03
	const partDir = join(PART_STORAGE, messageID);

	try {
		if (!existsSync(partDir)) {
			mkdirSync(partDir, { recursive: true });
		}

		// RPTU-001: the id MUST be unique per invocation so that repeat recovery
		// passes on the same messageID do not overwrite a prior synthetic
		// thinking part. The `prt_0000000000_thinking_` prefix keeps the id
		// sorted before any real part id (which begins with a non-zero hex
		// timestamp after the `prt_` prefix), so the part still acts as a
		// prepend for `findMessagesWithOrphanThinking`.
		const partId = generateThinkingPartId();
		const part = {
			id: partId,
			sessionID,
			messageID,
			type: "thinking",
			thinking: "",
			synthetic: true,
		};

		atomicWriteFileSync(
			join(partDir, `${partId}.json`),
			JSON.stringify(part, null, 2),
			{ mode: 0o600 },
		);
		return true;
	} catch {
		return false;
	}
}

export function stripThinkingParts(messageID: string): boolean {
	validatePathId(messageID, "messageID"); // recovery-03
	const partDir = join(PART_STORAGE, messageID);
	if (!existsSync(partDir)) return false;

	let anyRemoved = false;
	let anyTargetFailed = false;
	try {
		for (const file of readdirSync(partDir)) {
			if (!file.endsWith(".json")) continue;
			try {
				const filePath = join(partDir, file);
				const content = readFileSync(filePath, "utf-8");
				const part = JSON.parse(content) as StoredPart;
				if (THINKING_TYPES.has(part.type)) {
					if (safeUnlinkWithRetry(filePath)) {
						anyRemoved = true;
					} else {
						// recovery-05: a thinking part we targeted could NOT be removed.
						// Reporting success here would let the auto-resume loop believe
						// the message is clean and retry forever, burning quota.
						anyTargetFailed = true;
					}
				}
			} catch {
				continue;
			}
		}
	} catch {
		return false;
	}

	// Only report success when every targeted thinking part was actually removed.
	return anyRemoved && !anyTargetFailed;
}

// =============================================================================
// Empty Message Recovery
// =============================================================================

export function findEmptyMessages(sessionID: string): string[] {
	const messages = readMessages(sessionID);
	const emptyIds: string[] = [];

	for (const msg of messages) {
		if (!messageHasContent(msg.id)) {
			emptyIds.push(msg.id);
		}
	}

	return emptyIds;
}

export function findEmptyMessageByIndex(
	sessionID: string,
	targetIndex: number,
): string | null {
	const messages = readMessages(sessionID);

	// API index may differ from storage index due to system messages
	const indicesToTry = [targetIndex, targetIndex - 1, targetIndex - 2];

	for (const idx of indicesToTry) {
		if (idx < 0 || idx >= messages.length) continue;

		const targetMsg = messages[idx];
		if (!targetMsg) continue;

		if (!messageHasContent(targetMsg.id)) {
			return targetMsg.id;
		}
	}

	return null;
}

export function findMessageByIndexNeedingThinking(
	sessionID: string,
	targetIndex: number,
): string | null {
	const messages = readMessages(sessionID);

	if (targetIndex < 0 || targetIndex >= messages.length) return null;

	const targetMsg = messages[targetIndex];
	if (!targetMsg || targetMsg.role !== "assistant") return null;

	const parts = readParts(targetMsg.id);
	if (parts.length === 0) return null;

	const sortedParts = [...parts].sort((a, b) => a.id.localeCompare(b.id));
	const firstPart = sortedParts[0];
	if (!firstPart) return null;

	const firstIsThinking = THINKING_TYPES.has(firstPart.type);

	if (!firstIsThinking) {
		return targetMsg.id;
	}

	return null;
}

export function replaceEmptyTextParts(
	messageID: string,
	replacementText: string,
): boolean {
	validatePathId(messageID, "messageID"); // recovery-03
	const partDir = join(PART_STORAGE, messageID);
	if (!existsSync(partDir)) return false;

	let anyReplaced = false;
	try {
		for (const file of readdirSync(partDir)) {
			if (!file.endsWith(".json")) continue;
			try {
				const filePath = join(partDir, file);
				const content = readFileSync(filePath, "utf-8");
				const part = JSON.parse(content) as StoredPart;

				if (part.type === "text") {
					const textPart = part as StoredTextPart;
					if (!textPart.text?.trim()) {
						textPart.text = replacementText;
						textPart.synthetic = true;
						atomicWriteFileSync(filePath, JSON.stringify(textPart, null, 2));
						anyReplaced = true;
					}
				}
			} catch {
				continue;
			}
		}
	} catch {
		return false;
	}

	return anyReplaced;
}

export function findMessagesWithEmptyTextParts(sessionID: string): string[] {
	const messages = readMessages(sessionID);
	const result: string[] = [];

	for (const msg of messages) {
		const parts = readParts(msg.id);
		const hasEmptyTextPart = parts.some((p) => {
			if (p.type !== "text") return false;
			const textPart = p as StoredTextPart;
			return !textPart.text?.trim();
		});

		if (hasEmptyTextPart) {
			result.push(msg.id);
		}
	}

	return result;
}
