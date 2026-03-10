/// <reference types="bun-types" />
import { build } from "bun";
import solidPlugin from "@opentui/solid/bun-plugin";

const result = await build({
	entrypoints: ["./runtime/opentui/index.ts"],
	outdir: "./dist/opentui",
	target: "bun",
	sourcemap: "external",
  plugins: [solidPlugin],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log.message);
  }
  process.exit(1);
}

console.log(`Built OpenTUI runtime (${result.outputs.length} files) -> dist/opentui`);
