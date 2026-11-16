import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

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

  it("throws in a process that never exposed the collector", async () => {
    // A process that has exposed the collector cannot take it back, so the
    // call runs in a process of its own.

    const output = await runDenoCommandWithTemporaryLock({
      root: fromFileUrl(new URL("../../../", import.meta.url)),
      args: (lock) => [
        "run",
        "--frozen",
        `--lock=${lock}`,
        fromFileUrl(
          new URL("./collected-memory-unexposed-helper.ts", import.meta.url),
        ),
      ],
    });

    const decoder = new TextDecoder();
    expect(output.success, decoder.decode(output.stderr)).toBe(true);
    expect(decoder.decode(output.stdout).trim()).toBe(
      "V8 exposes no `gc()`, because this process has no `--expose-gc`",
    );
  });
});
