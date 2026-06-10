#!/usr/bin/env node
/**
 * Regenerate config/schema/config.schema.json from the zod PluginConfigSchema
 * (audit roadmap §4.5.2). The schema content lives in lib/config-schema.ts;
 * this script just writes its deterministic serialization to disk.
 *
 * Run via `npm run generate:schema` (which builds dist/ first — this script
 * imports the compiled output because lib/ is TypeScript).
 *
 * Drift guard: test/config-schema-generated.test.ts fails whenever the
 * committed file no longer matches the generated output.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

let renderConfigJsonSchema;
try {
	({ renderConfigJsonSchema } = await import("../dist/lib/config-schema.js"));
} catch (error) {
	console.error(
		"Failed to import dist/lib/config-schema.js — run `npm run build` first (or use `npm run generate:schema`, which builds automatically).",
	);
	throw error;
}

const targetUrl = new URL(
	"../config/schema/config.schema.json",
	import.meta.url,
);
await writeFile(targetUrl, renderConfigJsonSchema(), "utf8");
console.log(`Wrote ${fileURLToPath(targetUrl)}`);
