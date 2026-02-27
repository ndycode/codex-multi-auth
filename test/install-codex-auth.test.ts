import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const scriptPath = "scripts/install-codex-auth.js";

describe("install-codex-auth script", () => {
  it("uses lowercase config template filenames", () => {
    const content = readFileSync(scriptPath, "utf8");
    expect(content).toContain('"codex-legacy.json"');
    expect(content).toContain('"codex-modern.json"');
    expect(content).not.toContain('"Codex-legacy.json"');
    expect(content).not.toContain('"Codex-modern.json"');
  });

  it("uses collision-resistant backup suffix", () => {
    const content = readFileSync(scriptPath, "utf8");
    expect(content).toContain("process.pid");
    expect(content).toContain("Math.random().toString(36)");
  });
});