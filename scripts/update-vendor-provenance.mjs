#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const components = [
	{
		name: "@codex-ai/plugin",
		root: "vendor/codex-ai-plugin",
		source: "vendored dist shim",
		files: [
			"vendor/codex-ai-plugin/package.json",
			"vendor/codex-ai-plugin/dist/index.js",
			"vendor/codex-ai-plugin/dist/index.d.ts",
			"vendor/codex-ai-plugin/dist/tool.js",
			"vendor/codex-ai-plugin/dist/tool.d.ts",
		],
	},
	{
		name: "@codex-ai/sdk",
		root: "vendor/codex-ai-sdk",
		source: "vendored dist shim",
		files: [
			"vendor/codex-ai-sdk/package.json",
			"vendor/codex-ai-sdk/dist/index.js",
			"vendor/codex-ai-sdk/dist/index.d.ts",
		],
	},
];

async function loadExistingManifest() {
	try {
		const content = await readFile("vendor/provenance.json", "utf8");
		const parsed = JSON.parse(content);
		return Array.isArray(parsed?.components) ? parsed : { components: [] };
	} catch {
		return { components: [] };
	}
}

async function hashFile(path) {
	const content = await readFile(path);
	return createHash("sha256").update(content).digest("hex");
}

const existingManifest = await loadExistingManifest();
const existingFiles = Object.fromEntries(
	existingManifest.components.flatMap((component) =>
		Array.isArray(component.files)
			? component.files
					.filter(
						(file) =>
							file &&
							typeof file === "object" &&
							typeof file.path === "string",
					)
					.map((file) => [file.path, file])
			: [],
	),
);

const manifest = {
	generatedAt: new Date().toISOString().slice(0, 10),
	components: [],
};

for (const component of components) {
	const packageJson = JSON.parse(
		await readFile(`${component.root}/package.json`, "utf8"),
	);
	manifest.components.push({
		name: component.name,
		version: packageJson.version,
		source: component.source,
		root: component.root,
		files: await Promise.all(
			component.files.map(async (path) => {
				const prior = existingFiles[path] ?? {};
				const { path: _priorPath, sha256: _priorHash, ...extra } = prior;
				return {
					path,
					sha256: await hashFile(path),
					...extra,
				};
			}),
		),
	});
}

await writeFile(
	"vendor/provenance.json",
	`${JSON.stringify(manifest, null, 2)}\n`,
	"utf8",
);
console.log(
	`Updated vendor/provenance.json for ${manifest.components.length} component(s)`,
);
