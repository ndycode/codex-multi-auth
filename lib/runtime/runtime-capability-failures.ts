import { canonicalServiceTier } from "../model-route-policy.js";
import { isRecord } from "../utils.js";
export type CapabilityFailure = "model" | "effort" | "tier";
/** Narrow structured rejections only: malformed input, authentication and capacity are not entitlements. */
export function classifyCapabilityFailure(
	status: number,
	body: unknown,
): CapabilityFailure | null {
	if (
		![400, 403, 404].includes(status) ||
		!isRecord(body) ||
		!isRecord(body.error)
	)
		return null;
	const { code, param } = body.error;
	if (
		[
			"model_not_found",
			"model_not_supported",
			"unsupported_model",
			"model_access_denied",
		].includes(String(code))
	)
		return "model";
	if (
		status !== 400 ||
		!["invalid_value", "unsupported_value", "unsupported_parameter"].includes(
			String(code),
		)
	)
		return null;
	if (param === "reasoning.effort") return "effort";
	if (param === "service_tier") return "tier";
	return null;
}
/** Bounded short-lived negative evidence; never persisted with credentials or user content. */
export class RuntimeCapabilityFailures {
	private readonly denied = new Map<string, number>();
	constructor(
		private readonly now: () => number = Date.now,
		private readonly ttlMs = 300_000,
	) {}
	private key(
		credential: string,
		model: string,
		kind: CapabilityFailure,
		value = "",
	) {
		return JSON.stringify([credential, model, kind, value]);
	}
	record(
		credential: string,
		model: string,
		kind: CapabilityFailure,
		effort?: string,
		tier?: string,
	) {
		if ((kind === "effort" && !effort) || (kind === "tier" && !tier)) return;
		const value =
			kind === "model"
				? ""
				: JSON.stringify([
						effort ?? null,
						canonicalServiceTier(tier ?? "default"),
					]);
		const key = this.key(credential, model, kind, value);
		this.denied.delete(key);
		this.denied.set(key, this.now() + this.ttlMs);
		while (this.denied.size > 4096) {
			const first = this.denied.keys().next().value;
			if (first) this.denied.delete(first);
		}
	}
	supports(
		credential: string,
		model: string,
		effort?: string,
		tier?: string,
	): boolean {
		const combination = JSON.stringify([
			effort ?? null,
			canonicalServiceTier(tier ?? "default"),
		]);
		const keys = [
			this.key(credential, model, "model"),
			this.key(credential, model, "effort", combination),
			this.key(credential, model, "tier", combination),
		];
		return keys.every((key) => {
			const expiry = this.denied.get(key);
			if (expiry === undefined) return true;
			if (expiry > this.now()) return false;
			this.denied.delete(key);
			return true;
		});
	}
}
