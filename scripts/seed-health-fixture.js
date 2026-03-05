#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
const root = join(workspace, ".tmp", "health-fixture");
const logsDir = join(root, "logs");

mkdirSync(logsDir, { recursive: true });
writeFileSync(
	join(root, "openai-codex-accounts.json"),
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
	"utf8",
);
writeFileSync(
	join(root, "settings.json"),
	`${JSON.stringify({ version: 1, pluginConfig: {}, dashboardDisplaySettings: {} }, null, 2)}\n`,
	"utf8",
);
writeFileSync(
	join(logsDir, "audit.log"),
	`${JSON.stringify({ timestamp: new Date().toISOString(), action: "request.start", outcome: "success" })}\n`,
	"utf8",
);
