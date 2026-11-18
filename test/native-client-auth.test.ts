import { describe, it, expect, vi } from "vitest";
import { isNativeClientToken } from "../lib/runtime/native-client-auth.js";
const token = (exp: number) =>
	`header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
describe("native client authentication", () => {
	it("follows the genuine desktop token refresh and rejects the previous token", async () => {
		let current = token(200);
		const read = async () =>
			JSON.stringify({ tokens: { access_token: current } });
		const old = current;
		expect(await isNativeClientToken(old, 100000, read)).toBe(true);
		current = token(300);
		expect(await isNativeClientToken(old, 100000, read)).toBe(false);
		expect(await isNativeClientToken(current, 100000, read)).toBe(true);
	});
	it("rejects expired tokens, malformed files, and a forged bearer even with matching claims", async () => {
		const current = token(200),
			read = async () => JSON.stringify({ tokens: { access_token: current } });
		expect(await isNativeClientToken(current, 200000, read)).toBe(false);
		expect(await isNativeClientToken(current + "forged", 100000, read)).toBe(
			false,
		);
		expect(await isNativeClientToken(current, 100000, async () => "{")).toBe(
			false,
		);
		expect(
			await isNativeClientToken(current, 100000, async () => {
				throw Error("unreadable");
			}),
		).toBe(false);
	});
});

it.each(["EBUSY", "EPERM", "EACCES", "partial"])("retries transient desktop auth %s", async code => {
 const current = token(200);
 const read = vi.fn().mockRejectedValueOnce(code === "partial" ? new SyntaxError("partial JSON") : Object.assign(Error("locked"), {code})).mockResolvedValue(JSON.stringify({tokens:{access_token:current}}));
 expect(await isNativeClientToken(current,100000,read)).toBe(true);
 expect(read).toHaveBeenCalledTimes(2);
});
it("bounds desktop auth retries", async()=>{
 const read=vi.fn().mockRejectedValue(Object.assign(Error("locked"),{code:"EBUSY"}));
 expect(await isNativeClientToken(token(200),100000,read)).toBe(false);
 expect(read).toHaveBeenCalledTimes(3);
});
