import { describe, expect, it } from "vitest";
import { parseKey } from "../lib/ui/ansi.js";

describe("ansi parseKey", () => {
	it("parses home key variants", () => {
		expect(parseKey(Buffer.from("\x1b[H"))).toBe("home");
		expect(parseKey(Buffer.from("\x1bOH"))).toBe("home");
		expect(parseKey(Buffer.from("\x1b[1~"))).toBe("home");
		expect(parseKey(Buffer.from("\x1b[7~"))).toBe("home");
	});

	it("parses end key variants", () => {
		expect(parseKey(Buffer.from("\x1b[F"))).toBe("end");
		expect(parseKey(Buffer.from("\x1bOF"))).toBe("end");
		expect(parseKey(Buffer.from("\x1b[4~"))).toBe("end");
		expect(parseKey(Buffer.from("\x1b[8~"))).toBe("end");
	});

	it("preserves existing arrow and escape parsing", () => {
		expect(parseKey(Buffer.from("\x1b[A"))).toBe("up");
		expect(parseKey(Buffer.from("\x1b[B"))).toBe("down");
		expect(parseKey(Buffer.from("\x1b"))).toBe("escape-start");
		expect(parseKey(Buffer.from("\x03"))).toBe("escape");
		expect(parseKey(Buffer.from("\r"))).toBe("enter");
	});
});
