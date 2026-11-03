import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DecisionsRuntime,
	type DecisionsCatalogs,
} from "../lib/runtime/decisions-runtime.js";
import type { ApiRouteCredential } from "../lib/api-route-store.js";
import type { RouteCatalog } from "../lib/model-route-policy.js";
const route = (
	id = "one",
	kind: ApiRouteCredential["kind"] = "zdr",
	region: "us" | "global" = "us",
): ApiRouteCredential => ({
	id,
	label: id,
	kind,
	region,
	enabled: true,
	priority: id === "one" ? 0 : 1,
	apiKey: `key-${id}`,
	visibleModels: ["decision-test"],
});
const build = (routes: ApiRouteCredential[]): RouteCatalog[] =>
	routes.map((r) => ({
		...r,
		models: [{ slug: "decision-test", supported_endpoints: ["/v1/decisions"] }],
	}));
const warmFrom = (
	evidence: (routes: ApiRouteCredential[]) => RouteCatalog[],
): DecisionsCatalogs => ({
	cached: evidence,
	discover: async (routes) => evidence(routes),
});
const catalogs = warmFrom(build);
const body = {
	model: "zdr/decision-test",
	input: [
		{
			role: "user",
			content: [{ type: "input_json", data: { enabled: true } }],
		},
	],
	questions: [
		{ type: "predicate", instructions: "yes?" },
		{
			type: "choice",
			instructions: "pick",
			choices: [{ value: true }, { value: "true" }],
		},
		{
			type: "score",
			instructions: "rate",
			levels: [{ label: "low" }, { label: "high" }],
		},
	],
};
const answer = {
	model: "decision-test",
	answers: [
		{ type: "predicate", name: null, probability: 0.5 },
		{
			type: "choice",
			name: null,
			choice: true,
			confidence: 0.8,
			probabilities: [
				{ value: true, probability: 0.9 },
				{ value: "true", probability: 0.1 },
			],
		},
		{
			type: "score",
			name: null,
			score: 0.4,
			confidence: 0.6,
			probabilities: [
				{ label: "low", value: 0, probability: 0.6 },
				{ label: "high", value: 1, probability: 0.4 },
			],
		},
		{ type: "refusal", name: null },
	],
	usage: {
		input_tokens: 12,
		input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
		output_tokens: 0,
		total_tokens: 12,
	},
};
afterEach(() => vi.useRealTimers());
describe("native Decisions boundary", () => {
	it("forwards typed inputs, answers, refusals and usage without Responses fields", async () => {
		const fetcher = vi.fn(async () => Response.json(answer));
		const runtime = new DecisionsRuntime(fetcher, catalogs);
		expect(await (await runtime.request(body, [route()])).json()).toEqual(
			answer,
		);
		const [url, init] = fetcher.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://us.api.openai.com/v1/decisions");
		expect(JSON.parse(String(init.body))).toEqual({
			...body,
			model: "decision-test",
		});
		expect(init.redirect).toBe("error");
	});
	it.each([
		"decision-test",
		"psp/decision-test",
		"api/speed/priority/decision-test",
	])(
		"rejects unauthorized route %s without discovery or inference",
		async (model) => {
			const fetcher = vi.fn();
			const cached = vi.fn(build);
			const discover = vi.fn(catalogs.discover);
			const runtime = new DecisionsRuntime(fetcher, { cached, discover });
			expect(
				(await runtime.request({ ...body, model }, [route()])).status,
			).toBe(400);
			expect(fetcher).not.toHaveBeenCalled();
			expect(cached).not.toHaveBeenCalled();
			expect(discover).not.toHaveBeenCalled();
		},
	);
	it("requires endpoint evidence and visibility, not model ID alone", async () => {
		const fetcher = vi.fn();
		const runtime = new DecisionsRuntime(
			fetcher,
			warmFrom((routes) =>
				build(routes).map((c) => ({ ...c, models: [{ slug: "decision-test" }] })),
			),
		);
		expect((await runtime.request(body, [route()])).status).toBe(503);
		expect(fetcher).not.toHaveBeenCalled();
		const hidden = new DecisionsRuntime(fetcher, catalogs);
		expect(
			(await hidden.request(body, [{ ...route(), visibleModels: [] }])).status,
		).toBe(503);
	});
	it("fails over unsupported endpoints only within selected pool and region", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json(
					{ error: { code: "unsupported_endpoint" } },
					{ status: 404 },
				),
			)
			.mockResolvedValueOnce(Response.json(answer));
		const runtime = new DecisionsRuntime(fetcher, catalogs);
		expect(
			(
				await runtime.request(body, [
					route(),
					route("api", "api"),
					route("other-region", "zdr", "global"),
					route("backup"),
				])
			).status,
		).toBe(200);
		expect(
			fetcher.mock.calls.map((c) =>
				new Headers(c[1].headers).get("authorization"),
			),
		).toEqual(["Bearer key-one", "Bearer key-backup"]);
	});
	it("does not replay ambiguous transport failures", async () => {
		const fetcher = vi.fn().mockRejectedValue(Error("connection lost"));
		const runtime = new DecisionsRuntime(fetcher, catalogs);
		expect(
			(await runtime.request(body, [route(), route("backup")])).status,
		).toBe(502);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("preserves provider rejection status and safe structured error fields", async () => {
		const fetcher = vi.fn(async () =>
			Response.json(
				{
					error: {
						code: "invalid_question",
						type: "invalid_request_error",
						param: "questions",
						message: "private echo",
					},
				},
				{ status: 400 },
			),
		);
		const result = await new DecisionsRuntime(fetcher, catalogs).request(body, [
			route(),
		]);
		expect(result.status).toBe(400);
		expect(await result.json()).toMatchObject({
			error: {
				code: "invalid_question",
				type: "invalid_request_error",
				param: "questions",
			},
		});
	});
	it("honors cancellation during discovery without sending", async () => {
		const controller = new AbortController();
		const fetcher = vi.fn();
		const runtime = new DecisionsRuntime(fetcher, {
			cached: () => [],
			discover: () => new Promise(() => {}),
		});
		const pending = runtime.request(body, [route()], controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("bounds stalled response bodies by the request deadline", async () => {
		vi.useFakeTimers();
		const fetcher = vi.fn(
			async () =>
				new Response(new ReadableStream({ start() {} }), {
					headers: { "content-type": "application/json" },
				}),
		);
		const pending = new DecisionsRuntime(
			fetcher,
			catalogs,
			Date.now,
			100,
		).request(body, [route()]);
		await vi.advanceTimersByTimeAsync(101);
		expect((await pending).status).toBe(504);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("waits Retry-After only for confirmed temporary 429", async () => {
		vi.useFakeTimers();
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json(
					{ error: { code: "rate_limit_exceeded" } },
					{ status: 429, headers: { "retry-after": "2" } },
				),
			)
			.mockResolvedValueOnce(Response.json(answer));
		const pending = new DecisionsRuntime(
			fetcher,
			catalogs,
			Date.now,
			10000,
		).request(body, [route()]);
		await vi.advanceTimersByTimeAsync(1999);
		expect(fetcher).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(4000);
		expect((await pending).status).toBe(200);
	});
});

it.each([500, 502, 503, 504])(
	"does not replay provider status %s",
	async (status) => {
		const fetcher = vi.fn(async () =>
			Response.json({ error: { code: "provider_error" } }, { status }),
		);
		expect(
			(
				await new DecisionsRuntime(fetcher, catalogs).request(body, [
					route(),
					route("backup"),
				])
			).status,
		).toBe(status);
		expect(fetcher).toHaveBeenCalledTimes(1);
	},
);
const authorizations = (fetcher: ReturnType<typeof vi.fn>) =>
	fetcher.mock.calls.map((c) =>
		new Headers((c[1] as RequestInit).headers).get("authorization"),
	);
describe("rejected pool credentials", () => {
	it.each([
		[401, { code: "invalid_api_key", type: "invalid_request_error" }],
		[403, { code: "unsupported_country_region_territory" }],
		[429, { code: "insufficient_quota", type: "insufficient_quota" }],
	] as const)(
		"fails over a %s credential rejection to the same pool and region",
		async (status, error) => {
			const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
				new Headers(init?.headers).get("authorization") === "Bearer key-one"
					? Response.json({ error }, { status })
					: Response.json(answer),
			);
			const response = await new DecisionsRuntime(fetcher, catalogs).request(
				body,
				[
					route(),
					route("api", "api"),
					route("other-region", "zdr", "global"),
					route("backup"),
				],
			);
			expect(response.status).toBe(200);
			expect(authorizations(fetcher)).toEqual([
				"Bearer key-one",
				"Bearer key-backup",
			]);
		},
	);
	it.each([401, 403])(
		"reports a pool exhausted by %s as unavailable, not as the caller's auth failure",
		async (status) => {
			const fetcher = vi.fn(async () =>
				Response.json(
					{ error: { code: "invalid_api_key", type: "invalid_request_error" } },
					{ status },
				),
			);
			const response = await new DecisionsRuntime(fetcher, catalogs).request(
				body,
				[route(), route("backup")],
			);
			expect(response.status).toBe(503);
			const text = await response.text();
			expect(JSON.parse(text).error.code).toBe("decisions_pool_unavailable");
			expect(text).not.toContain("invalid_api_key");
			expect(fetcher).toHaveBeenCalledTimes(2);
		},
	);
	it("keeps a pool-wide permanent quota rejection as a sanitized 429", async () => {
		const fetcher = vi.fn(async () =>
			Response.json(
				{ error: { code: "insufficient_quota", message: "private echo" } },
				{ status: 429 },
			),
		);
		const response = await new DecisionsRuntime(fetcher, catalogs).request(
			body,
			[route(), route("backup")],
		);
		expect(response.status).toBe(429);
		const text = await response.text();
		expect(JSON.parse(text).error.code).toBe("insufficient_quota");
		expect(text).not.toContain("private echo");
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it("fails over past a stalled error body without waiting for the deadline", async () => {
		vi.useFakeTimers();
		const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
			new Headers(init?.headers).get("authorization") === "Bearer key-one"
				? new Response(new ReadableStream({ start() {} }), { status: 401 })
				: Response.json(answer),
		);
		let status: number | undefined;
		void new DecisionsRuntime(fetcher, catalogs, Date.now, 30_000)
			.request(body, [route(), route("backup")])
			.then((response) => {
				status = response.status;
			});
		await vi.advanceTimersByTimeAsync(6_000);
		expect(status).toBe(200);
		expect(authorizations(fetcher)).toEqual([
			"Bearer key-one",
			"Bearer key-backup",
		]);
	});
	it("never resends a rejected credential while waiting for a rate-limited backup", async () => {
		vi.useFakeTimers();
		let backupSends = 0;
		const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
			if (new Headers(init?.headers).get("authorization") === "Bearer key-one")
				return Response.json({ error: { code: "invalid_api_key" } }, { status: 401 });
			return ++backupSends === 1
				? Response.json(
						{ error: { code: "rate_limit_exceeded" } },
						{ status: 429, headers: { "retry-after": "2" } },
					)
				: Response.json(answer);
		});
		const pending = new DecisionsRuntime(fetcher, catalogs).request(body, [
			route(),
			route("backup"),
		]);
		await vi.advanceTimersByTimeAsync(5000);
		expect((await pending).status).toBe(200);
		expect(authorizations(fetcher)).toEqual([
			"Bearer key-one",
			"Bearer key-backup",
			"Bearer key-backup",
		]);
	});
});
it("records unsupported endpoint per credential without losing other routes", async () => {
	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(
			Response.json(
				{ error: { code: "unsupported_endpoint" } },
				{ status: 404 },
			),
		)
		.mockImplementation(async () => Response.json(answer));
	const runtime = new DecisionsRuntime(fetcher, catalogs);
	const routes = [route(), route("backup")];
	await runtime.request(body, routes);
	await runtime.request(body, routes);
	expect(
		fetcher.mock.calls.map((c) =>
			new Headers(c[1].headers).get("authorization"),
		),
	).toEqual(["Bearer key-one", "Bearer key-backup", "Bearer key-backup"]);
});
it.each([
	{ code: "model_not_found", type: "invalid_request_error" },
	{ code: "not_found", param: "model" },
	{ code: null, param: null, type: "invalid_request_error" },
])("caches a 404 that names the model or endpoint (%o)", async (error) => {
	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(Response.json({ error }, { status: 404 }))
		.mockImplementation(async () => Response.json(answer));
	const runtime = new DecisionsRuntime(fetcher, catalogs);
	const routes = [route(), route("backup")];
	expect((await runtime.request(body, routes)).status).toBe(200);
	expect((await runtime.request(body, routes)).status).toBe(200);
	expect(authorizations(fetcher)).toEqual([
		"Bearer key-one",
		"Bearer key-backup",
		"Bearer key-backup",
	]);
});
it.each([
	{ code: "not_found", type: "invalid_request_error", param: "input" },
	{ code: "file_not_found", type: "invalid_request_error" },
])(
	"returns a request-specific 404 without disabling the credential (%o)",
	async (error) => {
		const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
			String(init?.body).includes("file-missing")
				? Response.json({ error }, { status: 404 })
				: Response.json(answer),
		);
		const runtime = new DecisionsRuntime(fetcher, catalogs);
		const routes = [route(), route("backup")];
		const missing = await runtime.request(
			{
				...body,
				input: [
					{
						role: "user",
						content: [{ type: "input_file", file_id: "file-missing" }],
					},
				],
			},
			routes,
		);
		expect(missing.status).toBe(404);
		expect((await missing.json()).error).toMatchObject(error);
		expect((await runtime.request(body, routes)).status).toBe(200);
		expect(authorizations(fetcher)).toEqual(["Bearer key-one", "Bearer key-one"]);
	},
);
describe("cooldowns longer than the deadline", () => {
	const limited = () =>
		Response.json(
			{ error: { code: "rate_limit_exceeded" } },
			{ status: 429, headers: { "retry-after": "120" } },
		);
	it("tells a caller held by a cached cooldown when to retry", async () => {
		const fetcher = vi.fn(async () => limited());
		const runtime = new DecisionsRuntime(fetcher, catalogs);
		expect((await runtime.request(body, [route()])).status).toBe(429);
		const held = await runtime.request(body, [route()]);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(held.status).toBe(429);
		expect(Number(held.headers.get("retry-after"))).toBeGreaterThanOrEqual(119);
		expect((await held.json()).error).toMatchObject({
			code: "rate_limit_exceeded",
			retry_after_ms: expect.any(Number),
		});
	});
	it("reports the cooldown rather than a backup's permanent quota rejection", async () => {
		const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
			new Headers(init?.headers).get("authorization") === "Bearer key-one"
				? limited()
				: Response.json({ error: { code: "insufficient_quota" } }, { status: 429 }),
		);
		const response = await new DecisionsRuntime(fetcher, catalogs).request(
			body,
			[route(), route("backup")],
		);
		expect(response.status).toBe(429);
		expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(
			120,
		);
		expect((await response.json()).error.code).toBe("rate_limit_exceeded");
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
describe("cooldowns that elapse while a backup is slow", () => {
	const primaryLimitedThenSlowBackupRejection = (retryAfter: string) => {
		const sends: [string | null, number][] = [];
		const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const authorization = new Headers(init?.headers).get("authorization");
			sends.push([authorization, Date.now()]);
			if (authorization === "Bearer key-backup")
				return new Promise<Response>((resolve) =>
					setTimeout(
						() =>
							resolve(
								Response.json(
									{ error: { code: "invalid_api_key" } },
									{ status: 401 },
								),
							),
						25_000,
					),
				);
			return sends.length === 1
				? Response.json(
						{ error: { code: "rate_limit_exceeded" } },
						{ status: 429, headers: { "retry-after": retryAfter } },
					)
				: Response.json(answer);
		});
		return { fetcher, sends };
	};
	it("retries the primary when its cooldown ends inside the deadline", async () => {
		vi.useFakeTimers();
		const start = Date.now();
		const { fetcher, sends } = primaryLimitedThenSlowBackupRejection("40");
		let status: number | undefined;
		void new DecisionsRuntime(fetcher, catalogs, Date.now, 60_000)
			.request(body, [route(), route("backup")])
			.then((response) => {
				status = response.status;
			});
		await vi.advanceTimersByTimeAsync(41_000);
		expect(status).toBe(200);
		expect(sends.map(([authorization, at]) => [authorization, at - start])).toEqual([
			["Bearer key-one", 0],
			["Bearer key-backup", 0],
			["Bearer key-one", expect.any(Number)],
		]);
		expect(sends[2]![1] - start).toBeGreaterThanOrEqual(40_000);
		expect(sends[2]![1] - start).toBeLessThanOrEqual(40_250);
	});
	it("reports the cooldown left, not the cooldown first seen", async () => {
		vi.useFakeTimers();
		const { fetcher } = primaryLimitedThenSlowBackupRejection("70");
		const pending = new DecisionsRuntime(fetcher, catalogs, Date.now, 60_000)
			.request(body, [route(), route("backup")]);
		await vi.advanceTimersByTimeAsync(25_000);
		const response = await pending;
		expect(response.status).toBe(429);
		expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(45);
		expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(46);
		const { retry_after_ms } = (await response.json()).error;
		expect(retry_after_ms).toBeGreaterThanOrEqual(45_000);
		expect(retry_after_ms).toBeLessThanOrEqual(45_250);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
describe("cold backup catalogs", () => {
	const warmPrimary = (
		discover: DecisionsCatalogs["discover"],
	): DecisionsCatalogs => ({
		cached: (routes) => build(routes.filter((r) => r.id === "one")),
		discover,
	});
	it("serves a warm primary without discovering a cold backup", async () => {
		vi.useFakeTimers();
		const fetcher = vi.fn(async () => Response.json(answer));
		const discover = vi.fn(() => new Promise<RouteCatalog[]>(() => {}));
		let status: number | undefined;
		void new DecisionsRuntime(fetcher, warmPrimary(discover))
			.request(body, [route(), route("backup")])
			.then((response) => {
				status = response.status;
			});
		await vi.advanceTimersByTimeAsync(0);
		expect(status).toBe(200);
		expect(authorizations(fetcher)).toEqual(["Bearer key-one"]);
		expect(discover).not.toHaveBeenCalled();
	});
	it("discovers only same-pool, same-region backups once the warm primary is rejected", async () => {
		vi.useFakeTimers();
		const events: string[] = [];
		const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const authorization = new Headers(init?.headers).get("authorization");
			events.push(`send ${authorization}`);
			return authorization === "Bearer key-one"
				? Response.json({ error: { code: "invalid_api_key" } }, { status: 401 })
				: Response.json(answer);
		});
		const discover = async (routes: ApiRouteCredential[]) => {
			events.push(`discover ${routes.map((r) => r.id).join()}`);
			await new Promise((resolve) => setTimeout(resolve, 2000));
			return build(routes);
		};
		let status: number | undefined;
		void new DecisionsRuntime(fetcher, warmPrimary(discover))
			.request(body, [
				route(),
				route("api", "api"),
				route("foreign", "zdr", "global"),
				route("backup"),
			])
			.then((response) => {
				status = response.status;
			});
		await vi.advanceTimersByTimeAsync(2000);
		expect(status).toBe(200);
		expect(events).toEqual([
			"send Bearer key-one",
			"discover backup",
			"send Bearer key-backup",
		]);
	});
	it("retries a warm primary's cooldown while backup discovery stalls", async () => {
		vi.useFakeTimers();
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json(
					{ error: { code: "rate_limit_exceeded" } },
					{ status: 429, headers: { "retry-after": "1" } },
				),
			)
			.mockImplementation(async () => Response.json(answer));
		let status: number | undefined;
		void new DecisionsRuntime(
			fetcher,
			warmPrimary(() => new Promise(() => {})),
		)
			.request(body, [route(), route("backup")])
			.then((response) => {
				status = response.status;
			});
		await vi.advanceTimersByTimeAsync(1300);
		expect(status).toBe(200);
		expect(authorizations(fetcher)).toEqual(["Bearer key-one", "Bearer key-one"]);
	});
});
it("cancels a Retry-After wait without a retry", async () => {
	vi.useFakeTimers();
	const controller = new AbortController();
	const fetcher = vi.fn(async () =>
		Response.json(
			{ error: { code: "rate_limit_exceeded" } },
			{ status: 429, headers: { "retry-after": "2" } },
		),
	);
	const pending = new DecisionsRuntime(fetcher, catalogs).request(
		body,
		[route()],
		controller.signal,
	);
	const rejected = expect(pending).rejects.toThrow();
	await vi.advanceTimersByTimeAsync(1);
	controller.abort();
	await rejected;
	await vi.advanceTimersByTimeAsync(3000);
	expect(fetcher).toHaveBeenCalledTimes(1);
});

it("does not retry an unclassified 429 rejection", async () => {
	vi.useFakeTimers();
	const fetcher = vi.fn(async () =>
		Response.json(
			{ error: { code: "unknown_rejection" } },
			{ status: 429, headers: { "retry-after": "1" } },
		),
	);
	const pending = new DecisionsRuntime(fetcher, catalogs).request(body, [
		route(),
		route("backup"),
	]);
	await vi.advanceTimersByTimeAsync(10000);
	expect((await pending).status).toBe(429);
	expect(fetcher).toHaveBeenCalledTimes(1);
});

describe("review regressions", () => {
	it.each([
		[404, "gateway error"],
		[405, ""],
		[501, "unsupported"],
	] as const)(
		"fails over non-JSON unsupported status %s",
		async (status, text) => {
			const fetcher = vi
				.fn()
				.mockResolvedValueOnce(new Response(text, { status }))
				.mockImplementation(async () => Response.json(answer));
			const runtime = new DecisionsRuntime(fetcher, catalogs);
			expect(
				(await runtime.request(body, [route(), route("backup")])).status,
			).toBe(200);
			await runtime.request(body, [route(), route("backup")]);
			expect(
				fetcher.mock.calls.map((c) =>
					new Headers(c[1].headers).get("authorization"),
				),
			).toEqual(["Bearer key-one", "Bearer key-backup", "Bearer key-backup"]);
		},
	);
	it("preserves plain-text 429 status and Retry-After without replay", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response("private provider text", {
					status: 429,
					headers: { "retry-after": "120" },
				}),
		);
		const response = await new DecisionsRuntime(fetcher, catalogs).request(
			body,
			[route(), route("backup")],
		);
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("120");
		expect(await response.text()).not.toContain("private provider text");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("ignores Responses probes but keeps credential availability and visibility", async () => {
		const fetcher = vi.fn(async () => Response.json(answer));
		const discovery = warmFrom((routes) =>
			build(routes).map((c) => ({
				...c,
				models: c.models.map((m) => ({
					...m,
					capability_probe_status: {
						responses: "unsupported",
						credential: c.id === "unavailable" ? "unavailable" : "available",
					},
				})),
			})),
		);
		const runtime = new DecisionsRuntime(fetcher, discovery);
		expect(
			(
				await runtime.request(body, [
					route("unavailable"),
					{ ...route("hidden"), visibleModels: [] },
					route(),
				])
			).status,
		).toBe(200);
		expect((await runtime.request(body, [route("unavailable")])).status).toBe(
			503,
		);
		expect(
			(await runtime.request(body, [{ ...route(), visibleModels: [] }])).status,
		).toBe(503);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(
			new Headers(
				(fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers,
			).get("authorization"),
		).toBe("Bearer key-one");
	});
	it("tries ready backups before long primary cooldowns, including cached cooldown", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json(
					{ error: { code: "rate_limit_exceeded" } },
					{ status: 429, headers: { "retry-after": "120" } },
				),
			)
			.mockImplementation(async () => Response.json(answer));
		const runtime = new DecisionsRuntime(fetcher, catalogs);
		const routes = [
			route(),
			route("foreign", "zdr", "global"),
			route("api", "api"),
			route("backup"),
		];
		expect((await runtime.request(body, routes)).status).toBe(200);
		expect((await runtime.request(body, routes)).status).toBe(200);
		expect(
			fetcher.mock.calls.map((c) =>
				new Headers(c[1].headers).get("authorization"),
			),
		).toEqual(["Bearer key-one", "Bearer key-backup", "Bearer key-backup"]);
	});
	it("does not spend send attempts waiting for another caller's recovery body", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json(
					{ error: { code: "rate_limit_exceeded" } },
					{ status: 429, headers: { "retry-after": "120" } },
				),
			)
			.mockImplementationOnce(
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								release = () => {
									controller.enqueue(
										new TextEncoder().encode(JSON.stringify(answer)),
									);
									controller.close();
								};
							},
						}),
						{ headers: { "content-type": "application/json" } },
					),
			)
			.mockImplementation(async () => Response.json(answer));
		const runtime = new DecisionsRuntime(fetcher, catalogs);
		expect((await runtime.request(body, [route()])).status).toBe(429);
		await vi.advanceTimersByTimeAsync(121000);
		const recovery = runtime.request(body, [route()]);
		await vi.advanceTimersByTimeAsync(1);
		let completed = false;
		const waiter = runtime.request(body, [route()]).then((r) => {
			completed = true;
			return r;
		});
		await vi.advanceTimersByTimeAsync(4100);
		expect(completed).toBe(false);
		expect(fetcher).toHaveBeenCalledTimes(2);
		release();
		expect((await recovery).status).toBe(200);
		await vi.advanceTimersByTimeAsync(1000);
		expect((await waiter).status).toBe(200);
		expect(fetcher).toHaveBeenCalledTimes(3);
	});
});

describe("large answers", () => {
	it("serves a schema-valid answer above 8 MiB and records its usage", async () => {
		const choices = Array.from({ length: 2000 }, (_, i) => ({
			value: `option-${i}`,
		}));
		const questions = Array.from({ length: 120 }, () => ({
			type: "choice",
			instructions: "pick",
			choices,
		}));
		const text = JSON.stringify({
			answers: questions.map(() => ({
				type: "choice",
				name: null,
				choice: "option-0",
				confidence: 0.5,
				probabilities: choices.map((c) => ({
					value: c.value,
					probability: 0.0005,
				})),
			})),
			usage: { input_tokens: 900_000, output_tokens: 0, total_tokens: 900_000 },
		});
		expect(text.length).toBeGreaterThan(8 * 1024 * 1024);
		const runtime = new DecisionsRuntime(
			vi.fn(async () => new Response(text)),
			catalogs,
		);
		const response = await runtime.request({ ...body, questions }, [route()]);
		expect(response.status).toBe(200);
		expect(runtime.usageFor(response)?.inputTokens).toBe(900_000);
		expect((await response.text()).length).toBe(text.length);
	});
	it("reports an answer over the response cap distinctly and does not replay it", async () => {
		const chunk = new Uint8Array(1024 * 1024).fill(32);
		let sent = 0;
		const fetcher = vi.fn(
			async () =>
				new Response(
					new ReadableStream({
						pull(controller) {
							if (sent++ > 64) controller.close();
							else controller.enqueue(chunk);
						},
					}),
				),
		);
		const response = await new DecisionsRuntime(fetcher, catalogs).request(
			body,
			[route(), route("backup")],
		);
		expect(response.status).toBe(502);
		expect((await response.json()).error.code).toBe(
			"decisions_response_too_large",
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
it("rejects malformed successful Decisions bodies without replay", async () => {
	const fetcher = vi.fn(async () => new Response("not JSON", { status: 200 }));
	const response = await new DecisionsRuntime(fetcher, catalogs).request(body, [
		route(),
		route("backup"),
	]);
	expect(response.status).toBe(502);
	expect(fetcher).toHaveBeenCalledTimes(1);
});
