//! Port of `lib/request/helpers/tool-utils.ts` — strict JSON-Schema cleanup of
//! tool definitions (spec 06 §4).
//!
//! The cleanup runs over raw `serde_json::Value`s (the TS operated on plain
//! objects), so every odd shape a host can send — untyped tools, namespaces,
//! non-record parameters — behaves exactly like the JS runtime guards. The
//! typed [`RequestToolDefinition`] wrappers round-trip losslessly through
//! `Value` (verified in `cma_core::types` tests).

use cma_core::types::RequestToolDefinition;
use serde_json::{Map, Value, json};

/// TS `cleanupToolDefinitions` — `None` (TS non-array) passes through as
/// `None`; each tool is cleaned independently.
///
/// Rules (per tool, `type:"function"` only; `type:"namespace"` recurses):
/// 1. Filter `required` to properties that exist.
/// 2. Inject a `_placeholder` property into empty object parameter schemas.
/// 3. Flatten `anyOf`-of-`const` into `enum` (+ type inference).
/// 4. Normalize nullable array types to a single type + `(nullable)` note.
/// 5. Remove unsupported keywords (`additionalProperties`, `const`, `title`,
///    `$schema`).
pub fn cleanup_tool_definitions(
    tools: Option<Vec<RequestToolDefinition>>,
) -> Option<Vec<RequestToolDefinition>> {
    let tools = tools?;
    Some(
        tools
            .into_iter()
            .map(|tool| {
                // Value round-trip: lossless for every arm incl. `Other`.
                let raw = serde_json::to_value(&tool).unwrap_or(Value::Null);
                let cleaned = cleanup_tool_definition_value(raw);
                serde_json::from_value(cleaned).unwrap_or(tool)
            })
            .collect(),
    )
}

/// TS `cleanupToolDefinition` — dispatch on the `type` literal.
fn cleanup_tool_definition_value(tool: Value) -> Value {
    let Some(record) = tool.as_object() else {
        return tool;
    };
    match record.get("type").and_then(Value::as_str) {
        Some("function") => cleanup_function_tool_value(tool),
        Some("namespace") if record.get("tools").is_some_and(Value::is_array) => {
            let mut record = tool.as_object().cloned().unwrap_or_default();
            if let Some(Value::Array(nested)) = record.get("tools").cloned() {
                record.insert(
                    "tools".to_string(),
                    Value::Array(nested.into_iter().map(cleanup_tool_definition_value).collect()),
                );
            }
            Value::Object(record)
        }
        _ => tool,
    }
}

/// TS `cleanupFunctionTool` — only when `function` and `function.parameters`
/// are both plain records (arrays/null/strings pass through untouched, TS
/// `isRecord` parity).
fn cleanup_function_tool_value(tool: Value) -> Value {
    let Some(tool_record) = tool.as_object() else {
        return tool;
    };
    let Some(function_def) = tool_record.get("function").and_then(Value::as_object) else {
        return tool;
    };
    let Some(parameters) = function_def.get("parameters").and_then(Value::as_object) else {
        return tool;
    };

    // TS clones via JSON.parse(JSON.stringify(...)) — a Value is already an
    // owned JSON tree, so the circular/bigint clone-failure path cannot occur.
    let mut cleaned_parameters = parameters.clone();
    cleanup_schema(&mut cleaned_parameters);

    let mut new_function = function_def.clone();
    new_function.insert("parameters".to_string(), Value::Object(cleaned_parameters));
    let mut new_tool = tool_record.clone();
    new_tool.insert("function".to_string(), Value::Object(new_function));
    Value::Object(new_tool)
}

/// JS-truthiness of an optional JSON value (`!schema.type` etc.).
fn is_js_falsy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::Bool(flag)) => !flag,
        Some(Value::String(text)) => text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().map(|f| f == 0.0).unwrap_or(false),
        _ => false,
    }
}

/// TS `cleanupSchema` — recursive, mutates in place. Step order matters and is
/// preserved exactly.
fn cleanup_schema(schema: &mut Map<String, Value>) {
    // Step 0: delete `properties` keys whose value is undefined — JSON has no
    // undefined, so this is structurally moot after the Value round-trip
    // (spec 06 §4 notes it is "mostly moot after JSON clone" in TS too).

    // Step 1: flatten anyOf → enum when EVERY option carries a `const` key.
    if let Some(Value::Array(any_of)) = schema.get("anyOf") {
        // TS `"const" in opt` — a non-object option would throw in JS; here it
        // simply fails the all-const test.
        let all_const = !any_of.is_empty()
            && any_of
                .iter()
                .all(|option| option.as_object().is_some_and(|o| o.contains_key("const")));
        if all_const {
            let enum_values: Vec<Value> = any_of
                .iter()
                .map(|option| option.get("const").cloned().unwrap_or(Value::Null))
                .collect();
            let first = enum_values.first().cloned();
            schema.insert("enum".to_string(), Value::Array(enum_values));
            schema.remove("anyOf");

            // Infer type from the first value if `type` is missing (falsy).
            if is_js_falsy(schema.get("type")) {
                let inferred = match first {
                    Some(Value::String(_)) => Some("string"),
                    Some(Value::Number(_)) => Some("number"),
                    Some(Value::Bool(_)) => Some("boolean"),
                    _ => None,
                };
                if let Some(inferred) = inferred {
                    schema.insert("type".to_string(), Value::String(inferred.to_string()));
                }
            }
        }
    }

    // Step 2: flatten nullable array types (["string","null"] → "string").
    if let Some(Value::Array(types)) = schema.get("type").cloned() {
        let is_nullable = types.iter().any(|t| t.as_str() == Some("null"));
        let non_null: Vec<Value> = types
            .into_iter()
            .filter(|t| t.as_str() != Some("null"))
            .collect();
        if let Some(first) = non_null.first() {
            schema.insert("type".to_string(), first.clone());
            if is_nullable {
                // TS `(schema.description as string) || ""` — non-string
                // descriptions degrade to "" (the TS would throw on them).
                let desc = schema
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if !desc.to_lowercase().contains("nullable") {
                    let annotated = if desc.is_empty() {
                        "(nullable)".to_string()
                    } else {
                        format!("{desc} (nullable)")
                    };
                    schema.insert("description".to_string(), Value::String(annotated));
                }
            }
        }
    }

    // Step 3: filter `required` down to keys that exist in `properties`.
    if let (Some(Value::Array(required)), Some(Value::Object(properties))) =
        (schema.get("required"), schema.get("properties"))
    {
        let valid_required: Vec<Value> = required
            .iter()
            .filter(|key| {
                key.as_str()
                    .map(|key| properties.contains_key(key))
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        if valid_required.is_empty() {
            schema.remove("required");
        } else if valid_required.len() != required.len() {
            schema.insert("required".to_string(), Value::Array(valid_required));
        }
    }

    // Step 4: inject a placeholder property into empty object schemas.
    if schema.get("type").and_then(Value::as_str) == Some("object") {
        let needs_placeholder = match schema.get("properties") {
            // `!schema.properties` (falsy) or `Object.keys(...).length === 0`.
            None | Some(Value::Null) => true,
            Some(Value::Object(map)) => map.is_empty(),
            Some(Value::Array(items)) => items.is_empty(),
            Some(Value::String(text)) => text.is_empty(),
            // Numbers/bools have no enumerable keys in JS.
            Some(Value::Bool(_)) | Some(Value::Number(_)) => true,
        };
        if needs_placeholder {
            schema.insert(
                "properties".to_string(),
                json!({
                    "_placeholder": {
                        "type": "boolean",
                        "description": "This property is a placeholder and should be ignored.",
                    }
                }),
            );
        }
    }

    // Step 5: remove unsupported keywords.
    schema.remove("additionalProperties");
    schema.remove("const");
    schema.remove("title");
    schema.remove("$schema");

    // Step 6: recurse into each property schema.
    if let Some(Value::Object(properties)) = schema.get_mut("properties") {
        for property in properties.values_mut() {
            if let Value::Object(nested) = property {
                cleanup_schema(nested);
            }
        }
    }

    // Step 7: recurse into array items.
    if let Some(Value::Object(items)) = schema.get_mut("items") {
        cleanup_schema(items);
    }
}

// ===========================================================================
// Tests — ported from test/tool-utils.test.ts
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Parse tools from JSON, clean them, and return the cleaned JSON.
    fn cleanup(value: Value) -> Value {
        let tools: Vec<RequestToolDefinition> =
            serde_json::from_value(value).expect("test tools must parse");
        serde_json::to_value(cleanup_tool_definitions(Some(tools)).unwrap()).unwrap()
    }

    fn function_tool(parameters: Value) -> Value {
        json!([{ "type": "function", "function": { "name": "test", "parameters": parameters } }])
    }

    fn parameters_of(cleaned: &Value) -> &Value {
        &cleaned[0]["function"]["parameters"]
    }

    #[test]
    fn returns_none_for_none_input() {
        assert!(cleanup_tool_definitions(None).is_none());
    }

    #[test]
    fn returns_non_function_tools_unchanged() {
        let tools = json!([{ "type": "other", "data": "value" }]);
        assert_eq!(cleanup(tools.clone()), tools);
    }

    #[test]
    fn preserves_typed_hosted_tools_unchanged() {
        let tools = json!([
            { "type": "tool_search", "max_num_results": 3, "search_context_size": "medium" },
            {
                "type": "mcp",
                "server_label": "docs",
                "server_url": "https://mcp.example.com",
                "defer_loading": true,
                "require_approval": "never",
            },
            {
                "type": "computer_use_preview",
                "display_width": 1024,
                "display_height": 768,
                "environment": "browser",
            },
        ]);
        assert_eq!(cleanup(tools.clone()), tools);
    }

    #[test]
    fn treats_array_parameters_as_non_records_and_leaves_tool_unchanged() {
        let tools = json!([{
            "type": "function",
            "function": { "name": "array-params", "parameters": [] },
        }]);
        assert_eq!(cleanup(tools.clone()), tools);
    }

    #[test]
    fn filters_required_array_to_only_existing_properties() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": { "a": { "type": "string" } },
            "required": ["a", "b", "c"],
        })));
        assert_eq!(parameters_of(&cleaned)["required"], json!(["a"]));
    }

    #[test]
    fn removes_required_array_when_no_valid_properties_remain() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": { "a": { "type": "string" } },
            "required": ["b", "c"],
        })));
        assert!(parameters_of(&cleaned).get("required").is_none());
    }

    #[test]
    fn keeps_required_array_unchanged_when_all_required_properties_exist() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": { "a": { "type": "string" }, "b": { "type": "number" } },
            "required": ["a", "b"],
        })));
        assert_eq!(parameters_of(&cleaned)["required"], json!(["a", "b"]));
    }

    #[test]
    fn injects_placeholder_for_empty_object_parameters() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": {},
        })));
        assert_eq!(
            parameters_of(&cleaned)["properties"]["_placeholder"],
            json!({
                "type": "boolean",
                "description": "This property is a placeholder and should be ignored.",
            })
        );
    }

    #[test]
    fn flattens_any_of_with_const_values_into_enum() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": {
                "status": {
                    "anyOf": [{ "const": "active" }, { "const": "inactive" }, { "const": "pending" }],
                },
            },
        })));
        let status = &parameters_of(&cleaned)["properties"]["status"];
        assert!(status.get("anyOf").is_none());
        assert_eq!(status["enum"], json!(["active", "inactive", "pending"]));
        assert_eq!(status["type"], json!("string"));
    }

    #[test]
    fn infers_number_and_boolean_types_for_const_enums() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": {
                "level": { "anyOf": [{ "const": 1 }, { "const": 2 }, { "const": 3 }] },
                "enabled": { "anyOf": [{ "const": true }, { "const": false }] },
            },
        })));
        let level = &parameters_of(&cleaned)["properties"]["level"];
        assert_eq!(level["enum"], json!([1, 2, 3]));
        assert_eq!(level["type"], json!("number"));
        let enabled = &parameters_of(&cleaned)["properties"]["enabled"];
        assert_eq!(enabled["enum"], json!([true, false]));
        assert_eq!(enabled["type"], json!("boolean"));
    }

    #[test]
    fn does_not_infer_type_when_any_of_first_value_is_object_or_null() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": {
                "config": { "anyOf": [{ "const": { "nested": true } }, { "const": { "nested": false } }] },
                "nullable": { "anyOf": [{ "const": null }, { "const": "value" }] },
            },
        })));
        let config = &parameters_of(&cleaned)["properties"]["config"];
        assert!(config.get("anyOf").is_none());
        assert_eq!(config["enum"], json!([{ "nested": true }, { "nested": false }]));
        assert!(config.get("type").is_none());
        let nullable = &parameters_of(&cleaned)["properties"]["nullable"];
        assert_eq!(nullable["enum"], json!([null, "value"]));
        assert!(nullable.get("type").is_none());
    }

    #[test]
    fn preserves_existing_type_when_any_of_has_const_values() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": {
                "status": { "type": "string", "anyOf": [{ "const": "a" }, { "const": "b" }] },
            },
        })));
        let status = &parameters_of(&cleaned)["properties"]["status"];
        assert!(status.get("anyOf").is_none());
        assert_eq!(status["enum"], json!(["a", "b"]));
        assert_eq!(status["type"], json!("string"));
    }

    #[test]
    fn does_not_flatten_empty_any_of_or_mixed_any_of() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": {
                "empty": { "anyOf": [] },
                "mixed": { "anyOf": [{ "const": "a" }, { "type": "string" }] },
            },
        })));
        let empty = &parameters_of(&cleaned)["properties"]["empty"];
        assert_eq!(empty["anyOf"], json!([]));
        assert!(empty.get("enum").is_none());
        let mixed = &parameters_of(&cleaned)["properties"]["mixed"];
        assert!(mixed.get("anyOf").is_some());
        assert!(mixed.get("enum").is_none());
    }

    #[test]
    fn flattens_nullable_types_to_single_type_with_description() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": {
                "name": { "type": ["string", "null"], "description": "User name" },
            },
        })));
        let name = &parameters_of(&cleaned)["properties"]["name"];
        assert_eq!(name["type"], json!("string"));
        assert_eq!(name["description"], json!("User name (nullable)"));
    }

    #[test]
    fn does_not_duplicate_nullable_annotation() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": {
                "name": { "type": ["string", "null"], "description": "This is nullable already" },
            },
        })));
        assert_eq!(
            parameters_of(&cleaned)["properties"]["name"]["description"],
            json!("This is nullable already")
        );
    }

    #[test]
    fn handles_nullable_type_without_description() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": { "noDesc": { "type": ["string", "null"] } },
        })));
        let no_desc = &parameters_of(&cleaned)["properties"]["noDesc"];
        assert_eq!(no_desc["type"], json!("string"));
        assert_eq!(no_desc["description"], json!("(nullable)"));
    }

    #[test]
    fn handles_nullable_type_array_with_only_null_type() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": { "onlyNull": { "type": ["null"] } },
        })));
        assert_eq!(
            parameters_of(&cleaned)["properties"]["onlyNull"]["type"],
            json!(["null"])
        );
    }

    #[test]
    fn flattens_type_array_without_null_to_single_type() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": { "field": { "type": ["string", "number"] } },
        })));
        let field = &parameters_of(&cleaned)["properties"]["field"];
        assert_eq!(field["type"], json!("string"));
        assert!(field.get("description").is_none());
    }

    #[test]
    fn removes_unsupported_keywords() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": { "a": { "type": "string" } },
            "additionalProperties": false,
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "TestParams",
        })));
        let params = parameters_of(&cleaned);
        assert!(params.get("additionalProperties").is_none());
        assert!(params.get("$schema").is_none());
        assert!(params.get("title").is_none());
    }

    #[test]
    fn recursively_cleans_nested_properties() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": {
                "nested": {
                    "type": "object",
                    "properties": { "inner": { "type": ["number", "null"] } },
                    "additionalProperties": true,
                },
            },
        })));
        let nested = &parameters_of(&cleaned)["properties"]["nested"];
        assert!(nested.get("additionalProperties").is_none());
        assert_eq!(nested["properties"]["inner"]["type"], json!("number"));
    }

    #[test]
    fn recursively_cleans_array_items() {
        let cleaned = cleanup(function_tool(json!({
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": { "val": { "type": ["string", "null"] } },
                        "additionalProperties": false,
                    },
                },
            },
        })));
        let item_schema = &parameters_of(&cleaned)["properties"]["items"]["items"];
        assert!(item_schema.get("additionalProperties").is_none());
        assert_eq!(item_schema["properties"]["val"]["type"], json!("string"));
    }

    #[test]
    fn handles_tool_without_parameters_property() {
        let tools = json!([{ "type": "function", "function": { "name": "simple_action" } }]);
        let cleaned = cleanup(tools);
        assert_eq!(cleaned[0]["function"]["name"], json!("simple_action"));
        assert!(cleaned[0]["function"].get("parameters").is_none());
    }

    #[test]
    fn recursively_cleans_nested_function_tools_inside_namespace_bundles() {
        let cleaned = cleanup(json!([
            {
                "type": "namespace",
                "name": "search_bundle",
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "lookup",
                            "parameters": {
                                "type": "object",
                                "properties": {},
                                "additionalProperties": false,
                            },
                        },
                    },
                    { "type": "tool_search", "max_num_results": 2 },
                ],
            },
        ]));
        let namespace_tools = cleaned[0]["tools"].as_array().unwrap();
        let nested_params = &namespace_tools[0]["function"]["parameters"];
        assert!(nested_params.get("additionalProperties").is_none());
        assert_eq!(
            nested_params["properties"],
            json!({
                "_placeholder": {
                    "type": "boolean",
                    "description": "This property is a placeholder and should be ignored.",
                }
            })
        );
        assert_eq!(
            namespace_tools[1],
            json!({ "type": "tool_search", "max_num_results": 2 })
        );
    }
}
