import {
	addLocalClientToken,
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
			"  codex auth bridge token create [--label <label>]",
			"  codex auth bridge token list",
			"  codex auth bridge token rotate <id>",
			"  codex auth bridge token revoke <id>",
		].join("\n"),
	);
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
		logError("Expected `codex auth bridge token ...`");
		return 1;
	}
	if (action === "create") {
		const parsed = parseLabel(rest);
		if (!parsed.ok) {
			logError(parsed.message);
			return 1;
		}
		const created = await addLocalClientToken({ label: parsed.label });
		logInfo(`Token id: ${created.record.id}`);
		logInfo(`Token prefix: ${created.record.prefix}`);
		logInfo(`Token: ${created.plainToken}`);
		return 0;
	}
	if (action === "list") {
		const store = await loadLocalClientTokenStore();
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
		const id = rest[0];
		if (!id) {
			logError("Missing token id");
			return 1;
		}
		const rotated = await rotateLocalClientToken({ id });
		if (!rotated) {
			logError("Token not found or already revoked.");
			return 1;
		}
		logInfo(`Token id: ${rotated.record.id}`);
		logInfo(`Token prefix: ${rotated.record.prefix}`);
		logInfo(`Token: ${rotated.plainToken}`);
		return 0;
	}
	if (action === "revoke") {
		const id = rest[0];
		if (!id) {
			logError("Missing token id");
			return 1;
		}
		const revoked = await revokeLocalClientToken(id);
		if (!revoked) {
			logError("Token not found or already revoked.");
			return 1;
		}
		logInfo("Token revoked.");
		return 0;
	}
	logError(`Unknown bridge token action: ${action ?? ""}`);
	return 1;
}
