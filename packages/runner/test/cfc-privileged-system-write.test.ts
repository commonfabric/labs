import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { storedCfcMetadataAppliesToPath } from "../src/cfc/metadata.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { prepareAndCommit } from "./refused-commit.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-privileged-system-write",
);

// Audit S18: a write addressed directly at a document's ["cfc"] label-map path
// forges the CFC metadata that drives label derivation for OTHER writes,
// bypassing the commit-boundary derivation + mint-gating (S4) entirely. Only the
// runtime's own persistence (inside prepareBoundaryCommit's privileged scope)
// may write there; a non-privileged ["cfc"] write must fail closed in enforce
// mode and surface a diagnostic in observe. The forgery is the write PATH, not
// the hash: it names the backed seed document so the observe/disabled arms
// reach their commit outcome instead of refusing at the storage boundary for
// an unbacked schema reference.
const forgedMetadata = {
  version: 1,
  schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
  labelMap: {
    version: 1,
    entries: [{
      path: [],
      // The exact runtime-evidence atom the prompt-injection screen trusts.
      label: { integrity: [{ kind: "InjectionSafe" }] },
    }],
  },
};

describe("CFC privileged system write (S18)", () => {
  it("rejects a non-privileged ['cfc'] metadata write in enforce mode", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-forge-enforce",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      // Backed here too: the S18 gate must be the ONLY thing that can
      // reject this transaction, never the storage boundary's closure check.
      writeSeedEnvelopeDoc(tx, signer.did());
      // Forge the label map directly at the document's ["cfc"] path.
      tx.writeOrThrow({
        space: signer.did(),
        id,
        type: "application/json",
        path: ["cfc"],
      }, forgedMetadata);

      // Prepared, so the commit's rejection carries the S18 reason itself
      // rather than the generic relevant-but-unprepared guard.
      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(isCfcEnforcementRejection(result.error)).toBe(true);
      expect(String((result.error as Error).message)).toContain(
        "unprivileged write to protected runtime surface",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows the write but records a diagnostic in observe mode", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // Observe is the rung under test: `expect(result.ok).toBeDefined()`
      // reads that the forged write lands, and the diagnostics assertion
      // below reads the record it leaves instead of a rejection.
      cfcEnforcementMode: "observe",
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-forge-observe",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      writeSeedEnvelopeDoc(tx, signer.did());
      tx.writeOrThrow({
        space: signer.did(),
        id,
        type: "application/json",
        path: ["cfc"],
      }, forgedMetadata);

      const result = await tx.commit().settled;
      expect(result.ok).toBeDefined();
      expect(
        tx.getCfcState().diagnostics.some((d) =>
          d.toLowerCase().includes("unprivileged") && d.includes("cfc")
        ),
      ).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("exposes no privilege-escalation method on the transaction (S18 review)", async () => {
    // The reviewer's scenario: (cell.tx as any).runPrivilegedSystemWrite(() =>
    // cell.tx.writeOrThrow({ path: ["cfc"] }, forged)). The scope is now an
    // ECMAScript #private method, so no such property exists on the tx — and a
    // direct ["cfc"] write therefore still fails closed.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const escalate = (tx as unknown as Record<string, unknown>)
        .runPrivilegedSystemWrite;
      expect(escalate).toBeUndefined();
      // And nothing under the tx wrapper exposes it either.
      const inner = (tx as unknown as { tx?: Record<string, unknown> }).tx;
      expect(inner?.runPrivilegedSystemWrite).toBeUndefined();
      await tx.commit().settled;
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("permits the runtime's own label persistence (privileged) to commit", async () => {
    // A normal labeled write: the runtime derives + persists ["cfc"] metadata
    // inside prepareBoundaryCommit's privileged scope. This must NOT trip the
    // guard — i.e. legitimate CFC persistence still commits in enforce mode.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const guarded = internSchema(
        {
          type: "object",
          properties: {
            secret: { type: "string", ifc: { confidentiality: ["base"] } },
          },
          required: ["secret"],
        } satisfies JSONSchema,
        true,
      );
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "s18-legit-persist",
        guarded.schema,
        tx,
      );
      cell.set({ secret: "value" });
      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("records a ['cfc'] write made while disabled so a mid-tx escalation to enforce rejects", async () => {
    // setCfcEnforcementMode permits raising the mode mid-transaction
    // (disabled/observe impose no floor — audit S3), so a forged ["cfc"] write
    // performed in a disabled window must not survive a later escalation to
    // enforce. Like every other CFC signal, the write is recorded
    // unconditionally and only evaluated against the mode at prepare/commit
    // time.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // The disabled window is the subject. The transaction forges the label
      // map at this rung, and `unprivilegedSystemWrites.length` is asserted to
      // be 1 before the escalation below turns that record into a rejection.
      cfcEnforcementMode: "disabled",
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-forge-escalate",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      // Backed here too: the S18 gate must be the ONLY thing that can
      // reject this transaction, never the storage boundary's closure check.
      writeSeedEnvelopeDoc(tx, signer.did());
      // Forge the label map while the transaction is still disabled.
      tx.writeOrThrow({
        space: signer.did(),
        id,
        type: "application/json",
        path: ["cfc"],
      }, forgedMetadata);
      // The forgery is recorded even though enforcement is disabled.
      expect(tx.getCfcState().unprivilegedSystemWrites.length).toBe(1);

      tx.setCfcEnforcementMode("enforce-explicit");
      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(isCfcEnforcementRejection(result.error)).toBe(true);
      expect(String((result.error as Error).message)).toContain(
        "unprivileged write to protected runtime surface",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("still commits a never-escalated transaction under disabled mode", async () => {
    // `disabled` leaves CFC inert end-to-end: the forged write is recorded
    // (see above) but prepareBoundaryCommit never runs for a transaction whose
    // mode is still disabled at commit, so nothing turns the record into a
    // rejection.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // The disabled rung is the subject. The transaction stays at it through
      // commit, and `expect(result.ok).toBeDefined()` reads that the forged
      // write commits.
      cfcEnforcementMode: "disabled",
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-forge-disabled",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      writeSeedEnvelopeDoc(tx, signer.did());
      tx.writeOrThrow({
        space: signer.did(),
        id,
        type: "application/json",
        path: ["cfc"],
      }, forgedMetadata);

      const result = await tx.commit().settled;
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not gate value-path writes", async () => {
    // The Cell API writes value paths, never the document ["cfc"] field, so
    // ordinary pattern writes are unaffected.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const plain = runtime.getCell<{ note: string }>(
        signer.did(),
        "s18-plain-value",
        undefined,
        tx,
      );
      plain.set({ note: "hello" });
      const result = await tx.commit().settled;
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("gates a path-[] full-document write that mints a label map", async () => {
    // A path-[] write replaces the whole envelope, so an envelope carrying a
    // `cfc` record of the writer's own installs a label map the derivation
    // pass never derived, with the address never naming ["cfc"]. This case
    // mints onto a document that stored no map; the case further down
    // substitutes one for another. Both are recorded like a write that names
    // the path.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-root-mint",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      writeSeedEnvelopeDoc(tx, signer.did());
      tx.writeOrThrow({
        space: signer.did(),
        id,
        type: "application/json" as const,
        path: [],
      }, { value: { note: "one" }, cfc: forgedMetadata });
      expect(tx.getCfcState().unprivilegedSystemWrites).toEqual([`${id}/cfc`]);
      expect(tx.getCfcState().diagnostics).toContain(
        "unprivileged-cfc-forgery",
      );

      const result = await tx.commit().settled;
      expect(result.error).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  //
  // Root envelope writes and the stored label map
  //
  // A path-[] whole-document write replaces every sibling of `value`, the
  // ["cfc"] label map included. An envelope that omits `cfc` therefore erases
  // the stored map, and the document that carried confidentiality reads
  // afterwards as carrying none. That is the S18 downgrade spelled as an
  // omission rather than as an overwrite, so it is recorded as the same class
  // of unprivileged label-map write. The cases below cover the erasure, the
  // shapes that erase nothing, and the runtime's own exempt persistence.
  //

  const storedMetadata = {
    version: 1,
    schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
    labelMap: {
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: ["secret"] },
      }],
    },
  };

  const seedLabeledDocument = async (
    runtime: Runtime,
    name: string,
  ): Promise<{
    space: ReturnType<typeof signer.did>;
    id: URI;
    type: "application/json";
    path: string[];
  }> => {
    const seed = runtime.edit();
    const target = runtime.getCell(signer.did(), name, undefined, seed);
    const address = {
      space: signer.did(),
      id: target.getAsNormalizedFullLink().id as URI,
      type: "application/json" as const,
      path: [] as string[],
    };
    // The commit boundary validates a metadata `schemaHash` like any other
    // schema reference, so the seed names the backed seed document and
    // installs it in the same transaction.
    writeSeedEnvelopeDoc(seed, signer.did());
    seedStoredEnvelope(seed, address, {
      value: { note: "one" },
      cfc: storedMetadata,
    });
    const seedResult = await seed.commit().settled;
    expect(seedResult.ok).toBeDefined();
    return address;
  };

  it("rejects a root envelope write that erases a stored label map", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const address = await seedLabeledDocument(runtime, "s18-root-erase");

      const tx = runtime.edit();
      tx.writeOrThrow(address, { value: { note: "two" } });
      expect(tx.getCfcState().unprivilegedSystemWrites).toEqual([
        `${address.id}/cfc`,
      ]);

      const { reasons, result } = await prepareAndCommit(tx);
      expect(reasons).toContain(
        `unprivileged write to protected runtime surface ${address.id}/cfc`,
      );
      expect(result.error?.name).toBe("CfcCommitRefusalError");

      // The stored label map survives the refused commit.
      const after = runtime.edit();
      expect(after.readOrThrow({ ...address, path: ["cfc"] })).toEqual(
        storedMetadata,
      );
      await after.commit().settled;
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("gates a loaded writer stripping a live label map to an empty one", async () => {
    // The substituting half of the same forgery. A writer holding the
    // document strips every label by replacing the stored map with a
    // well-formed one carrying no entries. The `cfc` member is present either
    // way, so an omission test sees nothing; what is recorded is that the map
    // left behind is not the map that was stored.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const address = await seedLabeledDocument(runtime, "s18-root-strip");
      const target = {
        space: signer.did(),
        id: address.id,
        scope: "space",
        path: [],
      } as const;

      const before = runtime.edit();
      expect(storedCfcMetadataAppliesToPath(before, target)).toBe(true);
      await before.commit().settled;

      const tx = runtime.edit();
      const envelope = tx.readOrThrow(address) as Record<string, unknown>;
      expect(envelope.cfc).toBeDefined();
      tx.writeOrThrow(address, {
        ...envelope,
        value: { note: "stripped" },
        cfc: { ...storedMetadata, labelMap: { version: 1, entries: [] } },
      });
      expect(tx.getCfcState().unprivilegedSystemWrites).toEqual([
        `${address.id}/cfc`,
      ]);
      expect(tx.getCfcState().diagnostics).toContain(
        "unprivileged-cfc-forgery",
      );
      expect((await tx.commit().settled).error).toBeDefined();

      // The stored label map survives the refused commit.
      const after = runtime.edit();
      expect(storedCfcMetadataAppliesToPath(after, target)).toBe(true);
      await after.commit().settled;
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not gate a root envelope write on a document with no stored label map", async () => {
    // Creating a document, and replacing one that never carried a label map,
    // erase nothing — the ordinary seeding shape stays ungated.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-root-unlabeled",
        undefined,
        tx,
      );
      const address = {
        space: signer.did(),
        id: target.getAsNormalizedFullLink().id as URI,
        type: "application/json" as const,
        path: [] as string[],
      };
      tx.writeOrThrow(address, { value: { note: "one" } });
      tx.writeOrThrow(address, { value: { note: "two" } });
      expect(tx.getCfcState().unprivilegedSystemWrites.length).toBe(0);

      const result = await tx.commit().settled;
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("gates a rebuilt envelope whose labels work out the same", async () => {
    // What a whole-document write owes the sibling is the value the document
    // holds. An OR clause listing the same alternatives in another order
    // names the same label, and the envelope around it is still one this
    // writer composed rather than the one it read, so it records. The rule
    // holds at the value, which is the one answer that fits every spelling a
    // stored envelope takes.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const seed = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-root-reorder",
        undefined,
        seed,
      );
      const address = {
        space: signer.did(),
        id: target.getAsNormalizedFullLink().id as URI,
        type: "application/json" as const,
        path: [] as string[],
      };
      writeSeedEnvelopeDoc(seed, signer.did());
      const entry = (...anyOf: string[]) => ({
        path: [] as string[],
        label: { confidentiality: [{ anyOf }] },
      });
      seedStoredEnvelope(seed, address, {
        value: { note: "one" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: { version: 1, entries: [entry("alpha", "beta")] },
        },
      });
      expect((await seed.commit().settled).ok).toBeDefined();

      const tx = runtime.edit();
      tx.writeOrThrow(address, {
        value: { note: "two" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: { version: 1, entries: [entry("beta", "alpha")] },
        },
      });
      expect(tx.getCfcState().unprivilegedSystemWrites).toEqual([
        `${address.id}/cfc`,
      ]);
      expect(tx.getCfcState().diagnostics).toContain(
        "unprivileged-cfc-forgery",
      );
      expect((await tx.commit().settled).error).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not gate a root envelope write that carries the stored label map forward", async () => {
    // Spreading the read envelope, the way ACLManager does, keeps `cfc` in
    // place. That write is not an erasure and stays ungated.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const address = await seedLabeledDocument(runtime, "s18-root-preserve");

      const tx = runtime.edit();
      const envelope = tx.readOrThrow(address) as Record<string, unknown>;
      tx.writeOrThrow(address, { ...envelope, value: { note: "two" } });
      expect(tx.getCfcState().unprivilegedSystemWrites.length).toBe(0);

      const result = await tx.commit().settled;
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a root envelope whose cfc member a reader reports as absent", async () => {
    // Carrying the key is not carrying the map. `cfc: null` — and every other
    // value `readStoredCfcMetadata` reports as absent — leaves the document
    // reading as an unlabeled one, so it erases the stored map exactly as an
    // envelope with no `cfc` member does. The shapes here are the ones the
    // prepare pass can also read; the case below takes the one it cannot.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      for (
        const [name, malformed] of [
          ["s18-root-null", null],
          ["s18-root-scalar", "not-an-envelope"],
        ] as const
      ) {
        const address = await seedLabeledDocument(runtime, name);
        const tx = runtime.edit();
        tx.writeOrThrow(address, { value: { note: "two" }, cfc: malformed });
        expect(tx.getCfcState().unprivilegedSystemWrites).toEqual([
          `${address.id}/cfc`,
        ]);
        const { reasons, result } = await prepareAndCommit(tx);
        expect(reasons).toContain(
          `unprivileged write to protected runtime surface ${address.id}/cfc`,
        );
        expect(result.error?.name).toBe("CfcCommitRefusalError");
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("refuses the commit as a preparation crash when the stored `cfc` member cannot be walked", async () => {
    // A record at the reserved position with no `version` is one no reader
    // can produce labels from. It is not the stored map either, so the S18
    // arm records the substitution. Prepare then reads the same member and
    // crashes on it, and that crash replaces every reason the pass had
    // collected, the S18 verdict among them. `CommitPreparationError` is not
    // a terminal rejection, so the scheduler spends its bounded retry budget
    // on a commit that refuses identically every time, where the verdict it
    // discarded would have stopped at the first attempt.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const address = await seedLabeledDocument(
        runtime,
        "s18-root-versionless",
      );
      const tx = runtime.edit();
      tx.writeOrThrow(address, {
        value: { note: "two" },
        cfc: { labelMap: { version: 1, entries: [] } },
      });
      expect(tx.getCfcState().unprivilegedSystemWrites).toEqual([
        `${address.id}/cfc`,
      ]);

      const { reasons, result } = await prepareAndCommit(tx);
      expect(reasons.join(" ")).toContain(
        "carries no label map this build can read",
      );
      expect(reasons.join(" ")).not.toContain(
        "unprivileged write to protected runtime surface",
      );
      expect(result.error?.name).toBe("CommitPreparationError");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("records a root envelope carrying a label map this build cannot read as a forgery", async () => {
    // An envelope whose `version` this build does not interpret is not an
    // erasure: the reader throws on it and every consumer fails closed, so the
    // document it leaves behind is not an unlabeled one. It is still not the
    // map that was stored, so it is recorded, and the diagnostic says which of
    // the two it was.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const address = await seedLabeledDocument(runtime, "s18-root-future");
      const tx = runtime.edit();
      tx.writeOrThrow(address, {
        value: { note: "two" },
        cfc: { ...storedMetadata, version: 99 },
      });
      expect(tx.getCfcState().diagnostics).toContain(
        "unprivileged-cfc-forgery",
      );
      expect(tx.getCfcState().diagnostics).not.toContain(
        "unprivileged-cfc-erasure",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("diagnoses a label-map erasure in observe mode", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // Observe is the rung under test: `expect(result.ok).toBeDefined()`
      // reads that the erasing write lands, and the diagnostics assertion
      // below reads the record it leaves instead of a rejection.
      cfcEnforcementMode: "observe",
    });
    try {
      const address = await seedLabeledDocument(runtime, "s18-root-observe");

      const tx = runtime.edit();
      tx.writeOrThrow(address, { value: { note: "two" } });
      const result = await tx.commit().settled;
      expect(result.ok).toBeDefined();
      expect(
        tx.getCfcState().diagnostics.some((d) =>
          d.toLowerCase().includes("unprivileged") && d.includes("cfc")
        ),
      ).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("records a label-map erasure made while disabled so a mid-tx escalation rejects", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // The disabled window is the subject. The erasing write happens at this
      // rung, and `unprivilegedSystemWrites.length` is asserted to be 1 before
      // the escalation below turns that record into a rejection.
      cfcEnforcementMode: "disabled",
    });
    try {
      const address = await seedLabeledDocument(runtime, "s18-root-escalate");

      const tx = runtime.edit();
      tx.writeOrThrow(address, { value: { note: "two" } });
      expect(tx.getCfcState().unprivilegedSystemWrites.length).toBe(1);

      tx.setCfcEnforcementMode("enforce-explicit");
      const { reasons, result } = await prepareAndCommit(tx);
      expect(reasons).toContain(
        `unprivileged write to protected runtime surface ${address.id}/cfc`,
      );
      expect(result.error?.name).toBe("CfcCommitRefusalError");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("diagnoses a forged label map in observe mode", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
    });
    try {
      const address = await seedLabeledDocument(runtime, "s18-forge-observe");

      const tx = runtime.edit();
      tx.writeOrThrow(address, {
        value: { note: "two" },
        cfc: forgedMetadata,
      });
      expect((await tx.commit().settled).ok).toBeDefined();
      expect(tx.getCfcState().diagnostics).toContain(
        `unprivileged write to protected runtime surface ${address.id}/cfc`,
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("records a forged label map written while disabled so a mid-tx escalation rejects", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    try {
      const address = await seedLabeledDocument(runtime, "s18-forge-escalate");

      const tx = runtime.edit();
      tx.writeOrThrow(address, {
        value: { note: "two" },
        cfc: forgedMetadata,
      });
      expect(tx.getCfcState().unprivilegedSystemWrites).toEqual([
        `${address.id}/cfc`,
      ]);
      tx.setCfcEnforcementMode("enforce-explicit");
      expect((await tx.commit().settled).error).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("gates a write addressed at the ['source'] sibling", async () => {
    // `source` is the other reserved sibling. The prepare pass leaves it out
    // of schema write policy and out of the flow join, on the strength of the
    // runtime being its only writer, so a write reaching it from outside the
    // privileged scope is recorded like a label-map write.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-source-path",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      tx.writeOrThrow(
        {
          space: signer.did(),
          id,
          type: "application/json" as const,
          path: ["source"],
        },
        { note: "smuggled" } as never,
      );
      expect(tx.getCfcState().unprivilegedSystemWrites).toEqual([
        `${id}/source`,
      ]);
      expect(tx.getCfcState().diagnostics).toContain(
        "unprivileged-source-write",
      );
      expect((await tx.commit().settled).error).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("gates a path-[] write whose envelope carries a ['source'] sibling", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-source-envelope",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      tx.writeOrThrow(
        {
          space: signer.did(),
          id,
          type: "application/json" as const,
          path: [],
        },
        { value: { note: "one" }, source: { note: "smuggled" } } as never,
      );
      expect(tx.getCfcState().unprivilegedSystemWrites).toEqual([
        `${id}/source`,
      ]);
      expect(tx.getCfcState().diagnostics).toContain(
        "unprivileged-source-forgery",
      );
      expect((await tx.commit().settled).error).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not gate a path-[] write made inside the privileged scope", async () => {
    // The one route a fixture has. `seedStoredEnvelope` runs the write inside
    // the privileged persistence scope, reached through the transaction's
    // `accessForTestingOnly` getter, so a seed lands the label state a test
    // needs without being recorded as the forgery it resembles.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-root-seed",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredEnvelope(tx, {
        space: signer.did(),
        id,
        type: "application/json" as const,
        path: [],
      }, { value: { note: "one" }, cfc: forgedMetadata });
      expect(tx.getCfcState().unprivilegedSystemWrites).toEqual([]);
      expect((await tx.commit().settled).ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("accepts no write option as authorization", async () => {
    // The guard has no options-carried key, so a caller cannot reach past it
    // by supplying one. Every write option below — a plain flag, a registered
    // symbol, and a fresh one — leaves the write recorded. Reintroducing an
    // options-carried bypass fails here.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const tx = runtime.edit();
      writeSeedEnvelopeDoc(tx, signer.did());
      const lookalikes = [
        { "reserved-sibling-write": true },
        { [Symbol.for("reserved-sibling-write")]: true },
        { [Symbol("privileged")]: true },
      ];
      // One document apiece: a second write of the same envelope over the
      // first one's result changes nothing, and would be left alone for that
      // reason rather than for anything to do with the options it carried.
      const ids = lookalikes.map((_, index) =>
        runtime.getCell(
          signer.did(),
          `s18-root-no-option-${index}`,
          undefined,
          tx,
        ).getAsNormalizedFullLink().id as URI
      );
      lookalikes.forEach((options, index) => {
        tx.writeOrThrow(
          {
            space: signer.did(),
            id: ids[index],
            type: "application/json" as const,
            path: [],
          },
          { value: { note: "one" }, cfc: forgedMetadata },
          options as never,
        );
      });
      expect(tx.getCfcState().unprivilegedSystemWrites).toEqual(
        ids.map((id) => `${id}/cfc`),
      );
      expect((await tx.commit().settled).error).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("permits the runtime's own privileged root write over a labeled document", async () => {
    // The privileged scope is exempt, so the runtime's own persistence still
    // replaces an envelope wholesale without tripping the erasure arm.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const guarded = internSchema(
        {
          type: "object",
          properties: {
            secret: { type: "string", ifc: { confidentiality: ["base"] } },
          },
          required: ["secret"],
        } satisfies JSONSchema,
        true,
      );
      const first = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "s18-root-privileged",
        guarded.schema,
        first,
      );
      cell.set({ secret: "one" });
      first.prepareCfc();
      expect((await first.commit().settled).ok).toBeDefined();

      // The label persistence stored a map; a second labeled write reruns the
      // whole privileged persistence pass over the same document.
      const second = runtime.edit();
      const again = runtime.getCell(
        signer.did(),
        "s18-root-privileged",
        guarded.schema,
        second,
      );
      again.set({ secret: "two" });
      second.prepareCfc();
      expect((await second.commit().settled).ok).toBeDefined();

      const after = runtime.edit();
      expect(
        after.readOrThrow({
          space: signer.did(),
          id: again.getAsNormalizedFullLink().id as URI,
          type: "application/json",
          path: ["cfc"],
        }),
      ).toBeDefined();
      await after.commit().settled;
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not reach a writer whose transaction never loaded the document", async () => {
    // The bound on the arm above, pinned rather than described. The stored
    // half reads through the writing transaction, and a transaction whose
    // view does not hold the document answers the same "no map here" a
    // document with no map answers. So a writer that simply does not sync
    // first erases the map and commits: no race, the map present throughout.
    //
    // What the arm establishes is therefore narrower than "a root envelope
    // write cannot erase a stored label map" — it is that such a write cannot
    // erase a label map THIS TRANSACTION HAS LOADED. Closing the rest means
    // either forcing the document into view before deciding, which turns
    // every blind root write into a read-modify-write, or making the commit
    // boundary establish what the space holds. Both are open design choices,
    // and this test fails when either lands, which is the point of it.
    const server: MemoryV2Server.Server = await newSharedServer();
    const space = signer.did();
    let id: URI;
    try {
      {
        const storage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const runtime = new Runtime({
          apiUrl: new URL("https://example.com"),
          storageManager: storage,
        });
        try {
          const seed = runtime.edit();
          const cell = runtime.getCell(space, "s18-unloaded", undefined, seed);
          id = cell.getAsNormalizedFullLink().id as URI;
          writeSeedEnvelopeDoc(seed, space);
          seedStoredEnvelope(seed, {
            space,
            id,
            type: "application/json",
            path: [],
          }, { value: { note: "one" }, cfc: storedMetadata });
          expect((await seed.commit().settled).ok).toBeDefined();
          await storage.synced();
        } finally {
          await runtime.dispose();
          await storage.close();
        }
      }

      // A session that has never synced the document, writing the whole
      // envelope with no `cfc`.
      {
        const storage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const runtime = new Runtime({
          apiUrl: new URL("https://example.com"),
          storageManager: storage,
        });
        try {
          const tx = runtime.edit();
          tx.writeOrThrow({
            space,
            id: id!,
            type: "application/json",
            path: [],
          }, { value: { note: "erased" } });
          expect(tx.getCfcState().unprivilegedSystemWrites).toEqual([]);
          expect((await tx.commit().settled).ok).toBeDefined();
          await storage.synced();
        } finally {
          await runtime.dispose();
          await storage.close();
        }
      }

      // The stored label map is gone from the durable document.
      {
        const storage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const runtime = new Runtime({
          apiUrl: new URL("https://example.com"),
          storageManager: storage,
        });
        try {
          const cell = runtime.getCell(space, "s18-unloaded", undefined);
          await cell.sync();
          const tx = runtime.edit();
          expect(tx.readOrThrow({
            space,
            id: id!,
            type: "application/json",
            path: [],
          })).toEqual({ value: { note: "erased" } });
          await tx.commit().settled;
        } finally {
          await runtime.dispose();
          await storage.close();
        }
      }
    } finally {
      await server.close?.();
    }
  });
});
