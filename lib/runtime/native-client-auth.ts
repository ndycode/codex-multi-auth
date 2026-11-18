import { createHash, timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";
import { decodeJWT } from "../auth/auth.js";
import { getCodexCliAuthPath } from "../codex-cli/state.js";
import { isRecord } from "../utils.js";

async function readDesktopAuth(): Promise<string> {
	const file = await open(getCodexCliAuthPath(), "r");
	try {
		const buffer = Buffer.alloc(1024 * 1024 + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead > 1024 * 1024) throw new Error("Oversized desktop auth file");
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await file.close();
	}
}

/** Trust the exact local desktop credential, never claims from the incoming bearer. */
export async function isNativeClientToken(
	bearer: string,
	now: number,
	read: () => Promise<string> = readDesktopAuth,
): Promise<boolean> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
	try {
		const auth: unknown = JSON.parse(await read());
		if (!isRecord(auth) || !isRecord(auth.tokens)) return false;
		const token = auth.tokens.access_token;
		if (typeof token !== "string" || !token) return false;
		const claims = decodeJWT(token);
		if (typeof claims?.exp !== "number" || claims.exp * 1000 <= now)
			return false;
		return timingSafeEqual(
			createHash("sha256").update(bearer).digest(),
			createHash("sha256").update(token).digest(),
		);
	} catch (error) {
        const retryable = error instanceof SyntaxError || ["EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");
        if (!retryable || attempt === 2) return false;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    }
    return false;
}
