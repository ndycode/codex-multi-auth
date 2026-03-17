import { EventEmitter } from "node:events";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout, type Key } from "ink";
import { ANSI } from "./ansi.js";

export interface InkTerminalSize {
	columns: number;
	rows: number;
}

export interface InkLineController<Result> {
	finish(value: Result | null): void;
	rerender(): void;
	getTerminal(): InkTerminalSize;
}

export interface InkLineAppOptions<Result> {
	clearScreen?: boolean;
	clearOnExit?: boolean;
	patchConsole?: boolean;
	initialGuardMs?: number;
	renderLines(terminal: InkTerminalSize): string[];
	onInput?(
		input: string,
		key: Key,
		controller: InkLineController<Result>,
	): void;
	onMount?(controller: InkLineController<Result>): void | (() => void);
}

interface InkLineRootProps<Result> {
	options: InkLineAppOptions<Result>;
	onFinish(value: Result | null): void;
}

interface InkStdinAdapter {
	stdin: NodeJS.ReadStream;
	cleanup(): void;
}

function createInkStdinAdapter(source: NodeJS.ReadStream): InkStdinAdapter {
	const proxy = new EventEmitter() as NodeJS.ReadStream & {
		isTTY: boolean;
		setRawMode(mode: boolean): void;
	};
	let encoding: BufferEncoding = "utf8";
	const handleData = (chunk: Buffer | string) => {
		proxy.emit(
			"data",
			typeof chunk === "string" ? chunk : chunk.toString(encoding),
		);
	};
	const handleEnd = () => {
		proxy.emit("end");
	};
	const handleError = (error: Error) => {
		proxy.emit("error", error);
	};

	proxy.isTTY = true;
	proxy.setRawMode = (mode: boolean) => {
		try {
			source.setRawMode?.(mode);
		} catch {
			// Ink only needs the method to exist; unsupported hosts can no-op.
		}
		return proxy;
	};
	proxy.setEncoding = (nextEncoding?: BufferEncoding) => {
		if (nextEncoding) {
			source.setEncoding?.(nextEncoding);
			encoding = nextEncoding;
		}
		return proxy;
	};
	proxy.resume = () => {
		source.resume();
		return proxy;
	};
	proxy.pause = () => {
		source.pause();
		return proxy;
	};
	proxy.ref = () => {
		source.ref?.();
		return proxy;
	};
	proxy.unref = () => {
		source.unref?.();
		return proxy;
	};
	proxy.read = () => {
		const chunk = source.read?.() ?? null;
		if (typeof chunk === "string" || chunk === null) {
			return chunk;
		}
		return chunk.toString(encoding);
	};

	source.on("data", handleData);
	source.on("end", handleEnd);
	source.on("error", handleError);

	return {
		stdin: proxy,
		cleanup() {
			source.off("data", handleData);
			source.off("end", handleEnd);
			source.off("error", handleError);
		},
	};
}

function InkLineRoot<Result>({
	options,
	onFinish,
}: InkLineRootProps<Result>): React.ReactElement {
	const { exit } = useApp();
	const { stdout } = useStdout();
	const [revision, setRevision] = useState(0);
	const [terminal, setTerminal] = useState<InkTerminalSize>({
		columns: stdout.columns ?? process.stdout.columns ?? 80,
		rows: stdout.rows ?? process.stdout.rows ?? 24,
	});
	const terminalRef = useRef(terminal);
	const finishRef = useRef(onFinish);
	const guardUntilRef = useRef(Date.now() + (options.initialGuardMs ?? 0));
	const settledRef = useRef(false);

	useEffect(() => {
		finishRef.current = onFinish;
	}, [onFinish]);

	useEffect(() => {
		terminalRef.current = terminal;
	}, [terminal]);

	const controller = useMemo<InkLineController<Result>>(
		() => ({
			finish(value) {
				if (settledRef.current) return;
				settledRef.current = true;
				finishRef.current(value);
				exit();
			},
			rerender() {
				setRevision((value) => value + 1);
			},
			getTerminal() {
				return terminalRef.current;
			},
		}),
		[exit],
	);

	useEffect(() => {
		const handleResize = () => {
			setTerminal({
				columns: stdout.columns ?? process.stdout.columns ?? 80,
				rows: stdout.rows ?? process.stdout.rows ?? 24,
			});
		};

		stdout.on("resize", handleResize);
		return () => {
			stdout.off("resize", handleResize);
		};
	}, [stdout]);

	useEffect(() => options.onMount?.(controller), [controller, options]);

	useInput((input, key) => {
		if (Date.now() < guardUntilRef.current && (key.return || key.escape)) {
			return;
		}
		options.onInput?.(input, key, controller);
	});

	const lines = options.renderLines(terminal);

	return React.createElement(
		Box,
		{ flexDirection: "column" },
		...lines.map((line, index) =>
			React.createElement(
				Text,
				{
					key: `${revision}:${index}`,
					wrap: "truncate-end",
				},
				line,
			)
		),
	);
}

export async function runInkLineApp<Result>(
	options: InkLineAppOptions<Result>,
): Promise<Result | null> {
	if (options.clearScreen) {
		process.stdout.write(ANSI.clearScreen + ANSI.moveTo(1, 1));
	}

	let result: Result | null = null;
	const stdinAdapter = createInkStdinAdapter(process.stdin);
	const instance = render(
		React.createElement(InkLineRoot<Result>, {
			options,
			onFinish(value) {
				result = value;
			},
		}),
		{
			stdin: stdinAdapter.stdin,
			stdout: process.stdout,
			stderr: process.stderr,
			exitOnCtrlC: false,
			patchConsole: options.patchConsole ?? false,
		},
	);

	const handleSignal = () => {
		result = null;
		instance.unmount();
	};

	process.once("SIGINT", handleSignal);
	process.once("SIGTERM", handleSignal);

	try {
		await instance.waitUntilExit();
	} finally {
		process.removeListener("SIGINT", handleSignal);
		process.removeListener("SIGTERM", handleSignal);
		stdinAdapter.cleanup();
		if (options.clearOnExit !== false) {
			instance.clear();
		}
		instance.cleanup();
	}

	return result;
}
