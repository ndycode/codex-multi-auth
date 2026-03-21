#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPackBudgetCheck } from "./check-pack-budget-lib.js";

export { runPackBudgetCheck } from "./check-pack-budget-lib.js";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await runPackBudgetCheck();
}
