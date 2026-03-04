#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runDevDoctor } from "./doctor-dev.js";

function resolveNpmInvocation() {
	const npmExecPath = (process.env.npm_execpath ?? "").trim();
	if (npmExecPath.length > 0) {
		return {
			command: process.execPath,
			prefixArgs: [npmExecPath],
		};
	}

	return {
		command: process.platform === "win32" ? "npm.cmd" : "npm",
		prefixArgs: [],
	};
}

function runCommand(command, args = [], cwd = process.cwd()) {
	return new Promise((resolveExitCode) => {
		const child = spawn(command, args, {
			cwd,
			stdio: "inherit",
			env: process.env,
		});

		child.once("error", (error) => {
			console.error(`Failed to run command: ${command} ${args.join(" ")}`);
			console.error(String(error));
			resolveExitCode(1);
		});

		child.once("exit", (code, signal) => {
			if (signal) {
				resolveExitCode(signal === "SIGINT" ? 130 : 1);
				return;
			}
			resolveExitCode(typeof code === "number" ? code : 1);
		});
	});
}

export async function runSetupDev(options = {}) {
	const cwd = resolve(options.cwd ?? process.cwd());

	console.log("Running dev environment checks...");
	const doctorExitCode = runDevDoctor({ cwd });
	if (doctorExitCode !== 0) {
		return doctorExitCode;
	}

	const npmInvocation = resolveNpmInvocation();
	const runNpm = (args) =>
		runCommand(npmInvocation.command, [...npmInvocation.prefixArgs, ...args], cwd);

	console.log("Installing dependencies with npm ci...");
	const installExitCode = await runNpm(["ci"]);
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
