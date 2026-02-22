import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

const { MESSAGE_STORAGE, PART_STORAGE } = vi.hoisted(() => ({
  MESSAGE_STORAGE: "C:\\virtual\\message",
  PART_STORAGE: "C:\\virtual\\part",
}));

const fsPromisesMock = vi.hoisted(() => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn(),
  rename: vi.fn().mockResolvedValue(undefined),
}));

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("fs/promises", () => fsPromisesMock);
vi.mock("node:fs", () => fsMock);
vi.mock("../lib/recovery/constants.js", () => ({
  MESSAGE_STORAGE,
  PART_STORAGE,
  THINKING_TYPES: new Set(["thinking", "redacted_thinking", "reasoning"]),
  META_TYPES: new Set(["step-start", "step-finish"]),
}));

let storage: typeof import("../lib/recovery/storage.js");

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  storage = await import("../lib/recovery/storage.js");
});

describe("RecoveryStorage", () => {
  describe("generatePartId", () => {
    it("should include prefix, timestamp, and random", () => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1700000000000);
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.123456789);

      const id = storage.generatePartId();

      expect(id).toMatch(/^prt_[0-9a-f]+[a-z0-9]{8}$/);
      expect(id).toContain((1700000000000).toString(16));

      nowSpy.mockRestore();
      randomSpy.mockRestore();
    });
  });

  describe("getMessageDir", () => {
    it("should return empty string when base dir missing", () => {
      fsMock.existsSync.mockImplementation((path: string) => path !== MESSAGE_STORAGE);

      expect(storage.getMessageDir("sess")).toBe("");
    });

    it("should return direct session path when present", () => {
      const sessionID = "sess";
      const directPath = join(MESSAGE_STORAGE, sessionID);

      fsMock.existsSync.mockImplementation((path: string) => path === MESSAGE_STORAGE || path === directPath);

      expect(storage.getMessageDir(sessionID)).toBe(directPath);
    });

    it("should search subdirectories for session", () => {
      const sessionID = "sess";
      const foundPath = join(MESSAGE_STORAGE, "alpha", sessionID);

      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === MESSAGE_STORAGE) return true;
        if (path === join(MESSAGE_STORAGE, sessionID)) return false;
        return path === foundPath;
      });
      fsMock.readdirSync.mockReturnValue(["alpha", "beta"]);

      expect(storage.getMessageDir(sessionID)).toBe(foundPath);
    });

    it("should return empty string on read errors", () => {
      fsMock.existsSync.mockImplementation((path: string) => path === MESSAGE_STORAGE);
      fsMock.readdirSync.mockImplementation(() => {
        throw new Error("nope");
      });

      expect(storage.getMessageDir("sess")).toBe("");
    });
  });

  describe("readMessages", () => {
    it("should return empty array when message dir missing", () => {
      fsMock.existsSync.mockReturnValue(false);

      expect(storage.readMessages("sess")).toEqual([]);
    });

    it("should sort messages and skip invalid files", () => {
      const sessionID = "sess";
      const messageDir = join(MESSAGE_STORAGE, sessionID);

      fsMock.existsSync.mockImplementation((path: string) => path === MESSAGE_STORAGE || path === messageDir);
      fsMock.readdirSync.mockReturnValue(["b.json", "a.json", "note.txt", "bad.json"]);
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path === join(messageDir, "b.json")) {
          return JSON.stringify({ id: "b", sessionID, role: "assistant", time: { created: 2 } });
        }
        if (path === join(messageDir, "a.json")) {
          return JSON.stringify({ id: "a", sessionID, role: "assistant", time: { created: 1 } });
        }
        if (path === join(messageDir, "bad.json")) {
          throw new Error("bad");
        }
        return "";
      });

      const result = storage.readMessages(sessionID);
      expect(result.map((msg) => msg.id)).toEqual(["a", "b"]);
    });

    it("should return empty array on read failure", () => {
      const sessionID = "sess";
      const messageDir = join(MESSAGE_STORAGE, sessionID);

      fsMock.existsSync.mockImplementation((path: string) => path === MESSAGE_STORAGE || path === messageDir);
      fsMock.readdirSync.mockImplementation(() => {
        throw new Error("fail");
      });

      expect(storage.readMessages(sessionID)).toEqual([]);
    });
  });

  describe("readParts", () => {
    it("should return empty array when part dir missing", () => {
      fsMock.existsSync.mockReturnValue(false);

      expect(storage.readParts("msg")).toEqual([]);
    });

    it("should parse part files and skip invalid JSON", () => {
      const messageID = "msg";
      const partDir = join(PART_STORAGE, messageID);

      fsMock.existsSync.mockImplementation((path: string) => path === partDir);
      fsMock.readdirSync.mockReturnValue(["one.json", "bad.json", "two.json"]);
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path === join(partDir, "one.json")) {
          return JSON.stringify({ id: "1", messageID, sessionID: "s", type: "text", text: "hi" });
        }
        if (path === join(partDir, "two.json")) {
          return JSON.stringify({ id: "2", messageID, sessionID: "s", type: "tool" });
        }
        if (path === join(partDir, "bad.json")) {
          throw new Error("bad");
        }
        return "";
      });

      const result = storage.readParts(messageID);
      expect(result).toHaveLength(2);
    });

    it("should return empty array on read failure", () => {
      const messageID = "msg";
      const partDir = join(PART_STORAGE, messageID);

      fsMock.existsSync.mockImplementation((path: string) => path === partDir);
      fsMock.readdirSync.mockImplementation(() => {
        throw new Error("fail");
      });

      expect(storage.readParts(messageID)).toEqual([]);
    });
  });

  describe("hasContent", () => {
    it("should ignore thinking and meta types", () => {
      expect(storage.hasContent({ id: "1", sessionID: "s", messageID: "m", type: "thinking" })).toBe(false);
      expect(storage.hasContent({ id: "1", sessionID: "s", messageID: "m", type: "step-start" })).toBe(false);
    });

    it("should treat text parts with content as true", () => {
      expect(storage.hasContent({ id: "1", sessionID: "s", messageID: "m", type: "text", text: "" })).toBe(false);
      expect(storage.hasContent({ id: "1", sessionID: "s", messageID: "m", type: "text", text: " hi " })).toBe(true);
    });

    it("should treat tool parts as true", () => {
      expect(storage.hasContent({ id: "1", sessionID: "s", messageID: "m", type: "tool" })).toBe(true);
      expect(storage.hasContent({ id: "1", sessionID: "s", messageID: "m", type: "tool_use" })).toBe(true);
      expect(storage.hasContent({ id: "1", sessionID: "s", messageID: "m", type: "tool_result" })).toBe(true);
    });

    it("should treat unknown types as false", () => {
      expect(storage.hasContent({ id: "1", sessionID: "s", messageID: "m", type: "custom" })).toBe(false);
    });
  });

  describe("messageHasContent", () => {
    it("should return true when any part has content", () => {
      const partDir = join(PART_STORAGE, "m");
      fsMock.existsSync.mockImplementation((path: string) => path === partDir);
      fsMock.readdirSync.mockReturnValue(["p1.json", "p2.json", "p3.json"]);
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path.includes("p1.json")) return JSON.stringify({ id: "1", sessionID: "s", messageID: "m", type: "reasoning", text: "" });
        if (path.includes("p2.json")) return JSON.stringify({ id: "2", sessionID: "s", messageID: "m", type: "text", text: "" });
        if (path.includes("p3.json")) return JSON.stringify({ id: "3", sessionID: "s", messageID: "m", type: "text", text: " ok " });
        return "{}";
      });

      expect(storage.messageHasContent("m")).toBe(true);
    });
  });

  describe("injectTextPart", () => {
    it("should create directory and write synthetic text part", () => {
      const sessionID = "sess";
      const messageID = "msg";
      const partDir = join(PART_STORAGE, messageID);

      fsMock.existsSync.mockReturnValue(false);

      const result = storage.injectTextPart(sessionID, messageID, "hello");

      expect(result).toBe(true);
      expect(fsMock.mkdirSync).toHaveBeenCalledWith(partDir, { recursive: true });
      expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);

      const [filePath, payload] = fsMock.writeFileSync.mock.calls[0] ?? [];
      expect(filePath).toMatch(/prt_[0-9a-f]+[a-z0-9]+\.json$/);
      const parsed = JSON.parse(payload);
      expect(parsed).toMatchObject({
        sessionID,
        messageID,
        type: "text",
        text: "hello",
        synthetic: true,
      });
      expect(parsed.id).toMatch(/^prt_/);
    });

    it("should return false on write error", () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.writeFileSync.mockImplementation(() => {
        throw new Error("fail");
      });

      expect(storage.injectTextPart("s", "m", "hi")).toBe(false);
    });
  });

  describe("thinking block recovery", () => {
    it("should find messages with thinking blocks", () => {
      const msgDir = join(MESSAGE_STORAGE, "s");
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === MESSAGE_STORAGE) return true;
        if (path === msgDir) return true;
        if (path === join(PART_STORAGE, "m1")) return true;
        if (path === join(PART_STORAGE, "m2")) return true;
        return false;
      });
      fsMock.readdirSync.mockImplementation((path: string) => {
        if (path === msgDir) return ["m1.json", "m2.json"];
        if (path === join(PART_STORAGE, "m1")) return ["p1.json"];
        if (path === join(PART_STORAGE, "m2")) return ["p2.json"];
        return [];
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path.includes("m1.json") && path.includes("message")) return JSON.stringify({ id: "m1", sessionID: "s", role: "assistant" });
        if (path.includes("m2.json") && path.includes("message")) return JSON.stringify({ id: "m2", sessionID: "s", role: "user" });
        if (path.includes("p1.json")) return JSON.stringify({ id: "p1", sessionID: "s", messageID: "m1", type: "thinking" });
        if (path.includes("p2.json")) return JSON.stringify({ id: "p2", sessionID: "s", messageID: "m2", type: "text", text: "hi" });
        return "{}";
      });

      expect(storage.findMessagesWithThinkingBlocks("s")).toEqual(["m1"]);
    });

    it("should find messages with thinking only", () => {
      const msgDir = join(MESSAGE_STORAGE, "s");
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === MESSAGE_STORAGE) return true;
        if (path === msgDir) return true;
        if (path.startsWith(PART_STORAGE)) return true;
        return false;
      });
      fsMock.readdirSync.mockImplementation((path: string) => {
        if (path === msgDir) return ["m1.json", "m2.json", "m3.json"];
        if (path === join(PART_STORAGE, "m1")) return ["p1.json"];
        if (path === join(PART_STORAGE, "m2")) return ["p2.json", "p3.json"];
        if (path === join(PART_STORAGE, "m3")) return [];
        return [];
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path.includes("m1.json") && path.includes("message")) return JSON.stringify({ id: "m1", sessionID: "s", role: "assistant" });
        if (path.includes("m2.json") && path.includes("message")) return JSON.stringify({ id: "m2", sessionID: "s", role: "assistant" });
        if (path.includes("m3.json") && path.includes("message")) return JSON.stringify({ id: "m3", sessionID: "s", role: "assistant" });
        if (path.includes("p1.json")) return JSON.stringify({ id: "p1", sessionID: "s", messageID: "m1", type: "thinking" });
        if (path.includes("p2.json")) return JSON.stringify({ id: "p2", sessionID: "s", messageID: "m2", type: "thinking" });
        if (path.includes("p3.json")) return JSON.stringify({ id: "p3", sessionID: "s", messageID: "m2", type: "text", text: "hi" });
        return "{}";
      });

      expect(storage.findMessagesWithThinkingOnly("s")).toEqual(["m1"]);
    });

    it("should find messages with orphan thinking", () => {
      const msgDir = join(MESSAGE_STORAGE, "s");
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === MESSAGE_STORAGE) return true;
        if (path === msgDir) return true;
        if (path.startsWith(PART_STORAGE)) return true;
        return false;
      });
      fsMock.readdirSync.mockImplementation((path: string) => {
        if (path === msgDir) return ["m1.json", "m2.json"];
        if (path === join(PART_STORAGE, "m1")) return ["a.json", "b.json"];
        if (path === join(PART_STORAGE, "m2")) return ["a.json"];
        return [];
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path.includes("m1.json") && path.includes("message")) return JSON.stringify({ id: "m1", sessionID: "s", role: "assistant" });
        if (path.includes("m2.json") && path.includes("message")) return JSON.stringify({ id: "m2", sessionID: "s", role: "assistant" });
        // m1: first part alphabetically is "a" which is TEXT (not thinking) = orphan
        if (path.includes(join(PART_STORAGE, "m1")) && path.includes("a.json")) return JSON.stringify({ id: "a", sessionID: "s", messageID: "m1", type: "text", text: "hi" });
        if (path.includes(join(PART_STORAGE, "m1")) && path.includes("b.json")) return JSON.stringify({ id: "b", sessionID: "s", messageID: "m1", type: "thinking" });
        // m2: first part alphabetically is "a" which is THINKING = not orphan
        if (path.includes(join(PART_STORAGE, "m2")) && path.includes("a.json")) return JSON.stringify({ id: "a", sessionID: "s", messageID: "m2", type: "thinking" });
        return "{}";
      });

      expect(storage.findMessagesWithOrphanThinking("s")).toEqual(["m1"]);
    });
  });

  describe("prependThinkingPart", () => {
    it("should create directory and write thinking part", () => {
      const sessionID = "s";
      const messageID = "m";
      const partDir = join(PART_STORAGE, messageID);

      fsMock.existsSync.mockReturnValue(false);

      const result = storage.prependThinkingPart(sessionID, messageID);

      expect(result).toBe(true);
      expect(fsMock.mkdirSync).toHaveBeenCalledWith(partDir, { recursive: true });

      const [filePath, payload] = fsMock.writeFileSync.mock.calls[0] ?? [];
      expect(filePath).toBe(join(partDir, "prt_0000000000_thinking.json"));
      expect(JSON.parse(payload)).toMatchObject({
        id: "prt_0000000000_thinking",
        sessionID,
        messageID,
        type: "thinking",
        thinking: "",
        synthetic: true,
      });
    });

    it("should return false on write error", () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.writeFileSync.mockImplementation(() => {
        throw new Error("fail");
      });

      expect(storage.prependThinkingPart("s", "m")).toBe(false);
    });
  });

  describe("stripThinkingParts", () => {
    it("should return false when part dir missing", () => {
      fsMock.existsSync.mockReturnValue(false);

      expect(storage.stripThinkingParts("m")).toBe(false);
    });

    it("should remove thinking parts and ignore others", () => {
      const messageID = "m";
      const partDir = join(PART_STORAGE, messageID);

      fsMock.existsSync.mockReturnValue(true);
      fsMock.readdirSync.mockReturnValue(["a.json", "b.json", "bad.json"]);
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path === join(partDir, "a.json")) {
          return JSON.stringify({ id: "a", sessionID: "s", messageID, type: "thinking" });
        }
        if (path === join(partDir, "b.json")) {
          return JSON.stringify({ id: "b", sessionID: "s", messageID, type: "text", text: "hi" });
        }
        if (path === join(partDir, "bad.json")) {
          throw new Error("bad");
        }
        return "";
      });

      expect(storage.stripThinkingParts(messageID)).toBe(true);
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(join(partDir, "a.json"));
      expect(fsMock.unlinkSync).toHaveBeenCalledTimes(1);
    });

    it("should return false on directory read error", () => {
      const messageID = "m";
      const partDir = join(PART_STORAGE, messageID);

      fsMock.existsSync.mockImplementation((path: string) => path === partDir);
      fsMock.readdirSync.mockImplementation(() => {
        throw new Error("fail");
      });

      expect(storage.stripThinkingParts(messageID)).toBe(false);
    });

    it("should skip non-JSON files in part directory (line 275 coverage)", () => {
      const messageID = "m";
      const partDir = join(PART_STORAGE, messageID);

      fsMock.existsSync.mockReturnValue(true);
      fsMock.readdirSync.mockReturnValue(["readme.txt", ".DS_Store", "a.json"]);
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path === join(partDir, "a.json")) {
          return JSON.stringify({ id: "a", sessionID: "s", messageID, type: "thinking" });
        }
        throw new Error("Should not read non-JSON files");
      });

      expect(storage.stripThinkingParts(messageID)).toBe(true);
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(join(partDir, "a.json"));
      expect(fsMock.unlinkSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("empty message recovery", () => {
    it("should find empty messages", () => {
      const msgDir = join(MESSAGE_STORAGE, "s");
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === MESSAGE_STORAGE) return true;
        if (path === msgDir) return true;
        if (path === join(PART_STORAGE, "m1")) return true;
        if (path === join(PART_STORAGE, "m2")) return true;
        return false;
      });
      fsMock.readdirSync.mockImplementation((path: string) => {
        if (path === msgDir) return ["m1.json", "m2.json"];
        if (path === join(PART_STORAGE, "m1")) return ["p1.json"];
        if (path === join(PART_STORAGE, "m2")) return ["p2.json"];
        return [];
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path.includes("m1.json") && path.includes("message")) return JSON.stringify({ id: "m1", sessionID: "s", role: "assistant" });
        if (path.includes("m2.json") && path.includes("message")) return JSON.stringify({ id: "m2", sessionID: "s", role: "assistant" });
        if (path.includes("p1.json")) return JSON.stringify({ id: "p1", sessionID: "s", messageID: "m1", type: "text", text: "" });
        if (path.includes("p2.json")) return JSON.stringify({ id: "p2", sessionID: "s", messageID: "m2", type: "text", text: "content" });
        return "{}";
      });

      expect(storage.findEmptyMessages("s")).toEqual(["m1"]);
    });

    it("should find empty message by index using fallback", () => {
      const msgDir = join(MESSAGE_STORAGE, "s");
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === MESSAGE_STORAGE) return true;
        if (path === msgDir) return true;
        if (path.startsWith(PART_STORAGE)) return true;
        return false;
      });
      fsMock.readdirSync.mockImplementation((path: string) => {
        if (path === msgDir) return ["m0.json", "m1.json", "m2.json"];
        if (path === join(PART_STORAGE, "m0")) return ["p0.json"];
        if (path === join(PART_STORAGE, "m1")) return ["p1.json"];
        if (path === join(PART_STORAGE, "m2")) return ["p2.json"];
        return [];
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path.includes("m0.json") && path.includes("message")) return JSON.stringify({ id: "m0", sessionID: "s", role: "assistant" });
        if (path.includes("m1.json") && path.includes("message")) return JSON.stringify({ id: "m1", sessionID: "s", role: "assistant" });
        if (path.includes("m2.json") && path.includes("message")) return JSON.stringify({ id: "m2", sessionID: "s", role: "assistant" });
        if (path.includes("p0.json")) return JSON.stringify({ id: "p0", sessionID: "s", messageID: "m0", type: "text", text: "content" });
        if (path.includes("p1.json")) return JSON.stringify({ id: "p1", sessionID: "s", messageID: "m1", type: "text", text: "" });
        if (path.includes("p2.json")) return JSON.stringify({ id: "p2", sessionID: "s", messageID: "m2", type: "text", text: "content" });
        return "{}";
      });

      expect(storage.findEmptyMessageByIndex("s", 2)).toBe("m1");
    });

    it("should return null when no empty message found", () => {
      const msgDir = join(MESSAGE_STORAGE, "s");
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === MESSAGE_STORAGE) return true;
        if (path === msgDir) return true;
        if (path.startsWith(PART_STORAGE)) return true;
        return false;
      });
      fsMock.readdirSync.mockImplementation((path: string) => {
        if (path === msgDir) return ["m0.json"];
        if (path === join(PART_STORAGE, "m0")) return ["p0.json"];
        return [];
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path.includes("m0.json") && path.includes("message")) return JSON.stringify({ id: "m0", sessionID: "s", role: "assistant" });
        if (path.includes("p0.json")) return JSON.stringify({ id: "p0", sessionID: "s", messageID: "m0", type: "text", text: "content" });
        return "{}";
      });

      expect(storage.findEmptyMessageByIndex("s", 0)).toBeNull();
    });
  });

  describe("findMessageByIndexNeedingThinking", () => {
    it("should return null for out-of-bounds index (line 335 coverage)", () => {
      const msgDir = join(MESSAGE_STORAGE, "s");
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === MESSAGE_STORAGE) return true;
        if (path === msgDir) return true;
        return false;
      });
      fsMock.readdirSync.mockImplementation((path: string) => {
        if (path === msgDir) return ["m.json"];
        return [];
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path.includes("m.json") && path.includes("message")) return JSON.stringify({ id: "m", sessionID: "s", role: "assistant" });
        return "{}";
      });

      expect(storage.findMessageByIndexNeedingThinking("s", -1)).toBeNull();
      expect(storage.findMessageByIndexNeedingThinking("s", 5)).toBeNull();
    });

    it("should return null for non-assistant", () => {
      const msgDir = join(MESSAGE_STORAGE, "s");
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === MESSAGE_STORAGE) return true;
        if (path === msgDir) return true;
        return false;
      });
      fsMock.readdirSync.mockImplementation((path: string) => {
        if (path === msgDir) return ["m.json"];
        return [];
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path.includes("m.json") && path.includes("message")) return JSON.stringify({ id: "m", sessionID: "s", role: "user" });
        return "{}";
      });

      expect(storage.findMessageByIndexNeedingThinking("s", 0)).toBeNull();
    });

    it("should return message id when first part is not thinking", () => {
      const msgDir = join(MESSAGE_STORAGE, "s");
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === MESSAGE_STORAGE) return true;
        if (path === msgDir) return true;
        if (path === join(PART_STORAGE, "m")) return true;
        return false;
      });
      fsMock.readdirSync.mockImplementation((path: string) => {
        if (path === msgDir) return ["m.json"];
        if (path === join(PART_STORAGE, "m")) return ["a.json", "b.json"];
        return [];
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path.includes("m.json") && path.includes("message")) return JSON.stringify({ id: "m", sessionID: "s", role: "assistant" });
        // "a" is text (comes first alphabetically), "b" is thinking -> firstIsThinking=false -> returns messageID
        if (path.includes("a.json")) return JSON.stringify({ id: "a", sessionID: "s", messageID: "m", type: "text", text: "hi" });
        if (path.includes("b.json")) return JSON.stringify({ id: "b", sessionID: "s", messageID: "m", type: "thinking" });
        return "{}";
      });

      expect(storage.findMessageByIndexNeedingThinking("s", 0)).toBe("m");
    });
  });

  describe("replaceEmptyTextParts", () => {
    it("should return false when part dir missing", () => {
      fsMock.existsSync.mockReturnValue(false);

      expect(storage.replaceEmptyTextParts("m", "replacement")).toBe(false);
    });

    it("should replace empty text parts and mark synthetic", () => {
      const messageID = "m";
      const partDir = join(PART_STORAGE, messageID);

      fsMock.existsSync.mockReturnValue(true);
      fsMock.readdirSync.mockReturnValue(["a.json", "b.json", "c.json"]);
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path === join(partDir, "a.json")) {
          return JSON.stringify({ id: "a", sessionID: "s", messageID, type: "text", text: "" });
        }
        if (path === join(partDir, "b.json")) {
          return JSON.stringify({ id: "b", sessionID: "s", messageID, type: "text", text: "hi" });
        }
        if (path === join(partDir, "c.json")) {
          return JSON.stringify({ id: "c", sessionID: "s", messageID, type: "tool" });
        }
        return "";
      });

      expect(storage.replaceEmptyTextParts(messageID, "replacement")).toBe(true);
      expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);

      const [filePath, payload] = fsMock.writeFileSync.mock.calls[0] ?? [];
      expect(filePath).toBe(join(partDir, "a.json"));
      expect(JSON.parse(payload)).toMatchObject({
        id: "a",
        type: "text",
        text: "replacement",
        synthetic: true,
      });
    });

    it("should return false on directory read error", () => {
      const messageID = "m";
      const partDir = join(PART_STORAGE, messageID);

      fsMock.existsSync.mockImplementation((path: string) => path === partDir);
      fsMock.readdirSync.mockImplementation(() => {
        throw new Error("fail");
      });

      expect(storage.replaceEmptyTextParts(messageID, "replacement")).toBe(false);
    });
  });

  describe("findMessagesWithEmptyTextParts", () => {
    it("should return messages containing empty text parts", () => {
      const msgDir = join(MESSAGE_STORAGE, "s");
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === MESSAGE_STORAGE) return true;
        if (path === msgDir) return true;
        if (path === join(PART_STORAGE, "m1")) return true;
        if (path === join(PART_STORAGE, "m2")) return true;
        return false;
      });
      fsMock.readdirSync.mockImplementation((path: string) => {
        if (path === msgDir) return ["m1.json", "m2.json"];
        if (path === join(PART_STORAGE, "m1")) return ["p1.json"];
        if (path === join(PART_STORAGE, "m2")) return ["p2.json"];
        return [];
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path.includes("m1.json") && path.includes("message")) return JSON.stringify({ id: "m1", sessionID: "s", role: "assistant" });
        if (path.includes("m2.json") && path.includes("message")) return JSON.stringify({ id: "m2", sessionID: "s", role: "assistant" });
        if (path.includes("p1.json")) return JSON.stringify({ id: "p1", sessionID: "s", messageID: "m1", type: "text", text: "" });
        if (path.includes("p2.json")) return JSON.stringify({ id: "p2", sessionID: "s", messageID: "m2", type: "text", text: "ok" });
        return "{}";
      });

      expect(storage.findMessagesWithEmptyTextParts("s")).toEqual(["m1"]);
    });
  });

  describe("validatePathId (via getMessageDir)", () => {
    it("should throw on unsafe session ID characters", () => {
      expect(() => storage.getMessageDir("sess/../hack")).toThrow("Invalid sessionID: contains unsafe characters");
    });

    it("should throw on ID with special characters", () => {
      expect(() => storage.getMessageDir("sess/evil")).toThrow("Invalid sessionID: contains unsafe characters");
    });
  });

  describe("findMessageByIndexNeedingThinking - line 353", () => {
    it("should return null when first part is thinking", () => {
      const msgDir = join(MESSAGE_STORAGE, "s");
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === MESSAGE_STORAGE) return true;
        if (path === msgDir) return true;
        if (path === join(PART_STORAGE, "m")) return true;
        return false;
      });
      fsMock.readdirSync.mockImplementation((path: string) => {
        if (path === msgDir) return ["m.json"];
        if (path === join(PART_STORAGE, "m")) return ["a.json"];
        return [];
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path.includes("m.json") && path.includes("message")) return JSON.stringify({ id: "m", sessionID: "s", role: "assistant" });
        if (path.includes("a.json")) return JSON.stringify({ id: "a", sessionID: "s", messageID: "m", type: "thinking" });
        return "{}";
      });

      expect(storage.findMessageByIndexNeedingThinking("s", 0)).toBeNull();
    });
  });

  describe("replaceEmptyTextParts parse error - line 379", () => {
    it("should continue on JSON parse error for individual parts", () => {
      const messageID = "m";
      const partDir = join(PART_STORAGE, messageID);

      fsMock.existsSync.mockReturnValue(true);
      fsMock.readdirSync.mockReturnValue(["bad.json", "good.json"]);
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path === join(partDir, "bad.json")) {
          return "not valid json";
        }
        if (path === join(partDir, "good.json")) {
          return JSON.stringify({ id: "good", sessionID: "s", messageID, type: "text", text: "" });
        }
        return "";
      });

      expect(storage.replaceEmptyTextParts(messageID, "replacement")).toBe(true);
      expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("replaceEmptyTextParts - line 363 non-json files", () => {
    it("should skip non-json files in directory", () => {
      const messageID = "m";
      const partDir = join(PART_STORAGE, messageID);

      fsMock.existsSync.mockReturnValue(true);
      fsMock.readdirSync.mockReturnValue(["readme.txt", "backup.bak", "good.json"]);
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path === join(partDir, "good.json")) {
          return JSON.stringify({ id: "good", sessionID: "s", messageID, type: "text", text: "" });
        }
        return "";
      });

      expect(storage.replaceEmptyTextParts(messageID, "replacement")).toBe(true);
      expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("findMessagesWithEmptyTextParts - line 396 non-text types", () => {
    it("should not include messages where parts are non-text type", () => {
      const msgDir = join(MESSAGE_STORAGE, "s");
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === MESSAGE_STORAGE) return true;
        if (path === msgDir) return true;
        if (path === join(PART_STORAGE, "m")) return true;
        return false;
      });
      fsMock.readdirSync.mockImplementation((path: string) => {
        if (path === msgDir) return ["m.json"];
        if (path === join(PART_STORAGE, "m")) return ["a.json"];
        return [];
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path.includes("m.json") && path.includes("message")) {
          return JSON.stringify({ id: "m", sessionID: "s", role: "assistant" });
        }
        if (path.includes("a.json")) {
          return JSON.stringify({ id: "a", sessionID: "s", messageID: "m", type: "tool" });
        }
        return "{}";
      });

      const result = storage.findMessagesWithEmptyTextParts("s");
      expect(result).toEqual([]);
    });
  });

  describe("findMessageByIndexNeedingThinking - lines 341-345 edge cases", () => {
    it("should return null when parts array is empty", () => {
      const msgDir = join(MESSAGE_STORAGE, "s");
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === MESSAGE_STORAGE) return true;
        if (path === msgDir) return true;
        if (path === join(PART_STORAGE, "m")) return true;
        return false;
      });
      fsMock.readdirSync.mockImplementation((path: string) => {
        if (path === msgDir) return ["m.json"];
        if (path === join(PART_STORAGE, "m")) return [];
        return [];
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path.includes("m.json") && path.includes("message")) {
          return JSON.stringify({ id: "m", sessionID: "s", role: "assistant" });
        }
        return "{}";
      });

      expect(storage.findMessageByIndexNeedingThinking("s", 0)).toBeNull();
    });

    it("should return null when target message is not assistant role", () => {
      const msgDir = join(MESSAGE_STORAGE, "s");
      fsMock.existsSync.mockImplementation((path: string) => {
        if (path === MESSAGE_STORAGE) return true;
        if (path === msgDir) return true;
        return false;
      });
      fsMock.readdirSync.mockImplementation((path: string) => {
        if (path === msgDir) return ["m.json"];
        return [];
      });
      fsMock.readFileSync.mockImplementation((path: string) => {
        if (path.includes("m.json") && path.includes("message")) {
          return JSON.stringify({ id: "m", sessionID: "s", role: "user" });
        }
        return "{}";
      });

      expect(storage.findMessageByIndexNeedingThinking("s", 0)).toBeNull();
    });
  });
});
