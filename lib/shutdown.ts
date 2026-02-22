type CleanupFn = () => void | Promise<void>;

const cleanupFunctions: CleanupFn[] = [];
let shutdownRegistered = false;

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
	const fns = [...cleanupFunctions];
	cleanupFunctions.length = 0;

	for (const fn of fns) {
		try {
			await fn();
		} catch {
			// Ignore cleanup errors during shutdown
		}
	}
}

function ensureShutdownHandler(): void {
	if (shutdownRegistered) return;
	shutdownRegistered = true;

	const handleSignal = () => {
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
