import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import {
	loadApiRoutes,
	saveApiRoutes,
	type ApiRouteCredential,
} from "../api-route-store.js";
import { ApiModelRuntime } from "../runtime/api-model-runtime.js";
import { select, type MenuItem } from "../ui/select.js";

interface MenuDeps {
	load: () => Promise<ApiRouteCredential[]>;
	save: (
		routes: ApiRouteCredential[],
		expected: ApiRouteCredential[],
	) => Promise<void>;
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
	save: (routes, expected) => saveApiRoutes(routes, undefined, expected),
	select: (items, message) => select(items, { message, allowEscape: true }),
	text: (message) => ask(message),
	secret: () => ask("API key (hidden): ", true),
	discover: async (route) => {
		const runtime = new ApiModelRuntime();
		const catalogs = await runtime.catalogs([route], true);
		if (runtime.statuses([route])[0]?.error)
			throw Error(
				"Model discovery failed. Check the credential and its API permissions.",
			);
		return catalogs[0]?.models.map((m) => m.slug) ?? [];
	},
	log: console.log,
};
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
					label: `${r.label} · ${r.kind.toUpperCase()} · priority ${r.priority} · ${r.visibleModels.length} models${r.enabled ? "" : " · disabled"}`,
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
					priority: Number(priority),
					enabled: true,
					visibleModels: [],
				};
			} else if (route) {
				const action = await d.select(
					[
						{ label: "Choose visible models", value: "models" },
						{ label: "Change priority", value: "priority" },
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
				if (action !== "models") {
					const next = routes.map((r) => (r.id === route?.id ? route : r));
					await d.save(next, routes);
					routes = next;
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
			await d.save(next, routes);
			routes = next;
			d.log(
				"Saved. Choose an API or ZDR model explicitly in Codex. Desktop login is unchanged.",
			);
		} catch (error) {
            const changed = error instanceof Error && error.message.startsWith("API route configuration changed");
            let reloaded = false;
            try {routes = await d.load();reloaded = true;} catch { /* Keep the last readable configuration. */ }
			d.log(changed ? (reloaded
                ? "API routes changed in another process; the latest configuration was reloaded. Repeat the edit."
                : "API routes changed in another process and could not be reloaded. Reopen the menu before editing.") :
				"API setup did not complete. No partial credential was saved; check the key, permissions, and configuration.",
			);
		}
	}
}
