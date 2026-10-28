/**
 * A generic lift whose input is scoped and labelled around a payload that may
 * be `null` or `undefined` captures that input, in a computed it reads, with
 * its nullish value. While the payload is a type parameter, the nullish
 * member is the `null` or `undefined` beside the deferred `ScopeTag` and
 * `CfcTag`, and the transformer reads it as the `null` or `undefined` it is
 * once they resolve, so the computed runs with the value the input holds.
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase(
  "runner-generic-carrier-nullish-capture",
);
const space = signer.did();

/** A pattern reading `secret`, declared around `nullish`, through a lift. */
const program = (nullish: "null" | "undefined"): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, lift, pattern, type Confidential, type PerUser } from 'commonfabric';",
      "const read = lift(<T extends { a: string }>(",
      `  { secret }: { secret: PerUser<Confidential<T | ${nullish}, ["owner"]>> },`,
      ') => computed(() => secret?.a ?? "absent"));',
      "export default pattern<{",
      `  secret: PerUser<Confidential<{ a: string } | ${nullish}, ["owner"]>>;`,
      "}>((input) => ({ out: read(input) }));",
    ].join("\n"),
  }],
});

describe("generic-carrier-nullish-capture", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  /** The value `out` holds for the pattern run with `secret`. */
  const outFor = async (
    nullish: "null" | "undefined",
    secret: { a: string } | null | undefined,
  ): Promise<unknown> => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    const compiled = await runtime.patternManager.compilePattern(
      program(nullish),
      { space },
    );
    const tx = runtime.edit();
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      `generic carrier ${nullish} ${secret === undefined ? "absent" : "set"}`,
      compiled.resultSchema,
      tx,
    );
    runtime.run(tx, compiled, { secret }, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).ok).toBeDefined();
    await result.pull();
    await runtime.settled();
    const read = runtime.edit();
    const out = result.key("out").withTx(read).get();
    read.commit();
    return out;
  };

  for (const nullish of ["undefined", "null"] as const) {
    it(`returns the fallback for an input that is \`${nullish}\``, async () => {
      expect(await outFor(nullish, nullish === "null" ? null : undefined))
        .toBe("absent");
    });

    it(`returns the payload's member for a present input beside \`${nullish}\``, async () => {
      expect(await outFor(nullish, { a: "x" })).toBe("x");
    });
  }
});
