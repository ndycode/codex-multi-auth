import { describe, it, expect } from "vitest";
import { cleanupToolDefinitions } from "../lib/request/helpers/tool-utils.js";
import type { RequestToolDefinition } from "../lib/types.js";

describe("cleanupToolDefinitions", () => {
  it("returns undefined for non-array input", () => {
    expect(cleanupToolDefinitions(null)).toBeUndefined();
    expect(cleanupToolDefinitions("string" as unknown as RequestToolDefinition[])).toBeUndefined();
    expect(cleanupToolDefinitions({} as unknown as RequestToolDefinition[])).toBeUndefined();
  });

  it("returns non-function tools unchanged", () => {
    const tools = [{ type: "other", data: "value" }];
    expect(cleanupToolDefinitions(tools)).toEqual(tools);
  });

  it("preserves typed GPT-5.4 hosted tools unchanged", () => {
    const tools: RequestToolDefinition[] = [
      { type: "tool_search", max_num_results: 3, search_context_size: "medium" },
      {
        type: "mcp",
        server_label: "docs",
        server_url: "https://mcp.example.com",
        defer_loading: true,
        require_approval: "never",
      },
      {
        type: "computer_use_preview",
        display_width: 1024,
        display_height: 768,
        environment: "browser",
      },
    ];

    expect(cleanupToolDefinitions(tools)).toEqual(tools);
  });

  it("treats array parameters as non-records and leaves tool unchanged", () => {
    const tools = [{
      type: "function",
      function: {
        name: "array-params",
        parameters: [] as unknown,
      },
    }];

    const result = cleanupToolDefinitions(tools as never) as typeof tools;
    expect(result[0]).toBe(tools[0]);
  });

  it("returns tool unchanged when parameters contain circular references", () => {
    const circular: Record<string, unknown> = {
      type: "object",
      properties: { a: { type: "string" } },
    };
    circular.self = circular;
    const tools = [{
      type: "function",
      function: {
        name: "circular-params",
        parameters: circular,
      },
    }];

    const result = cleanupToolDefinitions(tools as never) as typeof tools;
    expect(result[0]).toBe(tools[0]);
  });

  it("returns tool unchanged when parameters contain bigint values", () => {
    const tools = [{
      type: "function",
      function: {
        name: "bigint-params",
        parameters: {
          type: "object",
          properties: {
            size: 1n,
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools as never) as typeof tools;
    expect(result[0]).toBe(tools[0]);
  });

  it("filters required array to only existing properties", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a", "b", "c"],
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    expect(result[0].function.parameters.required).toEqual(["a"]);
  });

  it("removes required array when no valid properties remain", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["b", "c"],
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    expect(result[0].function.parameters.required).toBeUndefined();
  });

  it("injects placeholder for empty object parameters", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: { type: "object", properties: {} },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    expect(result[0].function.parameters.properties).toHaveProperty("_placeholder");
    const props = result[0].function.parameters.properties as Record<string, unknown>;
    expect(props._placeholder).toEqual({
      type: "boolean",
      description: "This property is a placeholder and should be ignored.",
    });
  });

  it("flattens anyOf with const values into enum", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            status: {
              anyOf: [{ const: "active" }, { const: "inactive" }, { const: "pending" }],
            },
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const status = result[0].function.parameters.properties.status as Record<string, unknown>;
    expect(status.anyOf).toBeUndefined();
    expect(status.enum).toEqual(["active", "inactive", "pending"]);
    expect(status.type).toBe("string");
  });

  it("flattens nullable types to single type", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            name: { type: ["string", "null"], description: "User name" },
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const name = result[0].function.parameters.properties.name as Record<string, unknown>;
    expect(name.type).toBe("string");
    expect(name.description).toBe("User name (nullable)");
  });

  it("does not duplicate nullable annotation", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            name: { type: ["string", "null"], description: "This is nullable already" },
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const name = result[0].function.parameters.properties.name as Record<string, unknown>;
    expect(name.description).toBe("This is nullable already");
  });

  it("removes unsupported keywords", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: { a: { type: "string" } },
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
          title: "TestParams",
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    expect(result[0].function.parameters.additionalProperties).toBeUndefined();
    expect(result[0].function.parameters.$schema).toBeUndefined();
    expect(result[0].function.parameters.title).toBeUndefined();
  });

  it("recursively cleans nested properties", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            nested: {
              type: "object",
              properties: {
                inner: { type: ["number", "null"] },
              },
              additionalProperties: true,
            },
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const nested = result[0].function.parameters.properties.nested as Record<string, unknown>;
    expect(nested.additionalProperties).toBeUndefined();
    const inner = (nested.properties as Record<string, Record<string, unknown>>).inner;
    expect(inner.type).toBe("number");
  });

  it("recursively cleans array items", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { val: { type: ["string", "null"] } },
                additionalProperties: false,
              },
            },
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const items = result[0].function.parameters.properties.items as Record<string, unknown>;
    const itemSchema = items.items as Record<string, unknown>;
    expect(itemSchema.additionalProperties).toBeUndefined();
    const val = (itemSchema.properties as Record<string, Record<string, unknown>>).val;
    expect(val.type).toBe("string");
  });

  it("does not mutate original input", () => {
    const original = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a", "b"],
          additionalProperties: false,
        },
      },
    }];

    const originalJson = JSON.stringify(original);
    cleanupToolDefinitions(original);
    expect(JSON.stringify(original)).toBe(originalJson);
  });

  it("infers number type for enum with number values", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            level: {
              anyOf: [{ const: 1 }, { const: 2 }, { const: 3 }],
            },
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const level = result[0].function.parameters.properties.level as Record<string, unknown>;
    expect(level.anyOf).toBeUndefined();
    expect(level.enum).toEqual([1, 2, 3]);
    expect(level.type).toBe("number");
  });

  it("infers boolean type for enum with boolean values", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            enabled: {
              anyOf: [{ const: true }, { const: false }],
            },
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const enabled = result[0].function.parameters.properties.enabled as Record<string, unknown>;
    expect(enabled.anyOf).toBeUndefined();
    expect(enabled.enum).toEqual([true, false]);
    expect(enabled.type).toBe("boolean");
  });

  it("skips undefined property values in properties object", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            defined: { type: "string" },
            undefinedProp: undefined,
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const props = result[0].function.parameters.properties as Record<string, unknown>;
    expect(props.defined).toBeDefined();
    expect(props.undefinedProp).toBeUndefined();
  });

  it("handles properties object where all values are undefined", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            a: undefined,
            b: undefined,
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    expect(result[0].function.parameters.properties).toHaveProperty("_placeholder");
  });

  it("handles nullable type array with only null type", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            onlyNull: { type: ["null"] },
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const onlyNull = result[0].function.parameters.properties.onlyNull as Record<string, unknown>;
    expect(onlyNull.type).toEqual(["null"]);
  });

  it("handles nullable type without description", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            noDesc: { type: ["string", "null"] },
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const noDesc = result[0].function.parameters.properties.noDesc as Record<string, unknown>;
    expect(noDesc.type).toBe("string");
    expect(noDesc.description).toBe("(nullable)");
  });

  it("keeps required array unchanged when all required properties exist", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    expect(result[0].function.parameters.required).toEqual(["a", "b"]);
  });

  it("does not flatten anyOf with empty array", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            empty: {
              anyOf: [],
            },
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const empty = result[0].function.parameters.properties.empty as Record<string, unknown>;
    expect(empty.anyOf).toEqual([]);
    expect(empty.enum).toBeUndefined();
  });

  it("does not flatten anyOf when not all options have const", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            mixed: {
              anyOf: [{ const: "a" }, { type: "string" }],
            },
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const mixed = result[0].function.parameters.properties.mixed as Record<string, unknown>;
    expect(mixed.anyOf).toBeDefined();
    expect(mixed.enum).toBeUndefined();
  });

  it("flattens type array without null to single type", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            field: { type: ["string", "number"] },
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const field = result[0].function.parameters.properties.field as Record<string, unknown>;
    expect(field.type).toBe("string");
    expect(field.description).toBeUndefined();
  });

  it("handles tool without parameters property (line 40 coverage)", () => {
    const tools = [{
      type: "function",
      function: {
        name: "simple_action",
      },
    }];

    const result = cleanupToolDefinitions(tools as never) as { type: string; function: { name: string; parameters?: unknown } }[];
    expect(result[0].function.name).toBe("simple_action");
    expect(result[0].function.parameters).toBeUndefined();
  });

  it("handles tool with null parameters (line 40 coverage)", () => {
    const tools = [{
      type: "function",
      function: {
        name: "null_params",
        parameters: null,
      },
    }];

    const result = cleanupToolDefinitions(tools as never) as typeof tools;
    expect(result[0].function.name).toBe("null_params");
  });

  it("handles null schema in cleanupSchema (line 52 coverage)", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: null as unknown as { type: "object"; properties?: Record<string, unknown> },
      },
    }];

    const result = cleanupToolDefinitions(tools as never) as typeof tools;
    expect(result[0].function.parameters).toBeNull();
  });

  it("handles non-object schema in cleanupSchema (line 52 coverage)", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: "not-an-object" as unknown as { type: "object" },
      },
    }];

    const result = cleanupToolDefinitions(tools as never) as typeof tools;
    expect(result[0].function.parameters).toBe("not-an-object");
  });

  it("does not infer type when anyOf first value is object (line 64, 67 coverage)", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            config: {
              anyOf: [{ const: { nested: true } }, { const: { nested: false } }],
            },
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const config = result[0].function.parameters.properties.config as Record<string, unknown>;
    expect(config.anyOf).toBeUndefined();
    expect(config.enum).toEqual([{ nested: true }, { nested: false }]);
    expect(config.type).toBeUndefined();
  });

  it("handles anyOf with null const value (line 64, 67 coverage)", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            nullable: {
              anyOf: [{ const: null }, { const: "value" }],
            },
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const nullable = result[0].function.parameters.properties.nullable as Record<string, unknown>;
    expect(nullable.anyOf).toBeUndefined();
    expect(nullable.enum).toEqual([null, "value"]);
    expect(nullable.type).toBeUndefined();
  });

  it("preserves existing type when anyOf has const values (line 64 false branch)", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: {
            status: {
              type: "string",
              anyOf: [{ const: "a" }, { const: "b" }],
            },
          },
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const status = result[0].function.parameters.properties.status as Record<string, unknown>;
    expect(status.anyOf).toBeUndefined();
    expect(status.enum).toEqual(["a", "b"]);
    expect(status.type).toBe("string");
  });

  it("skips undefined property in loop without crashing (line 136 coverage)", () => {
    const tools = [{
      type: "function",
      function: {
        name: "test",
        parameters: {
          type: "object",
          properties: Object.create(null, {
            valid: { value: { type: "string" }, enumerable: true },
            sparse: { value: undefined, enumerable: true },
          }),
        },
      },
    }];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const props = result[0].function.parameters.properties as Record<string, unknown>;
    expect(props.valid).toEqual({ type: "string" });
  });

  it("recursively cleans nested function tools inside namespace bundles", () => {
    const tools: RequestToolDefinition[] = [
      {
        type: "namespace",
        name: "search_bundle",
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              parameters: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
          },
          { type: "tool_search", max_num_results: 2 },
        ],
      },
    ];

    const result = cleanupToolDefinitions(tools) as typeof tools;
    const namespaceTools = result[0].tools ?? [];
    const nestedFunction = namespaceTools[0] as Extract<RequestToolDefinition, { type: "function" }>;
    expect(nestedFunction.function.parameters?.additionalProperties).toBeUndefined();
    expect(nestedFunction.function.parameters?.properties).toEqual({
      _placeholder: {
        type: "boolean",
        description: "This property is a placeholder and should be ignored.",
      },
    });
    expect(namespaceTools[1]).toEqual({ type: "tool_search", max_num_results: 2 });
  });
});

describe("cleanupToolDefinitions fused-path parity", () => {
  const fnTool = (parameters: Record<string, unknown>): RequestToolDefinition =>
    ({
      type: "function",
      function: { name: "f", parameters },
    }) as unknown as RequestToolDefinition;

  const parametersOf = (tool: unknown): Record<string, unknown> =>
    (tool as { function: { parameters: Record<string, unknown> } }).function
      .parameters;

  it("removes an empty required array when a properties object exists", () => {
    const tools = [fnTool({
      type: "object",
      properties: { a: { type: "string" } },
      required: [],
    })];

    const result = cleanupToolDefinitions(tools) as unknown[];
    // The legacy cleanup deleted `required` whenever no entries survived,
    // including an already-empty array — the clean-path check must not
    // return such a schema unchanged.
    expect(result[0]).not.toBe(tools[0]);
    expect(parametersOf(result[0]).required).toBeUndefined();
    expect(parametersOf(result[0])).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
  });

  it("removes an empty required array on a properties array", () => {
    const tools = [fnTool({
      type: "object",
      properties: [],
      required: [],
    })];

    const result = cleanupToolDefinitions(tools) as unknown[];
    expect(parametersOf(result[0]).required).toBeUndefined();
    expect(parametersOf(result[0]).properties).toHaveProperty("_placeholder");
  });

  it("keeps an empty required array when there is no properties object", () => {
    const tools = [fnTool({ type: "string", required: [] })];

    const result = cleanupToolDefinitions(tools) as unknown[];
    // Legacy left `required` untouched without a properties object, so the
    // clean path is correct to return the identical tool here.
    expect(result[0]).toBe(tools[0]);
    expect(parametersOf(result[0]).required).toEqual([]);
  });

  it("keeps a fully-valid required array unchanged on the clean path", () => {
    const tools = [fnTool({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    })];

    const result = cleanupToolDefinitions(tools) as unknown[];
    expect(result[0]).toBe(tools[0]);
    expect(parametersOf(result[0]).required).toEqual(["a"]);
  });

  it("never invokes an enumerable getter during inspection", () => {
    let reads = 0;
    const parameters: Record<string, unknown> = {
      type: "object",
      properties: { a: { type: "string" } },
    };
    Object.defineProperty(parameters, "required", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        if (reads > 1) throw new Error(`getter read ${reads}`);
        return ["missing"];
      },
    });
    const tools = [fnTool(parameters)];

    const result = cleanupToolDefinitions(tools) as unknown[];
    // Legacy behavior: a single JSON.stringify read resolves the getter;
    // the invalid entry then removes `required` entirely.
    expect(reads).toBe(1);
    expect(parametersOf(result[0]).required).toBeUndefined();
    expect(parametersOf(result[0])).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
  });

  it("captures the first-read value of a stateful getter like JSON.stringify", () => {
    let reads = 0;
    const parameters: Record<string, unknown> = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["missing"], // dirty: forces a clone
    };
    Object.defineProperty(parameters, "x_custom", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return `v${reads}`;
      },
    });
    const tools = [fnTool(parameters)];

    const result = cleanupToolDefinitions(tools) as unknown[];
    expect(parametersOf(result[0]).x_custom).toBe("v1");
    expect(reads).toBe(1);
  });

  it("routes accessors on nested schema nodes through the legacy path", () => {
    let reads = 0;
    const propSchema: Record<string, unknown> = { type: "string" };
    Object.defineProperty(propSchema, "title", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        if (reads > 1) throw new Error(`nested getter read ${reads}`);
        return "Doc";
      },
    });
    const tools = [fnTool({
      type: "object",
      properties: { a: propSchema },
    })];

    const result = cleanupToolDefinitions(tools) as unknown[];
    const a = (parametersOf(result[0]).properties as Record<string, unknown>).a;
    expect(reads).toBe(1);
    expect(a).toEqual({ type: "string" });
  });

  it("routes array-element accessors through the legacy path", () => {
    let reads = 0;
    const required: unknown[] = ["a"];
    Object.defineProperty(required, "1", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        if (reads > 1) throw new Error(`array accessor read ${reads}`);
        return "missing";
      },
    });
    const tools = [fnTool({
      type: "object",
      properties: { a: { type: "string" } },
      required,
    })];

    const result = cleanupToolDefinitions(tools) as unknown[];
    expect(reads).toBe(1);
    expect(parametersOf(result[0]).required).toEqual(["a"]);
  });

  it("does not double-read an accessor `properties` map", () => {
    let reads = 0;
    const parameters: Record<string, unknown> = {
      type: "object",
      required: ["ghost"],
    };
    Object.defineProperty(parameters, "properties", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        if (reads > 1) throw new Error(`properties read ${reads}`);
        return { a: { type: "string" } };
      },
    });
    const tools = [fnTool(parameters)];

    const result = cleanupToolDefinitions(tools) as unknown[];
    expect(reads).toBe(1);
    expect(parametersOf(result[0]).required).toBeUndefined();
    expect(parametersOf(result[0]).properties).toEqual({
      a: { type: "string" },
    });
  });

  it("returns the tool unchanged when a proxy get trap throws mid-clone", () => {
    // The proxy reports plain data descriptors but throws on `title` reads;
    // the fused clone must fail over to the JSON round-trip, which throws at
    // the same point and leaves the tool untouched — identical outcomes.
    const proxied = new Proxy(
      { type: "string", title: "T" },
      {
        get(target, prop, receiver) {
          if (prop === "title") throw new Error("get trap");
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    const tools = [fnTool({
      type: "object",
      properties: { a: proxied },
    })];

    const result = cleanupToolDefinitions(tools);
    expect(result![0]).toBe(tools[0]);
  });

  it("cleans schemas behind a transparent proxy like the JSON round-trip", () => {
    const tools = [fnTool({
      type: "object",
      properties: new Proxy(
        { a: { type: "string", title: "T" } },
        {},
      ) as unknown as Record<string, unknown>,
    })];

    const result = cleanupToolDefinitions(tools) as unknown[];
    const a = (parametersOf(result[0]).properties as Record<string, unknown>).a;
    expect(a).toEqual({ type: "string" });
  });
});

describe("cleanupToolDefinitions legacy differential corpus", () => {
  // Exact copies of the pre-optimization implementation: every tool paid a
  // JSON.stringify+parse clone followed by in-place cleanup. Kept as the
  // oracle so the inspect/fused-clone fast paths can be diffed against the
  // semantics they replaced, including throw and return-unchanged behavior.
  const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  const legacyCleanupSchema = (schema: Record<string, unknown>): void => {
    if (!schema || typeof schema !== "object") return;

    if (schema.properties && typeof schema.properties === "object") {
      const properties = schema.properties as Record<string, unknown>;
      for (const key of Object.keys(properties)) {
        if (properties[key] === undefined) {
          delete properties[key];
        }
      }
    }

    if (Array.isArray(schema.anyOf)) {
      const anyOf = schema.anyOf as Record<string, unknown>[];
      const allConst = anyOf.every((opt) => "const" in opt);
      if (allConst && anyOf.length > 0) {
        const enumValues = anyOf.map((opt) => opt.const);
        schema.enum = enumValues;
        delete schema.anyOf;

        if (!schema.type) {
          const firstVal = enumValues[0];
          if (typeof firstVal === "string") schema.type = "string";
          else if (typeof firstVal === "number") schema.type = "number";
          else if (typeof firstVal === "boolean") schema.type = "boolean";
        }
      }
    }

    if (Array.isArray(schema.type)) {
      const types = schema.type as string[];
      const isNullable = types.includes("null");
      const nonNullTypes = types.filter((t) => t !== "null");

      if (nonNullTypes.length > 0) {
        schema.type = nonNullTypes[0];
        if (isNullable) {
          const desc = (schema.description as string) || "";
          if (!desc.toLowerCase().includes("nullable")) {
            schema.description = desc ? `${desc} (nullable)` : "(nullable)";
          }
        }
      }
    }

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

    delete schema.additionalProperties;
    delete schema.const;
    delete schema.title;
    delete schema.$schema;

    if (schema.properties && typeof schema.properties === "object") {
      const props = schema.properties as Record<string, Record<string, unknown>>;
      for (const key in props) {
        const prop = props[key];
        if (prop !== undefined) {
          legacyCleanupSchema(prop);
        }
      }
    }

    if (schema.items && typeof schema.items === "object") {
      legacyCleanupSchema(schema.items as Record<string, unknown>);
    }
  };

  const legacyCleanupTool = (tool: unknown): unknown => {
    if (!isPlainRecord(tool)) return tool;
    if (tool.type === "function") {
      const functionDef = tool.function;
      if (!isPlainRecord(functionDef)) return tool;
      const parameters = functionDef.parameters;
      if (!isPlainRecord(parameters)) return tool;
      let cleanedParameters: Record<string, unknown>;
      try {
        cleanedParameters = JSON.parse(JSON.stringify(parameters)) as Record<
          string,
          unknown
        >;
      } catch {
        return tool;
      }
      legacyCleanupSchema(cleanedParameters);
      return {
        ...tool,
        function: { ...functionDef, parameters: cleanedParameters },
      };
    }
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      return {
        ...tool,
        tools: tool.tools.map((nested: unknown) => legacyCleanupTool(nested)),
      };
    }
    return tool;
  };

  const deepObject = (depth: number): Record<string, unknown> => {
    const root: Record<string, unknown> = {
      type: "object",
      properties: { leaf: { type: "string", title: "deep" } },
    };
    let node = root;
    for (let i = 0; i < depth; i++) {
      const next: Record<string, unknown> = {
        type: "object",
        properties: { child: node },
      };
      node = next;
    }
    return node;
  };

  const sparseEnum: unknown[] = [];
  sparseEnum[1] = 1; // hole at index 0

  const protoKeyed = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string","title":"x"}},"required":["__proto__","ghost"]}',
  ) as Record<string, unknown>;

  const corpus: Array<[string, Record<string, unknown>]> = [
    ["clean schema", {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a", "b"],
    }],
    ["empty required array with properties", {
      type: "object",
      properties: { a: { type: "string" } },
      required: [],
    }],
    ["empty required array without properties", {
      type: "string",
      required: [],
    }],
    ["required partially invalid", {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "ghost"],
    }],
    ["required entirely invalid", {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["ghost"],
    }],
    ["required non-string entries", {
      type: "object",
      properties: { a: { type: "string" }, "1": { type: "number" } },
      required: [1, "a", null, true, "ghost"],
    }],
    ["required non-array object", {
      type: "object",
      properties: { a: { type: "string" } },
      required: { 0: "a", length: 1 },
    }],
    ["required length vs properties array", {
      type: "object",
      properties: [],
      required: ["length"],
    }],
    ["empty properties object gets placeholder", {
      type: "object",
      properties: {},
    }],
    ["missing properties gets placeholder", { type: "object" }],
    ["string properties stays", { type: "object", properties: "str" }],
    ["numeric properties becomes placeholder", { type: "object", properties: 5 }],
    ["null properties becomes placeholder", { type: "object", properties: null }],
    ["properties array of schemas", {
      type: "object",
      properties: [{ type: "string", title: "x" }],
    }],
    ["properties array with primitive", {
      type: "object",
      properties: ["nope", { type: "string" }],
    }],
    ["anyOf flattens to enum", {
      type: "object",
      properties: { s: { anyOf: [{ const: "a" }, { const: "b" }] } },
    }],
    ["anyOf mixed survives", {
      type: "object",
      properties: { m: { anyOf: [{ const: "a" }, { type: "string" }] } },
    }],
    ["anyOf empty survives", {
      type: "object",
      properties: { e: { anyOf: [] } },
    }],
    ["anyOf primitives throw", {
      type: "object",
      properties: { p: { anyOf: [1, 2] } },
    }],
    ["nullable type array", {
      type: "object",
      properties: {
        a: { type: ["string", "null"], description: "Name" },
        b: { type: ["null"] },
        c: { type: ["string", "number"] },
        d: { type: [] },
      },
    }],
    ["nullable already annotated", {
      type: "object",
      properties: { a: { type: ["string", "null"], description: "is nullable" } },
    }],
    ["all unsupported keywords", {
      type: "object",
      properties: { a: { type: "string", const: "x", title: "t" } },
      additionalProperties: false,
      $schema: "draft",
      title: "root",
      const: 1,
    }],
    ["items object cleaned", {
      type: "object",
      properties: {
        a: { type: "array", items: { type: "string", title: "x" } },
      },
    }],
    ["items array elements not cleaned", {
      type: "object",
      properties: {
        a: { type: "array", items: [{ type: "string", title: "x" }] },
      },
    }],
    ["items primitive survives", {
      type: "object",
      properties: { a: { type: "array", items: "weird" } },
    }],
    ["nested object recursion", {
      type: "object",
      properties: {
        n: {
          type: "object",
          properties: { i: { type: ["number", "null"] } },
          required: ["i", "ghost"],
          additionalProperties: true,
        },
      },
    }],
    ["__proto__ property key", protoKeyed],
    ["arbitrary subtree fidelity", {
      type: "object",
      properties: { a: { type: "string" } },
      extra: { nested: { deep: [1, 2.5, { x: "y" }, null, true] } },
    }],
    ["undefined property value dropped", {
      type: "object",
      properties: { a: { type: "string" }, gone: undefined },
      required: ["gone"],
    }],
    ["all-undefined properties placeholder", {
      type: "object",
      properties: { a: undefined, b: undefined },
    }],
    ["NaN default becomes null", {
      type: "object",
      properties: { a: { type: "string", default: Number.NaN } },
    }],
    ["negative zero becomes zero", {
      type: "object",
      properties: { a: { type: "number", default: -0 } },
    }],
    ["bigint value returns tool unchanged", {
      type: "object",
      properties: { a: { type: "string", big: 1n } },
    }],
    ["function value dropped", {
      type: "object",
      properties: { a: { type: "string", fn: () => 1 } },
    }],
    ["symbol value dropped", {
      type: "object",
      properties: { a: { type: "string", sym: Symbol("s") } },
    }],
    ["sparse enum becomes null-padded", {
      type: "object",
      properties: { a: { type: "number", enum: sparseEnum } },
    }],
    ["toJSON value rewritten", {
      type: "object",
      properties: {
        a: { type: "string", toJSON: () => ({ type: "number" }) },
      },
    }],
    ["null-prototype schema node", Object.assign(Object.create(null), {
      type: "object",
      properties: { a: { type: "string" } },
      title: "np",
    })],
    ["date value serializes via toJSON", {
      type: "object",
      properties: { a: { type: "string", when: new Date(0) } },
    }],
    ["deep nesting under the walk limit", deepObject(400)],
    ["deep nesting over the walk limit", deepObject(600)],
    ["huge enum array", {
      type: "object",
      properties: { a: { enum: Array.from({ length: 5000 }, (_, i) => i) } },
    }],
    ["huge required array", {
      type: "object",
      properties: { a: { type: "string" } },
      required: new Array(2000).fill("a").concat(["ghost"]),
    }],
    ["required symbol entry", {
      type: "object",
      properties: { a: { type: "string" } },
      required: [Symbol("s")],
    }],
    ["key order preserved", {
      description: "first",
      type: "object",
      properties: { z: { type: "string" }, a: { type: "string" } },
      required: ["z", "a"],
      deprecated: true,
    }],
  ];

  for (const [name, parameters] of corpus) {
    it(`matches legacy clone+cleanup: ${name}`, () => {
      const tool = {
        type: "function",
        function: { name: "f", parameters },
      } as unknown as RequestToolDefinition;

      let expected: string;
      try {
        expected = JSON.stringify(legacyCleanupTool(tool));
      } catch (err) {
        expected = `THREW:${(err as Error).name}`;
      }

      let actual: string;
      try {
        actual = JSON.stringify(cleanupToolDefinitions([tool])![0]);
      } catch (err) {
        actual = `THREW:${(err as Error).name}`;
      }

      expect(actual).toBe(expected);
    });
  }
});
