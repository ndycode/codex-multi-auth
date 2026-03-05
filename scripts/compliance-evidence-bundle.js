#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import process from "node:process";

const PROFILES = {
	quick: [
		{ id: "typecheck", args: ["run", "typecheck"] },
		{ id: "lint", args: ["run", "lint"] },
		{ id: "build", args: ["run", "build"] },
		{ id: "health-check", args: ["run", "ops:health-check"] },
		{ id: "perf-budget", args: ["run", "perf:budget-check"] },
	],
	release: [
		{ id: "typecheck", args: ["run", "typecheck"] },
		{ id: "lint", args: ["run", "lint"] },
		{ id: "build", args: ["run", "build"] },
		{ id: "test", args: ["test"] },
		{ id: "audit-ci", args: ["run", "audit:ci"] },
		{ id: "health-check", args: ["run", "ops:health-check"] },
		{ id: "perf-budget", args: ["run", "perf:budget-check"] },
		{ id: "sbom-generate", args: ["run", "sbom:generate"] },
		{ id: "sbom-verify", args: ["run", "sbom:verify"] },
	],
};
const MAX_BUFFER_BYTES = 20 * 1024 * 1024;

function parseArgValue(name) {
	const prefix = `${name}=`;
	const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
	return hit ? hit.slice(prefix.length) : undefined;
}

function hasFlag(name) {
	return process.argv.slice(2).includes(name);
}

function safeExec(command, args, cwd) {
	try {
		return execFileSync(command, args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		return (error?.stdout ?? error?.stderr ?? "").toString();
	}
}

function runNpm(args, options) {
	if (process.platform === "win32") {
		const escaped = args
			.map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))
			.join(" ");
		return execFileSync("cmd.exe", ["/d", "/s", "/c", `npm ${escaped}`], {
			...options,
			maxBuffer: MAX_BUFFER_BYTES,
		});
	}
	return execFileSync("npm", args, {
		...options,
		maxBuffer: MAX_BUFFER_BYTES,
	});
}

function runCheck(entry, cwd, dryRun) {
	const startedAt = new Date().toISOString();
	const startedMs = Date.now();
	if (dryRun) {
		return {
			id: entry.id,
			command: `npm ${entry.args.join(" ")}`,
			startedAt,
			durationMs: 0,
			status: "skipped",
			exitCode: 0,
			output: "dry-run",
		};
	}
	try {
		const output = runNpm(entry.args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return {
			id: entry.id,
			command: `npm ${entry.args.join(" ")}`,
			startedAt,
			durationMs: Date.now() - startedMs,
			status: "pass",
			exitCode: 0,
			output,
		};
	} catch (error) {
		const stdout = error?.stdout ? String(error.stdout) : "";
		const stderr = error?.stderr ? String(error.stderr) : "";
		const message = error instanceof Error ? error.message : String(error);
		return {
			id: entry.id,
			command: `npm ${entry.args.join(" ")}`,
			startedAt,
			durationMs: Date.now() - startedMs,
			status: "fail",
			exitCode: typeof error?.status === "number" ? error.status : 1,
			output: `${stdout}${stderr}${stdout || stderr ? "" : message}`,
		};
	}
}

function markdownSummary(payload) {
	const lines = [
		"# Compliance Evidence Bundle",
		"",
		`Generated at: ${payload.generatedAt}`,
		`Profile: ${payload.profile}`,
		`Branch: ${payload.git.branch}`,
		`Commit: ${payload.git.commit}`,
		"",
		"| Check | Status | Exit | Duration (ms) |",
		"| --- | --- | ---: | ---: |",
	];
	for (const result of payload.results) {
		lines.push(`| ${result.id} | ${result.status} | ${result.exitCode} | ${result.durationMs} |`);
	}
	lines.push("", `Overall: **${payload.status.toUpperCase()}**`);
	return `${lines.join("\n")}\n`;
}

async function main() {
	const cwd = process.cwd();
	const profile = parseArgValue("--profile") ?? "quick";
	const dryRun = hasFlag("--dry-run");
	if (!Object.hasOwn(PROFILES, profile)) {
		throw new Error(`Unknown profile: ${profile}. Expected one of: ${Object.keys(PROFILES).join(", ")}`);
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = resolve(parseArgValue("--out-dir") ?? join(cwd, ".tmp", "compliance-evidence", timestamp));
	await mkdir(outDir, { recursive: true });

	const git = {
		branch: safeExec("git", ["branch", "--show-current"], cwd).trim(),
		commit: safeExec("git", ["rev-parse", "HEAD"], cwd).trim(),
	};

	const checks = PROFILES[profile];
	const results = checks.map((entry) => runCheck(entry, cwd, dryRun));
	for (let index = 0; index < results.length; index += 1) {
		const result = results[index];
		const logName = `${String(index + 1).padStart(2, "0")}-${result.id}.log`;
		await writeFile(join(outDir, logName), result.output, "utf8");
	}

	const payload = {
		command: "compliance-evidence-bundle",
		generatedAt: new Date().toISOString(),
		profile,
		dryRun,
		outputDir: outDir,
		git,
		results: results.map(({ output, ...rest }) => rest),
		status: results.every((entry) => entry.status === "pass" || entry.status === "skipped")
			? "pass"
			: "fail",
	};

	await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	await writeFile(join(outDir, "summary.md"), markdownSummary(payload), "utf8");

	console.log(JSON.stringify(payload, null, 2));
	if (payload.status === "fail") {
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(
		`compliance-evidence-bundle failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
