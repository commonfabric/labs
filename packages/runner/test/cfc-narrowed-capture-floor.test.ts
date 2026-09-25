/**
 * A lift that reads part of a labeled value is labeled as one reading all of
 * it is. The transformer narrows the lift's capture schema to the fields the
 * lift reads, and keeps the labels of the value it narrows; the runner joins
 * the confidentiality of every label in a lift's argument schema into its
 * result as a `declared` entry (`applyArgumentIfcToResult`). Under `observe`
 * flow labels no other entry labels the result, so the declared one is all
 * that does.
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-narrowed-capture-floor",
);
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: Record<string, unknown>;
  origin?: string;
};

/** A pattern over `secret`, declared as `declaration`, returning `out`. */
const program = (declaration: string, out: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, type Confidential } from 'commonfabric';",
      "interface Secret { a: string; b: string }",
      `export default pattern<{ secret: ${declaration} }>(({ secret }) => ({`,
      `  out: computed(() => ${out}),`,
      "}));",
    ].join("\n"),
  }],
});

describe("cfc-narrowed-capture-floor", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  /** The labels of the `declared` entries stored on the result's `out`. */
  const declaredLabelsOfOut = async (
    declaration: string,
    out: string,
  ): Promise<Record<string, unknown>[]> => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "observe",
    });
    const compiled = await runtime.patternManager.compilePattern(
      program(declaration, out),
      { space },
    );
    const tx = runtime.edit();
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "narrowed capture floor",
      compiled.resultSchema,
      tx,
    );
    runtime.run(tx, compiled, { secret: { a: "x", b: "y" } }, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).ok).toBeDefined();
    await result.pull();
    await runtime.settled();
    await storageManager.synced();

    const read = runtime.edit();
    const outCell = result.key("out").withTx(read).resolveAsCell();
    const id = outCell.getAsNormalizedFullLink().id;
    expect(outCell.get()).toBe("x");
    read.commit();
    const replica = storageManager.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return (replica.getDocument(id)?.cfc?.labelMap?.entries ?? [])
      .filter((entry) => entry.origin === "declared")
      .map((entry) => entry.label);
  };

  it("labels the result of a lift reading a labeled value by a property chain", async () => {
    expect(
      await declaredLabelsOfOut(
        'Confidential<Secret, readonly ["topsecret"]>',
        "secret.a",
      ),
    ).toEqual([{ confidentiality: ["topsecret"] }]);
  });

  it("labels the result of a lift reading a labeled value by an optional chain", async () => {
    expect(
      await declaredLabelsOfOut(
        'Confidential<Secret, readonly ["topsecret"]> | undefined',
        'secret?.a ?? ""',
      ),
    ).toEqual([{ confidentiality: ["topsecret"] }]);
  });

  it("labels nothing for a lift reading an unlabeled value", async () => {
    expect(await declaredLabelsOfOut("Secret", "secret.a")).toEqual([]);
  });
});
