#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PLATFORM_PACKAGE_BY_TARGET = {
	"x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
	"aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
	"x86_64-apple-darwin": "@openai/codex-darwin-x64",
	"aarch64-apple-darwin": "@openai/codex-darwin-arm64",
	"x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
	"aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

function fail(message) {
	console.error(message);
	process.exit(1);
}

function getTargetTriple() {
	switch (process.platform) {
		case "linux":
		case "android":
			switch (process.arch) {
				case "x64":
					return "x86_64-unknown-linux-musl";
				case "arm64":
					return "aarch64-unknown-linux-musl";
				default:
					return null;
			}
		case "darwin":
			switch (process.arch) {
				case "x64":
					return "x86_64-apple-darwin";
				case "arm64":
					return "aarch64-apple-darwin";
				default:
					return null;
			}
		case "win32":
			switch (process.arch) {
				case "x64":
					return "x86_64-pc-windows-msvc";
				case "arm64":
					return "aarch64-pc-windows-msvc";
				default:
					return null;
			}
		default:
			return null;
	}
}

function parseArgs(argv) {
	const parsed = {
		codextRoot: "",
		destinationRoot: "",
		officialVendorRoot: "",
		sourceBin: "",
		skipBuild: false,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		switch (arg) {
			case "--codext-root":
				parsed.codextRoot = argv[i + 1] ?? "";
				i += 1;
				break;
			case "--official-vendor-root":
				parsed.officialVendorRoot = argv[i + 1] ?? "";
				i += 1;
				break;
			case "--destination-root":
				parsed.destinationRoot = argv[i + 1] ?? "";
				i += 1;
				break;
			case "--source-bin":
				parsed.sourceBin = argv[i + 1] ?? "";
				i += 1;
				break;
			case "--skip-build":
				parsed.skipBuild = true;
				break;
			default:
				fail(`Unknown argument: ${arg}`);
		}
	}

	return parsed;
}

function resolveNpmGlobalRoot() {
	const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npmCmd, ["root", "-g"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) {
		fail(
			[
				"Failed to resolve the global npm root while locating @openai/codex.",
				String(result.error),
			].join("\n"),
		);
	}
	if (result.status !== 0) {
		const stderr = result.stderr?.trim();
		fail(
			[
				"Failed to resolve the global npm root while locating @openai/codex.",
				stderr ? `npm stderr: ${stderr}` : null,
			]
				.filter(Boolean)
				.join("\n"),
		);
	}
	return result.stdout.trim();
}

function resolveOfficialVendorRootFromCodexBin(targetTriple) {
	const codexBinOverride = (process.env.CODEX_MULTI_AUTH_REAL_CODEX_BIN ?? "").trim();
	if (codexBinOverride.length === 0) {
		return null;
	}

	const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];
	if (!platformPackage) {
		return null;
	}

	const resolvedBin = resolvePath(codexBinOverride);
	const vendorRoot = join(
		dirname(resolvedBin),
		"..",
		"node_modules",
		platformPackage,
		"vendor",
	);
	return existsSync(join(vendorRoot, targetTriple)) ? vendorRoot : null;
}

function resolveOfficialVendorRoot(targetTriple, override) {
	const trimmedOverride = override.trim();
	if (trimmedOverride.length > 0) {
		const resolved = resolvePath(trimmedOverride);
		if (!existsSync(join(resolved, targetTriple))) {
			fail(
				[
					`Official vendor root override is missing target ${targetTriple}:`,
					resolved,
				].join("\n"),
			);
		}
		return resolved;
	}

	const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];
	if (!platformPackage) {
		fail(`Unsupported target triple: ${targetTriple}`);
	}

	const require = createRequire(import.meta.url);
	try {
		const packageJsonPath = require.resolve(`${platformPackage}/package.json`);
		return join(dirname(packageJsonPath), "vendor");
	} catch {
		// Fall through to global lookup.
	}

	const vendorRootFromCodexBin = resolveOfficialVendorRootFromCodexBin(targetTriple);
	if (vendorRootFromCodexBin) {
		return vendorRootFromCodexBin;
	}

	const globalRoot = resolveNpmGlobalRoot();
	const globalVendorRoot = join(
		globalRoot,
		"@openai",
		"codex",
		"node_modules",
		platformPackage,
		"vendor",
	);
	if (existsSync(join(globalVendorRoot, targetTriple))) {
		return globalVendorRoot;
	}

	fail(
		[
			`Could not locate the stock vendor runtime for ${platformPackage}.`,
			"Install the official CLI globally first: npm install -g @openai/codex",
			"Or pass --official-vendor-root <path-to-vendor>.",
		].join("\n"),
	);
}

function resolveCodextRsDir(packageRoot, override) {
	const candidates = [];
	const trimmedOverride = override.trim();
	if (trimmedOverride.length > 0) {
		candidates.push(resolvePath(trimmedOverride));
	}

	const envCandidates = [
		process.env.CODEX_MULTI_AUTH_CODEXT_RS_DIR,
		process.env.CODEX_MULTI_AUTH_CODEXT_DIR,
	].map((value) => (value ?? "").trim());
	for (const candidate of envCandidates) {
		if (candidate.length > 0) {
			candidates.push(resolvePath(candidate));
		}
	}

	candidates.push(resolvePath(packageRoot, "..", "codext", "codex-rs"));
	candidates.push(resolvePath(packageRoot, "..", "codext"));

	for (const candidate of candidates) {
		if (existsSync(join(candidate, "Cargo.toml"))) {
			return candidate;
		}
		const nested = join(candidate, "codex-rs");
		if (existsSync(join(nested, "Cargo.toml"))) {
			return nested;
		}
	}

	fail(
		[
			"Could not locate the codext source tree to build the hot-reload runtime.",
			"Pass --codext-root <path> or set CODEX_MULTI_AUTH_CODEXT_RS_DIR.",
		].join("\n"),
	);
}

function resolveRuntimeDestinationRoot(override) {
	const trimmedOverride = override.trim();
	if (trimmedOverride.length > 0) {
		return resolvePath(trimmedOverride);
	}

	const envRoot = (process.env.CODEX_MULTI_AUTH_RUNTIME_ROOT ?? "").trim();
	if (envRoot.length > 0) {
		return resolvePath(envRoot);
	}

	return resolvePath(homedir(), ".codex", "multi-auth", "runtime");
}

function runOrFail(command, args, options = {}) {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		...options,
	});
	if (result.status !== 0) {
		fail(`Command failed: ${command} ${args.join(" ")}`);
	}
}

function buildCodextRuntime(codextRsDir) {
	const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
	const buildAttempts = [
		{
			label: "release",
			args: ["build", "--release", "--bin", "codex"],
			binaryPath: join(codextRsDir, "target", "release", binaryName),
			env: {},
		},
		...(process.platform === "win32"
			? [
					{
						label: "release (Windows fallback: lto=off, codegen-units=16)",
						args: ["build", "--release", "--bin", "codex"],
						binaryPath: join(codextRsDir, "target", "release", binaryName),
						env: {
							CARGO_PROFILE_RELEASE_LTO: "off",
							CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
						},
					},
					{
						label: "ci-test (Windows fallback profile)",
						args: ["build", "--profile", "ci-test", "--bin", "codex"],
						binaryPath: join(codextRsDir, "target", "ci-test", binaryName),
						env: {},
					},
				]
			: []),
	];

	let lastFailure = "";
	for (const attempt of buildAttempts) {
		console.log(`Building codext runtime via cargo profile: ${attempt.label}`);
		const result = spawnSync("cargo", attempt.args, {
			cwd: codextRsDir,
			stdio: "inherit",
			env: {
				...process.env,
				...attempt.env,
			},
		});
		if (result.status === 0 && existsSync(attempt.binaryPath)) {
			return attempt.binaryPath;
		}
		lastFailure = `cargo ${attempt.args.join(" ")} failed`;
	}

	fail(
		[
			"Unable to build the patched codext runtime.",
			lastFailure,
		].join("\n"),
	);
}

const args = parseArgs(process.argv.slice(2));
const targetTriple = getTargetTriple();
if (!targetTriple) {
	fail(`Unsupported platform: ${process.platform} (${process.arch})`);
}

const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const packageRoot = resolvePath(scriptDir, "..");
const officialVendorRoot = resolveOfficialVendorRoot(
	targetTriple,
	args.officialVendorRoot,
);
const officialArchRoot = join(officialVendorRoot, targetTriple);
if (!existsSync(officialArchRoot)) {
	fail(`Official vendor runtime is missing target ${targetTriple}: ${officialArchRoot}`);
}

let sourceBinary = args.sourceBin.trim();
if (sourceBinary.length > 0) {
	sourceBinary = resolvePath(sourceBinary);
	if (!existsSync(sourceBinary)) {
		fail(`Source runtime binary does not exist: ${sourceBinary}`);
	}
} else {
	const codextRsDir = resolveCodextRsDir(packageRoot, args.codextRoot);
	if (args.skipBuild) {
		const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
		sourceBinary = join(codextRsDir, "target", "release", binaryName);
		if (!existsSync(sourceBinary)) {
			fail(
				[
					"--skip-build was requested but the codext release binary does not exist yet:",
					sourceBinary,
				].join("\n"),
			);
		}
	} else {
		sourceBinary = buildCodextRuntime(codextRsDir);
	}
}

const destinationArchRoot = join(
	resolveRuntimeDestinationRoot(args.destinationRoot),
	targetTriple,
);
rmSync(destinationArchRoot, { recursive: true, force: true });
mkdirSync(dirname(destinationArchRoot), { recursive: true });
cpSync(officialArchRoot, destinationArchRoot, { recursive: true, force: true });

const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
const destinationBinary = join(destinationArchRoot, "codex", binaryName);
copyFileSync(sourceBinary, destinationBinary);
if (process.platform !== "win32") {
	chmodSync(destinationBinary, 0o755);
}

const manifestPath = join(destinationArchRoot, "codex-multi-auth-runtime.json");
writeFileSync(
	manifestPath,
	JSON.stringify(
		{
			targetTriple,
			builtAt: new Date().toISOString(),
			officialVendorRoot,
			officialArchRoot,
			sourceBinary,
			destinationBinary,
			sourceKind: basename(sourceBinary),
		},
		null,
		2,
	),
	"utf8",
);

console.log(
	[
		`Bundled hot-reload Codex runtime for ${targetTriple}.`,
		`Copied stock vendor tree from: ${officialArchRoot}`,
		`Replaced runtime binary with: ${sourceBinary}`,
		`Staged runtime cache at: ${destinationArchRoot}`,
	].join("\n"),
);
