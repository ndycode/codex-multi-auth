# Hashline v2 (PinEdit-style) Benchmark Format

Use pin tags to edit files with unambiguous line anchors.

## Tag format

Each line is shown as `N#XXX:content` where:
- `N` is the 1-based line number
- `XXX` is a 3-character content hash

Always use tags from the most recent read output.

## Operations

### `set`
Replace or delete one line or a range.

Single line replace:
```json
{ "op": "set", "tag": "5#a2f", "content": ["new line"] }
```

Range replace:
```json
{ "op": "set", "first": "5#a2f", "last": "8#b3g", "content": ["line1", "line2"] }
```

Delete (single or range): use `content: null`.

### `ins`
Insert lines relative to an anchor.

After a line:
```json
{ "op": "ins", "after": "5#a2f", "content": ["inserted line"] }
```

Before a line:
```json
{ "op": "ins", "before": "5#a2f", "content": ["inserted line"] }
```

At beginning/end of file:
```json
{ "op": "ins", "bof": true, "content": ["first line"] }
{ "op": "ins", "eof": true, "content": ["last line"] }
```

### `sub`
Replace text inside a single line.

```json
{ "op": "sub", "tag": "5#a2f", "old": "foo", "new": "bar" }
```

`old` must appear exactly once in the target line.

## Full call shape

```json
{
  "path": "src/TodoApp.tsx",
  "edits": [
    { "op": "sub", "tag": "7#abc", "old": "Todos", "new": "Tasks" },
    { "op": "ins", "eof": true, "content": ["export default TodoApp;"] }
  ]
}
```

## Rules

- Output one JSON code block only.
- Do not use tools or function calls.
- Do not copy tags into `content` lines.
- Batch all changes for the file in one edit call.
- If you are changing text within one line, prefer `sub`.
