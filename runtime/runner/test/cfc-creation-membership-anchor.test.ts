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

const signer = await Identity.fromPassphrase("runner-cfc-creation-anchor");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
  observes?: string;
};

describe("CFC: creation anchors membership at the canonical container path", () => {
  // A document-creating write lands at the RAW document root: writeOrThrow's
  // missing-doc retry constructs the envelope `{value: ...}` and writes it at
  // storage path []. `valueWriteTargets` canonicalizes the write PATH but used
  // to keep the RAW envelope as the written value, so the pure-link container
  // walk descended through the `value` wrapper key and emitted raw-projected
  // container paths — the membership stamp (origin:"structure",
  // observes:"enumerate") then persisted anchored at ["value"] instead of the
  // canonical container path []. Consumption compares stored anchors against
  // canonical read paths, so nothing at the canonical path consumed the
  // membership label until the next write's carry-forward re-anchored it; the
  // window was only masked by the co-minted frozen existence entry carrying
  // the same creating join. These tests pin the canonical anchoring at
  // creation itself.

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
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
    seedStoredEnvelope(seed, {
      space,
      scope: "space",
      id,
      path: [],
    }, {
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
    return replica!.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  const createList = async (): Promise<string> => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // `entriesOf` reads the label map the replica stores, and flow labels
      // reach storage at "persist".
      cfcFlowLabels: "persist",
    });

    await seedLabeledDoc(runtime, "anchor-el-0", { n: 1 }, "alice-secret");
    await seedLabeledDoc(runtime, "anchor-el-1", { n: 2 }, "bob-secret");

    const listSchema = {
      type: "array",
      items: { asCell: ["cell"] },
    } as const;

    // The creating transaction: a content read (alice joins the flow join)
    // plus the pure-link array write that creates the list document.
    const setup = runtime.edit();
    const el0 = runtime.getCell(space, "anchor-el-0", undefined, setup);
    const el1 = runtime.getCell(space, "anchor-el-1", undefined, setup);
    el0.get();
    const listCell = runtime.getCell(space, "anchor-list", listSchema, setup);
    listCell.set([el0, el1]);
    runtime.prepareTxForCommit(setup);
    expect((await setup.commit().settled).ok).toBeDefined();
    return listCell.getAsNormalizedFullLink().id;
  };

  it("mints the structure/enumerate membership entry at [] in the creating tx", async () => {
    const listId = await createList();

    // The membership stamp must anchor at the canonical container path
    // immediately after the creating commit — not at the raw storage
    // projection ["value"], which no canonical-path read would consume.
    const membership = entriesOf(listId).filter((e) =>
      e.origin === "structure" && e.observes === "enumerate"
    );
    expect(membership.map((e) => e.path)).toEqual([[]]);
    expect(membership[0].label.confidentiality).toEqual(["alice-secret"]);

    // The general form of the same invariant: no persisted entry may sit at
    // a raw storage path. A leading "value" segment in a stored anchor is
    // the raw document projection leaking into logical space (a user field
    // actually named "value" would live at raw ["value","value"] and
    // canonicalize to logical ["value"] — stored anchors here come from
    // canonical mint paths, so a leading "value" can only be the leak).
    expect(
      entriesOf(listId).filter((e) => e.path[0] === "value"),
    ).toEqual([]);
  });

  it("a shape read at the canonical container path consumes the creating join", async () => {
    const listId = await createList();

    // The reader's output document declares the confidentiality it is about
    // to receive, so the stamped write fits the ceiling its label map states.
    await seedLabeledDoc(
      runtime!,
      "anchor-out",
      { copied: false },
      "alice-secret",
    );

    // A nonRecursive (shape) read at the container observes membership and
    // existence: the creating join must arrive in the reader's flow join
    // and stamp its output. (During the mis-anchored window this held only
    // by coincidence — the frozen existence entry carried the same atoms —
    // so this is the consumption guard for the canonical anchoring above.)
    const readTx = runtime!.edit();
    readTx.readOrThrow({
      space,
      scope: "space",
      id: listId as `${string}:${string}`,
      type: "application/json",
      path: ["value"],
    }, { nonRecursive: true });
    const out = runtime!.getCell(space, "anchor-out", undefined, readTx);
    out.set({ copied: true });
    runtime!.prepareTxForCommit(readTx);
    expect((await readTx.commit().settled).ok).toBeDefined();

    const outDerived = entriesOf(out.getAsNormalizedFullLink().id).find((e) =>
      e.origin === "derived" && e.observes === "value"
    );
    expect(outDerived?.label.confidentiality).toEqual(["alice-secret"]);
  });
});
