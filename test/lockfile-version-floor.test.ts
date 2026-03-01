import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(process.cwd());
const MIN_HONO_FLOOR = "4.12.2";
const MIN_ROLLUP_FLOOR = "4.59.0";

function readJson(filePath: string): unknown {
	return JSON.parse(readFileSync(join(projectRoot, filePath), "utf-8"));
}

function extractSemverFloor(range: string): string {
	const match = range.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) {
		throw new Error(`Unable to extract semver floor from range "${range}"`);
	}
	return `${match[1]}.${match[2]}.${match[3]}`;
}

function parseSemver(version: string): [number, number, number] {
	const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
	if (!match) {
		throw new Error(`Invalid semver "${version}"`);
	}
	return [
		Number.parseInt(match[1], 10),
		Number.parseInt(match[2], 10),
		Number.parseInt(match[3], 10),
	];
}

function compareSemver(left: string, right: string): number {
	const leftParts = parseSemver(left);
	const rightParts = parseSemver(right);
	for (let index = 0; index < 3; index += 1) {
		const delta = leftParts[index] - rightParts[index];
		if (delta !== 0) {
			return delta;
		}
	}
	return 0;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readStringField(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Expected non-empty string at key "${key}"`);
	}
	return value;
}

describe("lockfile version floors", () => {
	it("keeps configured floors at or above hardened minimums", () => {
		const packageJson = readJson("package.json");
		expect(isObjectRecord(packageJson)).toBe(true);

		const dependencies = isObjectRecord(packageJson) && isObjectRecord(packageJson.dependencies)
			? packageJson.dependencies
			: {};
		const overrides = isObjectRecord(packageJson) && isObjectRecord(packageJson.overrides)
			? packageJson.overrides
			: {};

		const honoFloor = extractSemverFloor(readStringField(dependencies, "hono"));
		const rollupFloor = extractSemverFloor(readStringField(overrides, "rollup"));

		expect(compareSemver(honoFloor, MIN_HONO_FLOOR)).toBeGreaterThanOrEqual(0);
		expect(compareSemver(rollupFloor, MIN_ROLLUP_FLOOR)).toBeGreaterThanOrEqual(0);
	});

	it("keeps lockfile resolved versions at or above declared floors", () => {
		const packageJson = readJson("package.json");
		const lockfile = readJson("package-lock.json");
		expect(isObjectRecord(packageJson)).toBe(true);
		expect(isObjectRecord(lockfile)).toBe(true);

		const dependencies = isObjectRecord(packageJson) && isObjectRecord(packageJson.dependencies)
			? packageJson.dependencies
			: {};
		const overrides = isObjectRecord(packageJson) && isObjectRecord(packageJson.overrides)
			? packageJson.overrides
			: {};
		const packages =
			isObjectRecord(lockfile) && isObjectRecord(lockfile.packages)
				? lockfile.packages
				: {};

		const resolvedHonoRecord = isObjectRecord(packages["node_modules/hono"]) ? packages["node_modules/hono"] : null;
		const resolvedRollupRecord = isObjectRecord(packages["node_modules/rollup"]) ? packages["node_modules/rollup"] : null;

		expect(resolvedHonoRecord).not.toBeNull();
		expect(resolvedRollupRecord).not.toBeNull();

		const declaredHonoFloor = extractSemverFloor(readStringField(dependencies, "hono"));
		const declaredRollupFloor = extractSemverFloor(readStringField(overrides, "rollup"));
		const resolvedHonoVersion = readStringField(resolvedHonoRecord ?? {}, "version");
		const resolvedRollupVersion = readStringField(resolvedRollupRecord ?? {}, "version");

		expect(compareSemver(resolvedHonoVersion, declaredHonoFloor)).toBeGreaterThanOrEqual(0);
		expect(compareSemver(resolvedRollupVersion, declaredRollupFloor)).toBeGreaterThanOrEqual(0);
	});
});
