#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
	await readFile(new URL("../vendor/provenance.json", import.meta.url), "utf8"),
);

if (!manifest || !Array.isArray(manifest.components)) {
	throw new Error("vendor/provenance.json is missing a valid components array");
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
}

console.log(
	`Vendor provenance ok: ${manifest.components.length} component(s), ${manifest.components.reduce((/** @type {number} */ sum, /** @type {{ files?: unknown[] }} */ component) => sum + (Array.isArray(component.files) ? component.files.length : 0), 0)} file(s) verified`,
);
