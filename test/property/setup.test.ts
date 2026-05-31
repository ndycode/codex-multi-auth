import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { arbHealthScore, arbAccountIndex, arbQuotaKey } from "./helpers.js";

describe("Property test setup verification", () => {
  // Regression (tests-ci-02): the global property-test config is wired via
  // vitest setupFiles, so fc.configureGlobal actually applies here. Previously
  // setup.ts was never imported and these settings were inert.
  it("applies the global fast-check config from setup.ts", () => {
    const global = fc.readConfigureGlobal();
    expect(global?.numRuns).toBe(100);
    expect(global?.skipAllAfterTimeLimit).toBe(10000);
    expect(global?.endOnFailure).toBe(true);
  });

  it("health scores are always in valid range", () => {
    fc.assert(
      fc.property(arbHealthScore, (score) => {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
        return true;
      })
    );
  });

  it("account indices are always valid", () => {
    fc.assert(
      fc.property(arbAccountIndex, (index) => {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThanOrEqual(19);
        return true;
      })
    );
  });

  it("quota keys are valid strings or undefined", () => {
    fc.assert(
      fc.property(arbQuotaKey, (key) => {
        if (key !== undefined) {
          expect(typeof key).toBe("string");
          expect(key.length).toBeGreaterThan(0);
        }
        return true;
      })
    );
  });
});
