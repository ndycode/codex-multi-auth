import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildConfigJsonSchema,
	CONFIG_SCHEMA_RELATIVE_PATH,
	renderConfigJsonSchema,
} from "../lib/config-schema.js";
import { PluginConfigSchema } from "../lib/schemas.js";

const committedPath = path.join(process.cwd(), CONFIG_SCHEMA_RELATIVE_PATH);

/**
 * Drift guard for audit roadmap §4.5.2: config/schema/config.schema.json is
 * generated from the zod PluginConfigSchema. If PluginConfigSchema (or the
 * generator) changes without regenerating the committed file, these tests
 * fail. Fix: run `npm run generate:schema` and commit the result.
 */
describe("config.schema.json is generated from PluginConfigSchema", () => {
	let committedRaw = "";

	beforeAll(() => {
		// Read inside beforeAll so a missing/locked file surfaces as a named
		// test failure with remediation, not an ENOENT at collection time.
		try {
			// Normalize CRLF as belt-and-braces for checkouts that predate the
			// .gitattributes eol=lf pin; the renderer always emits LF.
			committedRaw = readFileSync(committedPath, "utf8").replace(
				/\r\n/g,
				"\n",
			);
		} catch (error) {
			throw new Error(
				`could not read ${CONFIG_SCHEMA_RELATIVE_PATH} — run \`npm run generate:schema\` and commit the result (${String(error)})`,
			);
		}
	});

	it("committed schema deep-equals the in-memory regeneration (if this fails, run `npm run generate:schema`)", () => {
		expect(
			JSON.parse(committedRaw),
			"config/schema/config.schema.json is out of date — run `npm run generate:schema` and commit the result",
		).toEqual(buildConfigJsonSchema());
	});

	// This doubles as the cross-process determinism check: the committed file
	// was rendered by a separate generator invocation, so byte-equality here
	// proves a fresh render reproduces it exactly.
	it("committed schema matches the serialized output byte-for-byte (if this fails, run `npm run generate:schema`)", () => {
		expect(
			committedRaw,
			"config/schema/config.schema.json serialization drifted — run `npm run generate:schema` and commit the result",
		).toBe(renderConfigJsonSchema());
	});

	it("covers every PluginConfigSchema field and preserves root metadata", () => {
		const schema = buildConfigJsonSchema() as {
			$schema?: string;
			$id?: string;
			title?: string;
			$defs?: {
				pluginConfig?: { properties?: Record<string, unknown> };
			};
		};

		expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
		expect(schema.$id).toBe(
			"https://codex-multi-auth.local/schema/config.schema.json",
		);
		expect(schema.title).toBe("codex-multi-auth config template");

		// Structural invariants of the document (cheap stand-in for a full
		// metaschema validation, which would require a new validator dep).
		const doc = schema as unknown as {
			type?: unknown;
			properties?: unknown;
			required?: unknown;
		};
		expect(doc.type).toBe("object");
		expect(doc.properties).toBeTypeOf("object");
		expect(doc.required).toEqual(["plugin", "provider"]);
		expect(schema.$defs?.pluginConfig?.properties).toBeTypeOf("object");

		const generatedKeys = Object.keys(
			schema.$defs?.pluginConfig?.properties ?? {},
		).sort();
		const zodKeys = Object.keys(PluginConfigSchema.shape).sort();
		expect(generatedKeys).toEqual(zodKeys);
		expect(zodKeys.length).toBeGreaterThan(0);
	});
});
