export interface ShellWorkspaceAccountSeed {
	label: string;
	email: string;
	workspace: string;
	health: number;
	status: "active" | "ok" | "cooldown";
	lastUsedLabel: string;
	cooldownUntil?: number;
	cooldownReason?: string;
}

export const SHELL_WORKSPACE_HEALTH_TIMESTAMP = Date.UTC(2026, 2, 10, 12, 0, 0);

export const SHELL_WORKSPACE_ACCOUNTS: readonly ShellWorkspaceAccountSeed[] = [
	{
		label: "Maya Rivera",
		email: "maya@studio.dev",
		workspace: "Product Workspace",
		health: 98,
		status: "active",
		lastUsedLabel: "today",
	},
	{
		label: "Build Canary",
		email: "build-canary@studio.dev",
		workspace: "CI Sandbox",
		health: 76,
		status: "ok",
		lastUsedLabel: "today",
	},
	{
		label: "Ops Sandbox",
		email: "ops-sandbox@studio.dev",
		workspace: "Recovery Lab",
		health: 42,
		status: "cooldown",
		lastUsedLabel: "2d ago",
		cooldownUntil: SHELL_WORKSPACE_HEALTH_TIMESTAMP + 25 * 60 * 1000,
		cooldownReason: "refresh",
	},
] as const;
