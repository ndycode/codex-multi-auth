import type { PluginInput } from "@codex-ai/plugin";
import { createSessionRecoveryHook } from "../recovery.js";

export function createRuntimeSessionRecoveryHook(deps: {
	enabled: boolean;
	client: PluginInput["client"];
	directory: string;
	autoResume: boolean;
}) {
	return deps.enabled
		? createSessionRecoveryHook(
				{ client: deps.client, directory: deps.directory },
				{ sessionRecovery: true, autoResume: deps.autoResume },
			)
		: null;
}
