import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function resolveBunCommand() {
	const envPath = (process.env.BUN_BIN ?? "").trim();
	if (envPath.length > 0) {
		return envPath;
	}

	const home = homedir();
	const candidates = process.platform === "win32"
		? [join(home, ".bun", "bin", "bun.exe")]
		: [join(home, ".bun", "bin", "bun")];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return "bun";
}

const bunCommand = resolveBunCommand();
const bunArgs = process.argv.length > 2 ? process.argv.slice(2) : ["test"];
const result = spawnSync(bunCommand, bunArgs, {
	stdio: "inherit",
	shell: process.platform === "win32",
	env: process.env,
});

if (typeof result.status === "number") {
	process.exit(result.status);
}

process.exit(1);
