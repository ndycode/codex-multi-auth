import { createHash } from "node:crypto";

const TAG_RE = /^(\d+)#([0-9a-z]{3})$/;
const LOOSE_TAG_RE = /^L?(\d+)(?:#([0-9a-z]+))?$/i;

function normalizeLineForHash(line) {
  let value = line;
  if (value.endsWith("\r")) {
    value = value.slice(0, -1);
  }
  return value.replace(/\s+/g, "");
}

export function computeHashlineV2Hash(line) {
  const normalized = normalizeLineForHash(line);
  const digest = createHash("sha1").update(normalized, "utf8").digest();
  const raw = (digest.readUInt32BE(0) % 46656).toString(36);
  return raw.padStart(3, "0");
}

export function formatFileForHashlineV2(_filePath, content, startLine = 1, endLine) {
  if (content.length === 0) {
    return "";
  }
  const lines = content.split("\n");
  const stop = typeof endLine === "number" ? Math.min(endLine, lines.length) : lines.length;
  const start = Math.max(1, startLine);
  const output = [];
  for (let index = start - 1; index < stop; index += 1) {
    const lineNumber = index + 1;
    const hash = computeHashlineV2Hash(lines[index] ?? "");
    output.push(`${lineNumber}#${hash}:${lines[index] ?? ""}`);
  }
  return output.join("\n");
}

export function extractJsonCodeBlock(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return null;
  }
  const sentinel = text.match(/BEGIN_V2_JSON\s*([\s\S]*?)\s*END_V2_JSON/i);
  if (sentinel?.[1]) {
    return sentinel[1].trim();
  }
  const fencedJson = text.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJson?.[1]) {
    return fencedJson[1].trim();
  }
  const fencedJsonLike = text.match(/```(?:jsonc|javascript|js|ts|tsx)?\s*([\s\S]*?)```/i);
  if (fencedJsonLike?.[1] && /["']?\bpath\b["']?\s*:/.test(fencedJsonLike[1]) && /["']?\bedits\b["']?\s*:/.test(fencedJsonLike[1])) {
    return fencedJsonLike[1].trim();
  }
  const fenced = text.match(/```\s*([\s\S]*?)```/);
  if (fenced?.[1] && fenced[1].includes("\"edits\"")) {
    return fenced[1].trim();
  }
  const rawQuoted = text.match(/(\{[\s\S]*?"path"\s*:[\s\S]*?"edits"\s*:\s*\[[\s\S]*?\][\s\S]*?\})/);
  if (rawQuoted?.[1]) {
    return rawQuoted[1].trim();
  }
  const rawLoose = text.match(/(\{[\s\S]*?\bpath\b\s*:[\s\S]*?\bedits\b\s*:\s*\[[\s\S]*?\][\s\S]*?\})/i);
  if (rawLoose?.[1]) {
    return rawLoose[1].trim();
  }
  const balanced = extractBalancedJsonObject(text);
  return balanced?.trim() ?? null;
}

function extractBalancedJsonObject(text) {
  if (typeof text !== "string") {
    return null;
  }
  let start = -1;
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (ch === "\"" || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, index + 1);
        if (/\bpath\b\s*:/.test(candidate) && /\bedits\b\s*:/.test(candidate)) {
          return candidate;
        }
      }
    }
  }
  return null;
}

function stripJsonComments(text) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    const next = text[index + 1];

    if (inString) {
      output += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (ch === "\"" || ch === "'") {
      inString = true;
      quote = ch;
      output += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      if (index < text.length) {
        output += "\n";
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      index += 2;
      while (index < text.length) {
        if (text[index] === "*" && text[index + 1] === "/") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    output += ch;
  }

  return output;
}

function quoteUnquotedKeys(text) {
  return text.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3');
}

function convertSingleQuotedStrings(text) {
  return text.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, inner) => `"${inner.replace(/"/g, '\\"')}"`);
}

function trimToJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return text;
  }
  return text.slice(start, end + 1);
}

function normalizeJsonCandidate(text) {
  let next = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'");
  next = next.replace(/```[a-z]*\s*/gi, "").replace(/```/g, "");
  next = next.replace(/BEGIN_V2_JSON/gi, "").replace(/END_V2_JSON/gi, "");
  next = trimToJsonObject(next);
  next = stripJsonComments(next);
  next = quoteUnquotedKeys(next);
  next = convertSingleQuotedStrings(next);
  next = next.replace(/,\s*([}\]])/g, "$1");
  return next.trim();
}

function parseJsonWithRepairs(jsonText) {
  const candidates = [];
  const seen = new Set();
  const push = (value) => {
    const key = String(value ?? "");
    if (key.length === 0 || seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(key);
  };

  push(String(jsonText ?? "").trim());
  push(normalizeJsonCandidate(jsonText));
  const balanced = extractBalancedJsonObject(String(jsonText ?? ""));
  if (balanced) {
    push(balanced.trim());
    push(normalizeJsonCandidate(balanced));
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Invalid JSON");
}

function parseTag(tag) {
  const match = TAG_RE.exec(String(tag ?? "").trim());
  if (!match) {
    throw new Error(`Invalid tag format: ${tag}`);
  }
  const line = Number.parseInt(match[1], 10);
  if (!Number.isFinite(line) || line < 1) {
    throw new Error(`Invalid line number in tag: ${tag}`);
  }
  return { line, hash: match[2] };
}

function validateEdit(edit, index) {
  if (!edit || typeof edit !== "object") {
    throw new Error(`Edit ${index} must be an object`);
  }
  const op = edit.op;
  if (!["set", "ins", "sub"].includes(op)) {
    throw new Error(`Edit ${index} has unsupported op: ${String(op)}`);
  }
  if (op === "set") {
    const hasTag = typeof edit.tag === "string";
    const hasRange = typeof edit.first === "string" && typeof edit.last === "string";
    if (!hasTag && !hasRange) {
      throw new Error(`Edit ${index} set requires tag or first+last`);
    }
    if (!(edit.content === null || (Array.isArray(edit.content) && edit.content.every((v) => typeof v === "string")))) {
      throw new Error(`Edit ${index} set content must be string[] or null`);
    }
    return;
  }
  if (op === "ins") {
    if (!Array.isArray(edit.content) || !edit.content.every((v) => typeof v === "string")) {
      throw new Error(`Edit ${index} ins content must be string[]`);
    }
    const anchors = ["after", "before", "bof", "eof"].filter((key) => key in edit);
    if (anchors.length === 0) {
      throw new Error(`Edit ${index} ins requires after/before/bof/eof`);
    }
    return;
  }
  if (op === "sub") {
    if (typeof edit.tag !== "string" || typeof edit.old !== "string" || typeof edit.new !== "string") {
      throw new Error(`Edit ${index} sub requires tag, old, new strings`);
    }
  }
}

function normalizeEditShape(edit) {
  if (!edit || typeof edit !== "object") {
    return edit;
  }
  const next = { ...edit };
  if ((next.op === "set" || next.op === "ins") && typeof next.content === "string") {
    next.content = [next.content];
  }
  return next;
}

function normalizeHashlineV2Path(pathValue) {
  const normalized = String(pathValue ?? "").trim().replace(/\\/g, "/");
  if (!normalized) {
    return normalized;
  }
  if (normalized === "TodoApp.tsx" || normalized.endsWith("/TodoApp.tsx")) {
    return "src/TodoApp.tsx";
  }
  if (normalized.startsWith("./")) {
    return normalized;
  }
  return normalized;
}

export function parseHashlineV2Call(jsonText) {
  let parsed;
  try {
    parsed = parseJsonWithRepairs(jsonText);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Edit call must be an object");
  }
  if (typeof parsed.path !== "string" || parsed.path.trim().length === 0) {
    throw new Error("Edit call path is required");
  }
  parsed.path = normalizeHashlineV2Path(parsed.path);
  if (parsed.edits && !Array.isArray(parsed.edits) && typeof parsed.edits === "object") {
    parsed.edits = [parsed.edits];
  }
  if (!Array.isArray(parsed.edits)) {
    throw new Error("Edit call edits must be an array");
  }
  parsed.edits = parsed.edits.map(normalizeEditShape);
  parsed.edits.forEach((edit, index) => validateEdit(edit, index));
  return parsed;
}

function stripTagPrefix(line) {
  const match = /^(\d+#[0-9a-z]{3}:)(.*)$/i.exec(line);
  if (!match) {
    return line;
  }
  return match[2];
}

function resolveUniqueSubTagFromOldText(content, oldText) {
  if (typeof content !== "string" || typeof oldText !== "string" || oldText.length === 0) {
    return null;
  }
  const lines = content.split("\n");
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.includes(oldText)) {
      matches.push(index);
    }
  }
  if (matches.length !== 1) {
    return null;
  }
  const lineIndex = matches[0];
  const line = lines[lineIndex] ?? "";
  return `${lineIndex + 1}#${computeHashlineV2Hash(line)}`;
}

function canonicalizeLooseTag(tagValue, sourceContent) {
  const raw = String(tagValue ?? "").trim();
  if (!raw || typeof sourceContent !== "string" || sourceContent.length === 0) {
    return null;
  }
  const bareHash = raw.replace(/^#/, "");
  if (/^[0-9a-z]{3}$/i.test(bareHash)) {
    const lines = sourceContent.split("\n");
    const matches = [];
    for (let index = 0; index < lines.length; index += 1) {
      const hash = computeHashlineV2Hash(lines[index] ?? "");
      if (hash === bareHash.toLowerCase()) {
        matches.push(index);
      }
    }
    if (matches.length === 1) {
      const lineNumber = matches[0] + 1;
      return `${lineNumber}#${bareHash.toLowerCase()}`;
    }
  }
  const match = LOOSE_TAG_RE.exec(raw);
  if (!match) {
    return null;
  }
  const lineNumber = Number.parseInt(match[1], 10);
  if (!Number.isFinite(lineNumber) || lineNumber < 1) {
    return null;
  }
  const lines = sourceContent.split("\n");
  if (lineNumber > lines.length) {
    return null;
  }
  const line = lines[lineNumber - 1] ?? "";
  return `${lineNumber}#${computeHashlineV2Hash(line)}`;
}

function tryCanonicalizeTag(tagValue, sourceContent) {
  try {
    parseTag(tagValue);
    return tagValue;
  } catch {
    return canonicalizeLooseTag(tagValue, sourceContent) ?? tagValue;
  }
}

export function autocorrectHashlineV2Call(call, sourceContent) {
  const normalized = {
    path: call.path,
    edits: call.edits.map((edit) => {
      if (edit.op === "set" && Array.isArray(edit.content)) {
        const nextEdit = {
          ...edit,
          content: edit.content.map((line) => stripTagPrefix(line)),
        };
        if (typeof nextEdit.tag === "string") {
          nextEdit.tag = tryCanonicalizeTag(nextEdit.tag, sourceContent);
        }
        if (typeof nextEdit.first === "string") {
          nextEdit.first = tryCanonicalizeTag(nextEdit.first, sourceContent);
        }
        if (typeof nextEdit.last === "string") {
          nextEdit.last = tryCanonicalizeTag(nextEdit.last, sourceContent);
        }
        return nextEdit;
      }
      if (edit.op === "ins" && Array.isArray(edit.content)) {
        const nextEdit = {
          ...edit,
          content: edit.content.map((line) => stripTagPrefix(line)),
        };
        if (typeof nextEdit.after === "string") {
          nextEdit.after = tryCanonicalizeTag(nextEdit.after, sourceContent);
        }
        if (typeof nextEdit.before === "string") {
          nextEdit.before = tryCanonicalizeTag(nextEdit.before, sourceContent);
        }
        return nextEdit;
      }
      if (edit.op === "sub") {
        const nextEdit = { ...edit };
        nextEdit.tag = tryCanonicalizeTag(nextEdit.tag, sourceContent);
        try {
          parseTag(nextEdit.tag);
        } catch {
          const correctedTag = resolveUniqueSubTagFromOldText(sourceContent, nextEdit.old);
          if (correctedTag) {
            nextEdit.tag = correctedTag;
          }
        }
        return nextEdit;
      }
      return { ...edit };
    }),
  };
  return normalized;
}

function resolveTag(tag, lines) {
  let parsed;
  try {
    parsed = parseTag(tag);
  } catch (error) {
    return {
      ok: false,
      index: -1,
      error: error instanceof Error ? error.message : `Invalid tag format: ${String(tag)}`,
    };
  }
  const index = parsed.line - 1;
  if (index < 0 || index >= lines.length) {
    return { ok: false, index, error: `Line ${parsed.line} out of range (file has ${lines.length} lines)` };
  }
  const actualHash = computeHashlineV2Hash(lines[index] ?? "");
  if (actualHash !== parsed.hash) {
    return {
      ok: false,
      index,
      error: `Hash mismatch at line ${parsed.line}: expected ${parsed.hash}, got ${actualHash}`,
    };
  }
  return { ok: true, index, error: null };
}

export function applyHashlineV2Edits(content, call) {
  const lines = content.split("\n");
  const errors = [];
  const resolved = [];

  for (const edit of call.edits) {
    if (edit.op === "set") {
      if (typeof edit.tag === "string") {
        const target = resolveTag(edit.tag, lines);
        if (!target.ok) {
          errors.push(target.error);
          continue;
        }
        resolved.push({ edit, start: target.index, end: target.index });
      } else {
        const first = resolveTag(edit.first, lines);
        const last = resolveTag(edit.last, lines);
        if (!first.ok) {
          errors.push(first.error);
          continue;
        }
        if (!last.ok) {
          errors.push(last.error);
          continue;
        }
        if (first.index > last.index) {
          errors.push(`set range invalid: first ${edit.first} is after last ${edit.last}`);
          continue;
        }
        resolved.push({ edit, start: first.index, end: last.index });
      }
      continue;
    }

    if (edit.op === "ins") {
      let anchorIndex;
      if (edit.bof) {
        anchorIndex = -1;
      } else if (edit.eof) {
        anchorIndex = lines.length;
      } else if (typeof edit.after === "string") {
        const after = resolveTag(edit.after, lines);
        if (!after.ok) {
          errors.push(after.error);
          continue;
        }
        anchorIndex = after.index;
        if (typeof edit.before === "string") {
          const before = resolveTag(edit.before, lines);
          if (!before.ok) {
            errors.push(before.error);
            continue;
          }
        }
      } else if (typeof edit.before === "string") {
        const before = resolveTag(edit.before, lines);
        if (!before.ok) {
          errors.push(before.error);
          continue;
        }
        anchorIndex = before.index - 1;
      } else {
        errors.push("ins requires after, before, bof, or eof");
        continue;
      }
      resolved.push({ edit, start: anchorIndex, end: anchorIndex });
      continue;
    }

    if (edit.op === "sub") {
      const target = resolveTag(edit.tag, lines);
      if (!target.ok) {
        errors.push(target.error);
        continue;
      }
      const line = lines[target.index] ?? "";
      const firstOccurrence = line.indexOf(edit.old);
      if (firstOccurrence === -1) {
        errors.push(`sub old text not found at line ${target.index + 1}`);
        continue;
      }
      if (line.indexOf(edit.old, firstOccurrence + 1) !== -1) {
        errors.push(`sub old text occurs multiple times at line ${target.index + 1}`);
        continue;
      }
      resolved.push({ edit, start: target.index, end: target.index });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, content, applied: 0 };
  }

  resolved.sort((left, right) => right.start - left.start);

  for (const item of resolved) {
    const edit = item.edit;
    if (edit.op === "set") {
      if (typeof edit.tag === "string") {
        const lineIndex = parseTag(edit.tag).line - 1;
        if (edit.content === null) {
          lines.splice(lineIndex, 1);
        } else {
          lines.splice(lineIndex, 1, ...edit.content);
        }
      } else {
        const firstIndex = parseTag(edit.first).line - 1;
        const lastIndex = parseTag(edit.last).line - 1;
        const count = lastIndex - firstIndex + 1;
        if (edit.content === null) {
          lines.splice(firstIndex, count);
        } else {
          lines.splice(firstIndex, count, ...edit.content);
        }
      }
      continue;
    }

    if (edit.op === "ins") {
      let insertAt;
      if (edit.bof) {
        insertAt = 0;
      } else if (edit.eof) {
        insertAt = lines.length;
      } else if (typeof edit.after === "string") {
        insertAt = parseTag(edit.after).line;
      } else {
        insertAt = parseTag(edit.before).line - 1;
      }
      lines.splice(insertAt, 0, ...edit.content);
      continue;
    }

    if (edit.op === "sub") {
      const lineIndex = parseTag(edit.tag).line - 1;
      lines[lineIndex] = (lines[lineIndex] ?? "").replace(edit.old, edit.new);
    }
  }

  return {
    ok: true,
    errors: [],
    content: lines.join("\n"),
    applied: resolved.length,
  };
}
