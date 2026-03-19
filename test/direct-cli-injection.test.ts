import { describe, expect, it, vi } from "vitest";
import {
	announceDirectCliInjection,
	formatDirectCliInjectionSignal,
	sanitizeDirectCliInjectionLabel,
} from "../lib/ui/direct-cli-injection.js";

function createFakeTerminalStream() {
	let output = "";
	return {
		isTTY: true,
		write(chunk: string) {
			output += chunk;
			return true;
		},
		get output() {
			return output;
		},
	};
}

describe("direct cli injection ui", () => {
	it("sanitizes labels before formatting the signal text", () => {
		const label = "\x1b[31m  Account\nOne\t\t[\u0007id:abc123]  ";

		expect(sanitizeDirectCliInjectionLabel(label)).toBe("Account One [id:abc123]");
		expect(formatDirectCliInjectionSignal(label)).toBe("Account One [id:abc123] injected");
	});

	it("truncates long labels before formatting the signal text", () => {
		const label = "x".repeat(100);

		expect(sanitizeDirectCliInjectionLabel(label, 12)).toBe("xxxxxxxxx...");
		expect(formatDirectCliInjectionSignal(label)).toBe(`${"x".repeat(69)}... injected`);
	});

	it("announces the signal to both banner and terminal title streams", () => {
		const bannerStream = createFakeTerminalStream();
		const titleStream = createFakeTerminalStream();

		const wrote = announceDirectCliInjection("Account 1", {
			bannerStream,
			titleStream,
		});

		expect(wrote).toBe(true);
		expect(bannerStream.output).toBe("Account 1 injected\n");
		expect(titleStream.output).toBe("\x1b]0;Account 1 injected\x07");
	});

	it("skips non-tty streams without throwing", () => {
		const bannerStream = { isTTY: false, write: vi.fn() };
		const titleStream = { isTTY: false, write: vi.fn() };

		const wrote = announceDirectCliInjection("Account 1", {
			bannerStream,
			titleStream,
		});

		expect(wrote).toBe(false);
		expect(bannerStream.write).not.toHaveBeenCalled();
		expect(titleStream.write).not.toHaveBeenCalled();
	});
});
