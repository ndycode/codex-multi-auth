import { isRecord } from "../../utils.js";

export interface ToolFunction {
	name: string;
	description?: string;
	parameters?: {
		type: "object";
		properties?: Record<string, unknown>;
		required?: string[];
		[key: string]: unknown;
	};
}

export interface Tool {
	type: "function";
	function: ToolFunction;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	return cloneJsonRecord(value);
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
	const seen = new WeakSet<object>();
	return cloneJsonValue(value, seen) as Record<string, unknown>;
}

function cloneJsonValue(value: unknown, seen: WeakSet<object>): unknown {
	if (value === null) return null;
	const valueType = typeof value;
	if (valueType === "string" || valueType === "number" || valueType === "boolean") {
		return value;
	}
	if (valueType === "bigint") {
		// Keep current behavior parity with JSON.stringify, which throws on bigint.
		throw new TypeError("Cannot serialize bigint value");
	}
	if (valueType !== "object") {
		// JSON serialization drops undefined/symbol/function in object fields.
		return undefined;
	}

	if (Array.isArray(value)) {
		if (seen.has(value)) {
			throw new TypeError("Cannot clone circular value");
		}
		seen.add(value);
		const clonedArray = value.map((entry) => {
			const cloned = cloneJsonValue(entry, seen);
			// JSON.stringify array semantics convert undefined to null.
			return cloned === undefined ? null : cloned;
		});
		seen.delete(value);
		return clonedArray;
	}

	const inputObject = value as Record<string, unknown>;
	if (seen.has(inputObject)) {
		throw new TypeError("Cannot clone circular value");
	}
	seen.add(inputObject);
	const clonedObject: Record<string, unknown> = {};
	for (const key of Object.keys(inputObject)) {
		const cloned = cloneJsonValue(inputObject[key], seen);
		if (cloned !== undefined) {
			clonedObject[key] = cloned;
		}
	}
	seen.delete(inputObject);
	return clonedObject;
}

/**
 * Cleans up tool definitions to ensure strict JSON Schema compliance.
 *
 * Implements "require" logic and advanced normalization:
 * 1. Filters 'required' array to remove properties that don't exist in 'properties'.
 * 2. Injects a placeholder property for empty parameter objects.
 * 3. Flattens 'anyOf' with 'const' values into 'enum'.
 * 4. Normalizes nullable types (array types) to single type + description.
 * 5. Removes unsupported keywords (additionalProperties, const, etc.).
 *
 * @param tools - Array of tool definitions
 * @returns Cleaned array of tool definitions
 */
export function cleanupToolDefinitions(tools: unknown): unknown {
	if (!Array.isArray(tools)) return tools;

	return tools.map((tool) => {
		if (!isRecord(tool) || tool.type !== "function") {
			return tool;
		}
		const functionDef = tool.function;
		if (!isRecord(functionDef)) {
			return tool;
		}
		const parameters = functionDef.parameters;
		if (!isRecord(parameters)) {
			return tool;
		}

		// Clone only the schema tree we mutate to avoid heavy deep cloning of entire tools.
		let cleanedParameters: Record<string, unknown>;
		try {
			cleanedParameters = cloneRecord(parameters);
		} catch {
			return tool;
		}
		cleanupSchema(cleanedParameters);

		return {
			...tool,
			function: {
				...functionDef,
				parameters: cleanedParameters,
			},
		};
	});
}

/**
 * Recursively cleans up a JSON schema object
 */
function cleanupSchema(schema: Record<string, unknown>): void {
	if (!schema || typeof schema !== "object") return;

	if (schema.properties && typeof schema.properties === "object") {
		const properties = schema.properties as Record<string, unknown>;
		for (const key in properties) {
			if (!Object.prototype.hasOwnProperty.call(properties, key)) continue;
			if (properties[key] === undefined) {
				delete properties[key];
			}
		}
	}

	// 1. Flatten Unions (anyOf -> enum)
	if (Array.isArray(schema.anyOf)) {
		const anyOf = schema.anyOf as Record<string, unknown>[];
		const allConst = anyOf.every((opt) => "const" in opt);
		if (allConst && anyOf.length > 0) {
			const enumValues = anyOf.map((opt) => opt.const);
			schema.enum = enumValues;
			delete schema.anyOf;

			// Infer type from first value if missing
			if (!schema.type) {
				const firstVal = enumValues[0];
				if (typeof firstVal === "string") schema.type = "string";
				else if (typeof firstVal === "number") schema.type = "number";
				else if (typeof firstVal === "boolean") schema.type = "boolean";
			}
		}
	}

	// 2. Flatten Nullable Types (["string", "null"] -> "string")
	if (Array.isArray(schema.type)) {
		const types = schema.type as unknown[];
		let isNullable = false;
		let firstNonNullType: string | undefined;
		for (let i = 0; i < types.length; i += 1) {
			const candidate = types[i];
			if (candidate === "null") {
				isNullable = true;
				continue;
			}
			if (!firstNonNullType && typeof candidate === "string") {
				firstNonNullType = candidate;
			}
		}

		if (firstNonNullType) {
			// Use the first non-null type (most strict models expect a single string type)
			schema.type = firstNonNullType;
			if (isNullable) {
				const desc = (schema.description as string) || "";
				// Only append if not already present
				if (!desc.toLowerCase().includes("nullable")) {
					schema.description = desc ? `${desc} (nullable)` : "(nullable)";
				}
			}
		}
	}

	// 3. Filter 'required' array
	if (
		Array.isArray(schema.required) &&
		schema.properties &&
		typeof schema.properties === "object"
	) {
		const properties = schema.properties as Record<string, unknown>;
		const required = schema.required as string[];
		const validRequired: string[] = [];
		for (let i = 0; i < required.length; i += 1) {
			const key = required[i];
			if (
				typeof key === "string" &&
				Object.prototype.hasOwnProperty.call(properties, key)
			) {
				validRequired.push(key);
			}
		}

		if (validRequired.length === 0) {
			delete schema.required;
		} else if (validRequired.length !== required.length) {
			schema.required = validRequired;
		}
	}

	// 4. Handle empty object parameters
	if (
		schema.type === "object" &&
		(!schema.properties || !hasOwnProperties(schema.properties as Record<string, unknown>))
	) {
		schema.properties = {
			_placeholder: {
				type: "boolean",
				description: "This property is a placeholder and should be ignored.",
			},
		};
	}

	// 5. Remove unsupported keywords
	delete schema.additionalProperties;
	delete schema.const;
	delete schema.title;
	delete schema.$schema;

	// 6. Recurse into properties
	if (schema.properties && typeof schema.properties === "object") {
		const props = schema.properties as Record<string, Record<string, unknown>>;
		for (const key in props) {
			if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
			const prop = props[key];
			// istanbul ignore next -- JSON.stringify at line 39 strips undefined values
			if (prop !== undefined) {
				cleanupSchema(prop);
			}
		}
	}

	// 7. Recurse into array items
	if (schema.items && typeof schema.items === "object") {
		cleanupSchema(schema.items as Record<string, unknown>);
	}
}

function hasOwnProperties(record: Record<string, unknown>): boolean {
	for (const key in record) {
		if (Object.prototype.hasOwnProperty.call(record, key)) {
			return true;
		}
	}
	return false;
}
