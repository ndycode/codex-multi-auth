import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { select, type MenuItem } from "../ui/select.js";

export interface ResumeThread {
	id: string;
	name?: string | null;
	preview?: string;
	cwd: string;
	modelProvider?: string;
}

export interface ResumePage {
	data: ResumeThread[];
	nextCursor?: string | null;
}

export interface ResumePickerOptions {
	codexBin: { path: string; launchWithNode?: boolean };
	cwd: string;
	configArgs: string[];
	showAll: boolean;
	includeNonInteractive: boolean;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

/** Read the canonical index through Codex, rather than depending on SQLite schemas. */
export function createResumeCatalog(options: ResumePickerOptions) {
	const args = [...options.configArgs, "app-server", "--listen", "stdio://"];
	const child = spawn(
		options.codexBin.launchWithNode ? process.execPath : options.codexBin.path,
		options.codexBin.launchWithNode ? [options.codexBin.path, ...args] : args,
		{ cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] },
	);
	const lines = createInterface({ input: child.stdout });
	// Drain diagnostics, but never print arbitrary child output (which may contain secrets).
	child.stderr.resume();
	let nextId = 0;
	let closed = false;
	let failure: Error | null = null;
	const pending = new Map<number, {
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();
	function fail(error: Error) {
		failure = error;
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		pending.clear();
	}
	child.on("error", () => fail(new Error("Could not start Codex session discovery.")));
	child.on("exit", () => fail(new Error("Codex session discovery stopped.")));
	child.stdin.on("error", () => fail(new Error("Codex session discovery disconnected.")));
	lines.on("line", (line) => {
		let message: { id?: number; error?: unknown; result?: unknown };
		try { message = JSON.parse(line); } catch { return; }
		if (!message || typeof message.id !== "number") return;
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		clearTimeout(request.timer);
		if (message.error) request.reject(new Error("Codex rejected the session discovery request."));
		else request.resolve(message.result);
	});
	function request(method: string, params: unknown): Promise<unknown> {
		if (failure || closed) return Promise.reject(failure ?? new Error("Session catalog is closed."));
		return new Promise((resolve, reject) => {
			const id = ++nextId;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error("Codex session discovery timed out."));
			}, options.timeoutMs ?? 15_000);
			pending.set(id, { resolve, reject, timer });
			child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	}
	let initialized = false;
	return {
		async page(cursor: string | null = null): Promise<ResumePage> {
			if (!initialized) {
				await request("initialize", {
					clientInfo: { name: "codex-multi-auth-resume", version: "1" },
					capabilities: { experimentalApi: true },
				});
				child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
				initialized = true;
			}
			const result = await request("thread/list", {
				limit: 50, cursor, sortKey: "updated_at", archived: false,
				// An empty list explicitly disables the server's current-provider filter.
				modelProviders: [],
				// Omitted or empty means interactive-only, so name the resumable non-interactive kinds (as Codex does).
				sourceKinds: options.includeNonInteractive ? ["cli", "vscode", "exec", "appServer"] : ["cli", "vscode"],
				...(options.showAll ? {} : { cwd: options.cwd }),
			});
			if (!result || typeof result !== "object" || !("data" in result) || !Array.isArray(result.data)) {
				throw new Error("Codex returned an invalid session list.");
			}
			const data = result.data.filter((thread): thread is ResumeThread =>
				thread && typeof thread.id === "string" && typeof thread.cwd === "string",
			);
			const cursorValue = "nextCursor" in result ? result.nextCursor : null;
			return { data, nextCursor: typeof cursorValue === "string" ? cursorValue : null };
		},
		close() {
			if (closed) return;
			closed = true;
			fail(new Error("Session catalog is closed."));
			lines.close();
			child.stdin.end();
			child.kill("SIGTERM");
			// Only terminate the discovery child we own, never an existing Codex server.
			const timer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, 1_000);
			timer.unref();
			child.once("exit", () => clearTimeout(timer));
		},
	};
}

function displayText(value: unknown): string {
	// Session titles and directory names are untrusted terminal output.
	return String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 180);
}

type Choice = { kind: "thread"; id: string } | { kind: "next" | "previous" | "cancel" };

export async function pickResumeThread(
	options: ResumePickerOptions,
	deps = { createCatalog: createResumeCatalog, select: select<Choice> },
): Promise<string | null> {
	const catalog = deps.createCatalog(options);
	const pages: ResumePage[] = [];
	let pageIndex = 0;
	let interrupted = false;
	const onInterrupt = () => {
		interrupted = true;
		catalog.close();
	};
	process.once("SIGINT", onInterrupt);
	process.once("SIGTERM", onInterrupt);
	try {
		pages.push(await catalog.page());
		for (;;) {
			const page = pages[pageIndex];
			if (!page) throw new Error("Session page is unavailable.");
			const items: MenuItem<Choice>[] = page.data.map((thread) => ({
				label: displayText(thread.name || thread.preview || thread.id),
				hint: displayText(`${thread.cwd} · ${thread.modelProvider ?? "unknown provider"} · ${thread.id}`),
				value: { kind: "thread", id: thread.id },
			}));
			if (pageIndex > 0) items.push({ label: "Previous page", value: { kind: "previous" } });
			if (page.nextCursor) items.push({ label: "Next page", value: { kind: "next" } });
			// select() returns a sole choice without rendering, so an empty list would exit silently.
			if (items.length === 0) {
				process.stdout.write("No saved Codex sessions found.\n");
				return null;
			}
			// Also prevents the shared select UI from auto-opening a single session.
			items.push({ label: "Cancel", value: { kind: "cancel" } });
			const choice = await deps.select(items, {
				message: "Resume a Codex session",
				subtitle: page.data.length ? "All providers · resumes through multi-auth" : "No saved sessions found",
				allowEscape: true,
			});
			if (!choice || choice.kind === "cancel") return null;
			if (choice.kind === "thread") return choice.id;
			if (choice.kind === "previous") { pageIndex -= 1; continue; }
			if (!pages[pageIndex + 1]) pages.push(await catalog.page(page.nextCursor));
			pageIndex += 1;
		}
	} catch (error) {
		// Closing the catalog on Ctrl+C rejects the pending request; that is a cancel, not a failure.
		if (interrupted) return null;
		throw error;
	} finally {
		process.removeListener("SIGINT", onInterrupt);
		process.removeListener("SIGTERM", onInterrupt);
		catalog.close();
	}
}
