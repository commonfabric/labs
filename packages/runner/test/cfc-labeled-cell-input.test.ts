import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-labeled-cell-input");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: Record<string, unknown>;
  origin?: string;
};

/** A pattern over `secret`, declared by `declaration`, reading its cell. */
const program = (declaration: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { type Cell, computed, pattern, type Confidential } from 'commonfabric';",
      `export default pattern<{ ${declaration} }>(({ secret }) => ({`,
      '  out: computed(() => secret.c?.get() ?? ""),',
      "}));",
    ].join("\n"),
  }],
});

describe("cfc-labeled-cell-input", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  /** The labels of the `declared` entries stored on the input's `secret.c`. */
  const declaredLabelsOfInput = async (
    declaration: string,
  ): Promise<Record<string, unknown>[]> => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "observe",
    });
    const compiled = await runtime.patternManager.compilePattern(
      program(declaration),
      { space },
    );
    const tx = runtime.edit();
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "labeled cell input",
      compiled.resultSchema,
      tx,
    );
    runtime.run(tx, compiled, { secret: { c: "x" } }, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).ok).toBeDefined();
    await result.pull();
    await runtime.settled();
    await storageManager.synced();

    const read = runtime.edit();
    const input = result.withTx(read).getArgumentCell()!;
    const { id } = input.key("secret").key("c").getAsNormalizedFullLink();
    read.commit();
    const replica = storageManager.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return (replica.getDocument(id)?.cfc?.labelMap?.entries ?? [])
      .filter((entry) =>
        entry.origin === "declared" && entry.path.join("/") === "secret/c"
      )
      .map((entry) => entry.label);
  };

  for (const missing of ["", " | undefined", " | null"]) {
    it(
      `stores the label of a labeled cell input declared${
        missing ? ` with \`${missing.slice(3)}\`` : " alone"
      }`,
      async () => {
        expect(
          await declaredLabelsOfInput(
            `secret: { c: Confidential<Cell<string>, ["b"]>${missing} }`,
          ),
        ).toEqual([{ confidentiality: ["b"] }]);
      },
    );
  }
});
