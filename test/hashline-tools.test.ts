import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@codex-ai/plugin/tool";
import {
	applyHashlineEdit,
	applyLegacyEdit,
	computeHashline,
	createHashlineEditTool,
	createHashlineReadTool,
	formatHashlineRef,
	parseHashlineRef,
	renderHashlineSlice,
} from "../lib/tools/hashline-tools.js";

function createToolContext(directory: string): ToolContext {
	return {
		sessionID: "session-test",
		messageID: "message-test",
		agent: "agent-test",
		directory,
		worktree: directory,
		abort: new AbortController().signal,
		metadata: vi.fn(),
		ask: vi.fn(async () => {}),
	};
}

describe("hashline tools", () => {
	it("computes stable 8-char hashline hashes", () => {
		const hashA = computeHashline("alpha");
		const hashB = computeHashline("alpha");
		const hashC = computeHashline("beta");

		expect(hashA).toHaveLength(8);
		expect(hashA).toBe(hashB);
		expect(hashA).not.toBe(hashC);
	});

	it("formats and parses hashline refs", () => {
		const ref = formatHashlineRef(7, "example line");
		const parsed = parseHashlineRef(ref);

		expect(parsed).not.toBeNull();
		expect(parsed?.lineNumber).toBe(7);
		expect(parsed?.hash).toBe(computeHashline("example line"));
	});

	it("rejects malformed hashline refs", () => {
		expect(parseHashlineRef("7#abcdef12")).toBeNull();
		expect(parseHashlineRef("L0#abcdef12")).toBeNull();
		expect(parseHashlineRef("L2#xyz")).toBeNull();
	});

	it("renders hashline slices with refs", () => {
		const content = "alpha\nbeta\ngamma\n";
		const rendered = renderHashlineSlice(content, 2, 2);

		expect(rendered).toContain("Hashline window 2-3 of 3");
		expect(rendered).toContain(`${formatHashlineRef(2, "beta")} | beta`);
		expect(rendered).toContain(`${formatHashlineRef(3, "gamma")} | gamma`);
	});

	it("applies legacy edit replacement", () => {
		const result = applyLegacyEdit("one two one", {
			oldString: "one",
			newString: "ONE",
			replaceAll: true,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.updatedContent).toBe("ONE two ONE");
			expect(result.replacements).toBe(2);
		}
	});

	it("rejects ambiguous legacy edits without replaceAll", () => {
		const result = applyLegacyEdit("one two one", {
			oldString: "one",
			newString: "ONE",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("multiple");
		}
	});

	it("rejects unresolved template placeholders in legacy oldString", () => {
		const result = applyLegacyEdit("alpha\nbeta\n", {
			oldString: "${TARGET_SNIPPET}",
			newString: "beta",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("unresolved template placeholder");
			expect(result.message).toContain("hashline_read");
		}
	});

	it("allows normal template-literal fragments in legacy oldString", () => {
		const result = applyLegacyEdit("const message = `hello ${name}`;\n", {
			oldString: "${name}",
			newString: "${userName}",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.updatedContent).toBe(
				"const message = `hello ${userName}`;\n",
			);
			expect(result.replacements).toBe(1);
		}
	});

	it("applies hashline replace with hash verification", () => {
		const content = "alpha\nbeta\ngamma\n";
		const lineRef = formatHashlineRef(2, "beta");
		const result = applyHashlineEdit(content, {
			lineRef,
			operation: "replace",
			content: "BETA",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.updatedContent).toBe("alpha\nBETA\ngamma\n");
			expect(result.operation).toBe("replace");
		}
	});

	it("rejects hashline edit when hash does not match current line", () => {
		const content = "alpha\nbeta\ngamma\n";
		const result = applyHashlineEdit(content, {
			lineRef: "L2#00000000",
			operation: "replace",
			content: "BETA",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("hash mismatch");
		}
	});

	it("executes edit tool in hashline mode", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "hashline-edit-"));
		try {
			const filePath = join(tempDir, "demo.txt");
			await writeFile(filePath, "one\ntwo\nthree\n", "utf8");

			const editTool = createHashlineEditTool();
			const context = createToolContext(tempDir);
			const lineRef = formatHashlineRef(2, "two");

			const output = await editTool.execute(
				{
					path: filePath,
					lineRef,
					operation: "replace",
					content: "TWO",
				},
				context,
			);

			const next = await readFile(filePath, "utf8");
			expect(next).toBe("one\nTWO\nthree\n");
			expect(output).toContain("using hashline replace");
			expect((context.ask as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("executes hashline_read tool", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "hashline-read-"));
		try {
			const filePath = join(tempDir, "demo.txt");
			await writeFile(filePath, "one\ntwo\nthree\n", "utf8");

			const readTool = createHashlineReadTool();
			const context = createToolContext(tempDir);
			const output = await readTool.execute(
				{ path: filePath, startLine: 1, maxLines: 2 },
				context,
			);

			expect(output).toContain("Hashline window 1-2");
			expect(output).toContain(formatHashlineRef(1, "one"));
			expect(output).toContain(formatHashlineRef(2, "two"));
			expect((context.ask as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

