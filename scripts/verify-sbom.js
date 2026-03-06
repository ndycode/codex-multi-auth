#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

function fail(message) {
	console.error(`verify-sbom failed: ${message}`);
	process.exit(1);
}

function main() {
	const inputPath = resolve(process.argv[2] ?? ".tmp/sbom.cdx.json");
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(inputPath, "utf8"));
	} catch (error) {
		fail(`unable to parse JSON from ${inputPath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!parsed || typeof parsed !== "object") {
		fail("SBOM root must be a JSON object");
	}
	if (parsed.bomFormat !== "CycloneDX") {
		fail(`expected bomFormat CycloneDX, got ${String(parsed.bomFormat)}`);
	}
	if (typeof parsed.specVersion !== "string" || parsed.specVersion.trim().length === 0) {
		fail("specVersion is missing");
	}
	if (!Array.isArray(parsed.components) || parsed.components.length === 0) {
		fail("components array is missing or empty");
	}

	const metadata = parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {};
	const component = metadata.component && typeof metadata.component === "object" ? metadata.component : {};
	const payload = {
		command: "verify-sbom",
		inputPath,
		bomFormat: parsed.bomFormat,
		specVersion: parsed.specVersion,
		componentCount: parsed.components.length,
		rootComponentName: typeof component.name === "string" ? component.name : null,
		rootComponentVersion: typeof component.version === "string" ? component.version : null,
		status: "pass",
	};
	console.log(JSON.stringify(payload, null, 2));
}

main();
