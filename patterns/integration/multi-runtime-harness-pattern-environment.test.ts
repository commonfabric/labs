/**
 * The multi-runtime harness's claim on this process's pattern environment,
 * which a harness hosting a serving loop sets to the address it hosts: two
 * harnesses alive at once, released in the order they were made, and a
 * harness ended with `terminate()`. Each harness hosts a serving loop, so each
 * claims the environment.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { getPatternEnvironment } from "@commonfabric/runner";
import { MultiRuntimeHarness } from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "share-intake",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/** A harness hosting a serving loop, with one session labeled `label`. */
const servingHarness = async (label: string): Promise<MultiRuntimeHarness> =>
  await MultiRuntimeHarness.create({
    programPath: PROGRAM_PATH,
    rootPath: ROOT_PATH,
    sessions: [{ label, cfc: { experimental: { serverExecution: true } } }],
  });

/** The address this process's pattern environment names. */
const environment = (): string => getPatternEnvironment().apiUrl.href;

describe("multi-runtime harness pattern environment", () => {
  it("keeps the environment of the harness made last while an earlier one is disposed, and restores the first environment once both are", async () => {
    const original = environment();
    const first = await servingHarness("pattern-environment-first");
    const firstEnvironment = environment();
    const second = await servingHarness("pattern-environment-second");
    const secondEnvironment = environment();

    await first.dispose();
    const afterFirst = environment();
    await second.dispose();

    expect(firstEnvironment).not.toBe(original);
    expect(secondEnvironment).not.toBe(firstEnvironment);
    expect(afterFirst).toBe(secondEnvironment);
    expect(environment()).toBe(original);
  });

  it("restores the environment it found when terminated", async () => {
    const original = environment();
    const harness = await servingHarness("pattern-environment-terminated");
    const claimed = environment();

    harness.terminate();
    const afterTerminate = environment();
    await harness.dispose();

    expect(claimed).not.toBe(original);
    expect(afterTerminate).toBe(original);
  });
});
