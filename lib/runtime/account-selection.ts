import type { Workspace } from "../accounts.js";
import type { AccountIdSource } from "../types.js";

export type TokenSuccessWithAccount<
	T extends { access: string; idToken?: string },
> = T & {
	accountIdOverride?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
	workspaces?: Workspace[];
};

type AccountCandidate = {
	accountId: string;
	label: string;
	isDefault?: boolean;
	source: AccountIdSource;
};

export function resolveAccountSelection<
	T extends { access: string; idToken?: string },
>(
	tokens: T,
	deps: {
		envAccountId?: string;
		logInfo: (message: string) => void;
		getAccountIdCandidates: (
			accessToken: string,
			idToken?: string,
		) => AccountCandidate[];
		selectBestAccountCandidate: (
			candidates: AccountCandidate[],
		) => AccountCandidate | null | undefined;
	},
): TokenSuccessWithAccount<T> {
	const override = (deps.envAccountId ?? "").trim();
	if (override) {
		const suffix = override.length > 6 ? override.slice(-6) : override;
		deps.logInfo(
			`Using account override from CODEX_AUTH_ACCOUNT_ID (id:${suffix}).`,
		);
		return {
			...tokens,
			accountIdOverride: override,
			accountIdSource: "manual",
			accountLabel: `Override [id:${suffix}]`,
		};
	}

	const candidates = deps.getAccountIdCandidates(tokens.access, tokens.idToken);
	if (candidates.length === 0) {
		return tokens;
	}

	const workspaces: Workspace[] = candidates.map((candidate) => ({
		id: candidate.accountId,
		name: candidate.label,
		enabled: true,
		isDefault: candidate.isDefault,
	}));

	if (candidates.length === 1) {
		const [candidate] = candidates;
		if (candidate) {
			return {
				...tokens,
				accountIdOverride: candidate.accountId,
				accountIdSource: candidate.source,
				accountLabel: candidate.label,
				workspaces,
			};
		}
	}

	const choice = deps.selectBestAccountCandidate(candidates);
	if (!choice) return tokens;

	return {
		...tokens,
		accountIdOverride: choice.accountId,
		accountIdSource: choice.source ?? "token",
		accountLabel: choice.label,
		workspaces,
	};
}
