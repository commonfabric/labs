/**
 * A lift whose inferred result holds a value an input's annotation labels with
 * a module policy declares that policy on its result. The transformer prints
 * the result from its type, which spells the policy's `typeof` binding as the
 * structural type of the value it names, so the result's member is read at the
 * annotation of the binding it holds (`readBindingAnnotation` in the schema
 * generator). The runner stores the declared label, and the policy releases
 * it.
 *
 * An array literal's element and a pattern member holding the lift itself are
 * read the same way, as is a member whose only label comes from a local
 * annotation over an unlabelled input, so a read of each releases to a reader
 * and holds against anyone else.
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { evaluateExchangeRules, type IFCLabel } from "../src/cfc/mod.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { readProjected } from "../src/cell.ts";
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

  describe("a result read at its element's or its lift's binding", () => {
    /**
     * The value a read of the result's `out` returns, with the confidentiality
     * that read consumed evaluated against the policy with a reader's
     * integrity (`released`) and with none (`held`), for `program` run over
     * `input` as the cell `name`, with flow labels `flowLabels`.
     */
    const readOut = async (
      program: RuntimeProgram,
      input: Record<string, unknown>,
      name: string,
      flowLabels: "persist" | "observe",
    ): Promise<{ value: unknown; released: unknown[]; held: unknown[] }> => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcFlowLabels: flowLabels,
      });
      const compiled = await runtime.patternManager.compilePattern(program, {
        space,
      });
      const tx = runtime.edit();
      const result = runtime.getCell<Record<string, unknown>>(
        space,
        `${name} ${flowLabels}`,
        compiled.resultSchema,
        tx,
      );
      runtime.run(tx, compiled, input, result);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).ok).toBeDefined();
      await result.pull();
      await runtime.settled();
      await storageManager.synced();

      const { value, consumed } = readProjected(
        result.key("out"),
        (read) => read,
      );
      const read = runtime.edit();
      const evaluate = (integrity: readonly ["reader"] | readonly []) => {
        const evaluated = evaluateExchangeRules(
          { confidentiality: [...(consumed.confidentiality ?? [])] },
          undefined,
          {
            integrity,
            modulePolicyResolver: (reference) =>
              read.resolveCfcPolicyManifest(reference, space),
          },
        );
        expect(evaluated.resolutionFailures).toEqual([]);
        return [...(evaluated.label.confidentiality ?? [])];
      };
      const released = evaluate(["reader"]);
      const held = evaluate([]);
      read.commit();
      return { value, released, held };
    };

    for (
      const [shape, out, value] of [
        ["an array literal holding the binding", "[a]", [["x", "y"]]],
        ["the binding alone", "a", ["x", "y"]],
      ] as const
    ) {
      for (
        const [spelling, declaration] of [
          ["a value", "a: Confidential<string[], [PolicyOf<typeof readers>]>"],
          [
            "a nullable value",
            "a: Confidential<string[] | null, [PolicyOf<typeof readers>]>",
          ],
        ] as const
      ) {
        for (const flowLabels of ["persist", "observe"] as const) {
          const read = () =>
            readOut(
              program(declaration, out),
              { a: ["x", "y"] },
              `result read at a binding ${out}`,
              flowLabels,
            );

          it(`releases a read of a lift returning ${shape} of ${spelling} to a reader, with ${flowLabels} flow labels`, async () => {
            const result = await read();

            expect(result.value).toEqual(value);
            expect(result.released).toEqual([]);
          });

          it(`holds a read of a lift returning ${shape} of ${spelling} against a reader with no integrity, with ${flowLabels} flow labels`, async () => {
            expect((await read()).held)
              .toMatchObject([{ policyRefKind: "module", symbol: "readers" }]);
          });
        }
      }
    }

    /**
     * A pattern whose input is unlabelled, and whose result holds that input
     * in an array through a local binding annotated with the policy: the
     * annotation is the value's only label.
     */
    const locallyLabelled: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { pattern, type Confidential } from 'commonfabric';",
          "import { type PolicyOf } from 'commonfabric/cfc';",
          "import { readers } from './rules.ts';",
          "export default pattern<{ a: string }>(({ a }) => {",
          "  const secret: Confidential<string, [PolicyOf<typeof readers>]> = a;",
          "  return { out: [secret] };",
          "});",
        ].join("\n"),
      }, program("", "a").files[1]!],
    };

    for (const flowLabels of ["persist", "observe"] as const) {
      const read = () =>
        readOut(
          locallyLabelled,
          { a: "secret" },
          "result labelled by a local annotation",
          flowLabels,
        );

      it(`releases a read of an element labelled only by a local annotation to a reader, with ${flowLabels} flow labels`, async () => {
        const result = await read();

        expect(result.value).toEqual(["secret"]);
        expect(result.released).toEqual([]);
      });

      it(`holds a read of an element labelled only by a local annotation against a reader with no integrity, with ${flowLabels} flow labels`, async () => {
        expect((await read()).held)
          .toMatchObject([{ policyRefKind: "module", symbol: "readers" }]);
      });
    }
  });
});
