import { describe, it, expect } from "vitest";
import { cleanupToolDefinitions } from "../lib/request/helpers/tool-utils.js";

describe("cleanupToolDefinitions", () => {
  it("returns non-array input unchanged", () => {
    expect(cleanupToolDefinitions(null)).toBeNull();
    expect(cleanupToolDefinitions("string")).toBe("string");
    expect(cleanupToolDefinitions({})).toEqual({});
  });

  it("returns non-function tools unchanged", () => {
    const tools = [{ type: "other", data: "value" }];
    expect(cleanupToolDefinitions(tools)).toEqual(tools);
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
});
