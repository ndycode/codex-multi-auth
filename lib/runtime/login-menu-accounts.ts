type LoginMenuAccount = {
	accountId?: string;
	accountLabel?: string;
	email?: string;
	index: number;
	addedAt?: number;
	lastUsed?: number;
	status: "active" | "ok" | "rate-limited" | "cooldown" | "disabled";
	isCurrentAccount: boolean;
	enabled: boolean;
};

export function buildLoginMenuAccounts(
	accounts: Array<{
		accountId?: string;
		accountLabel?: string;
		email?: string;
		addedAt?: number;
		lastUsed?: number;
		enabled?: boolean;
		coolingDownUntil?: number;
		rateLimitResetTimes?: Record<string, number | undefined>;
	}>,
	deps: {
		now: number;
		activeIndex: number;
		formatRateLimitEntry: (
			account: {
				rateLimitResetTimes?: Record<string, number | undefined>;
			},
			now: number,
		) => string | null;
	},
): LoginMenuAccount[] {
	return accounts.map((account, index) => {
		let status: LoginMenuAccount["status"];
		if (account.enabled === false) {
			status = "disabled";
		} else if (
			typeof account.coolingDownUntil === "number" &&
			account.coolingDownUntil > deps.now
		) {
			status = "cooldown";
		} else if (deps.formatRateLimitEntry(account, deps.now)) {
			status = "rate-limited";
		} else if (index === deps.activeIndex) {
			status = "active";
		} else {
			status = "ok";
		}

		return {
			accountId: account.accountId,
			accountLabel: account.accountLabel,
			email: account.email,
			index,
			addedAt: account.addedAt,
			lastUsed: account.lastUsed,
			status,
			isCurrentAccount: index === deps.activeIndex,
			enabled: account.enabled !== false,
		};
	});
}
