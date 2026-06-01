#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const manifest = JSON.parse(
	await readFile(new URL("../vendor/provenance.json", import.meta.url), "utf8"),
);

if (!manifest || !Array.isArray(manifest.components)) {
	throw new Error("vendor/provenance.json is missing a valid components array");
}

/**
 * Recursively list every file under a directory, as repo-relative POSIX paths.
 * @param {string} relRoot repo-relative root (e.g. "vendor/codex-ai-plugin")
 * @returns {Promise<string[]>}
 */
async function listFilesUnder(relRoot) {
	/** @type {string[]} */
	const out = [];
	/** @param {string} rel */
	async function walk(rel) {
		const dirUrl = new URL(`../${rel}`, import.meta.url);
		const entries = await readdir(dirUrl, { withFileTypes: true });
		for (const entry of entries) {
			const childRel = `${rel}/${entry.name}`;
			if (entry.isDirectory()) {
				await walk(childRel);
			} else if (entry.isFile()) {
				out.push(childRel);
			} else if (entry.isSymbolicLink()) {
				// install-scripts-01: a symlink under a vendored root could point an
				// unlisted artifact (or escape the tree) past the manifest check.
				// Fail closed instead of silently skipping it.
				throw new Error(
					`Symbolic links are not allowed in vendored content: ${childRel}`,
				);
			} else {
				// Any other dirent type (FIFO, socket, block/char device) is unexpected
				// in vendored source — reject rather than ignore.
				throw new Error(`Unsupported vendored entry type: ${childRel}`);
			}
		}
	}
	await walk(relRoot);
	return out;
}

for (const component of manifest.components) {
	if (
		!component ||
		!Array.isArray(component.files) ||
		component.files.length === 0
	) {
		throw new Error(
			`Component provenance entry is invalid: ${JSON.stringify(component)}`,
		);
	}
	for (const file of component.files) {
		if (!file?.path || !file?.sha256) {
			throw new Error(`Invalid file provenance entry in ${component.name}`);
		}
		let content;
		try {
			content = await readFile(new URL(`../${file.path}`, import.meta.url));
		} catch (error) {
			const code =
				error && typeof error === "object"
					? /** @type {{ code?: string }} */ (error).code
					: undefined;
			if (code === "ENOENT") {
				throw new Error(
					`Vendor file not found in ${component.name}: ${file.path} (${code})`,
				);
			}
			throw error;
		}
		const actual = createHash("sha256").update(content).digest("hex");
		if (actual !== file.sha256) {
			throw new Error(
				`Vendor provenance mismatch for ${file.path}: expected ${file.sha256}, got ${actual}`,
			);
		}
	}

	// install-scripts-01: verifying only the manifest's listed files lets a rogue
	// file added to a vendored dir pass silently. Enumerate the component root and
	// fail if any on-disk file is not in the manifest (extra/unlisted file).
	if (component.root) {
		const manifestPaths = new Set(
			component.files.map((/** @type {{ path: string }} */ f) => f.path),
		);
		let onDisk;
		try {
			onDisk = await listFilesUnder(component.root);
		} catch (error) {
			const code =
				error && typeof error === "object"
					? /** @type {{ code?: string }} */ (error).code
					: undefined;
			throw new Error(
				`Failed to enumerate vendor root for ${component.name} (${component.root}): ${code ?? error}`,
			);
		}
		const extras = onDisk.filter((path) => !manifestPaths.has(path));
		if (extras.length > 0) {
			throw new Error(
				`Unlisted vendor file(s) in ${component.name}: ${extras.join(", ")}. ` +
					`Every file under ${component.root} must be declared in vendor/provenance.json.`,
			);
		}
	}
}

console.log(
	`Vendor provenance ok: ${manifest.components.length} component(s), ${manifest.components.reduce((/** @type {number} */ sum, /** @type {{ files?: unknown[] }} */ component) => sum + (Array.isArray(component.files) ? component.files.length : 0), 0)} file(s) verified`,
);
