import * as fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function normalizePathForCompare(path) {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getDefaultPaths() {
	const src = join(__dirname, "..", "lib", "oauth-success.html");
	const dest = join(__dirname, "..", "dist", "lib", "oauth-success.html");
	return { src, dest };
}

/**
 * Pause execution for the requested number of milliseconds.
 * @param {number} delayMs milliseconds to wait
 */
async function sleep(delayMs) {
	return new Promise((resolve) => {
		setTimeout(resolve, delayMs);
	});
}

/**
 * Copy a file and retry automatically while the destination is temporarily locked.
 * @param {string} src absolute path to the source HTML file
 * @param {string} dest absolute path to the destination HTML file
 * @param {{ maxAttempts?: number, backoffMs?: number }} options retry configuration
 */
async function copyWithRetry(
	src,
	dest,
	{ maxAttempts = 3, backoffMs = 50 } = {},
) {
	let attempt = 0;
	for (;;) {
		try {
			await fs.copyFile(src, dest);
			return;
		} catch (err) {
			const isBusy = err && typeof err === "object" && err.code === "EBUSY";
			if (!isBusy || attempt >= maxAttempts - 1) {
				throw err;
			}
			attempt += 1;
			await sleep(backoffMs * attempt);
		}
	}
}

/**
 * Copy the OAuth success HTML into dist/, ensuring safe directory creation and retries.
 * @param {{ src?: string, dest?: string }} options optional override paths for testing
 */
export async function copyOAuthSuccessHtml(options = {}) {
	const defaults = getDefaultPaths();
	const src = options.src ?? defaults.src;
	const dest = options.dest ?? defaults.dest;

	await fs.mkdir(dirname(dest), { recursive: true });
	await copyWithRetry(src, dest);

	return { src, dest };
}

const isDirectRun = (() => {
	if (!process.argv[1]) return false;
	return (
		normalizePathForCompare(process.argv[1]) ===
		normalizePathForCompare(__filename)
	);
})();

if (isDirectRun) {
	await copyOAuthSuccessHtml();
}
