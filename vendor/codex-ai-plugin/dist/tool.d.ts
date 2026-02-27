export interface ToolContext {
  [key: string]: any;
  directory: string;
  worktree: string;
  ask: (request: any) => Promise<any> | any;
}

export interface ToolDefinition<TArgs = any, TResult = any> {
  description?: string;
  args?: Record<string, any>;
  parameters?: unknown;
  execute: (args: TArgs, context: ToolContext) => Promise<TResult> | TResult;
  [key: string]: any;
}

export interface SchemaNode {
  optional: () => SchemaNode;
  describe: (_text: string) => SchemaNode;
  min: (_value: number) => SchemaNode;
  max: (_value: number) => SchemaNode;
  default: (_value: unknown) => SchemaNode;
  int: () => SchemaNode;
  array: (_node?: unknown) => SchemaNode;
  [key: string]: any;
}

export interface ToolFactory {
  <TArgs = any, TResult = any>(definition: ToolDefinition<TArgs, TResult>): ToolDefinition<TArgs, TResult>;
  schema: {
    string: () => SchemaNode;
    number: () => SchemaNode;
    boolean: () => SchemaNode;
    object: (shape: Record<string, unknown>) => SchemaNode;
    enum: (values: readonly unknown[]) => SchemaNode;
    literal: (value: unknown) => SchemaNode;
    array: (node: unknown) => SchemaNode;
    any: () => SchemaNode;
    unknown: () => SchemaNode;
  };
}

export declare const tool: ToolFactory;
