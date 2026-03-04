import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runDevDoctor } from "./doctor-dev.js";

const WINDOWS_INSTALL_RETRY_ATTEMPTS = 3;
const WINDOWS_INSTALL_RETRY_BASE_DELAY_MS = 300;

async function waitForMilliseconds(milliseconds, waitFn) {
	if (typeof waitFn === "function") {
		await waitFn(milliseconds);
		return;
	}
	await new Promise((resolveDelay) => {
		setTimeout(resolveDelay, milliseconds);
	});
}

export function resolveNpmInvocation(options = {}) {
	const platform = options.platform ?? process.platform;
	const npmExecPath = (options.npmExecPath ?? process.env.npm_execpath ?? "").trim();
	const execPath = options.execPath ?? process.execPath;

	if (npmExecPath.length > 0) {
		return {
			command: execPath,
			prefixArgs: [npmExecPath],
		};
	}

	return {
		command: platform === "win32" ? "npm.cmd" : "npm",
		prefixArgs: [],
	};
}

export function runCommand(command, args = [], cwd = process.cwd(), options = {}) {
	const spawnFactory = options.spawnFactory ?? spawn;
	const env = options.env ?? process.env;

	return new Promise((resolveExitCode) => {
		let settled = false;
		const settle = (exitCode) => {
			if (settled) {
				return;
			}
			settled = true;
			resolveExitCode(exitCode);
		};

		const child = spawnFactory(command, args, {
			cwd,
			stdio: "inherit",
			env,
		});

		child.once("error", (error) => {
			console.error(`Failed to run command: ${command} ${args.join(" ")}`);
			console.error(String(error));
			settle(1);
		});

		child.once("exit", (code, signal) => {
			if (signal) {
				settle(signal === "SIGINT" ? 130 : 1);
				return;
			}
			settle(typeof code === "number" ? code : 1);
		});
	});
}

export async function runSetupDev(options = {}) {
	const cwd = resolve(options.cwd ?? process.cwd());
	const platform = options.platform ?? process.platform;
	const runDoctor = options.runDevDoctorFn ?? runDevDoctor;
	const runCommandFn = options.runCommandFn ?? ((command, args, commandCwd) => runCommand(command, args, commandCwd));
	const installRetryAttempts =
		typeof options.installRetryAttempts === "number"
			? options.installRetryAttempts
			: platform === "win32"
				? WINDOWS_INSTALL_RETRY_ATTEMPTS
				: 1;
	const installRetryBaseDelayMs =
		typeof options.installRetryBaseDelayMs === "number"
			? options.installRetryBaseDelayMs
			: WINDOWS_INSTALL_RETRY_BASE_DELAY_MS;
	const npmInvocation =
		options.npmInvocation ??
		resolveNpmInvocation({
			platform,
			npmExecPath: options.npmExecPath,
			execPath: options.execPath,
		});

	console.log("Running dev environment checks...");
	const doctorExitCode = runDoctor({ cwd });
	if (doctorExitCode !== 0) {
		return doctorExitCode;
	}

	const runNpm = (args) =>
		runCommandFn(npmInvocation.command, [...npmInvocation.prefixArgs, ...args], cwd);

	console.log("Installing dependencies with npm ci...");
	let installExitCode = 1;
	for (let attempt = 1; attempt <= installRetryAttempts; attempt += 1) {
		installExitCode = await runNpm(["ci"]);
		if (installExitCode === 0) {
			break;
		}
		if (attempt < installRetryAttempts) {
			const delayMs = installRetryBaseDelayMs * 2 ** (attempt - 1);
			console.warn(
				`npm ci failed (attempt ${attempt}/${installRetryAttempts}). Retrying in ${delayMs}ms to tolerate transient EBUSY/EPERM Windows file locks...`,
			);
			await waitForMilliseconds(delayMs, options.waitFn);
		}
	}
	if (installExitCode !== 0) {
		console.error("setup:dev failed during npm ci.");
		return installExitCode;
	}

	console.log("Running local validation gate...");
	const gateCommands = [
		["run", "verify"],
		["test", "--", "test/documentation.test.ts"],
	];

	for (const gateCommand of gateCommands) {
		const gateExitCode = await runNpm(gateCommand);
		if (gateExitCode !== 0) {
			console.error(`setup:dev failed on: npm ${gateCommand.join(" ")}`);
			return gateExitCode;
		}
	}

	console.log("setup:dev completed successfully.");
	return 0;
}

const isDirectRun = (() => {
	try {
		return resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
})();

if (isDirectRun) {
	const exitCode = await runSetupDev();
	process.exitCode = exitCode;
}
