#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const MAX_BUFFER_BYTES = 20 * 1024 * 1024;

async function main() {
	const npmExecPath = process.env.npm_execpath;
	const outPath = resolve(".tmp/sbom.cdx.json");
	await mkdir(resolve(".tmp"), { recursive: true });
	const sbomArgs = ["sbom", "--omit=dev", "--sbom-format=cyclonedx", "--json"];
	const sbom = npmExecPath
		? execFileSync(process.execPath, [npmExecPath, ...sbomArgs], {
				cwd: process.cwd(),
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: MAX_BUFFER_BYTES,
			})
		: execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", sbomArgs, {
				cwd: process.cwd(),
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: MAX_BUFFER_BYTES,
			});
	await writeFile(outPath, `${sbom.trim()}\n`, "utf8");
	console.log(
		JSON.stringify(
			{
				command: "generate-sbom",
				outputPath: outPath,
				status: "pass",
			},
			null,
			2,
		),
	);
}

main().catch((error) => {
	console.error(`generate-sbom failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
