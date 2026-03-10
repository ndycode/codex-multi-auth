import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	promptInkAccountDetails,
	promptInkConfirmAccountDelete,
	promptInkConfirmAccountRefresh,
	promptInkRestoreForLogin,
} from "../lib/ui-ink/index.js";

function createMockInput(): NodeJS.ReadStream {
	const stream = new PassThrough() as PassThrough & NodeJS.ReadStream & {
		setRawMode: (value: boolean) => void;
		ref: () => void;
		unref: () => void;
	};
	Object.defineProperty(stream, "isTTY", {
		value: true,
		configurable: true,
	});
	stream.setRawMode = () => undefined;
	stream.ref = () => undefined;
	stream.unref = () => undefined;
	return stream;
}

function createMockOutput(): NodeJS.WriteStream {
	const stream = new PassThrough() as PassThrough & NodeJS.WriteStream;
	Object.defineProperty(stream, "isTTY", {
		value: true,
		configurable: true,
	});
	Object.defineProperty(stream, "columns", {
		value: 120,
		configurable: true,
	});
	Object.defineProperty(stream, "rows", {
		value: 40,
		configurable: true,
	});
	return stream;
}

function createAccount() {
	const now = Date.now();
	return {
		index: 0,
		sourceIndex: 2,
		quickSwitchNumber: 1,
		email: "alpha@example.com",
		accountId: "acc_alpha",
		addedAt: now - 10_000,
		lastUsed: now - 2_000,
		status: "active" as const,
		quotaSummary: "5h 70% | 7d 40%",
		enabled: true,
	};
}

describe("ink detail and recovery flows", () => {
	it.each([
		["s", "set-current"],
		["r", "refresh"],
		["e", "toggle"],
		["d", "delete"],
		["q", "cancel"],
	])("maps %s to %s on the account detail screen", async (keyPress, expected) => {
		const input = createMockInput();
		const output = createMockOutput();
		const stderr = createMockOutput();

		const resultPromise = promptInkAccountDetails({
			account: createAccount(),
			stdin: input,
			stdout: output,
			stderr,
			patchConsole: false,
			exitOnCtrlC: false,
		});

		await new Promise((resolve) => setTimeout(resolve, 30));
		input.push(keyPress);

		await expect(resultPromise).resolves.toBe(expected);
	});

	it("confirms refresh in the Ink re-login prompt", async () => {
		const input = createMockInput();
		const output = createMockOutput();
		const stderr = createMockOutput();

		const resultPromise = promptInkConfirmAccountRefresh({
			account: createAccount(),
			stdin: input,
			stdout: output,
			stderr,
			patchConsole: false,
			exitOnCtrlC: false,
		});

		await new Promise((resolve) => setTimeout(resolve, 30));
		input.push("r");

		await expect(resultPromise).resolves.toBe(true);
	});

	it("requires typing DELETE for Ink account deletion", async () => {
		const input = createMockInput();
		const output = createMockOutput();
		const stderr = createMockOutput();

		const resultPromise = promptInkConfirmAccountDelete({
			account: createAccount(),
			stdin: input,
			stdout: output,
			stderr,
			patchConsole: false,
			exitOnCtrlC: false,
		});

		await new Promise((resolve) => setTimeout(resolve, 30));
		for (const key of ["D", "E", "L", "E", "T", "E", "\r"]) {
			input.push(key);
		}

		await expect(resultPromise).resolves.toBe(true);
	});

	it("supports Ink restore prompt actions", async () => {
		const input = createMockInput();
		const output = createMockOutput();
		const stderr = createMockOutput();

		const resultPromise = promptInkRestoreForLogin({
			reasonText: "No saved account pool was found.",
			snapshotInfo: "latest backup | 2 accounts | 512 bytes | 3/9/2026, 10:00:00 PM\n/mock/openai-codex-accounts.json.bak",
			snapshotCount: 2,
			stdin: input,
			stdout: output,
			stderr,
			patchConsole: false,
			exitOnCtrlC: false,
		});

		await new Promise((resolve) => setTimeout(resolve, 30));
		input.push("r");

		await expect(resultPromise).resolves.toBe(true);
	});
});
