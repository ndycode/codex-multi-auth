import { describe, expect, it, vi } from "vitest";
import {
	extractAdvisoryIds,
	getAuditCommand,
	partitionHighCriticalVulnerabilities,
	runAuditDevAllowlist,
} from "../scripts/audit-dev-allowlist.js";

describe("audit-dev-allowlist helpers", () => {
	it("keeps advisories with string/number sources and drops invalid sources", () => {
		expect(extractAdvisoryIds([
			{ source: 12345 },
			{ source: "GHSA-abc" },
			{ source: {} },
			{ source: true },
			{},
		])).toEqual(["12345", "GHSA-abc"]);
	});

	it("treats missing/invalid advisory sources as unexpected even when allow predicate returns true", () => {
		const vulnerabilities = {
			"pkg-missing-source": {
				severity: "high",
				via: [{ name: "dep-without-source", range: "<1.0.0" }],
				fixAvailable: false,
			},
			"pkg-invalid-source": {
				severity: "critical",
				via: [{ name: "dep-invalid-source", source: { id: "not-supported" } }],
				fixAvailable: true,
			},
		};

		const result = partitionHighCriticalVulnerabilities(
			vulnerabilities,
			() => true,
		);

		expect(result.allowlisted).toEqual([]);
		expect(result.unexpected).toHaveLength(2);
		expect(result.unexpected[0]?.advisoryIds).toEqual([]);
		expect(result.unexpected[1]?.advisoryIds).toEqual([]);
	});

	it("uses cmd.exe execution path on Windows", () => {
		const command = getAuditCommand("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" });
		expect(command).toEqual({
			command: "C:\\Windows\\System32\\cmd.exe",
			commandArgs: ["/d", "/s", "/c", "npm audit --json"],
		});
	});

	it("routes runAuditDevAllowlist through cmd.exe on Windows", () => {
		const spawn = vi.fn().mockReturnValue({
			status: 0,
			stdout: "found 0 vulnerabilities",
			stderr: "",
		});
		const logs: string[] = [];
		const code = runAuditDevAllowlist({
			platform: "win32",
			env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
			spawn,
			log: (message) => logs.push(String(message)),
			warn: () => {},
			error: () => {},
		});

		expect(code).toBe(0);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledWith(
			"C:\\Windows\\System32\\cmd.exe",
			["/d", "/s", "/c", "npm audit --json"],
			expect.any(Object),
		);
		expect(logs).toContain("No vulnerabilities found in npm audit output.");
	});
});
