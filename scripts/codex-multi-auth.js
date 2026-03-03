#!/usr/bin/env node

import { runCodexMultiAuthCli } from "../dist/lib/codex-manager.js";

const exitCode = await runCodexMultiAuthCli(process.argv.slice(2));
process.exitCode = Number.isInteger(exitCode) ? exitCode : 1;
