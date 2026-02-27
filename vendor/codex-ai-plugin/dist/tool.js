const chain = {
  optional() { return this; },
  describe() { return this; },
  min() { return this; },
  max() { return this; },
  default() { return this; },
  int() { return this; },
  array() { return this; },
};

function node() {
  return Object.create(chain);
}

export function tool(definition) {
  return definition;
}

tool.schema = {
  string: () => node(),
  number: () => node(),
  boolean: () => node(),
  object: () => node(),
  enum: () => node(),
  literal: () => node(),
  array: () => node(),
  any: () => node(),
  unknown: () => node(),
};
