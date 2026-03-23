export interface CheckCommandDeps {
	runHealthCheck: (options: { liveProbe: boolean }) => Promise<void>;
}

export async function runCheckCommand(deps: CheckCommandDeps): Promise<number> {
	await deps.runHealthCheck({ liveProbe: true });
	return 0;
}
