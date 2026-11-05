import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-resume-membership");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
  observes?: string;
};

const RESULT_CAUSE = "cfc-resume-membership result cell";
const LIST_CAUSE = "cfc-resume-membership list";

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { n: number }[] }>(({ items }) => {",
      "  return { kept: items.filter((item) => item.n > 0) };",
      "});",
    ].join("\n"),
  }],
};

describe("CFC resume membership taint", () => {
  // The resume-time twin of "filter: structure label re-stamps from J when the
  // list grows" in cfc-flow-pointwise.test.ts. There the list grows while the
  // coordinator is live; here it grows while nothing is running, so the taint
  // has to reach the container's shape across a cold resume.
  //
  // What carries the taint across the resume is the coordinator's declaration
  // of its result container, which every reconcile makes at the top of its run,
  // before any of that reconcile's early returns. The resume publishes the
  // rebuilt aggregate from a separate transaction that makes no such
  // declaration, so the label depends on a reconcile running afterwards — which
  // one does, because the element results that drive the rebuild also
  // invalidate the reconcile. This test pins the outcome, so a change to either
  // half is caught here rather than in a space with real labels.

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;

  afterEach(async () => {
    await storageManager?.close();
    storageManager = undefined;
  });

  const newRuntime = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageManager!,
      // Persisting flow labels is what writes the structure stamp this test
      // reads back through `structureConfidentiality`.
      cfcFlowLabels: "persist",
    });

  const seedLabeledDoc = async (
    rt: Runtime,
    cause: string,
    value: FabricValue,
    atom: string,
  ): Promise<string> => {
    const seed = rt.edit();
    const cell = rt.getCell(space, cause, undefined, seed);
    const id = cell.getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: [atom] } }],
        },
      },
    });
    rt.prepareTxForCommit(seed);
    expect((await seed.commit().settled).ok).toBeDefined();
    return id;
  };

  const entriesOf = (id: string): StoredEntry[] => {
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  // `kept` is a link to the coordinator's result container; the container's own
  // document is what carries the structure label.
  const resolvedContainerId = (rt: Runtime, keptCell: any): string => {
    const rtx = rt.edit();
    const id =
      keptCell.withTx(rtx).resolveAsCell().getAsNormalizedFullLink().id;
    rt.prepareTxForCommit(rtx);
    rtx.commit();
    return id;
  };

  const structureConfidentiality = (id: string): string[] =>
    entriesOf(id)
      .filter((e) => e.origin === "structure" && e.path.length === 0)
      .flatMap((e) => e.label.confidentiality ?? []);

  it("carries a late element's secret into the resumed result's shape", async () => {
    storageManager = StorageManager.emulate({ as: signer });

    // SESSION 1: build the filtered list over two labeled elements.
    const rt1 = newRuntime();
    await seedLabeledDoc(rt1, "memb-el-0", { n: 1 }, "alice-secret");
    await seedLabeledDoc(rt1, "memb-el-1", { n: 2 }, "bob-secret");

    const compiled = await rt1.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const tx0 = rt1.edit();
    const el0 = rt1.getCell(space, "memb-el-0", undefined, tx0);
    const el1 = rt1.getCell(space, "memb-el-1", undefined, tx0);
    const listCell = rt1.getCell(
      space,
      LIST_CAUSE,
      { type: "array", items: { asCell: ["cell"] } },
      tx0,
    );
    listCell.set([el0, el1]);
    const rc1 = rt1.getCell<Record<string, unknown>>(
      space,
      RESULT_CAUSE,
      compiled.resultSchema,
      tx0,
    );
    rt1.run(tx0, compiled, { items: listCell }, rc1);
    rt1.prepareTxForCommit(tx0);
    expect((await tx0.commit().settled).ok).toBeDefined();
    await rc1.pull();
    await rt1.settled();
    await rt1.patternManager.flushCompileCacheWrites();
    await storageManager.synced();

    const keptId = resolvedContainerId(rt1, rc1.key("kept"));
    expect(
      ((rc1.key("kept") as any).getAsQueryResult() as unknown[]).length,
    ).toBe(2);

    const builtStructure = structureConfidentiality(keptId);
    expect(builtStructure).toContainEqual("alice-secret");
    expect(builtStructure).toContainEqual("bob-secret");
    // The third element's secret cannot be in the stamp yet: it does not exist.
    expect(builtStructure).not.toContainEqual("carol-secret");

    await rt1.dispose({ closeStorage: false });

    // BETWEEN SESSIONS: a third labeled element is appended to the input list
    // while no coordinator is running, the way another replica's write lands
    // while this one is down.
    // The element is EXCLUDED by the predicate, so the aggregate's value comes
    // out identical to the durable one. Its absence is what carries the secret:
    // the membership decision read carol's document to reach it.
    const rtMid = newRuntime();
    await seedLabeledDoc(rtMid, "memb-el-2", { n: -1 }, "carol-secret");
    const txMid = rtMid.edit();
    const listMid = rtMid.getCell(
      space,
      LIST_CAUSE,
      { type: "array", items: { asCell: ["cell"] } },
      txMid,
    );
    // Each element is named by its cause, so this write states the whole
    // membership. The labels the stored list carries reach nothing in this
    // transaction.
    listMid.set([
      rtMid.getCell(space, "memb-el-0", undefined, txMid),
      rtMid.getCell(space, "memb-el-1", undefined, txMid),
      rtMid.getCell(space, "memb-el-2", undefined, txMid),
    ]);
    rtMid.prepareTxForCommit(txMid);
    expect((await txMid.commit().settled).ok).toBeDefined();
    await storageManager.synced();
    await rtMid.dispose({ closeStorage: false });

    // SESSION 2: cold resume. The durable aggregate is the two-element list
    // from session 1; the input now has three. Membership is decided again,
    // and that decision reads the third element's predicate result.
    const rt2 = newRuntime();
    try {
      const tx2 = rt2.edit();
      const rc2 = rt2.getCell<Record<string, unknown>>(
        space,
        RESULT_CAUSE,
        compiled.resultSchema,
        tx2,
      );
      rt2.prepareTxForCommit(tx2);
      expect((await tx2.commit().settled).ok).toBeDefined();
      await rc2.sync();
      expect(await rt2.start(rc2)).toBe(true);
      await rc2.pull();
      await rt2.settled();

      // The value is unchanged — carol was filtered out — so nothing about the
      // aggregate's contents signals that a decision was made about her.
      expect(
        ((rc2.key("kept") as any).getAsQueryResult() as unknown[]).length,
      ).toBe(2);

      // The resumed shape was decided by all three predicate results, so the
      // container's structure label must carry all three secrets.
      const resumedStructure = structureConfidentiality(keptId);
      expect(resumedStructure).toContainEqual("alice-secret");
      expect(resumedStructure).toContainEqual("bob-secret");
      expect(resumedStructure).toContainEqual("carol-secret");
    } finally {
      await rt2.dispose({ closeStorage: false });
    }
  });
});
