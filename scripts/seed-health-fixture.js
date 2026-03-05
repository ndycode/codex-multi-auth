#!/usr/bin/env node

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
const root = join(workspace, ".tmp", "health-fixture");
const logsDir = join(root, "logs");

mkdirSync(logsDir, { recursive: true, mode: 0o700 });
const accountsPath = join(root, "openai-codex-accounts.json");
writeFileSync(
	accountsPath,
	`${JSON.stringify(
		{
			version: 4,
			accounts: [
				{
					refreshTokenRef: "fixture-account:refresh",
					accessTokenRef: "fixture-account:access",
					addedAt: 1,
					lastUsed: 1,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {
				codex: 0,
				legacy: 0,
				gpt5: 0,
				o3: 0,
				o4mini: 0,
				oss: 0,
			},
		},
		null,
		2,
	)}\n`,
	{ encoding: "utf8", mode: 0o600 },
);
try {
	chmodSync(accountsPath, 0o600);
} catch {
	// Best-effort hardening for non-posix environments.
}
const settingsPath = join(root, "settings.json");
writeFileSync(
	settingsPath,
	`${JSON.stringify({ version: 1, pluginConfig: {}, dashboardDisplaySettings: {} }, null, 2)}\n`,
	{ encoding: "utf8", mode: 0o600 },
);
try {
	chmodSync(settingsPath, 0o600);
} catch {
	// Best-effort hardening for non-posix environments.
}
const auditPath = join(logsDir, "audit.log");
writeFileSync(
	auditPath,
	`${JSON.stringify({ timestamp: new Date().toISOString(), action: "request.start", outcome: "success" })}\n`,
	{ encoding: "utf8", mode: 0o600 },
);
try {
	chmodSync(auditPath, 0o600);
} catch {
	// Best-effort hardening for non-posix environments.
}
