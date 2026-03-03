const DEFAULT_REDACT_KEYS = new Set([
	"token",
	"access",
	"accessToken",
	"refresh",
	"refreshToken",
	"idToken",
	"secret",
	"password",
	"authorization",
	"apiKey",
	"credential",
	"email",
	"accountId",
]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shouldRedactKey(key: string): boolean {
	const normalized = key.replace(/[_-]/g, "").toLowerCase();
	for (const candidate of DEFAULT_REDACT_KEYS) {
		if (normalized.includes(candidate.replace(/[_-]/g, "").toLowerCase())) {
			return true;
		}
	}
	return false;
}

export function redactForExternalOutput<T>(value: T): T {
	const visit = (node: unknown): unknown => {
		if (Array.isArray(node)) {
			return node.map((item) => visit(item));
		}
		if (!isObjectRecord(node)) {
			return node;
		}
		const next: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(node)) {
			if (shouldRedactKey(key)) {
				next[key] = "***REDACTED***";
				continue;
			}
			next[key] = visit(child);
		}
		return next;
	};
	return visit(value) as T;
}
