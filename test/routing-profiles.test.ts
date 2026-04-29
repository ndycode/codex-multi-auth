import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

describe("routing profiles", () => {
	let tempDir: string;
	let projectDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-routing-profiles-"));
		projectDir = join(tempDir, "project");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.writeFile(join(projectDir, "package.json"), "{}", "utf8");
		process.env.CODEX_MULTI_AUTH_DIR = join(tempDir, "multi-auth");
	});

	afterEach(async () => {
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it("resolves profile identity through existing project storage helpers", async () => {
		const {
			createDefaultRoutingProfile,
			loadRoutingProfileStore,
			resolveProjectRoutingProfile,
			saveRoutingProfileStore,
			upsertRoutingProfile,
		} = await import("../lib/routing-profiles.js");

		const initial = await resolveProjectRoutingProfile(projectDir);
		expect(initial.projectRoot).toBe(projectDir);
		expect(initial.identityRoot).toBe(projectDir);
		expect(initial.projectKey).toMatch(/^project-/);
		expect(initial.profile).toBeNull();

		const store = await loadRoutingProfileStore();
		const profile = createDefaultRoutingProfile({
			projectKey: initial.projectKey!,
			projectName: "project",
			identityRoot: initial.identityRoot!,
			now: 100,
		});
		upsertRoutingProfile(
			store,
			profile,
			(next) => {
				next.preferredTags.push("Team A");
				next.modelAllowlist.push("GPT-5.3-Codex");
				next.accountWeightByKey["sha256:abc"] = 3;
				next.budgetKey = "default";
			},
			200,
		);
		await saveRoutingProfileStore(store);

		const resolved = await resolveProjectRoutingProfile(projectDir);
		expect(resolved.profile).toMatchObject({
			projectKey: initial.projectKey,
			preferredTags: ["team a"],
			modelAllowlist: ["gpt-5.3-codex"],
			accountWeightByKey: { "sha256:abc": 3 },
			budgetKey: "default",
			updatedAt: 200,
		});
	});

	it("returns null profile when no profile is stored for the project", async () => {
		const { resolveProjectRoutingProfile } = await import(
			"../lib/routing-profiles.js"
		);
		const context = await resolveProjectRoutingProfile(projectDir);
		expect(context.projectKey).toMatch(/^project-/);
		expect(context.profile).toBeNull();
	});
});
