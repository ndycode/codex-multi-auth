#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { renderDashboardHtml } from "./bench-format/render.mjs";

function usage() {
  console.log([
    "Usage: node scripts/benchmark-render-dashboard.mjs --input=PATH [--output=PATH]",
    "",
    "Options:",
    "  --input=PATH   Path to benchmark summary.json",
    "  --output=PATH  Output HTML path (default: alongside input as dashboard.html)",
  ].join("\n"));
}

function argValue(args, name) {
  const prefix = `${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  const inputRaw = argValue(args, "--input");
  if (!inputRaw) {
    usage();
    process.exitCode = 1;
    return;
  }
  const inputPath = resolve(inputRaw);
  const outputPath = resolve(argValue(args, "--output") ?? inputPath.replace(/summary\.json$/i, "dashboard.html"));

  const summary = JSON.parse(await readFile(inputPath, "utf8"));
  const html = renderDashboardHtml(summary);
  await writeFile(outputPath, html, "utf8");
  console.log(`Dashboard written: ${outputPath}`);
}

main().catch((error) => {
  console.error(`Render failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
