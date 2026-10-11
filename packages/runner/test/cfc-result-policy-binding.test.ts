/**
 * A lift whose inferred result holds a value an input's annotation labels with
 * a module policy declares that policy on its result. The transformer prints
 * the result from its type, which spells the policy's `typeof` binding as the
 * structural type of the value it names, so the result's member is read at the
 * annotation of the binding it holds (`readBindingAnnotation` in the schema
 * generator). The runner stores the declared label, and the policy releases
 * it.
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { evaluateExchangeRules, type IFCLabel } from "../src/cfc/mod.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-result-policy-binding",
);
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: IFCLabel;
  origin?: string;
};

/**
 * A pattern over `a`, declared as `declaration`, returning `out` computed as
 * `out`, beside a module declaring the exchange rules `readers`, which release
 * a value to a reader.
 */
const program = (declaration: string, out: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, type Confidential } from 'commonfabric';",
      "import { type PolicyOf } from 'commonfabric/cfc';",
      "import { readers } from './rules.ts';",
      `export default pattern<{ ${declaration} }>(({ a }) => ({`,
      `  out: computed(() => ${out}),`,
      "}));",
    ].join("\n"),
  }, {
    name: "/rules.ts",
    contents: [
      "import { exchangeRule, exchangeRules, THIS_POLICY } from 'commonfabric/cfc';",
      "export const releaseToReaders = exchangeRule({",
      "  appliesTo: THIS_POLICY,",
      "  pre: { integrity: ['reader'] },",
      "  post: { dropClause: true },",
      "});",
      "export const readers = exchangeRules([releaseToReaders]);",
    ].join("\n"),
  }],
});

describe("cfc-result-policy-binding", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  /**
   * The `declared` labels stored at `whole` in the result's `out`, and the
   * confidentiality left of every label stored there once the policy is
   * evaluated with a reader's integrity.
   */
  const wholeLabels = async (
    declaration: string,
  ): Promise<{ declared: IFCLabel[]; released: unknown[] }> => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    const compiled = await runtime.patternManager.compilePattern(
      program(declaration, "({ whole: a, length: a?.length })"),
      { space },
    );
    const tx = runtime.edit();
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "result policy binding",
      compiled.resultSchema,
      tx,
    );
    runtime.run(tx, compiled, { a: ["x", "y"] }, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).ok).toBeDefined();
    await result.pull();
    await runtime.settled();
    await storageManager.synced();

    const read = runtime.edit();
    const outCell = result.key("out").withTx(read).resolveAsCell();
    const id = outCell.getAsNormalizedFullLink().id;
    expect(outCell.get()).toEqual({ whole: ["x", "y"], length: 2 });
    const replica = storageManager.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    const whole = (replica.getDocument(id)?.cfc?.labelMap?.entries ?? [])
      .filter((entry) => entry.path[0] === "whole");
    const evaluated = evaluateExchangeRules(
      {
        confidentiality: whole.flatMap((entry) =>
          entry.label.confidentiality ?? []
        ),
      },
      undefined,
      {
        integrity: ["reader"],
        modulePolicyResolver: (reference) =>
          read.resolveCfcPolicyManifest(reference, space),
      },
    );
    read.commit();
    expect(evaluated.resolutionFailures).toEqual([]);
    return {
      declared: whole
        .filter((entry) => entry.origin === "declared")
        .map((entry) => entry.label),
      released: [...(evaluated.label.confidentiality ?? [])],
    };
  };

  for (
    const [spelling, declaration] of [
      ["a value", "a: Confidential<string[], [PolicyOf<typeof readers>]>"],
      [
        "a nullable value",
        "a: Confidential<string[] | null, [PolicyOf<typeof readers>]>",
      ],
    ]
  ) {
    it(`stores the policy of ${spelling} a lift's result holds as its member's declared label`, async () => {
      expect((await wholeLabels(declaration!)).declared).toMatchObject([{
        confidentiality: [{ policyRefKind: "module", symbol: "readers" }],
      }]);
    });

    it(`releases the labels stored at the member holding ${spelling} to a reader`, async () => {
      expect((await wholeLabels(declaration!)).released).toEqual([]);
    });
  }
});
