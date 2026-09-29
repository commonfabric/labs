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

/**
 * A pattern over `secret`, declared by `declaration`, returning `out`, beside
 * a module declaring the exchange rules `rules`.
 */
const program = (declaration: string, out: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, type Confidential } from 'commonfabric';",
      "import { type PolicyOf } from 'commonfabric/cfc';",
      "import { rules } from './rules.ts';",
      "interface Secret { a: string; b: string }",
      "interface Other { a: string; c: number }",
      "type Either = Confidential<Secret, ['x']> | Confidential<Other, ['y']>;",
      `export default pattern<{ ${declaration} }>(({ secret }) => ({`,
      `  out: computed(() => ${out}),`,
      "}));",
    ].join("\n"),
  }, {
    name: "/rules.ts",
    contents: [
      "import { exchangeRule, exchangeRules, THIS_POLICY } from 'commonfabric/cfc';",
      "export const neverRelease = exchangeRule({",
      "  appliesTo: THIS_POLICY,",
      "  pre: { integrity: ['never'] },",
      "  post: { dropClause: true },",
      "});",
      "export const rules = exchangeRules([neverRelease]);",
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
        'secret: Confidential<Secret, readonly ["topsecret"]>',
        "secret.a",
      ),
    ).toEqual([{ confidentiality: ["topsecret"] }]);
  });

  it("labels the result of a lift reading a labeled value by an optional chain", async () => {
    expect(
      await declaredLabelsOfOut(
        'secret: Confidential<Secret, readonly ["topsecret"]> | undefined',
        'secret?.a ?? ""',
      ),
    ).toEqual([{ confidentiality: ["topsecret"] }]);
  });

  it("labels the result of a lift reading a labeled union with every member's confidentiality", async () => {
    const [label] = await declaredLabelsOfOut(
      'secret: Confidential<Either, ["outer"]>',
      "secret.a",
    );

    expect(new Set(label?.confidentiality as unknown[])).toEqual(
      new Set(["outer", "x", "y"]),
    );
  });

  it("labels the result of a lift reading a union under an empty label with each member's confidentiality", async () => {
    const [label] = await declaredLabelsOfOut(
      "secret: Confidential<Either, []>",
      "secret.a",
    );

    expect(new Set(label?.confidentiality as unknown[])).toEqual(
      new Set(["x", "y"]),
    );
  });

  it("labels the result of a lift reading a value by an optional chain with its declared policy", async () => {
    expect(
      await declaredLabelsOfOut(
        "secret: Confidential<Secret, [PolicyOf<typeof rules>]>",
        'secret?.a ?? ""',
      ),
    ).toMatchObject([{
      confidentiality: [{ policyRefKind: "module", symbol: "rules" }],
    }]);
  });

  it("labels the result of a lift reading an optional property with its declared policy", async () => {
    expect(
      await declaredLabelsOfOut(
        "secret?: Confidential<Secret, [PolicyOf<typeof rules>]>",
        'secret?.a ?? ""',
      ),
    ).toMatchObject([{
      confidentiality: [{ policyRefKind: "module", symbol: "rules" }],
    }]);
  });

  it("labels the result of a lift reading a value whole with its declared policy", async () => {
    expect(
      await declaredLabelsOfOut(
        "secret: Confidential<Secret, [PolicyOf<typeof rules>]>",
        'JSON.stringify(secret) ? secret.a : ""',
      ),
    ).toMatchObject([{
      confidentiality: [{ policyRefKind: "module", symbol: "rules" }],
    }]);
  });

  describe("a lift reading whole an optional value whose annotation writes a union", () => {
    const WHOLE = 'JSON.stringify(secret) ? secret?.a ?? "" : ""';
    const POLICY = [{
      confidentiality: [{ policyRefKind: "module", symbol: "rules" }],
    }];

    it("labels the result with a nullable value's declared policy", async () => {
      expect(
        await declaredLabelsOfOut(
          "secret?: Confidential<Secret, [PolicyOf<typeof rules>]> | null",
          WHOLE,
        ),
      ).toMatchObject(POLICY);
    });

    it("labels the result with the declared policy of each value the union holds", async () => {
      expect(
        await declaredLabelsOfOut(
          "secret?: Confidential<Secret, [PolicyOf<typeof rules>]> | Confidential<Other, [PolicyOf<typeof rules>]>",
          WHOLE,
        ),
      ).toMatchObject(POLICY);
    });

    it("labels the result with the declared policy of a value whose annotation writes `undefined`", async () => {
      expect(
        await declaredLabelsOfOut(
          "secret?: Confidential<Secret, [PolicyOf<typeof rules>]> | undefined",
          WHOLE,
        ),
      ).toMatchObject(POLICY);
    });
  });

  it("labels nothing for a lift reading an unlabeled value", async () => {
    expect(await declaredLabelsOfOut("secret: Secret", "secret.a")).toEqual(
      [],
    );
  });
});
