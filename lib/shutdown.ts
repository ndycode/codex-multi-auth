type CleanupFn = () => void | Promise<void>;

const cleanupFunctions: CleanupFn[] = [];
let shutdownRegistered = false;
let cleanupInFlight: Promise<void> | null = null;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 120_000;

function getShutdownTimeoutMs(): number {
	const raw = process.env.CODEX_AUTH_SHUTDOWN_TIMEOUT_MS;
	const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_SHUTDOWN_TIMEOUT_MS;
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_SHUTDOWN_TIMEOUT_MS;
	}
	return Math.max(1_000, Math.min(parsed, MAX_SHUTDOWN_TIMEOUT_MS));
}

export function registerCleanup(fn: CleanupFn): void {
	cleanupFunctions.push(fn);
	ensureShutdownHandler();
}

export function unregisterCleanup(fn: CleanupFn): void {
	const index = cleanupFunctions.indexOf(fn);
	if (index !== -1) {
		cleanupFunctions.splice(index, 1);
	}
}

export async function runCleanup(): Promise<void> {
	if (cleanupInFlight) {
		await cleanupInFlight;
		return;
	}

	const fns = [...cleanupFunctions];
	cleanupFunctions.length = 0;
	const timeoutMs = getShutdownTimeoutMs();

	const runner = (async () => {
		for (const fn of fns) {
			try {
				await fn();
			} catch {
				// Ignore cleanup errors during shutdown
			}
		}
	})();

	cleanupInFlight = Promise.race([
		runner,
		new Promise<void>((resolve) => {
			setTimeout(resolve, timeoutMs);
		}),
	]).finally(() => {
		cleanupInFlight = null;
	});

	await cleanupInFlight;
}

function ensureShutdownHandler(): void {
	if (shutdownRegistered) return;
	shutdownRegistered = true;
	let signalHandled = false;

	const handleSignal = () => {
		if (signalHandled) return;
		signalHandled = true;
		void runCleanup().finally(() => {
			process.exit(0);
		});
	};

	process.once("SIGINT", handleSignal);
	process.once("SIGTERM", handleSignal);
	process.once("beforeExit", () => {
		void runCleanup();
	});
}

export function getCleanupCount(): number {
	return cleanupFunctions.length;
}
