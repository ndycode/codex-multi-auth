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
const SENSITIVE_STRING_PATTERNS = [
	/\bsk-[a-z0-9][a-z0-9_-]{8,}\b/gi,
	/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi,
	/\beyJ[a-z0-9._-]{16,}\b/gi,
];

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
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

function redactSensitiveString(value: string): string {
	let redacted = value;
	for (const pattern of SENSITIVE_STRING_PATTERNS) {
		redacted = redacted.replace(pattern, "***REDACTED***");
	}
	return redacted;
}

export function redactForExternalOutput<T>(value: T): T {
	const seen = new WeakSet<object>();
	const visit = (node: unknown): unknown => {
		if (typeof node === "string") {
			return redactSensitiveString(node);
		}
		if (Array.isArray(node)) {
			if (seen.has(node)) {
				return "[Circular]";
			}
			seen.add(node);
			const next = node.map((item) => visit(item));
			seen.delete(node);
			return next;
		}
		if (!isObjectRecord(node)) {
			return node;
		}
		if (seen.has(node)) {
			return "[Circular]";
		}
		seen.add(node);
		const next: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(node)) {
			if (shouldRedactKey(key)) {
				next[key] = "***REDACTED***";
				continue;
			}
			next[key] = visit(child);
		}
		seen.delete(node);
		return next;
	};
	return visit(value) as T;
}
