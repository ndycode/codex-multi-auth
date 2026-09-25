import { isRecord } from "../utils.js";

type Item = Record<string, unknown>;

/** Preserve completed streamed items when the terminal response omits its output. */
export class ResponseOutputHistory {
	private readonly items = new Map<number, {item: Item; complete: boolean; bytes: number}>();
	private bytes = 0;
	private invalid = false;
	constructor(private readonly maxBytes: number) {}

	observe(event: Item): void {
		if (event.type !== "response.output_item.added" && event.type !== "response.output_item.done") return;
		const index = event.output_index;
		if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || !isRecord(event.item)) {
			this.invalidate();
			return;
		}
		const complete = event.type === "response.output_item.done";
		if (!complete && this.items.get(index)?.complete) return;
		this.put(index, event.item, complete);
	}

	finish(output: unknown): Item[] | undefined {
		if (this.invalid) return undefined;
		if (Array.isArray(output)) {
			for (const [position, item] of output.entries()) {
				if (!isRecord(item)) { this.invalidate(); break; }
				const match = typeof item.id === "string"
					? [...this.items].find(([, entry]) => entry.item.id === item.id)?.[0]
					: undefined;
				let index = match ?? position;
				const existing = this.items.get(index);
				if (match === undefined && existing && existing.item.id !== item.id) {
					index = Math.max(...this.items.keys()) + 1;
				}
				this.put(index, item, true);
				if (this.invalid) break;
			}
		}
		if (this.invalid || [...this.items.values()].some(entry => !entry.complete)) return undefined;
		return [...this.items].sort(([a], [b]) => a - b).map(([, entry]) => entry.item);
	}

	private invalidate(): void {
		this.invalid = true;
		this.items.clear();
		this.bytes = 0;
	}
	private put(index: number, item: Item, complete: boolean): void {
		if (this.invalid) return;
		const bytes = Buffer.byteLength(JSON.stringify(item));
		this.bytes += bytes - (this.items.get(index)?.bytes ?? 0);
		if (this.bytes > this.maxBytes || (!this.items.has(index) && this.items.size >= 4096)) {
			this.invalidate();
			return;
		}
		this.items.set(index, {item, complete, bytes});
	}
}

/** A replay must carry each tool call before its corresponding result. */
export function hasOrphanToolResult(input: unknown): boolean {
	if (!Array.isArray(input)) return false;
	const calls = new Set<string>();
	for (const item of input) {
		if (!isRecord(item)) continue;
		if (item.type === "function_call" || item.type === "custom_tool_call") {
			if (typeof item.call_id === "string") calls.add(`${item.type}:${item.call_id}`);
		} else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
			if (typeof item.call_id !== "string" || !calls.has(`${item.type.slice(0, -7)}:${item.call_id}`)) return true;
		}
	}
	return false;
}
