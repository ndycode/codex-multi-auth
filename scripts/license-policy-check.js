#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const lockPath = resolve(process.cwd(), "package-lock.json");
const denyList = (process.env.CODEX_LICENSE_DENYLIST ?? "GPL-2.0,GPL-3.0,AGPL-3.0")
	.split(",")
	.map((value) => value.trim().toUpperCase())
	.filter((value) => value.length > 0);
const failOnUnknown = process.env.CODEX_LICENSE_FAIL_ON_UNKNOWN === "1";

const packageLock = JSON.parse(readFileSync(lockPath, "utf8"));
const packages = packageLock.packages ?? {};

const violations = [];
const unknown = [];

function normalizeLicenseValue(value) {
	if (typeof value === "string") {
		return value;
	}
	if (value && typeof value === "object" && typeof value.type === "string") {
		return value.type;
	}
	return "";
}

function extractRawLicense(record) {
	const direct = normalizeLicenseValue(record.license);
	if (direct) return direct;

	if (typeof record.licenses === "string") {
		return record.licenses;
	}
	if (Array.isArray(record.licenses)) {
		const values = record.licenses
			.map((entry) => normalizeLicenseValue(entry))
			.filter((entry) => entry.length > 0);
		if (values.length > 0) {
			return values.join(" OR ");
		}
	}

	return "";
}

function extractLicenseTokens(rawLicense) {
	return rawLicense
		.toUpperCase()
		.split(/[^A-Z0-9.-]+/)
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

for (const [packagePath, metadata] of Object.entries(packages)) {
	if (!metadata || typeof metadata !== "object") continue;
	if (packagePath === "") continue;
	const record = metadata;
	const name = typeof record.name === "string" ? record.name : packagePath;
	const version = typeof record.version === "string" ? record.version : "0.0.0";
	const rawLicense = extractRawLicense(record);
	const normalized = rawLicense.trim().toUpperCase();
	if (!normalized) {
		unknown.push(`${name}@${version}`);
		continue;
	}
	const tokens = new Set(extractLicenseTokens(normalized));
	for (const denied of denyList) {
		if (tokens.has(denied)) {
			violations.push(`${name}@${version} (${rawLicense})`);
			break;
		}
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
