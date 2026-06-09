import { randomBytes } from "node:crypto";

/**
 * Unpredictable nonce for temp/staging file names: `<pid>.<epochMs>.<hex8>`.
 *
 * The random component comes from `crypto.randomBytes` instead of
 * `Math.random()`. `Math.random()` output is predictable once its internal
 * state is known, so a local attacker who can observe one staged path could
 * predict the next one and pre-create (or symlink) it before the atomic
 * write-then-rename lands. An 8-hex-char CSPRNG suffix removes that
 * predictability while keeping names short and `endsWith(".tmp")`-sweepable.
 */
export function tempFileNonce(): string {
	return `${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
}

/**
 * Staging path for an atomic write-then-rename of `targetPath`:
 * `<targetPath>.<pid>.<epochMs>.<hex8>.tmp`.
 *
 * Keeps the trailing `.tmp` extension so existing stale-artifact sweepers
 * (`entry.name.endsWith(".tmp")` in lib/storage.ts, lib/runtime-paths.ts,
 * lib/oc-chatgpt-target-detection.ts) continue to skip/collect staged files.
 */
export function tempPathFor(targetPath: string): string {
	return `${targetPath}.${tempFileNonce()}.tmp`;
}
