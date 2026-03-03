#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ALLOWED_HIGH_OR_CRITICAL_ADVISORIES = new Map([
	// Example:
	// ["1113465", { package: "minimatch", expiresOn: "2026-06-30" }],
]);

export function summarizeVia(via) {
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

export function extractAdvisoryIds(via) {
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

export function isAdvisoryAllowed(packageName, advisoryId, now = Date.now()) {
	const rule = ALLOWED_HIGH_OR_CRITICAL_ADVISORIES.get(advisoryId);
	if (!rule || typeof rule !== "object") {
		return false;
	}
	if (typeof rule.package === "string" && rule.package !== packageName) {
		return false;
	}
	if (typeof rule.expiresOn === "string") {
		const expiresAt = Date.parse(rule.expiresOn);
		if (!Number.isFinite(expiresAt) || now > expiresAt) {
			return false;
		}
	}
	return true;
}

export function getAuditCommand(platform = process.platform, env = process.env) {
	const isWindows = platform === "win32";
	return {
		command: isWindows ? env.ComSpec || "cmd.exe" : "npm",
		commandArgs: isWindows
			? ["/d", "/s", "/c", "npm audit --json"]
			: ["audit", "--json"],
	};
}

function resolveVulnerabilities(auditJson) {
	if (
		auditJson &&
		typeof auditJson === "object" &&
		auditJson.vulnerabilities &&
		typeof auditJson.vulnerabilities === "object"
	) {
		return auditJson.vulnerabilities;
	}
	return {};
}

export function partitionHighCriticalVulnerabilities(
	vulnerabilities,
	advisoryAllowed = isAdvisoryAllowed,
) {
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
			entry.advisoryIds.every((advisoryId) => advisoryAllowed(name, advisoryId));
		if (allAdvisoriesAllowlisted) {
			allowlisted.push(entry);
			continue;
		}
		unexpected.push(entry);
	}
	return { unexpected, allowlisted };
}

function parseAuditOutput(audit) {
	const stdout = (audit.stdout ?? "").trim();
	const stderr = (audit.stderr ?? "").trim();
	const combined = [stdout, stderr].filter(Boolean).join("\n");
	if (!combined) {
		return {
			type: "empty",
			ok: (audit.status ?? 1) === 0,
			stderr,
		};
	}
	if (!combined.includes("{") && /found 0 vulnerabilities/i.test(combined)) {
		return { type: "none" };
	}
	try {
		const jsonCandidate =
			(stdout.startsWith("{") ? stdout : "") ||
			(stderr.startsWith("{") ? stderr : "") ||
			combined.slice(combined.indexOf("{"));
		return {
			type: "json",
			json: JSON.parse(jsonCandidate.replace(/^\uFEFF/, "")),
		};
	} catch (error) {
		return {
			type: "parse_error",
			stderr,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

export function runAuditDevAllowlist(options = {}) {
	const {
		platform = process.platform,
		env = process.env,
		spawn = spawnSync,
		log = console.log,
		warn = console.warn,
		error = console.error,
		now = Date.now,
	} = options;

	const { command, commandArgs } = getAuditCommand(platform, env);
	const audit = spawn(command, commandArgs, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...env,
			// npm run -s can suppress child npm JSON output; force a readable level.
			npm_config_loglevel:
				env.npm_config_loglevel === "silent"
					? "notice"
					: env.npm_config_loglevel || "notice",
		},
	});

	const parsed = parseAuditOutput(audit);
	if (parsed.type === "empty") {
		if (parsed.ok) {
			log("No vulnerabilities found in npm audit output.");
			return 0;
		}
		error("Failed to read npm audit output.");
		return 1;
	}
	if (parsed.type === "none") {
		log("No vulnerabilities found in npm audit output.");
		return 0;
	}
	if (parsed.type === "parse_error") {
		error("Failed to parse npm audit JSON output.");
		if (parsed.stderr) {
			error(parsed.stderr);
		}
		error(parsed.message);
		return 1;
	}

	const vulnerabilities = resolveVulnerabilities(parsed.json);
	const { unexpected, allowlisted } = partitionHighCriticalVulnerabilities(
		vulnerabilities,
		(packageName, advisoryId) => isAdvisoryAllowed(packageName, advisoryId, now()),
	);

	if (unexpected.length > 0) {
		error("Unexpected high/critical vulnerabilities detected in dev dependency audit:");
		for (const entry of unexpected) {
			error(
				`- ${entry.name} (${entry.severity}) advisories=${entry.advisoryIds.join(", ") || "none"} via ${entry.via.join(", ") || "unknown"} fixAvailable=${String(entry.fixAvailable)}`,
			);
		}
		return 1;
	}

	if (allowlisted.length > 0) {
		warn("Allowlisted high/critical dev vulnerabilities detected:");
		for (const entry of allowlisted) {
			warn(
				`- ${entry.name} (${entry.severity}) advisories=${entry.advisoryIds.join(", ") || "none"} via ${entry.via.join(", ") || "unknown"} fixAvailable=${String(entry.fixAvailable)}`,
			);
		}
		warn("No unexpected high/critical vulnerabilities found.");
	}

	return 0;
}

const isEntryPoint =
	typeof process.argv[1] === "string" &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
	process.exit(runAuditDevAllowlist());
}
