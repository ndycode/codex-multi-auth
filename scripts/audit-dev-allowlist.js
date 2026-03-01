#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const ALLOWED_HIGH_OR_CRITICAL_ADVISORIES = new Map([
	// Example:
	// ["1113465", { package: "minimatch", expiresOn: "2026-06-30" }],
]);

function summarizeVia(via) {
	if (!Array.isArray(via)) return [];
	return via
		.map((item) => {
			if (typeof item === "string") return item;
			if (!item || typeof item !== "object") return "unknown";
			const name = typeof item.name === "string" ? item.name : "unknown";
			const range = typeof item.range === "string" ? item.range : "";
			return range ? `${name}:${range}` : name;
		})
		.slice(0, 5);
}

function extractAdvisoryIds(via) {
	if (!Array.isArray(via)) return [];
	const advisoryIds = [];
	for (const item of via) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const source = "source" in item ? item.source : undefined;
		if (typeof source === "number" || typeof source === "string") {
			advisoryIds.push(String(source));
		}
	}
	return advisoryIds;
}

function isAdvisoryAllowed(packageName, advisoryId) {
	const rule = ALLOWED_HIGH_OR_CRITICAL_ADVISORIES.get(advisoryId);
	if (!rule || typeof rule !== "object") {
		return false;
	}
	if (typeof rule.package === "string" && rule.package !== packageName) {
		return false;
	}
	if (typeof rule.expiresOn === "string") {
		const expiresAt = Date.parse(rule.expiresOn);
		if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
			return false;
		}
	}
	return true;
}

const isWindows = process.platform === "win32";
const command = isWindows ? process.env.ComSpec || "cmd.exe" : "npm";
const commandArgs = isWindows
	? ["/d", "/s", "/c", "npm audit --json"]
	: ["audit", "--json"];
const audit = spawnSync(command, commandArgs, {
	encoding: "utf8",
	stdio: ["ignore", "pipe", "pipe"],
	env: {
		...process.env,
		// npm run -s can suppress child npm JSON output; force a readable level.
		npm_config_loglevel:
			process.env.npm_config_loglevel === "silent"
				? "notice"
				: process.env.npm_config_loglevel || "notice",
	},
});

const stdout = (audit.stdout ?? "").trim();
const stderr = (audit.stderr ?? "").trim();
const combined = [stdout, stderr].filter(Boolean).join("\n");

if (!combined) {
	if ((audit.status ?? 1) === 0) {
		console.log("No vulnerabilities found in npm audit output.");
		process.exit(0);
	}
	console.error("Failed to read npm audit output.");
	process.exit(1);
}

// npm can emit human-readable success text (no JSON) on some versions/configs.
if (!combined.includes("{") && /found 0 vulnerabilities/i.test(combined)) {
	console.log("No vulnerabilities found in npm audit output.");
	process.exit(0);
}

let auditJson;
try {
	const jsonCandidate =
		(stdout.startsWith("{") ? stdout : "") ||
		(stderr.startsWith("{") ? stderr : "") ||
		combined.slice(combined.indexOf("{"));
	auditJson = JSON.parse(jsonCandidate.replace(/^\uFEFF/, ""));
} catch (error) {
	console.error("Failed to parse npm audit JSON output.");
	if (stderr) {
		console.error(stderr);
	}
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

const vulnerabilities =
	auditJson && typeof auditJson === "object" && auditJson.vulnerabilities && typeof auditJson.vulnerabilities === "object"
		? auditJson.vulnerabilities
		: {};

const unexpected = [];
const allowlisted = [];

for (const [name, details] of Object.entries(vulnerabilities)) {
	if (!details || typeof details !== "object") continue;
	const severity = typeof details.severity === "string" ? details.severity : "unknown";
	if (severity !== "high" && severity !== "critical") continue;

	const entry = {
		name,
		severity,
		via: summarizeVia(details.via),
		advisoryIds: extractAdvisoryIds(details.via),
		fixAvailable: details.fixAvailable ?? false,
	};

	const hasAdvisories = entry.advisoryIds.length > 0;
	const allAdvisoriesAllowlisted =
		hasAdvisories &&
		entry.advisoryIds.every((advisoryId) => isAdvisoryAllowed(name, advisoryId));
	if (allAdvisoriesAllowlisted) {
		allowlisted.push(entry);
		continue;
	}
	unexpected.push(entry);
}

if (unexpected.length > 0) {
	console.error("Unexpected high/critical vulnerabilities detected in dev dependency audit:");
	for (const entry of unexpected) {
		console.error(
			`- ${entry.name} (${entry.severity}) advisories=${entry.advisoryIds.join(", ") || "none"} via ${entry.via.join(", ") || "unknown"} fixAvailable=${String(entry.fixAvailable)}`,
		);
	}
	process.exit(1);
}

if (allowlisted.length > 0) {
	console.warn("Allowlisted high/critical dev vulnerabilities detected:");
	for (const entry of allowlisted) {
		console.warn(
			`- ${entry.name} (${entry.severity}) advisories=${entry.advisoryIds.join(", ") || "none"} via ${entry.via.join(", ") || "unknown"} fixAvailable=${String(entry.fixAvailable)}`,
		);
	}
	console.warn("No unexpected high/critical vulnerabilities found.");
}
