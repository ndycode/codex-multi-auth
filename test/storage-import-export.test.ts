import { beforeEach, describe, expect, it, vi } from "vitest";

const existsSyncMock = vi.fn();
const statMock = vi.fn();
const readFileMock = vi.fn();
const closeMock = vi.fn();
const openMock = vi.fn();

vi.mock("node:fs", () => ({
	existsSync: existsSyncMock,
	promises: {
		stat: statMock,
		readFile: readFileMock,
		open: openMock,
		mkdir: vi.fn(),
		writeFile: vi.fn(),
		rename: vi.fn(),
		unlink: vi.fn(),
	},
}));

describe("storage import-export", () => {
	beforeEach(() => {
		existsSyncMock.mockReset();
		statMock.mockReset();
		readFileMock.mockReset();
		closeMock.mockReset();
		openMock.mockReset();
		closeMock.mockResolvedValue(undefined);
		openMock.mockResolvedValue({
			stat: statMock,
			readFile: readFileMock,
			close: closeMock,
		});
	});

	it("rejects oversized import files before reading them", async () => {
		existsSyncMock.mockReturnValue(true);
		statMock.mockResolvedValue({ size: 4 * 1024 * 1024 + 1 });

		const { readImportFile } = await import("../lib/storage/import-export.js");

		await expect(
			readImportFile({
				resolvedPath: "/mock/import.json",
				normalizeAccountStorage: vi.fn(),
			}),
		).rejects.toThrow(/exceeds maximum size/i);

		expect(readFileMock).not.toHaveBeenCalled();
		expect(closeMock).toHaveBeenCalled();
	});

	it("accepts import files exactly at the size limit", async () => {
		existsSyncMock.mockReturnValue(true);
		statMock.mockResolvedValue({ size: 4 * 1024 * 1024 });
		readFileMock.mockResolvedValue('{"version":3,"accounts":[],"activeIndex":0}');

		const normalizeAccountStorage = vi.fn().mockReturnValue({
			version: 3,
			accounts: [],
			activeIndex: 0,
		});

		const { readImportFile } = await import("../lib/storage/import-export.js");

		await expect(
			readImportFile({
				resolvedPath: "/mock/import.json",
				normalizeAccountStorage,
			}),
		).resolves.toEqual({
			version: 3,
			accounts: [],
			activeIndex: 0,
		});

		expect(readFileMock).toHaveBeenCalled();
		expect(closeMock).toHaveBeenCalled();
	});

	it("reads valid import files under the size limit", async () => {
		existsSyncMock.mockReturnValue(true);
		statMock.mockResolvedValue({ size: 256 });
		readFileMock.mockResolvedValue('{"version":3,"accounts":[],"activeIndex":0}');

		const normalizeAccountStorage = vi.fn().mockReturnValue({
			version: 3,
			accounts: [],
			activeIndex: 0,
		});

		const { readImportFile } = await import("../lib/storage/import-export.js");

		await expect(
			readImportFile({
				resolvedPath: "/mock/import.json",
				normalizeAccountStorage,
			}),
		).resolves.toEqual({
			version: 3,
			accounts: [],
			activeIndex: 0,
		});

		expect(readFileMock).toHaveBeenCalledWith({ encoding: "utf-8" });
		expect(normalizeAccountStorage).toHaveBeenCalled();
		expect(closeMock).toHaveBeenCalled();
	});
});
