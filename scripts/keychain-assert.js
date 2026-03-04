#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";

function main() {
	const args = [
		"run",
		"test",
		"--",
		"test/storage-v4-keychain.test.ts",
		"test/token-store.test.ts",
	];
	const env = {
		...process.env,
		CODEX_SECRET_STORAGE_MODE: "keychain",
	};
	if (process.env.npm_execpath) {
		execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
			cwd: process.cwd(),
			stdio: "inherit",
			env,
		});
		return;
	}
	execFileSync("npm", args, {
		cwd: process.cwd(),
		stdio: "inherit",
		env,
	});
}

try {
	main();
} catch (error) {
	process.exit(typeof error?.status === "number" ? error.status : 1);
}
