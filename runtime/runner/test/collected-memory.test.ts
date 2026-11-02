import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  collectedMemory,
  exposeGarbageCollector,
} from "../src/collected-memory.ts";

const SIZE = 64 * 1024 * 1024;

describe("collected-memory", () => {
  it("counts a buffer this isolate holds, and not one it has released", () => {
    exposeGarbageCollector();
    const before = collectedMemory();
    let held: Uint8Array | undefined = new Uint8Array(SIZE);
    const during = collectedMemory();
    expect(during.external - before.external).toBeGreaterThanOrEqual(SIZE);
    expect(held.length).toBe(SIZE);
    held = undefined;
    const after = collectedMemory();
    expect(during.external - after.external).toBeGreaterThanOrEqual(SIZE);
    expect(after.heapUsed).toBeGreaterThan(0);
  });
});
