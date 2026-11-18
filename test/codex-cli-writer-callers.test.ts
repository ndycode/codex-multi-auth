import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Every ~/.codex/auth.json write has to hand the writer the id from
// codexCliAccountIdFor(): it applies the account's CodexCliMirror (an explicit
// id the backend refused) and the org-id substitution (#700/#703). A writer
// that passes account.accountId straight through puts a refused id back into
// auth.json, and Codex CLI 0.156+ then fails every request.

const ROOT = join(__dirname, "..");
const WRITER = "lib/codex-cli/writer.ts";

function listSources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return listSources(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

/** The text between the "(" at `open` and its matching ")". */
function argumentAt(source: string, open: number): string {
	let depth = 0;
	for (let i = open; i < source.length; i += 1) {
		if (source[i] === "(") depth += 1;
		else if (source[i] === ")") {
			depth -= 1;
			if (depth === 0) return source.slice(open + 1, i);
		}
	}
	throw new Error("unbalanced call");
}

/** The object literal assigned to `name` (`name = {...}`) in `source`. */
function assignedLiterals(source: string, name: string): string[] {
	const literals: string[] = [];
	const pattern = new RegExp(`\\b${name}\\s*=\\s*\\{`, "g");
	for (const match of source.matchAll(pattern)) {
		const start = (match.index ?? 0) + match[0].length - 1;
		let depth = 0;
		for (let i = start; i < source.length; i += 1) {
			if (source[i] === "{") depth += 1;
			else if (source[i] === "}") {
				depth -= 1;
				if (depth === 0) {
					literals.push(source.slice(start, i + 1));
					break;
				}
			}
		}
	}
	return literals;
}

function accountIdViolation(literal: string, source: string): string | null {
	const property = /\baccountId\s*:\s*([^\n]+)/.exec(literal);
	if (property) {
		return property[1]?.trim().startsWith("codexCliAccountIdFor(")
			? null
			: `accountId: ${property[1]?.trim()}`;
	}
	if (/(^|[\s{,])accountId\s*,/.test(literal)) {
		return /\bconst accountId\s*=\s*codexCliAccountIdFor\(/.test(source)
			? null
			: "accountId shorthand not from codexCliAccountIdFor()";
	}
	return "no accountId";
}

describe("Codex auth.json writer callers", () => {
	const sources = [...listSources(join(ROOT, "lib")), join(ROOT, "index.ts")].filter(
		(path) => relative(ROOT, path).replace(/\\/g, "/") !== WRITER,
	);
	const calls = sources.flatMap((path) => {
		const source = readFileSync(path, "utf-8");
		return [...source.matchAll(/\bsetCodexCliActiveSelection\(/g)].map((match) => {
			const argument = argumentAt(
				source,
				(match.index ?? 0) + match[0].length - 1,
			).trim();
			const literals = argument.startsWith("{")
				? [argument]
				: assignedLiterals(source, argument);
			return { file: relative(ROOT, path), argument, literals, source };
		});
	});

	it("finds the known writer call sites", () => {
		expect(calls.length).toBeGreaterThanOrEqual(9);
	});

	it("routes every written account id through codexCliAccountIdFor()", () => {
		const violations = calls.flatMap(({ file, argument, literals, source }) =>
			literals.length === 0
				? [`${file}: cannot resolve argument ${argument}`]
				: literals.flatMap((literal) => {
						const violation = accountIdViolation(literal, source);
						return violation ? [`${file}: ${violation}`] : [];
					}),
		);
		expect(violations).toEqual([]);
	});

	// A module that writes its own auth.json (e.g. an isolated CODEX_HOME for a
	// native RPC) bypasses the writer, so its literal token object must apply
	// the same mapping.
	const literalWrites = sources.flatMap((path) => {
		const source = readFileSync(path, "utf-8");
		if (!/["']auth\.json["']/.test(source)) return [];
		return [...source.matchAll(/\baccount_id\s*[:=]\s*([^,}\n;]+)/g)].map((match) => ({
			file: relative(ROOT, path),
			value: match[1]?.trim() ?? "",
		}));
	});

	it("finds the literal auth.json token writers", () => {
		expect(literalWrites.map(({ file }) => file.replace(/\\/g, "/"))).toContain(
			"lib/runtime/native-rate-limits.ts",
		);
	});

	it("routes every literal auth.json account_id through codexCliAccountIdFor()", () => {
		const violations = literalWrites
			.filter(({ value }) => !value.startsWith("codexCliAccountIdFor("))
			.map(({ file, value }) => `${file}: account_id ${value}`);
		expect(violations).toEqual([]);
	});
});
