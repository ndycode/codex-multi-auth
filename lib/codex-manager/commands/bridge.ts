import {
	addLocalClientToken,
	type LocalClientTokenRecord,
	loadLocalClientTokenStore,
	revokeLocalClientToken,
	rotateLocalClientToken,
} from "../../local-client-tokens.js";

export interface BridgeCommandDeps {
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
}

function printBridgeUsage(logInfo: (message: string) => void): void {
	logInfo(
		[
			"Usage:",
			"  codex-multi-auth bridge token create [--label <label>] [--json]",
			"  codex-multi-auth bridge token list [--json]",
			"  codex-multi-auth bridge token rotate <id> [--json]",
			"  codex-multi-auth bridge token revoke <id> [--json]",
		].join("\n"),
	);
}

function printJson(logInfo: (message: string) => void, value: unknown): void {
	logInfo(JSON.stringify(value, null, 2));
}

function publicTokenRecord(token: LocalClientTokenRecord): {
	id: string;
	label: string;
	prefix: string;
	createdAt: number;
	lastUsedAt: number | null;
	revokedAt: number | null;
	state: "active" | "revoked";
} {
	return {
		id: token.id,
		label: token.label,
		prefix: token.prefix,
		createdAt: token.createdAt,
		lastUsedAt: token.lastUsedAt,
		revokedAt: token.revokedAt,
		state: token.revokedAt === null ? "active" : "revoked",
	};
}

function consumeJsonFlag(args: string[]): { json: boolean; rest: string[] } {
	return {
		json: args.includes("--json") || args.includes("-j"),
		rest: args.filter((arg) => arg !== "--json" && arg !== "-j"),
	};
}

function parseLabel(args: string[]): { ok: true; label?: string } | { ok: false; message: string } {
	let label: string | undefined;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--label") {
			const value = args[i + 1];
			if (!value) return { ok: false, message: "Missing value for --label" };
			label = value;
			i += 1;
			continue;
		}
		if (arg?.startsWith("--label=")) {
			label = arg.slice("--label=".length);
			continue;
		}
		return { ok: false, message: `Unknown bridge token option: ${arg ?? ""}` };
	}
	return { ok: true, label };
}

export async function runBridgeCommand(
	args: string[],
	deps: BridgeCommandDeps = {},
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	if (args.includes("--help") || args.includes("-h")) {
		printBridgeUsage(logInfo);
		return 0;
	}
	const [area, action, ...rest] = args;
	if (area !== "token") {
		logError("Expected `codex-multi-auth bridge token ...`");
		return 1;
	}
	if (action === "create") {
		const { json, rest: actionArgs } = consumeJsonFlag(rest);
		const parsed = parseLabel(actionArgs);
		if (!parsed.ok) {
			logError(parsed.message);
			return 1;
		}
		const created = await addLocalClientToken({ label: parsed.label });
		if (json) {
			printJson(logInfo, {
				command: "bridge token create",
				token: publicTokenRecord(created.record),
				plainToken: created.plainToken,
			});
			return 0;
		}
		logInfo(`Token id: ${created.record.id}`);
		logInfo(`Token prefix: ${created.record.prefix}`);
		logInfo(`Token: ${created.plainToken}`);
		return 0;
	}
	if (action === "list") {
		const { json, rest: actionArgs } = consumeJsonFlag(rest);
		if (actionArgs.length > 0) {
			logError(`Unknown bridge token list option: ${actionArgs[0] ?? ""}`);
			return 1;
		}
		const store = await loadLocalClientTokenStore();
		if (json) {
			printJson(logInfo, {
				command: "bridge token list",
				tokens: store.tokens.map(publicTokenRecord),
			});
			return 0;
		}
		if (store.tokens.length === 0) {
			logInfo("No local bridge tokens configured.");
			return 0;
		}
		for (const token of store.tokens) {
			const state = token.revokedAt === null ? "active" : "revoked";
			logInfo(`${token.id} ${token.prefix} ${token.label} ${state}`);
		}
		return 0;
	}
	if (action === "rotate") {
		const { json, rest: actionArgs } = consumeJsonFlag(rest);
		const id = actionArgs[0];
		if (!id) {
			logError("Missing token id");
			return 1;
		}
		if (actionArgs.length > 1) {
			logError(`Unknown bridge token rotate option: ${actionArgs[1] ?? ""}`);
			return 1;
		}
		const rotated = await rotateLocalClientToken({ id });
		if (!rotated) {
			logError("Token not found or already revoked.");
			return 1;
		}
		if (json) {
			printJson(logInfo, {
				command: "bridge token rotate",
				token: publicTokenRecord(rotated.record),
				plainToken: rotated.plainToken,
			});
			return 0;
		}
		logInfo(`Token id: ${rotated.record.id}`);
		logInfo(`Token prefix: ${rotated.record.prefix}`);
		logInfo(`Token: ${rotated.plainToken}`);
		return 0;
	}
	if (action === "revoke") {
		const { json, rest: actionArgs } = consumeJsonFlag(rest);
		const id = actionArgs[0];
		if (!id) {
			logError("Missing token id");
			return 1;
		}
		if (actionArgs.length > 1) {
			logError(`Unknown bridge token revoke option: ${actionArgs[1] ?? ""}`);
			return 1;
		}
		const revoked = await revokeLocalClientToken(id);
		if (!revoked) {
			logError("Token not found or already revoked.");
			return 1;
		}
		if (json) {
			printJson(logInfo, {
				command: "bridge token revoke",
				id,
				revoked: true,
			});
			return 0;
		}
		logInfo("Token revoked.");
		return 0;
	}
	logError(`Unknown bridge token action: ${action ?? ""}`);
	return 1;
}
