import { ANSI } from "./ansi.js";

type ProgressOutput = { isTTY?: boolean; write: (text: string) => unknown };

/** Indeterminate progress: elapsed time is real; no guessed completion percentage. */
export async function withCheckProgress<T>(
 label: string | (() => string),
 operation: () => Promise<T>,
 log: (message: string) => void = message => { process.stdout.write(`${message}\n`); },
 output: ProgressOutput = process.stdout,
): Promise<T> {
 const message = () => typeof label === "function" ? label() : label;
 const started = Date.now();
 const interactive = output.isTTY === true;
 const frames = ["|", "/", "-", "\\"];
 let frame = 0;
 const elapsed = () => Math.floor((Date.now() - started) / 1000);
 const render = () => {
  if (interactive) output.write(`\r${ANSI.clearLine}${frames[frame++ % frames.length]} ${message()} (${elapsed()}s)`);
  else log(`${message()}... ${elapsed()}s elapsed`);
 };
 if (interactive) render();
 else log(`${message()}...`);
 const timer = setInterval(render, interactive ? 120 : 5000);
 timer.unref?.();
 try {
  return await operation();
 } finally {
  clearInterval(timer);
  if (interactive) output.write(`\r${ANSI.clearLine}`);
 }
}
