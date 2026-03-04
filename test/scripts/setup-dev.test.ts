import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	resolveNpmInvocation,
	runCommand,
	runSetupDev,
} from "../../scripts/setup-dev.js";

describe("setup-dev script", () => {
	it("uses process.execPath + npm_execpath when npm_execpath is set", () => {
		expect(
			resolveNpmInvocation({
				npmExecPath: "/tmp/npm-cli.js",
				execPath: "/opt/node/bin/node",
				platform: "linux",
			}),
		).toEqual({
			command: "/opt/node/bin/node",
			prefixArgs: ["/tmp/npm-cli.js"],
		});
	});

	it("falls back to npm.cmd on win32 when npm_execpath is absent", () => {
		expect(
			resolveNpmInvocation({
				npmExecPath: "",
				platform: "win32",
			}),
		).toEqual({
			command: "npm.cmd",
			prefixArgs: [],
		});
	});

	it("runCommand resolves to 1 when error fires before exit", async () => {
		const spawnFactory = vi.fn(() => {
			const child = new EventEmitter();
			queueMicrotask(() => {
				child.emit("error", new Error("boom"));
				child.emit("exit", 0, null);
			});
			return child;
		});

		const exitCode = await runCommand("npm", ["ci"], process.cwd(), { spawnFactory, env: {} });
		expect(exitCode).toBe(1);
	});

	it("runCommand keeps the first result when exit fires before error", async () => {
		const spawnFactory = vi.fn(() => {
			const child = new EventEmitter();
			queueMicrotask(() => {
				child.emit("exit", 0, null);
				child.emit("error", new Error("late error"));
			});
			return child;
		});

		const exitCode = await runCommand("npm", ["ci"], process.cwd(), { spawnFactory, env: {} });
		expect(exitCode).toBe(0);
	});

	it("runCommand maps SIGINT to exit code 130", async () => {
		const spawnFactory = vi.fn(() => {
			const child = new EventEmitter();
			queueMicrotask(() => {
				child.emit("exit", null, "SIGINT");
			});
			return child;
		});

		const exitCode = await runCommand("npm", ["ci"], process.cwd(), { spawnFactory, env: {} });
		expect(exitCode).toBe(130);
	});

	it("runSetupDev executes doctor, install, and validation gates in order", async () => {
		const runDevDoctorFn = vi.fn().mockReturnValue(0);
		const runCommandFn = vi.fn().mockResolvedValue(0);
		const exitCode = await runSetupDev({
			cwd: process.cwd(),
			platform: "linux",
			runDevDoctorFn,
			runCommandFn,
			npmInvocation: { command: "npm", prefixArgs: [] },
		});

		expect(exitCode).toBe(0);
		expect(runDevDoctorFn).toHaveBeenCalledTimes(1);
		expect(runCommandFn).toHaveBeenNthCalledWith(1, "npm", ["ci"], expect.any(String));
		expect(runCommandFn).toHaveBeenNthCalledWith(2, "npm", ["run", "verify"], expect.any(String));
		expect(runCommandFn).toHaveBeenNthCalledWith(
			3,
			"npm",
			["test", "--", "test/documentation.test.ts"],
			expect.any(String),
		);
	});

	it("runSetupDev short-circuits when doctor fails", async () => {
		const runDevDoctorFn = vi.fn().mockReturnValue(2);
		const runCommandFn = vi.fn();
		const exitCode = await runSetupDev({
			cwd: process.cwd(),
			runDevDoctorFn,
			runCommandFn,
			npmInvocation: { command: "npm", prefixArgs: [] },
		});

		expect(exitCode).toBe(2);
		expect(runCommandFn).not.toHaveBeenCalled();
	});

	it("retries npm ci on win32 before running gates", async () => {
		const runCommandFn = vi
			.fn()
			.mockResolvedValueOnce(1)
			.mockResolvedValueOnce(1)
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(0);
		const waitFn = vi.fn().mockResolvedValue(undefined);
		const exitCode = await runSetupDev({
			cwd: process.cwd(),
			platform: "win32",
			runDevDoctorFn: () => 0,
			runCommandFn,
			waitFn,
			npmInvocation: { command: "npm.cmd", prefixArgs: [] },
			installRetryAttempts: 3,
			installRetryBaseDelayMs: 10,
		});

		expect(exitCode).toBe(0);
		expect(runCommandFn).toHaveBeenNthCalledWith(1, "npm.cmd", ["ci"], expect.any(String));
		expect(runCommandFn).toHaveBeenNthCalledWith(2, "npm.cmd", ["ci"], expect.any(String));
		expect(runCommandFn).toHaveBeenNthCalledWith(3, "npm.cmd", ["ci"], expect.any(String));
		expect(waitFn).toHaveBeenCalledTimes(2);
		expect(waitFn).toHaveBeenNthCalledWith(1, 10);
		expect(waitFn).toHaveBeenNthCalledWith(2, 20);
	});

	it("fails setup when npm ci keeps failing after retries", async () => {
		const runCommandFn = vi
			.fn()
			.mockResolvedValueOnce(1)
			.mockResolvedValueOnce(1)
			.mockResolvedValueOnce(1);
		const waitFn = vi.fn().mockResolvedValue(undefined);
		const exitCode = await runSetupDev({
			cwd: process.cwd(),
			platform: "win32",
			runDevDoctorFn: () => 0,
			runCommandFn,
			waitFn,
			npmInvocation: { command: "npm.cmd", prefixArgs: [] },
			installRetryAttempts: 3,
			installRetryBaseDelayMs: 10,
		});

		expect(exitCode).toBe(1);
		expect(runCommandFn).toHaveBeenCalledTimes(3);
		expect(waitFn).toHaveBeenCalledTimes(2);
	});
});
