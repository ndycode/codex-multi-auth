import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type JsonSchema = {
	type?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	additionalProperties?: boolean;
};

const projectRoot = process.cwd();

function readJson(relativePath: string): unknown {
	return JSON.parse(
		readFileSync(path.join(projectRoot, relativePath), "utf8"),
	) as unknown;
}

function validateAgainstSchema(
	value: unknown,
	schema: JsonSchema,
	pathLabel = "$",
): string[] {
	const errors: string[] = [];

	if (schema.type === "object") {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			errors.push(`${pathLabel} must be an object`);
			return errors;
		}

		const record = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (!(key in record)) {
				errors.push(`${pathLabel}.${key} is required`);
			}
		}

		for (const [key, propertySchema] of Object.entries(
			schema.properties ?? {},
		)) {
			if (!(key in record)) continue;
			errors.push(
				...validateAgainstSchema(
					record[key],
					propertySchema,
					`${pathLabel}.${key}`,
				),
			);
		}
		return errors;
	}

	if (schema.type === "array") {
		if (!Array.isArray(value)) {
			errors.push(`${pathLabel} must be an array`);
			return errors;
		}
		if (schema.items) {
			value.forEach((item, index) => {
				errors.push(
					...validateAgainstSchema(
						item,
						schema.items as JsonSchema,
						`${pathLabel}[${index}]`,
					),
				);
			});
		}
		return errors;
	}

	if (schema.type === "string") {
		if (typeof value !== "string") {
			errors.push(`${pathLabel} must be a string`);
		}
		return errors;
	}

	return errors;
}

describe("config schema templates", () => {
	const schema = readJson("config/schema/config.schema.json") as JsonSchema;

	it("validates shipped config templates against the schema", () => {
		for (const file of [
			"config/codex-modern.json",
			"config/codex-legacy.json",
			"config/minimal-codex.json",
		]) {
			const payload = readJson(file);
			expect(validateAgainstSchema(payload, schema), file).toEqual([]);
		}
	});

	it("rejects a config missing required root fields", () => {
		const invalid = {
			plugin: ["codex-multi-auth"],
		};
		expect(validateAgainstSchema(invalid, schema)).toContain(
			"$.provider is required",
		);
	});

	it("rejects wrong primitive types for required fields", () => {
		const invalid = {
			plugin: [123],
			provider: "openai",
		};
		expect(validateAgainstSchema(invalid, schema)).toEqual([
			"$.plugin[0] must be a string",
			"$.provider must be an object",
		]);
	});
});
