import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

function parseArgs(argv) {
	let rootArg;
	let printEnv = false;
	const command = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--root") {
			rootArg = argv[index + 1];
			index += 1;
			continue;
		}
		if (arg === "--print-env") {
			printEnv = true;
			continue;
		}
		command.push(...argv.slice(index));
		break;
	}

	return { rootArg, printEnv, command };
}

function ensureDir(path) {
	mkdirSync(path, { recursive: true });
	return path;
}

function buildIsolatedEnv(rootPath) {
	const root = resolve(rootPath);
	const homeDir = ensureDir(join(root, "home"));
	const codexHome = ensureDir(join(root, "codex-home"));
	const multiAuthDir = ensureDir(join(codexHome, "multi-auth"));
	const xdgConfigHome = ensureDir(join(root, "xdg-config"));
	const configPath = join(multiAuthDir, "config.json");
	const windowsHomeMatch = /^[A-Za-z]:[\\/]/.exec(homeDir);
	const windowsDrive = windowsHomeMatch ? homeDir.slice(0, 2) : undefined;
	const windowsPath = windowsHomeMatch ? homeDir.slice(2).replaceAll("/", "\\") : undefined;

	return {
		root,
		homeDir,
		codexHome,
		multiAuthDir,
		xdgConfigHome,
		configPath,
		env: {
			...process.env,
			HOME: homeDir,
			USERPROFILE: homeDir,
			...(windowsDrive && windowsPath
				? {
					HOMEDRIVE: windowsDrive,
					HOMEPATH: windowsPath,
				}
				: {}),
			XDG_CONFIG_HOME: xdgConfigHome,
			CODEX_HOME: codexHome,
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_CONFIG_PATH: configPath,
		},
	};
}

function resolveCommand(command) {
	if (command !== "bun") {
		return command;
	}

	const explicit = (process.env.BUN_BIN ?? "").trim();
	if (explicit.length > 0) {
		return explicit;
	}

	const candidate = process.platform === "win32"
		? join(homedir(), ".bun", "bin", "bun.exe")
		: join(homedir(), ".bun", "bin", "bun");

	return existsSync(candidate) ? candidate : command;
}

const { rootArg, printEnv, command } = parseArgs(process.argv.slice(2));
const isolated = buildIsolatedEnv(rootArg ?? join(repoRoot, ".sandbox", "isolated-codex-env"));

if (printEnv) {
	console.log(JSON.stringify({
		root: isolated.root,
		homeDir: isolated.homeDir,
		codexHome: isolated.codexHome,
		multiAuthDir: isolated.multiAuthDir,
		xdgConfigHome: isolated.xdgConfigHome,
		configPath: isolated.configPath,
	}, null, 2));
	if (command.length === 0) {
		process.exit(0);
	}
}

if (command.length === 0) {
	console.error("Usage: node scripts/with-isolated-codex-env.mjs [--root PATH] [--print-env] <command> [args...]");
	process.exit(1);
}

const executable = resolveCommand(command[0]);
const result = spawnSync(executable, command.slice(1), {
	stdio: "inherit",
	cwd: repoRoot,
	env: isolated.env,
	shell: process.platform === "win32",
});

if (typeof result.status === "number") {
	process.exit(result.status);
}

process.exit(1);
