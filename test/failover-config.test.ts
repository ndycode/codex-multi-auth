import { describe, expect, it } from "vitest";
import {
	parseEnvInt,
	parseFailoverMode,
} from "../lib/request/failover-config.js";

describe("failover config helpers", () => {
	it("parses failover mode with balanced fallback", () => {
		expect(parseFailoverMode("aggressive")).toBe("aggressive");
		expect(parseFailoverMode(" conservative ")).toBe("conservative");
		expect(parseFailoverMode("weird")).toBe("balanced");
		expect(parseFailoverMode(undefined)).toBe("balanced");
	});

	it("parses finite integers from env values", () => {
		expect(parseEnvInt("42")).toBe(42);
		expect(parseEnvInt("08")).toBe(8);
		expect(parseEnvInt(undefined)).toBeUndefined();
		expect(parseEnvInt("abc")).toBeUndefined();
	});
});
