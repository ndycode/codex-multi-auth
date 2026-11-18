import { isRecord } from "../../utils.js";
import type {
	FunctionToolDefinition,
	RequestToolDefinition,
	ToolParametersSchema,
} from "../../types.js";

const hasOwn = (
	obj: object,
	key: string | number | symbol,
): boolean => Object.prototype.hasOwnProperty.call(obj, key);

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/**
 * Defines an own enumerable property on a clone output object. A plain
 * `clone["__proto__"] = v` assignment would silently rewrite the clone's
 * prototype instead of creating the own property `JSON.parse` produces.
 */
const setCloneProp = (
	out: Record<string, unknown>,
	key: string,
	child: unknown,
): void => {
	if (key === "__proto__") {
		Object.defineProperty(out, key, {
			value: child,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	} else {
		out[key] = child;
	}
};

/**
 * Deep-clones a tree already proven to be plain JSON data by
 * {@link inspectSchema}. Produces the same result as
 * `JSON.parse(JSON.stringify(value))` for that input class without building
 * an intermediate string.
 */
function clonePlainValue(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		const clone: unknown[] = new Array(value.length);
		for (let i = 0; i < value.length; i++) {
			clone[i] = clonePlainValue(value[i]);
		}
		return clone;
	}
	const clone: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		setCloneProp(
			clone,
			key,
			clonePlainValue((value as Record<string, unknown>)[key]),
		);
	}
	return clone;
}

/**
 * Values that are schema nodes (a `properties` entry, an `items` schema) get
 * the fused clone+clean; everything else is a plain JSON clone. Mirrors
 * cleanupSchema only recursing through `properties` values and `items`.
 */
function cloneSchemaChild(value: unknown): unknown {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return cloneAndCleanSchema(value as Record<string, unknown>);
	}
	return clonePlainValue(value);
}

function clonePropertiesMap(rawProps: object): unknown {
	if (Array.isArray(rawProps)) {
		const out: unknown[] = new Array(rawProps.length);
		for (let i = 0; i < rawProps.length; i++) {
			out[i] = cloneSchemaChild(rawProps[i]);
		}
		return out;
	}
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(rawProps)) {
		setCloneProp(
			out,
			key,
			cloneSchemaChild((rawProps as Record<string, unknown>)[key]),
		);
	}
	return out;
}

/**
 * The node-local half of {@link cleanupSchema}: steps 1-4 plus the unsupported
 * keyword drops (step 5). Step 0 (undefined `properties` values) is skipped
 * because this only runs on trees {@link inspectSchema} verified contain no
 * `undefined` values. Child recursion is already done by the fused clone.
 */
function applySchemaTransforms(out: Record<string, unknown>): void {
	// 1. Flatten Unions (anyOf -> enum)
	if (Array.isArray(out.anyOf)) {
		const anyOf = out.anyOf as Record<string, unknown>[];
		const allConst = anyOf.every((opt) => "const" in opt);
		if (allConst && anyOf.length > 0) {
			const enumValues = anyOf.map((opt) => opt.const);
			out.enum = enumValues;
			delete out.anyOf;

			if (!out.type) {
				const firstVal = enumValues[0];
				if (typeof firstVal === "string") out.type = "string";
				else if (typeof firstVal === "number") out.type = "number";
				else if (typeof firstVal === "boolean") out.type = "boolean";
			}
		}
	}

	// 2. Flatten Nullable Types (["string", "null"] -> "string")
	if (Array.isArray(out.type)) {
		const types = out.type as string[];
		const isNullable = types.includes("null");
		const nonNullTypes = types.filter((t) => t !== "null");

		if (nonNullTypes.length > 0) {
			out.type = nonNullTypes[0];
			if (isNullable) {
				const desc = (out.description as string) || "";
				if (!desc.toLowerCase().includes("nullable")) {
					out.description = desc ? `${desc} (nullable)` : "(nullable)";
				}
			}
		}
	}

	// 3. Filter 'required' array
	if (
		Array.isArray(out.required) &&
		out.properties &&
		typeof out.properties === "object"
	) {
		const properties = out.properties as Record<string, unknown>;
		const required = out.required as string[];

		const validRequired = required.filter((key: string) =>
			hasOwn(properties, key),
		);

		if (validRequired.length === 0) {
			delete out.required;
		} else if (validRequired.length !== required.length) {
			out.required = validRequired;
		}
	}

	// 4. Handle empty object parameters
	if (
		out.type === "object" &&
		(!out.properties || Object.keys(out.properties as object).length === 0)
	) {
		out.properties = {
			_placeholder: {
				type: "boolean",
				description: "This property is a placeholder and should be ignored.",
			},
		};
	}
}

/**
 * Fused clone+clean: produces exactly `cleanupSchema(JSON.clone(node))` in a
 * single pass for trees {@link inspectSchema} verified as plain JSON data.
 * The unsupported keywords are dropped during the key copy (equivalent to
 * step-5 deletes); node-level rewrites then run in cleanupSchema's order, and
 * they never observe child-cleaned state, so children can be cleaned eagerly
 * while copying.
 */
function cloneAndCleanSchema(node: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};

	for (const key of Object.keys(node)) {
		// Read once — and before the keyword skip — exactly like
		// JSON.stringify reads every enumerable value: a throwing get trap on
		// a dropped keyword must still fail (and fall back) here.
		const value = node[key];
		if (
			key === "additionalProperties" ||
			key === "const" ||
			key === "title" ||
			key === "$schema"
		) {
			continue;
		}
		if (key === "properties" && value !== null && typeof value === "object") {
			setCloneProp(out, key, clonePropertiesMap(value));
		} else if (key === "items" && value !== null && typeof value === "object") {
			setCloneProp(out, key, cloneSchemaChild(value));
		} else {
			setCloneProp(out, key, clonePlainValue(value));
		}
	}
	applySchemaTransforms(out);
	return out;
}

interface SchemaInspection {
	needsCleanup: boolean;
	jsonSerializable: boolean;
}

/**
 * Read-only mirror of {@link cleanupSchema}'s mutation conditions at a single
 * schema node. Mirrors the same short-circuit cascade: a node counts as dirty
 * iff cleanupSchema would delete, inject, or rewrite anything on it.
 * Recursion into `properties`/`items` is handled by {@link inspectSchema}.
 */
function schemaWouldChange(schema: Record<string, unknown>): boolean {
	const rawProps = schema.properties;
	const propsObject = !!rawProps && typeof rawProps === "object";

	// Step 0/3/4 helper state: own enumerable `properties` keys with a defined
	// value — exactly the keys the cleaned clone still has after the
	// undefined-value deletions (non-enumerable keys never survive the clone).
	const definedPropKeys = propsObject ? new Set<string>() : null;
	if (definedPropKeys !== null) {
		for (const key of Object.keys(rawProps as object)) {
			if ((rawProps as Record<string, unknown>)[key] === undefined) {
				return true;
			}
			definedPropKeys.add(key);
		}
	}

	// 1. anyOf of all-`const` options flattens into `enum`.
	if (
		Array.isArray(schema.anyOf) &&
		schema.anyOf.length > 0 &&
		(schema.anyOf as Record<string, unknown>[]).every((opt) => "const" in opt)
	) {
		return true;
	}

	// 2. A type array holding at least one non-"null" member collapses.
	if (Array.isArray(schema.type)) {
		for (const member of schema.type as unknown[]) {
			if (member !== "null") return true;
		}
	}

	// 3. `required` is rewritten when any entry is not a surviving property
	// key (evaluated after the step-0 undefined deletions).
	if (
		Array.isArray(schema.required) &&
		propsObject &&
		definedPropKeys !== null
	) {
		let valid = 0;
		for (const key of schema.required as string[]) {
			// hasOwnProperty coerces non-string entries; mirror that for the Set lookup.
			if (definedPropKeys.has(typeof key === "string" ? key : String(key))) {
				valid += 1;
			}
		}
		// cleanupSchema deletes `required` whenever zero entries survive —
		// including an empty `required: []`, which is a mutation, not a no-op.
		if (valid === 0 || valid !== schema.required.length) return true;
	}

	// 4. `type: "object"` with no surviving properties gains a placeholder.
	// Only reachable when step 2 left `type` as a non-array.
	if (schema.type === "object") {
		const empty = !rawProps
			? true
			: propsObject && definedPropKeys !== null
				? definedPropKeys.size === 0
				: Object.keys(rawProps as object).length === 0;
		if (empty) return true;
	}

	// 5. Unsupported keywords are deleted unconditionally.
	if (
		hasOwn(schema, "additionalProperties") ||
		hasOwn(schema, "const") ||
		hasOwn(schema, "title") ||
		hasOwn(schema, "$schema")
	) {
		return true;
	}

	return false;
}

/**
 * Walks a parameters schema once, answering two questions at the same time:
 *
 * - `needsCleanup`: would {@link cleanupSchema} mutate anything? Mirrors its
 *   traversal (schema nodes are the root, `properties` values, and `items`).
 * - `jsonSerializable`: is the tree plain JSON data such that
 *   `JSON.parse(JSON.stringify(tree))` is the identity transform on values?
 *   Anything the round-trip would rewrite or reject (cycles, bigint,
 *   `undefined` properties, `toJSON` hooks, exotic prototypes, sparse arrays,
 *   non-finite numbers) makes cleanup semantics depend on the actual clone,
 *   so such trees must stay on the legacy path for identical results.
 */
// Legitimate JSON Schemas are never this deep; deeper nesting means either a
// cycle (JSON.stringify would throw) or a pathological tree the legacy path
// can evaluate correctly. Bounding the walk keeps cycle detection free.
const MAX_SCHEMA_DEPTH = 512;

function inspectSchema(root: Record<string, unknown>): SchemaInspection {
	let jsonSerializable = true;
	// Mode-1 schema nodes are collected during the walk but only evaluated
	// afterwards: schemaWouldChange reads one level into children
	// (properties values, required/type/anyOf elements), which is only safe
	// once the whole tree is verified free of accessors.
	const schemaNodes: Array<Record<string, unknown>> = [];

	// mode 0: not a schema node (walked only for serializability)
	// mode 1: schema node (root / properties values / items)
	// mode 2: properties container (its VALUES are schema nodes)
	const walk = (value: unknown, mode: 0 | 1 | 2, depth: number): void => {
		if (!jsonSerializable) return;
		if (value === null || typeof value === "string" || typeof value === "boolean") {
			return;
		}
		if (typeof value === "number") {
			// JSON.stringify emits non-finite numbers (and -0) differently.
			if (!Number.isFinite(value) || Object.is(value, -0)) {
				jsonSerializable = false;
			}
			return;
		}
		if (typeof value !== "object" || depth > MAX_SCHEMA_DEPTH) {
			// bigint/symbol/function/undefined: JSON.stringify throws or drops.
			// Over-depth: cycle or pathological nesting — stay on legacy path.
			jsonSerializable = false;
			return;
		}
		const isArr = Array.isArray(value);
		const proto = Object.getPrototypeOf(value);
		if (
			isArr
				? proto !== Array.prototype
				: proto !== Object.prototype && proto !== null
		) {
			jsonSerializable = false;
			return;
		}
		// ownKeys covers non-enumerable + symbol keys that JSON.stringify and
		// the fast clone both skip; extra own keys mean the views diverge.
		const ownKeyCount = Reflect.ownKeys(value).length;
		// Values are read through property descriptors so accessors are never
		// invoked: a getter is stateful — it can return a different value than
		// the single read JSON.stringify performs, or throw on a later call —
		// so any accessor (or a descriptor a proxy withholds) routes the tree
		// to the legacy path before any getter can run.
		const descs = Object.getOwnPropertyDescriptors(value);
		if (isArr) {
			// Arrays own `length` plus their indices; sparse slots or extra
			// named keys serialize differently.
			if (ownKeyCount !== value.length + 1) {
				jsonSerializable = false;
				return;
			}
			// An array used as a `properties` map has its elements cleaned as
			// schemas by cleanupSchema's `for key in props` recursion.
			const childMode = mode === 2 ? 1 : 0;
			for (let i = 0; i < value.length; i++) {
				const desc = descs[i];
				if (!desc || "get" in desc || "set" in desc) {
					jsonSerializable = false;
					return;
				}
				const child: unknown = desc.value;
				if (child === undefined) {
					// JSON.stringify rewrites undefined array elements to null.
					jsonSerializable = false;
					return;
				}
				walk(child, childMode, depth + 1);
				if (!jsonSerializable) return;
			}
		} else {
			const keys = Object.keys(value);
			if (ownKeyCount !== keys.length) {
				jsonSerializable = false;
				return;
			}
			const childKeys: string[] = [];
			const childValues: unknown[] = [];
			for (const key of keys) {
				const desc = descs[key];
				if (!desc || "get" in desc || "set" in desc) {
					jsonSerializable = false;
					return;
				}
				childKeys.push(key);
				childValues.push(desc.value);
			}
			if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
				// JSON.stringify would call it and serialize the result instead.
				jsonSerializable = false;
				return;
			}
			if (mode === 1) {
				schemaNodes.push(value as Record<string, unknown>);
			}
			for (const [i, key] of childKeys.entries()) {
				const child = childValues[i];
				if (child === undefined) {
					// JSON.stringify drops undefined-valued keys entirely.
					jsonSerializable = false;
					return;
				}
				walk(child, childSchemaMode(mode, key), depth + 1);
				if (!jsonSerializable) return;
			}
		}
	};

	walk(root, 1, 0);
	if (!jsonSerializable) {
		return { needsCleanup: false, jsonSerializable };
	}
	for (const node of schemaNodes) {
		if (schemaWouldChange(node)) {
			return { needsCleanup: true, jsonSerializable };
		}
	}
	return { needsCleanup: false, jsonSerializable };
}

function childSchemaMode(mode: 0 | 1 | 2, key: string): 0 | 1 | 2 {
	if (mode === 2) return 1;
	if (mode === 1) {
		if (key === "properties") return 2;
		if (key === "items") return 1;
	}
	return 0;
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
export function cleanupToolDefinitions(
	tools: RequestToolDefinition[] | undefined,
): RequestToolDefinition[] | undefined {
	if (!Array.isArray(tools)) return undefined;

	return tools.map((tool) => cleanupToolDefinition(tool));
}

function cleanupToolDefinition(tool: RequestToolDefinition): RequestToolDefinition {
	if (!isRecord(tool)) {
		return tool;
	}

	if (tool.type === "function") {
		return cleanupFunctionTool(tool as FunctionToolDefinition);
	}

	if (tool.type === "namespace" && Array.isArray(tool.tools)) {
		return {
			...tool,
			tools: tool.tools.map((nestedTool) => cleanupToolDefinition(nestedTool)) as RequestToolDefinition[],
		};
	}

	return tool;
}

function cleanupFunctionTool(tool: FunctionToolDefinition): FunctionToolDefinition {
	const functionDef = tool.function;
	if (!isRecord(functionDef)) {
		return tool;
	}
	const parameters = functionDef.parameters;
	if (!isRecord(parameters)) {
		return tool;
	}

	// Read-only pre-check: a schema that needs no cleanup skips the deep clone
	// entirely. The check also verifies the tree is plain JSON data, because
	// clone semantics (and therefore cleanup outcomes) only differ from
	// observable behavior on inputs JSON.stringify would rewrite or reject.
	// Any failure here just falls back to the exact legacy path.
	let inspection: SchemaInspection | null = null;
	try {
		inspection = inspectSchema(parameters);
	} catch {
		inspection = null;
	}

	if (inspection?.jsonSerializable && !inspection.needsCleanup) {
		return tool;
	}

	// Clone only the schema tree we mutate to avoid heavy deep cloning of entire tools.
	// Verified-JSON trees get the fused single-pass clone+clean; everything
	// else keeps the exact JSON round-trip + in-place cleanup so throw/rewrite
	// semantics on exotic inputs stay identical. If the fused pass still hits a
	// value that lies about being plain data (e.g. a proxy whose get trap throws
	// after reporting data descriptors), retry through the legacy clone rather
	// than adding a new failure mode — the input tree is never mutated.
	let cleanedParameters: Record<string, unknown> | null = null;
	if (inspection?.jsonSerializable) {
		try {
			cleanedParameters = cloneAndCleanSchema(parameters);
		} catch {
			cleanedParameters = null;
		}
	}
	if (cleanedParameters === null) {
		try {
			cleanedParameters = cloneRecord(parameters);
		} catch {
			return tool;
		}
		cleanupSchema(cleanedParameters);
	}

	return {
		...tool,
		function: {
			...functionDef,
			parameters: cleanedParameters as ToolParametersSchema,
		},
	};
}

/**
 * Recursively cleans up a JSON schema object
 */
function cleanupSchema(schema: Record<string, unknown>): void {
	if (!schema || typeof schema !== "object") return;

	if (schema.properties && typeof schema.properties === "object") {
		const properties = schema.properties as Record<string, unknown>;
		for (const key of Object.keys(properties)) {
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
		const types = schema.type as string[];
		const isNullable = types.includes("null");
		const nonNullTypes = types.filter((t) => t !== "null");

		if (nonNullTypes.length > 0) {
			// Use the first non-null type (most strict models expect a single string type)
			schema.type = nonNullTypes[0];
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

		const validRequired = required.filter((key: string) =>
			Object.prototype.hasOwnProperty.call(properties, key),
		);

		if (validRequired.length === 0) {
			delete schema.required;
		} else if (validRequired.length !== required.length) {
			schema.required = validRequired;
		}
	}

	// 4. Handle empty object parameters
	if (
		schema.type === "object" &&
		(!schema.properties || Object.keys(schema.properties as object).length === 0)
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
