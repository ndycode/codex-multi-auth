import * as fc from "fast-check";

fc.configureGlobal({
  numRuns: 100,
  verbose: false,
  endOnFailure: true,
  skipAllAfterTimeLimit: 10000,
});

export { fc };

export function seedFromTestName(testName: string): number {
  let hash = 0;
  for (let i = 0; i < testName.length; i++) {
    const char = testName.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}
