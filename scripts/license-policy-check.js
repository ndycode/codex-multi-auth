#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const lockPath = resolve(process.cwd(), "package-lock.json");
const denyList = (process.env.CODEX_LICENSE_DENYLIST ?? "GPL-2.0,GPL-3.0,AGPL-3.0")
	.split(",")
	.map((value) => value.trim().toUpperCase())
	.filter((value) => value.length > 0);
const failOnUnknown = process.env.CODEX_LICENSE_FAIL_ON_UNKNOWN === "1";

if (!existsSync(lockPath)) {
	console.error(`License policy check failed: package-lock.json not found at ${lockPath}`);
	process.exit(1);
}

const packageLock = JSON.parse(readFileSync(lockPath, "utf8"));
const packages = packageLock.packages ?? {};

const violations = [];
const unknown = [];

function normalizeLegacyLicenses(rawLicenses) {
	if (!Array.isArray(rawLicenses)) return "";
	const values = rawLicenses
		.map((entry) => {
			if (typeof entry === "string") return entry;
			if (entry && typeof entry === "object" && typeof entry.type === "string") {
				return entry.type;
			}
			return "";
		})
		.filter((value) => value.length > 0);
	return values.join(" OR ");
}

function extractLicenseTokens(rawLicense) {
	return rawLicense
		.toUpperCase()
		.replace(/[()]/g, " ")
		.split(/\s+OR\s+|\s+AND\s+|\s+WITH\s+|,|\/|;/)
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

function isDeniedLicense(rawLicense) {
	const tokens = extractLicenseTokens(rawLicense);
	return tokens.some((token) =>
		denyList.some((denied) => token === denied || token.startsWith(`${denied}-`)),
	);
}

for (const [packagePath, metadata] of Object.entries(packages)) {
	if (!metadata || typeof metadata !== "object") continue;
	if (packagePath === "") continue;
	const record = metadata;
	const name = typeof record.name === "string" ? record.name : packagePath;
	const version = typeof record.version === "string" ? record.version : "0.0.0";
	const rawLicense =
		typeof record.license === "string"
			? record.license
			: typeof record.licenses === "string"
				? record.licenses
				: normalizeLegacyLicenses(record.licenses);
	const normalized = rawLicense.trim().toUpperCase();
	if (!normalized) {
		unknown.push(`${name}@${version}`);
		continue;
	}
	if (isDeniedLicense(normalized)) {
		violations.push(`${name}@${version} (${rawLicense})`);
	}
}

if (violations.length > 0) {
	console.error("License policy violations detected:");
	for (const entry of violations) {
		console.error(`- ${entry}`);
	}
	process.exit(1);
}

if (unknown.length > 0) {
	console.warn(`Packages with unknown license: ${unknown.length}`);
	for (const entry of unknown.slice(0, 20)) {
		console.warn(`- ${entry}`);
	}
	if (unknown.length > 20) {
		console.warn(`- ...and ${unknown.length - 20} more`);
	}
	if (failOnUnknown) {
		process.exit(1);
	}
}

console.log("License policy check passed.");
