import type { RequestBody } from "../types.js";
import type { CodexQuotaSnapshot } from "../quota-probe.js";
import type { ParsedCodexQuotaSnapshot } from "./quota-headers.js";

const QUOTA_PROBE_MODELS = [
	"gpt-5-codex",
	"gpt-5.3-codex",
	"gpt-5.2-codex",
] as const;

export async function fetchRuntimeCodexQuotaSnapshot(params: {
	accountId: string;
	accessToken: string;
	baseUrl: string;
	fetchImpl: typeof fetch;
	getCodexInstructions: (model: string) => Promise<string>;
	createCodexHeaders: (
		init: RequestInit | undefined,
		accountId: string,
		accessToken: string,
		meta: { model: string },
	) => Headers;
	parseCodexQuotaSnapshot: (
		headers: Headers,
		status: number,
	) => ParsedCodexQuotaSnapshot | null;
	getUnsupportedCodexModelInfo: (errorBody: unknown) => {
		isUnsupported: boolean;
		message?: string;
	};
}): Promise<CodexQuotaSnapshot> {
	let lastError: Error | null = null;

	for (const model of QUOTA_PROBE_MODELS) {
		try {
			const instructions = await params.getCodexInstructions(model);
			const probeBody: RequestBody = {
				model,
				stream: true,
				store: false,
				include: ["reasoning.encrypted_content"],
				instructions,
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "quota ping" }],
					},
				],
				reasoning: { effort: "none", summary: "auto" },
				text: { verbosity: "low" },
			};

			const headers = params.createCodexHeaders(
				undefined,
				params.accountId,
				params.accessToken,
				{ model },
			);
			headers.set("content-type", "application/json");

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 15_000);
			let response: Response;
			try {
				response = await params.fetchImpl(`${params.baseUrl}/codex/responses`, {
					method: "POST",
					headers,
					body: JSON.stringify(probeBody),
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timeout);
			}

			const snapshot = params.parseCodexQuotaSnapshot(
				response.headers,
				response.status,
			);
			if (snapshot) {
				try {
					await response.body?.cancel();
				} catch {
					// Ignore cancellation failures.
				}
				return { ...snapshot, model };
			}

			if (!response.ok) {
				const bodyText = await response.text().catch(() => "");
				let errorBody: unknown;
				try {
					errorBody = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
				} catch {
					errorBody = { error: { message: bodyText } };
				}

				const unsupportedInfo = params.getUnsupportedCodexModelInfo(errorBody);
				if (unsupportedInfo.isUnsupported) {
					lastError = new Error(
						unsupportedInfo.message ??
							`Model '${model}' unsupported for this account`,
					);
					continue;
				}

				const message =
					(typeof (errorBody as { error?: { message?: unknown } })?.error
						?.message === "string"
						? (errorBody as { error?: { message?: string } }).error?.message
						: bodyText) || `HTTP ${response.status}`;
				throw new Error(message);
			}

			lastError = new Error("Codex response did not include quota headers");
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}

	throw lastError ?? new Error("Failed to fetch quotas");
}
