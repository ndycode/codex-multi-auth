import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import solidPlugin from "@opentui/solid/bun-plugin";

const runtimeRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoRoot = resolve(runtimeRoot, "..");
const outputDir = join(repoRoot, "dist", "opentui");
const entrypoint = join(runtimeRoot, "opentui", "index.tsx");

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const result = await Bun.build({
	entrypoints: [entrypoint],
	outdir: outputDir,
	target: "bun",
	format: "esm",
	sourcemap: "external",
	plugins: [solidPlugin],
});

if (!result.success) {
	for (const log of result.logs) {
		console.error(log.message);
	}
	throw new Error("OpenTUI build failed.");
}

console.log(`Built OpenTUI shell proof at ${outputDir}`);
