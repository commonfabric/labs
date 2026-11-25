import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import type {
  CfcFlowLabelsMode,
  ImplementationIdentity,
} from "../src/cfc/mod.ts";
import { buildCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("cfc transformed-by withdrawal");
const space = signer.did();

const MODULE = "sha256:ballot-module";

// Drops this policy's clause from a value `tally` of the policy's own module
// computed, and from nothing else.
const artifact = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: MODULE,
  symbol: "ballotRules",
  template: {
    templateVersion: 1,
    exchangeRules: [{
      name: "releaseTally",
      preCondition: {
        confidentiality: [{ thisPolicy: true }],
        integrity: [{
          type: CFC_ATOM_TYPE.TransformedBy,
          identity: {
            kind: "verified",
            moduleIdentity: { thisPolicyField: "moduleIdentity" },
            symbol: "tally",
          },
        }],
      },
      postCondition: { confidentiality: [], integrity: [] },
    }],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});

const briefSchema = {
  type: "object",
  properties: { vote: { type: "string" }, note: { type: "string" } },
  required: ["vote", "note"],
  ifc: {
    confidentiality: [{
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module",
      moduleIdentity: MODULE,
      symbol: "ballotRules",
      policyDigest: artifact.policyDigest,
      subject: { __ctOwningSpace: true },
    }],
  },
} as const satisfies JSONSchema;

const publicCountsSchema = {
  type: "object",
  properties: { approve: { type: "number" }, reject: { type: "number" } },
  ifc: { maxConfidentiality: [] },
} as const satisfies JSONSchema;

const publicTextSchema = {
  type: "string",
  ifc: { maxConfidentiality: [] },
} as const satisfies JSONSchema;

const verified = (moduleIdentity: string, symbol: string) =>
  ({
    kind: "verified",
    moduleIdentity,
    symbol,
    codeHash: `code:${symbol}`,
  }) satisfies ImplementationIdentity;

const TALLY = verified(MODULE, "tally");
const HAND_COUNT = verified(MODULE, "handCount");
const PUBLISH = verified("sha256:room-module", "publish");

type Counts = { approve: number; reject: number };

describe("TransformedBy withdrawal", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  const start = async (flowLabels: CfcFlowLabelsMode): Promise<void> => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // The counts documents stand in for a lift's result document, which
      // takes the join its lift wrote without declaring a ceiling for it.
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: flowLabels,
    });
    runtime.registerCfcPolicyManifests(space, [artifact]);
    const seed = runtime.edit();
    runtime.getCell(space, "brief", briefSchema, seed).set({
      vote: "approve",
      note: "secret-note",
    });
    expect((await seed.commit().settled).error).toBeUndefined();
  };

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  // A transaction under `identity` whose writes persist the flow join, as
  // every transaction of a runtime at the default flow-label dial does.
  const measuredEdit = (
    identity: ImplementationIdentity,
  ): IExtendedStorageTransaction => {
    const tx = runtime.edit();
    tx.setCfcFlowLabelsMode("persist");
    setCfcImplementationIdentity(tx, identity);
    return tx;
  };

  // The tally writes the whole object at once, so one derived value entry at
  // the root labels the object and everything under it.
  const tallyWholeObject = async (cause: string): Promise<void> => {
    const tx = measuredEdit(TALLY);
    const brief = runtime.getCell(space, "brief", briefSchema, tx).get();
    runtime.getCell<Counts>(space, cause, undefined, tx).set({
      approve: brief.vote === "approve" ? 1 : 0,
      reject: brief.vote === "reject" ? 1 : 0,
    });
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  // Copies the counts field by field into a public-only store, observing the
  // object node first the way a handler's argument proxy does; returns
  // whether the gated write committed.
  const publishCounts = async (cause: string): Promise<boolean> => {
    const tx = measuredEdit(PUBLISH);
    const counts = runtime.getCell<Counts>(space, cause, undefined, tx);
    counts.getRaw({ nonRecursive: true });
    const approve = counts.key("approve").get();
    const reject = counts.key("reject").get();
    runtime.getCell(space, `public-${cause}`, publicCountsSchema, tx).set({
      approve,
      reject,
    });
    return (await tx.commit().settled).error === undefined;
  };

  // Copies the object's key set, and nothing under it, into a public-only
  // store; returns whether the gated write committed.
  const publishKeys = async (cause: string): Promise<boolean> => {
    const tx = measuredEdit(PUBLISH);
    const node = runtime.getCell<Record<string, number>>(
      space,
      cause,
      undefined,
      tx,
    ).getRaw({ nonRecursive: true }) as Record<string, unknown>;
    runtime.getCell(space, `public-keys-${cause}`, publicTextSchema, tx).set(
      Object.keys(node).join(","),
    );
    return (await tx.commit().settled).error === undefined;
  };

  for (const flowLabels of ["observe", "off"] as const) {
    describe(`a writer whose flow-label dial is ${flowLabels}`, () => {
      beforeEach(() => start(flowLabels));

      // Writes one key of the counts under `identity` at the runtime's own
      // dial, which persists no flow join.
      const writeKeyAs = async (
        identity: ImplementationIdentity,
        cause: string,
        key: (note: string) => string,
      ): Promise<void> => {
        const tx = runtime.edit();
        setCfcImplementationIdentity(tx, identity);
        const brief = runtime.getCell(space, "brief", briefSchema, tx).get();
        runtime.getCell<Record<string, number>>(space, cause, undefined, tx)
          .key(key(brief.note)).set(2);
        expect((await tx.commit().settled).error).toBeUndefined();
      };

      it("leaves the named function's object releasable when it writes nothing", async () => {
        await tallyWholeObject("counts");
        expect(await publishCounts("counts")).toBe(true);
        expect(await publishKeys("counts")).toBe(true);
      });

      it("refuses an object another function has overwritten a field of", async () => {
        await tallyWholeObject("counts");
        await writeKeyAs(HAND_COUNT, "counts", () => "approve");
        expect(await publishCounts("counts")).toBe(false);
      });

      it("refuses the key set of an object another function added a key to", async () => {
        await tallyWholeObject("counts");
        await writeKeyAs(HAND_COUNT, "counts", (note) => note);
        expect(await publishKeys("counts")).toBe(false);
      });

      it("refuses the key set of an object a writer reading nothing added a key to", async () => {
        await tallyWholeObject("counts");
        const id = runtime.getCell(space, "counts", undefined, runtime.edit())
          .getAsNormalizedFullLink().id;
        const tx = runtime.edit();
        setCfcImplementationIdentity(tx, HAND_COUNT);
        tx.writeOrThrow({
          space,
          scope: "space",
          id,
          path: ["value", "added"],
        }, 2);
        expect((await tx.commit().settled).error).toBeUndefined();
        expect(await publishKeys("counts")).toBe(false);
      });

      // Only a writer that derives its join can show it is the function the
      // stamp names, so a dial that derives none withdraws the stamp of even
      // that function's own write.
      it(
        flowLabels === "observe"
          ? "releases an object after the named function writes a field again"
          : "refuses an object after even the named function writes a field again",
        async () => {
          await tallyWholeObject("counts");
          await writeKeyAs(TALLY, "counts", () => "approve");
          expect(await publishCounts("counts")).toBe(flowLabels === "observe");
        },
      );
    });
  }

  describe("a reference written at a field named `internal`", () => {
    beforeEach(() => start("persist"));

    // Reads the brief and stores a reference to it at `internal` of the counts
    // under `identity`.
    const linkInternalAs = async (
      identity: ImplementationIdentity,
      cause: string,
    ): Promise<void> => {
      const tx = measuredEdit(identity);
      const brief = runtime.getCell(space, "brief", briefSchema, tx);
      brief.get();
      const id = runtime.getCell(space, cause, undefined, tx)
        .getAsNormalizedFullLink().id;
      tx.writeOrThrow({
        space,
        scope: "space",
        id,
        path: ["value", "internal"],
      }, brief.getAsLink());
      expect((await tx.commit().settled).error).toBeUndefined();
    };

    it("leaves the key set releasable after the named function writes one", async () => {
      await tallyWholeObject("counts");
      await linkInternalAs(TALLY, "counts");
      expect(await publishKeys("counts")).toBe(true);
    });

    it("refuses the key set after another function writes one", async () => {
      await tallyWholeObject("counts");
      await linkInternalAs(HAND_COUNT, "counts");
      expect(await publishKeys("counts")).toBe(false);
    });
  });

  describe("a list container a reconcile declares", () => {
    beforeEach(() => start("persist"));

    const declareContainer = (tx: IExtendedStorageTransaction, id: string) =>
      tx.recordCfcStructureContainer({
        space,
        id: id as `${string}:${string}`,
        scope: "space",
        path: [],
      });

    // Under `identity`, reads the brief and stores a list holding a reference
    // to the element `member`, declaring it the way a list coordinator
    // declares its result; returns the list's id.
    const selectInto = async (
      identity: ImplementationIdentity,
      cause: string,
      member: string,
    ): Promise<string> => {
      const tx = measuredEdit(identity);
      runtime.getCell(space, "brief", briefSchema, tx).get();
      const list = runtime.getCell(space, cause, {
        type: "array",
        items: { asCell: ["cell"] },
      }, tx);
      list.set([runtime.getCell(space, member, undefined, tx)]);
      const id = list.getAsNormalizedFullLink().id;
      declareContainer(tx, id);
      expect((await tx.commit().settled).error).toBeUndefined();
      return id;
    };

    // Under `identity`, replaces the reference at the list's first slot with
    // one to the element `member`.
    const replaceFirstAs = async (
      identity: ImplementationIdentity,
      cause: string,
      member: string,
    ): Promise<void> => {
      const tx = measuredEdit(identity);
      runtime.getCell(space, "brief", briefSchema, tx).get();
      runtime.getCell(space, cause, {
        type: "array",
        items: { asCell: ["cell"] },
      }, tx).key(0).set(runtime.getCell(space, member, undefined, tx));
      expect((await tx.commit().settled).error).toBeUndefined();
    };

    // Under `identity`, reconciles the list without writing it: the
    // transaction reads the brief, declares the list again, and writes only
    // a document of its own.
    const reconcileAs = async (
      identity: ImplementationIdentity,
      listId: string,
    ): Promise<void> => {
      const tx = measuredEdit(identity);
      runtime.getCell(space, "brief", briefSchema, tx).get();
      runtime.getCell(space, "reconcile-status", undefined, tx).set("done");
      declareContainer(tx, listId);
      expect((await tx.commit().settled).error).toBeUndefined();
    };

    // Copies the element at the list's first slot into a public-only store;
    // returns whether the gated write committed.
    const publishFirst = async (cause: string): Promise<boolean> => {
      const tx = measuredEdit(PUBLISH);
      const first = runtime.getCell<string[]>(space, cause, {
        type: "array",
        items: { type: "string" },
      }, tx).key(0).get();
      runtime.getCell(space, `public-${cause}`, publicTextSchema, tx).set(
        String(first),
      );
      return (await tx.commit().settled).error === undefined;
    };

    // The elements carry label metadata, as every document a reference into
    // a labeled list names must, and no confidentiality of their own.
    const elementSchema = {
      type: "string",
      ifc: { integrity: ["element"] },
    } as const satisfies JSONSchema;

    beforeEach(async () => {
      const seed = runtime.edit();
      runtime.getCell(space, "chosen", elementSchema, seed).set("chosen");
      runtime.getCell(space, "planted", elementSchema, seed).set("planted");
      expect((await seed.commit().settled).error).toBeUndefined();
    });

    it("releases the list the named function selected", async () => {
      const listId = await selectInto(TALLY, "selected", "chosen");
      await reconcileAs(TALLY, listId);
      expect(await publishFirst("selected")).toBe(true);
    });

    it("refuses a list whose slot another function replaced", async () => {
      await selectInto(TALLY, "selected", "chosen");
      await replaceFirstAs(HAND_COUNT, "selected", "planted");
      expect(await publishFirst("selected")).toBe(false);
    });

    it("refuses a list whose slot another function replaced, after the named function reconciles it", async () => {
      const listId = await selectInto(TALLY, "selected", "chosen");
      await replaceFirstAs(HAND_COUNT, "selected", "planted");
      await reconcileAs(TALLY, listId);
      expect(await publishFirst("selected")).toBe(false);
    });

    // Setting the list decides every slot, even where the diff writes only
    // the slot that changed; writing one slot leaves the rest as another
    // writer left them.
    it("releases a list whose slot another function replaced, once the named function sets it again", async () => {
      await selectInto(TALLY, "selected", "chosen");
      await replaceFirstAs(HAND_COUNT, "selected", "planted");
      await selectInto(TALLY, "selected", "chosen");
      expect(await publishFirst("selected")).toBe(true);
    });

    it("refuses a list whose slot another function replaced, after the named function writes that slot again", async () => {
      await selectInto(TALLY, "selected", "chosen");
      await replaceFirstAs(HAND_COUNT, "selected", "planted");
      await replaceFirstAs(TALLY, "selected", "chosen");
      expect(await publishFirst("selected")).toBe(false);
    });
  });
});
