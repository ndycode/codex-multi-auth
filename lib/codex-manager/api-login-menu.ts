import { apiBaseUrl } from "../api-region.js";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import {
	loadApiRoutes,
	saveApiRoutesSnapshot,
	type ApiRouteCredential,
} from "../api-route-store.js";
import { ApiModelRuntime } from "../runtime/api-model-runtime.js";
import { select, type MenuItem } from "../ui/select.js";

class ApiSetupDiscoveryError extends Error {}

interface MenuDeps {
	load: () => Promise<ApiRouteCredential[]>;
	save: (
		routes: ApiRouteCredential[],
		expected: ApiRouteCredential[],
	) => Promise<ApiRouteCredential[]>;
	select: (
		items: MenuItem<string>[],
		message: string,
	) => Promise<string | null>;
	text: (message: string) => Promise<string>;
	secret: () => Promise<string>;
	discover: (route: ApiRouteCredential) => Promise<string[]>;
	log: (message: string) => void;
}
async function ask(message: string, secret = false): Promise<string> {
	if (!process.stdin.isTTY)
		throw Error("API setup requires an interactive terminal.");
	// The secret never reaches the output stream, command arguments, or shell history.
	const sink = new Writable({
		write(_chunk, _encoding, done) {
			done();
		},
	});
	if (secret) process.stdout.write(message);
	const rl = createInterface({
		input: process.stdin,
		output: secret ? sink : process.stdout,
		terminal: true,
	});
	const cancel = () => rl.close();
	rl.on("SIGINT", cancel);
	try {
		return (await rl.question(secret ? "" : message)).trim();
	} finally {
		rl.off("SIGINT", cancel);
		rl.close();
		sink.destroy();
		if (secret) process.stdout.write("\n");
	}
}
const defaults: MenuDeps = {
	load: loadApiRoutes,
	save: (routes, expected) => saveApiRoutesSnapshot(routes, undefined, expected),
	select: (items, message) => select(items, { message, allowEscape: true }),
	text: (message) => ask(message),
	secret: () => ask("API key (hidden): ", true),
	discover: async (route) => {
		const runtime = new ApiModelRuntime();
		const catalogs = await runtime.catalogs([route], true);
		const status = runtime.statuses([route])[0];
        if (status?.error) {
            const failure = status.failure;
            const reason = failure?.kind === "http"
                ? "Model discovery returned HTTP " + failure.status + "." + (failure.status === 401 ? " Check the API key and selected API region." : failure.status === 403 ? " Check the key's model-list permissions." : failure.status === 429 ? " The API rate limit was reached; retry later." : " Retry when the API is available.")
                : failure?.kind === "timeout" ? `Model discovery timed out after 15 seconds. Check network access to ${apiBaseUrl(route)} and retry.`
                : failure?.kind === "network" ? `Model discovery failed before receiving a response. Check network access, DNS, and TLS for ${apiBaseUrl(route)}.`
                : "The API returned an invalid model catalog.";
            throw new ApiSetupDiscoveryError(reason);
        }
		return catalogs[0]?.models.map((m) => m.slug) ?? [];
	},
	log: console.log,
};
async function chooseRegion(d: MenuDeps): Promise<"global" | "us" | null> {
 const region = await d.select([
  {label: "Global (api.openai.com)", value: "global"},
  {label: "US (us.api.openai.com)", value: "us"},
 ], "Choose the API region required by this project");
 return region === "global" || region === "us" ? region : null;
}
async function chooseModels(
	route: ApiRouteCredential,
	d: MenuDeps,
): Promise<{ visibleModels: string[]; knownModels: string[] } | null> {
	const available = await d.discover(route);
	const selected = new Set(
		route.visibleModels.filter((id) => available.includes(id)),
	);
	let query = "";
	for (;;) {
		const visible = available.filter((m) => m.toLowerCase().includes(query));
		const choice = await d.select(
			[
				{ label: `Save ${selected.size} selected model(s)`, value: "save" },
				{ label: "Search models", value: "search" },
				{ label: "Clear selection", value: "clear" },
				...visible.map((model) => ({
					label: `${selected.has(model) ? "[x]" : "[ ]"} ${model}`,
					value: `toggle:${model}`,
				})),
				{ label: "Cancel without saving", value: "cancel" },
			],
			"Choose models visible in Codex (future GPT text models appear automatically)",
		);
		if (!choice || choice === "cancel") return null;
		if (choice === "save")
			return {
				visibleModels: [...selected].sort(),
				knownModels: [...new Set([...(route.knownModels ?? []), ...available])],
			};
		if (choice === "search") {
			query = (await d.text("Search: ")).toLowerCase();
			continue;
		}
		if (choice === "clear") {
			selected.clear();
			continue;
		}
		if (choice.startsWith("toggle:")) {
			const id = choice.slice(7);
			if (!available.includes(id)) continue;
			if (selected.has(id)) selected.delete(id);
			else selected.add(id);
		}
	}
}
const reasoningLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
async function configureModelMetadata(
	route: ApiRouteCredential,
	d: MenuDeps,
): Promise<ApiRouteCredential | null> {
	const modelChoice = await d.select(
		route.visibleModels.map((model) => ({ label: model, value: `model:${model}` })),
		"Choose a model for operator-declared metadata",
	);
	if (!modelChoice?.startsWith("model:")) return null;
	const model = modelChoice.slice(6);
	const selected = new Set(route.modelReasoningLevels?.[model] ?? []);
	const initialImageInput = route.modelInputModalities?.[model]?.includes("image") ?? false;
	let imageInput = initialImageInput;
	const inherited = route.modelAccessPrograms?.[model] ?? route.accessPrograms ?? {};
	let daybreakRed = inherited.cyber?.includes("daybreak_red") ?? false;
	for (;;) {
		const choice = await d.select(
			[
				{ label: `Save metadata for ${model}`, value: "save" },
				...reasoningLevels.map((level) => ({
					label: `${selected.has(level) ? "[x]" : "[ ]"} Reasoning: ${level}`,
					value: `toggle:${level}`,
				})),
				{ label: `${imageInput ? "[x]" : "[ ]"} Image inputs`, value: "image_input" },
				{ label: `${daybreakRed ? "[x]" : "[ ]"} Daybreak Red access`, value: "daybreak_red" },
				{ label: "Clear operator-declared metadata", value: "clear" },
				{ label: "Cancel without saving", value: "cancel" },
			],
			`Configure ${model} (operator-declared, separate from API verification)`,
		);
		if (!choice || choice === "cancel") return null;
		const modelReasoningLevels = { ...(route.modelReasoningLevels ?? {}) };
		const modelInputModalities = structuredClone(route.modelInputModalities ?? {});
		const modelAccessPrograms = structuredClone(route.modelAccessPrograms ?? {});
		if (choice === "clear") {
			delete modelReasoningLevels[model];
			delete modelInputModalities[model];
			delete modelAccessPrograms[model];
			return {
				...route,
				modelReasoningLevels: Object.keys(modelReasoningLevels).length ? modelReasoningLevels : undefined,
				modelInputModalities: Object.keys(modelInputModalities).length ? modelInputModalities : undefined,
				modelAccessPrograms: Object.keys(modelAccessPrograms).length ? modelAccessPrograms : undefined,
			};
		}
		if (choice === "image_input") {
			imageInput = !imageInput;
			continue;
		}
		if (choice === "daybreak_red") {
			daybreakRed = !daybreakRed;
			continue;
		}
		if (choice.startsWith("toggle:")) {
			const level = choice.slice(7) as typeof reasoningLevels[number];
			if (!reasoningLevels.includes(level)) continue;
			if (selected.has(level)) selected.delete(level);
			else selected.add(level);
			continue;
		}
		const ordered = reasoningLevels.filter((level) => selected.has(level));
		if (ordered.length) modelReasoningLevels[model] = ordered;
		else delete modelReasoningLevels[model];
		if (Object.hasOwn(modelInputModalities, model) || imageInput !== initialImageInput)
			modelInputModalities[model] = imageInput ? ["text", "image"] : ["text"];
		const programs = structuredClone(modelAccessPrograms[model] ?? inherited);
		const cyber = new Set(programs.cyber ?? []);
		if (daybreakRed) cyber.add("daybreak_red");
		else cyber.delete("daybreak_red");
		if (cyber.size) programs.cyber = [...cyber];
		else delete programs.cyber;
		modelAccessPrograms[model] = programs;
		return {
			...route,
			modelReasoningLevels: Object.keys(modelReasoningLevels).length ? modelReasoningLevels : undefined,
			modelInputModalities: Object.keys(modelInputModalities).length ? modelInputModalities : undefined,
			modelAccessPrograms,
		};
	}
}
export async function runApiLoginMenu(
	overrides: Partial<MenuDeps> = {},
): Promise<number> {
	const merged = { ...defaults, ...overrides };
	// Treat any value the menu did not offer (e.g. a reserved tier 0) as a cancel.
	const d: MenuDeps = {
		...merged,
		select: async (items, message) => {
			const choice = await merged.select(items, message);
			return choice !== null && items.some((item) => item.value === choice) ? choice : null;
		},
	};
	if (!overrides.select && !process.stdin.isTTY) {
		d.log("Run login --api in an interactive terminal.");
		return 1;
	}
	let routes: ApiRouteCredential[];
 try {routes = await d.load();}
 catch {d.log("API route configuration could not be read. Check api-routes.json and retry.");return 1;}
	for (;;) {
		const choice = await d.select(
			[
				{ label: "Add API credential", value: "add" },
				...routes.map((r) => ({
					label: `${r.label} · ${r.kind.toUpperCase()}${r.region === "us" ? " · US" : ""} · priority ${r.priority} · ${r.visibleModels.length} models${r.enabled ? "" : " · disabled"}`,
					value: r.id,
				})),
				{ label: "Back", value: "back" },
			],
			"API credentials and model routes",
		);
		if (!choice || choice === "back") return 0;
		try {
			let route = routes.find((r) => r.id === choice);
			if (choice === "add") {
				const label = (await d.text("Credential label: ")).trim();
				if (!label) continue;
				// Match the stored schema here, so a bad label is not reported as a key problem after discovery.
				if (label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) {
					d.log("Credential label must be 1-80 printable characters. Nothing was saved.");
					continue;
				}
				const kind = await d.select(
					[
						{ label: "API", value: "api" },
						{ label: "ZDR (operator-confirmed approval; not detected from the key)", value: "zdr" },
					],
					"Choose the routing pool (ZDR is operator-declared)",
				);
				if (kind !== "api" && kind !== "zdr") continue;
				const region = await chooseRegion(d);
 if (!region) continue;
 const apiKey = await d.secret();
				if (!apiKey) continue;
				const priority = await d.select(
					Array.from({ length: 9 }, (_, offset) => {
 const tier = 9 - offset;
 return {label: `Priority ${tier}${tier === 9 ? " (recommended; late tier)" : ""}`, value: String(tier)};
}),
					"Failover priority",
				);
				if (priority === null) continue;
				route = {
					id: randomUUID(),
					label,
					kind,
					apiKey,
 region,
					priority: Number(priority),
					enabled: true,
					visibleModels: [],
				};
			} else if (route) {
				const action = await d.select(
					[
						{ label: "Choose visible models", value: "models" },
						{ label: "Configure operator-declared model metadata", value: "metadata" },
						{ label: "Change priority", value: "priority" },
 { label: "Change API region", value: "region" },
						{
							label: route.probeCapabilities
								? "Disable billable capability probes"
								: "Enable small billable capability probes (15-minute cache)",
							value: "probes",
						},
						{ label: route.enabled ? "Disable" : "Enable", value: "toggle" },
						{ label: "Back", value: "back" },
					],
					route.label,
				);
				if (!action || action === "back") continue;
				if (action === "metadata") {
 const configured = await configureModelMetadata(route, d);
 if (configured === null) continue;
 route = configured;
 }
				if (action === "probes")
					route = { ...route, probeCapabilities: !route.probeCapabilities };
				if (action === "toggle") route = { ...route, enabled: !route.enabled };
				if (action === "priority") {
					const value = await d.select(
						Array.from({ length: 9 }, (_, offset) => {
 const tier = 9 - offset;
 return {label: `Priority ${tier}${tier === 9 ? " (recommended; late tier)" : ""}`, value: String(tier)};
}),
						"Failover priority",
					);
					if (value === null) continue;
					route = { ...route, priority: Number(value) };
				}
				if (action === "region") {
 const region = await chooseRegion(d);
 if (!region) continue;
 route = {...route, region, visibleModels: [], knownModels: []};
 }
 if (action !== "models" && action !== "region") {
					const next = routes.map((r) => (r.id === route?.id ? route : r));
					routes = await d.save(next, routes);
					continue;
				}
			}
			if (!route) continue;
			const selection = await chooseModels({ ...route, enabled: true }, d);
			if (selection === null) continue;
			const edited = { ...route, ...selection };
			const next = routes.some((r) => r.id === edited.id)
				? routes.map((r) => (r.id === edited.id ? edited : r))
				: [...routes, edited];
			routes = await d.save(next, routes);
			d.log(
				"Saved. Choose an API or ZDR model explicitly in Codex. Desktop login is unchanged.",
			);
		} catch (error) {
            const changed = error instanceof Error && error.message.startsWith("API route configuration changed");
            let reloaded = false;
            try {routes = await d.load();reloaded = true;} catch { /* Keep the last readable configuration. */ }
			d.log(error instanceof ApiSetupDiscoveryError ? error.message + " No credential was saved." : changed ? (reloaded
                ? "API routes changed in another process; the latest configuration was reloaded. Repeat the edit."
                : "API routes changed in another process and could not be reloaded. Reopen the menu before editing.") :
				"API setup did not complete. No partial credential was saved; check the key, permissions, and configuration.",
			);
		}
	}
}
