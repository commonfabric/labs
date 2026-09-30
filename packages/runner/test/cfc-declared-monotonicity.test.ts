import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import type { JSONSchema } from "../src/builder/types.ts";
import { stampExternalIngest } from "../src/cfc/external-ingest.ts";
import {
  cfcCanonicalClauseDigest,
  type CfcConfClause,
  type CfcDeclaredMonotonicityMode,
  collectDeclaredMonotonicityViolations,
} from "../src/cfc/mod.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  setCfcImplementationIdentity,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
import { seedStoredEnvelope } from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runner-cfc-declared-mono");

// WP5 (docs/specs/cfc-persisted-declassification.md §4 item 3, §5; spec
// §8.12.1/§8.12.8): the declared-component monotonicity gate. The declared
// (store-policy) component of a persisted path's label map evolves only
// through the schema-walk re-mint in prepare.ts; §8.12.1's
// `canUpdateStoreLabel` (confidentiality may only add clauses or remove
// alternatives; the integrity claim may only remove atoms) had no runtime
// check — the "never an ordinary write" clause of §8.12.7 route 2b was
// unenforced prose. This suite first PINS current behavior (the
// characterization block — the off/observe byte-compat contract), then
// specifies the gate behind `cfcDeclaredMonotonicity: off | observe |
// enforce` (default off).

const CLAUSE_A = "clause-a";
const CLAUSE_B = "clause-b";
const ATOM_X = "integrity-x";
const ATOM_Y = "integrity-y";

const SCHEMA_TWO_CLAUSES = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { confidentiality: [CLAUSE_A, CLAUSE_B] } },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const SCHEMA_ONE_CLAUSE = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { confidentiality: [CLAUSE_A] } },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const SCHEMA_OR_CLAUSE = {
  type: "object",
  properties: {
    out: {
      type: "string",
      ifc: { confidentiality: [{ anyOf: [CLAUSE_A, CLAUSE_B] }] },
    },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const SCHEMA_NO_IFC = {
  type: "object",
  properties: {
    out: { type: "string" },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const SCHEMA_MINT_X = {
  type: "object",
  properties: {
    out: {
      type: "string",
      ifc: { confidentiality: [CLAUSE_A], addIntegrity: [ATOM_X] },
    },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const SCHEMA_MINT_XY = {
  type: "object",
  properties: {
    out: {
      type: "string",
      ifc: { confidentiality: [CLAUSE_A], addIntegrity: [ATOM_X, ATOM_Y] },
    },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const SCHEMA_INTEGRITY_X = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { integrity: [ATOM_X] } },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const SCHEMA_EMPTY_INTEGRITY = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { integrity: [] } },
  },
  required: ["out"],
} as const satisfies JSONSchema;

type PersistedEntry = {
  path: string[];
  origin?: string;
  observes?: string;
  label: {
    confidentiality?: unknown[];
    integrity?: unknown[];
  };
};

const makeRuntime = (opts: {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  cfcEnforcementMode?: "disabled" | "observe" | "enforce-explicit";
  cfcFlowLabels?: "off" | "observe" | "persist";
  cfcDeclaredMonotonicity?: CfcDeclaredMonotonicityMode;
}) =>
  new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager: opts.storageManager,
    ...(opts.cfcEnforcementMode !== undefined
      ? { cfcEnforcementMode: opts.cfcEnforcementMode }
      : {}),
    ...(opts.cfcFlowLabels !== undefined
      ? { cfcFlowLabels: opts.cfcFlowLabels }
      : {}),
    ...(opts.cfcDeclaredMonotonicity !== undefined
      ? { cfcDeclaredMonotonicity: opts.cfcDeclaredMonotonicity }
      : {}),
  });

const persistedEntriesFor = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
): PersistedEntry[] => {
  const replica = storageManager.open(signer.did()).replica as unknown as {
    getDocument(id: string): {
      cfc?: { labelMap?: { entries: PersistedEntry[] } };
    } | undefined;
  };
  return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
};

const declaredEntryAt = (
  entries: PersistedEntry[],
  path: string[],
): PersistedEntry | undefined =>
  entries.find((entry) =>
    (entry.origin === "declared" || entry.origin === undefined) &&
    entry.path.length === path.length &&
    entry.path.every((segment, index) => segment === path[index])
  );

/** Commit a value write through a schema-bearing cell; returns the result. */
const commitWrite = async (
  runtime: Runtime,
  name: string,
  schema: JSONSchema | undefined,
  value: unknown,
): Promise<
  { error?: unknown; docId: string; diagnostics: string[] }
> => {
  const tx = runtime.edit();
  const cell = runtime.getCell(signer.did(), name, schema, tx);
  const docId = cell.getAsNormalizedFullLink().id;
  cell.set(value as never);
  tx.prepareCfc();
  const result = await tx.commit();
  return {
    ...(result.error !== undefined ? { error: result.error } : {}),
    docId,
    diagnostics: [...tx.getCfcState().diagnostics],
  };
};

/**
 * Rewrite the stored declared labelMap entries of an existing doc, keeping
 * the real schemaHash (so the next prepare's stored-schema load succeeds).
 * Runs on a SEPARATE runtime over the same storage: tests seed stored
 * ["cfc"] metadata via an ungated path-[] full-document write, which the
 * shape hydration delivers.
 * The caller owns the seeder runtime, and both runtimes here share one
 * caller-owned StorageManager: each is torn down with
 * `dispose({ closeStorage: false })` so neither closes the store the other is
 * still reading through, and the test closes it once itself.
 */
const rewriteStoredEntries = async (
  seeder: Runtime,
  docId: string,
  mutate: (entries: PersistedEntry[]) => PersistedEntry[],
): Promise<void> => {
  const tx = seeder.edit();
  const document = tx.readOrThrow({
    space: signer.did(),
    id: docId as URI,
    type: "application/json",
    path: [],
  }) as { value?: unknown; cfc?: { labelMap: { entries: PersistedEntry[] } } };
  const cloned = JSON.parse(JSON.stringify(document)) as {
    value?: unknown;
    cfc: {
      version: 1;
      schemaHash: string;
      labelMap: { version: 1; entries: PersistedEntry[] };
    };
  };
  cloned.cfc.labelMap.entries = mutate(cloned.cfc.labelMap.entries);
  seedStoredEnvelope(tx, {
    space: signer.did(),
    id: docId as URI,
    type: "application/json",
    path: [],
  }, cloned as never);
  const result = await tx.commit();
  expect(result.error).toBeUndefined();
};

describe("CFC declared-component monotonicity (WP5, §8.12.1/§8.12.8)", () => {
  describe("current behavior (characterization — the off/observe contract)", () => {
    // Characterization: what the re-mint does TODAY, with no gate dial.
    // These pin the `off`/`observe` byte-compat contract.

    it("(a) a schema dropping a confidentiality clause is rejected by the schema merge", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager });
      try {
        const first = await commitWrite(
          runtime,
          "dm-char-drop",
          SCHEMA_TWO_CLAUSES,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        const second = await commitWrite(
          runtime,
          "dm-char-drop",
          SCHEMA_ONE_CLAUSE,
          { out: "v2" },
        );
        // Today the SCHEMA-level weakening guard (mergeCfcSchemaEnvelopes)
        // rejects this route before any entry is re-minted.
        expect(String((second.error as Error | undefined)?.message)).toContain(
          "confidentiality cannot be weakened",
        );
        const entry = declaredEntryAt(
          persistedEntriesFor(storageManager, second.docId),
          ["out"],
        );
        expect(entry?.label.confidentiality).toEqual([CLAUSE_A, CLAUSE_B]);
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("(b) a schema adding an alternative to an existing clause is rejected by the schema merge", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager });
      try {
        const first = await commitWrite(
          runtime,
          "dm-char-alt",
          SCHEMA_ONE_CLAUSE,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        const second = await commitWrite(
          runtime,
          "dm-char-alt",
          SCHEMA_OR_CLAUSE,
          { out: "v2" },
        );
        // Replacing clause A with A∨B grows the clause's satisfier set; the
        // schema merge's clause-set subset check rejects it today.
        expect(String((second.error as Error | undefined)?.message)).toContain(
          "confidentiality cannot be weakened",
        );
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("(c) a schema adding an integrity atom silently grows the declared integrity claim", async () => {
      // THE gap the gate closes: §8.12.1 says the declared integrity claim
      // may only shrink, but addIntegrity growth is merge-legal and the
      // re-mint persists the grown claim with no check.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager });
      try {
        const first = await commitWrite(
          runtime,
          "dm-char-integ",
          SCHEMA_MINT_X,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        const before = declaredEntryAt(
          persistedEntriesFor(storageManager, first.docId),
          ["out"],
        );
        expect(before?.label.integrity).toEqual([ATOM_X]);
        const second = await commitWrite(
          runtime,
          "dm-char-integ",
          SCHEMA_MINT_XY,
          { out: "v2" },
        );
        expect(second.error).toBeUndefined();
        const after = declaredEntryAt(
          persistedEntriesFor(storageManager, second.docId),
          ["out"],
        );
        expect(after?.label.integrity).toEqual([ATOM_X, ATOM_Y]);
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("(d) a schema declaring nothing where an entry exists keeps the entry (merge restores stored ifc)", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager });
      try {
        const first = await commitWrite(
          runtime,
          "dm-char-none",
          SCHEMA_ONE_CLAUSE,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        const second = await commitWrite(
          runtime,
          "dm-char-none",
          SCHEMA_NO_IFC,
          { out: "v2" },
        );
        expect(second.error).toBeUndefined();
        const entry = declaredEntryAt(
          persistedEntriesFor(storageManager, second.docId),
          ["out"],
        );
        expect(entry?.label.confidentiality).toEqual([CLAUSE_A]);
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("a stored declared entry stronger than its schema is silently weakened under flow persist", async () => {
      // The entry-level weakening route the schema merge cannot see: the
      // stored declared entry carries confidentiality beyond what the
      // (unchanged) schema declares — an earlier exactCopy mint, an earlier
      // ratchet fold, a peer's write. Under cfcFlowLabels:"persist" the
      // re-mint derives from the schema alone and DROPS the extra clause.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        // At this rung the writer-fit check flags the second commit and lets
        // it land. That commit carries the clause the re-mint drops, and the
        // assertion below reads the entry it persisted.
        cfcEnforcementMode: "enforce-explicit",
        cfcFlowLabels: "persist",
      });
      const seeder = makeRuntime({ storageManager });
      try {
        const first = await commitWrite(
          runtime,
          "dm-char-entry-drop",
          SCHEMA_ONE_CLAUSE,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        await rewriteStoredEntries(
          seeder,
          first.docId,
          (entries) =>
            entries.map((entry) =>
              entry.origin === "declared" && entry.path.join("/") === "out"
                ? {
                  ...entry,
                  label: {
                    ...entry.label,
                    confidentiality: [CLAUSE_A, CLAUSE_B],
                  },
                }
                : entry
            ),
        );
        const second = await commitWrite(
          runtime,
          "dm-char-entry-drop",
          SCHEMA_ONE_CLAUSE,
          { out: "v2" },
        );
        expect(second.error).toBeUndefined();
        const entry = declaredEntryAt(
          persistedEntriesFor(storageManager, second.docId),
          ["out"],
        );
        // CLAUSE_B silently dropped: the non-monotone declared re-mint.
        expect(entry?.label.confidentiality).toEqual([CLAUSE_A]);
      } finally {
        await runtime.dispose({ closeStorage: false });
        await seeder.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("with flow labels off, the Wave-2 grow-only ratchet folds the stronger stored entry back in", async () => {
      // The dual pin: under cfcFlowLabels:"off" the legacy ratchet merges
      // prior confidentiality into the fresh entry, so the confidentiality
      // half of §8.12.1 cannot regress on this path — which is why the
      // gate's confidentiality tests run under flow persist.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager, cfcFlowLabels: "off" });
      const seeder = makeRuntime({ storageManager });
      try {
        const first = await commitWrite(
          runtime,
          "dm-char-ratchet",
          SCHEMA_ONE_CLAUSE,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        await rewriteStoredEntries(
          seeder,
          first.docId,
          (entries) =>
            entries.map((entry) =>
              entry.origin === "declared" && entry.path.join("/") === "out"
                ? {
                  ...entry,
                  label: {
                    ...entry.label,
                    confidentiality: [CLAUSE_A, CLAUSE_B],
                  },
                }
                : entry
            ),
        );
        const second = await commitWrite(
          runtime,
          "dm-char-ratchet",
          SCHEMA_ONE_CLAUSE,
          { out: "v2" },
        );
        expect(second.error).toBeUndefined();
        const entry = declaredEntryAt(
          persistedEntriesFor(storageManager, second.docId),
          ["out"],
        );
        expect(entry?.label.confidentiality).toEqual(
          expect.arrayContaining([CLAUSE_A, CLAUSE_B]),
        );
      } finally {
        await runtime.dispose({ closeStorage: false });
        await seeder.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });
  });

  describe("the cfcDeclaredMonotonicity dial", () => {
    // The dial: cfcDeclaredMonotonicity, mirroring cfcWriteFloor exactly.

    it("the enforce pin cannot be weakened mid-transaction", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcDeclaredMonotonicity: "enforce",
      });
      try {
        const tx = runtime.edit();
        expect(() => tx.setCfcDeclaredMonotonicityMode("off")).toThrow(
          "cannot be weakened",
        );
        expect(() => tx.setCfcDeclaredMonotonicityMode("observe")).toThrow(
          "cannot be weakened",
        );
        // Re-asserting enforce is fine.
        tx.setCfcDeclaredMonotonicityMode("enforce");
        expect(tx.getCfcState().declaredMonotonicityMode).toBe("enforce");
        await tx.commit();
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("a real mode change after prepare invalidates the prepared decision", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager });
      try {
        const tx = runtime.edit();
        const cell = runtime.getCell(
          signer.did(),
          "dm-dial-invalidate",
          SCHEMA_ONE_CLAUSE,
          tx,
        );
        cell.set({ out: "v1" });
        tx.prepareCfc();
        expect(tx.getCfcState().prepare.status).toBe("prepared");
        // A no-op re-set of the mode the transaction already carries does
        // not invalidate.
        tx.setCfcDeclaredMonotonicityMode(
          tx.getCfcState().declaredMonotonicityMode,
        );
        expect(tx.getCfcState().prepare.status).toBe("prepared");
        tx.setCfcDeclaredMonotonicityMode("enforce");
        const prepare = tx.getCfcState().prepare;
        expect(prepare.status).toBe("invalidated");
        expect(
          prepare.status === "invalidated" &&
            prepare.reasons.includes("declared-monotonicity-mode-changed"),
        ).toBe(true);
        tx.abort();
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });
  });

  describe("the widening-exemption seam (setter discipline)", () => {
    // The exception seam: the per-tx privileged widening exemption
    // (§8.12.7 route 2b; design doc §4). Setter discipline only here —
    // the gate-facing semantics are in the enforce block below.

    const EXEMPTION = () => ({
      space: signer.did(),
      id: "of:some-doc",
      path: ["out"],
      clauseDigest: "digest-of-clause",
    });

    it("pattern/handler code cannot set it: no identity fails closed", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager });
      try {
        const tx = runtime.edit();
        expect(() => tx.setCfcDeclaredWideningExemption(EXEMPTION())).toThrow(
          /builtin/,
        );
        tx.abort();
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("pattern/handler code cannot set it: a verified identity fails closed", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager });
      try {
        const tx = runtime.edit();
        setCfcImplementationIdentity(tx, {
          kind: "verified",
          moduleIdentity: "mod:example",
        });
        expect(() => tx.setCfcDeclaredWideningExemption(EXEMPTION())).toThrow(
          /builtin/,
        );
        tx.abort();
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("a malformed or over-broad marker fails closed (no wildcard exemptions)", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager });
      try {
        const tx = runtime.edit();
        setCfcImplementationIdentity(tx, {
          kind: "builtin",
          builtinId: "cfc-declassification-event-writer",
        });
        const attempt = (marker: unknown) => () =>
          tx.setCfcDeclaredWideningExemption(marker as never);
        expect(attempt(null)).toThrow(/malformed/);
        expect(attempt({ ...EXEMPTION(), space: "" })).toThrow(/malformed/);
        expect(attempt({ ...EXEMPTION(), id: "" })).toThrow(/malformed/);
        expect(attempt({ ...EXEMPTION(), clauseDigest: "" })).toThrow(
          /malformed/,
        );
        expect(attempt({ ...EXEMPTION(), path: "out" })).toThrow(/malformed/);
        expect(attempt({ ...EXEMPTION(), path: [42] })).toThrow(/malformed/);
        expect(attempt({ ...EXEMPTION(), clauseDigest: undefined })).toThrow(
          /malformed/,
        );
        tx.abort();
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("write-once: a second exemption in the same transaction fails closed", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager });
      try {
        const tx = runtime.edit();
        setCfcImplementationIdentity(tx, {
          kind: "builtin",
          builtinId: "cfc-declassification-event-writer",
        });
        tx.setCfcDeclaredWideningExemption(EXEMPTION());
        expect(tx.getCfcState().declaredWideningExemption).toMatchObject({
          id: "of:some-doc",
          clauseDigest: "digest-of-clause",
        });
        expect(() =>
          tx.setCfcDeclaredWideningExemption({
            ...EXEMPTION(),
            clauseDigest: "another-digest",
          })
        ).toThrow(/already set/);
        tx.abort();
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("delegates through TransactionWrapper to the wrapped transaction", async () => {
      // The wrapper forwards every dial setter and the seam; both must
      // reach the wrapped tx (and its pin/validation) identically.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager });
      try {
        const tx = runtime.edit();
        const wrapper = new TransactionWrapper(tx);
        wrapper.setCfcDeclaredMonotonicityMode("enforce");
        expect(tx.getCfcState().declaredMonotonicityMode).toBe("enforce");
        expect(() => wrapper.setCfcDeclaredMonotonicityMode("off")).toThrow(
          /cannot be weakened/,
        );
        expect(() => wrapper.setCfcDeclaredWideningExemption(EXEMPTION()))
          .toThrow(/builtin/);
        setCfcImplementationIdentity(tx, {
          kind: "builtin",
          builtinId: "cfc-declassification-event-writer",
        });
        wrapper.setCfcDeclaredWideningExemption(EXEMPTION());
        expect(tx.getCfcState().declaredWideningExemption?.id).toBe(
          "of:some-doc",
        );
        tx.abort();
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("setting the exemption after prepare invalidates the prepared decision", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager });
      try {
        const tx = runtime.edit();
        const cell = runtime.getCell(
          signer.did(),
          "dm-seam-invalidate",
          SCHEMA_ONE_CLAUSE,
          tx,
        );
        cell.set({ out: "v1" });
        setCfcImplementationIdentity(tx, {
          kind: "builtin",
          builtinId: "cfc-declassification-event-writer",
        });
        tx.prepareCfc();
        expect(tx.getCfcState().prepare.status).toBe("prepared");
        tx.setCfcDeclaredWideningExemption(EXEMPTION());
        const prepare = tx.getCfcState().prepare;
        expect(prepare.status).toBe("invalidated");
        expect(
          prepare.status === "invalidated" &&
            prepare.reasons.includes("declared-widening-exemption-added"),
        ).toBe(true);
        tx.abort();
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });
  });

  // Shared scenario builders for the gate-behavior blocks below.

  /**
   * Seeded-drop scenario: commit v1 under `schema`, then rewrite the stored
   * declared /out entry via `mutateEntry`, then commit v2 under the SAME
   * schema on a `cfcFlowLabels:"persist"` runtime (the ratchet-free route
   * where an entry-level weakening actually reaches the persist walk).
   * Returns the second commit's outcome plus the doc's persisted entries.
   */
  const seededRemintScenario = async (opts: {
    storageManager: ReturnType<typeof StorageManager.emulate>;
    name: string;
    schema: JSONSchema;
    dial?: CfcDeclaredMonotonicityMode;
    flowLabels?: "off" | "persist";
    mutateEntry: (entry: PersistedEntry) => PersistedEntry;
    beforeSecondCommit?: (
      tx: ReturnType<Runtime["edit"]>,
      docId: string,
    ) => void;
  }) => {
    const runtime = makeRuntime({
      storageManager: opts.storageManager,
      // At this rung the writer-fit check flags the second commit and lets it
      // land. That commit carries the clause the seeded entry adds, and the
      // callers read the error and the entries it produced.
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: opts.flowLabels ?? "persist",
      ...(opts.dial !== undefined
        ? { cfcDeclaredMonotonicity: opts.dial }
        : {}),
    });
    const seeder = makeRuntime({ storageManager: opts.storageManager });
    try {
      const first = await commitWrite(runtime, opts.name, opts.schema, {
        out: "v1",
      });
      expect(first.error).toBeUndefined();
      await rewriteStoredEntries(
        seeder,
        first.docId,
        (entries) =>
          entries.map((entry) =>
            entry.origin === "declared" && entry.path.join("/") === "out"
              ? opts.mutateEntry(entry)
              : entry
          ),
      );
      const tx = runtime.edit();
      const cell = runtime.getCell(signer.did(), opts.name, opts.schema, tx);
      cell.set({ out: "v2" } as never);
      opts.beforeSecondCommit?.(tx, first.docId);
      tx.prepareCfc();
      const result = await tx.commit();
      return {
        docId: first.docId,
        error: result.error,
        diagnostics: [...tx.getCfcState().diagnostics],
        entries: persistedEntriesFor(opts.storageManager, first.docId),
        prepare: tx.getCfcState().prepare,
      };
    } finally {
      await runtime.dispose({ closeStorage: false });
      await seeder.dispose({ closeStorage: false });
      await opts.storageManager.close();
    }
  };

  describe("enforce: non-monotone declared re-mints fail closed", () => {
    // The gate under enforce: §8.12.1 weakenings fail closed.

    it("a dropped confidentiality clause rejects, naming doc, path and direction", async () => {
      const result = await seededRemintScenario({
        storageManager: StorageManager.emulate({ as: signer }),
        name: "dm-enf-drop",
        schema: SCHEMA_ONE_CLAUSE,
        dial: "enforce",
        mutateEntry: (entry) => ({
          ...entry,
          label: { ...entry.label, confidentiality: [CLAUSE_A, CLAUSE_B] },
        }),
      });
      const message = String((result.error as Error | undefined)?.message);
      expect(message).toContain("declared-monotonicity confidentiality");
      expect(message).toContain(result.docId);
      expect(message).toContain("at /out");
      expect(message).toContain("§8.12.1");
      // The rejected commit persisted nothing: the seeded stored entry is
      // intact.
      const entry = declaredEntryAt(result.entries, ["out"]);
      expect(entry?.label.confidentiality).toEqual([CLAUSE_A, CLAUSE_B]);
    });

    it("an alternative added to an existing clause rejects", async () => {
      // Stored clause is the bare CLAUSE_A; the (unchanged) schema declares
      // the wider A∨B, so the re-mint would grow the clause's satisfier set
      // — exactly what canUpdateStoreLabel forbids.
      const result = await seededRemintScenario({
        storageManager: StorageManager.emulate({ as: signer }),
        name: "dm-enf-alt",
        schema: SCHEMA_OR_CLAUSE,
        dial: "enforce",
        mutateEntry: (entry) => ({
          ...entry,
          label: { ...entry.label, confidentiality: [CLAUSE_A] },
        }),
      });
      const message = String((result.error as Error | undefined)?.message);
      expect(message).toContain("declared-monotonicity confidentiality");
      expect(message).toContain("at /out");
    });

    it("untouched paths are not gated (carry-forward preserves the stored entry)", async () => {
      // A stored declared entry at a path this write does not touch is never
      // re-minted — the carry-forward keeps it verbatim, so there is nothing
      // for the gate to compare (proposedAt empty) and no false positive.
      const schema = {
        type: "object",
        properties: {
          out: { type: "string", ifc: { confidentiality: [CLAUSE_A] } },
          aux: { type: "string", ifc: { confidentiality: [CLAUSE_A] } },
        },
      } as const satisfies JSONSchema;
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcFlowLabels: "persist",
        cfcDeclaredMonotonicity: "enforce",
      });
      const seeder = makeRuntime({ storageManager });
      try {
        const first = await commitWrite(runtime, "dm-enf-untouched", schema, {
          out: "v1",
          aux: "v1",
        });
        expect(first.error).toBeUndefined();
        await rewriteStoredEntries(
          seeder,
          first.docId,
          (entries) =>
            entries.map((entry) =>
              entry.origin === "declared" && entry.path.join("/") === "aux"
                ? {
                  ...entry,
                  label: {
                    ...entry.label,
                    confidentiality: [CLAUSE_A, CLAUSE_B],
                  },
                }
                : entry
            ),
        );
        const tx = runtime.edit();
        const cell = runtime.getCell(
          signer.did(),
          "dm-enf-untouched",
          schema,
          tx,
        );
        cell.key("out").set("v2");
        tx.prepareCfc();
        const result = await tx.commit();
        expect(result.error).toBeUndefined();
        const entry = declaredEntryAt(
          persistedEntriesFor(storageManager, first.docId),
          ["aux"],
        );
        expect(entry?.label.confidentiality).toEqual([CLAUSE_A, CLAUSE_B]);
      } finally {
        await runtime.dispose({ closeStorage: false });
        await seeder.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("an ingest target keeps the runtime's mark but not the non-monotone declared claims", async () => {
      // The ingest carve-out (mirroring ingestVerificationFailed): under a
      // NON-REJECTING enforcement mode the fail-closed reason cannot abort
      // the commit, so the gate drops the weakened fresh declared entries —
      // the stored, stronger ones carry forward — while the runtime's
      // ExternalIngest mark still persists.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcEnforcementMode: "observe",
        cfcFlowLabels: "persist",
        cfcDeclaredMonotonicity: "enforce",
      });
      const seeder = makeRuntime({ storageManager });
      try {
        const first = await commitWrite(
          runtime,
          "dm-enf-ingest",
          SCHEMA_ONE_CLAUSE,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        await rewriteStoredEntries(
          seeder,
          first.docId,
          (entries) =>
            entries.map((entry) =>
              entry.origin === "declared" && entry.path.join("/") === "out"
                ? {
                  ...entry,
                  label: {
                    ...entry.label,
                    confidentiality: [CLAUSE_A, CLAUSE_B],
                  },
                }
                : entry
            ),
        );
        const tx = runtime.edit();
        const cell = runtime.getCell(
          signer.did(),
          "dm-enf-ingest",
          SCHEMA_ONE_CLAUSE,
          tx,
        );
        cell.set({ out: "v2" });
        stampExternalIngest(tx, {
          channel: "did:key:channel",
          audience: "did:key:presenter",
          receivedAt: "2026-07-09T12:00:00.000Z",
          valueDigest: "sha256:payload-v2",
          target: {
            space: signer.did(),
            id: first.docId as URI,
            scope: "space",
            path: [],
          },
        });
        tx.prepareCfc();
        const result = await tx.commit();
        expect(result.error).toBeUndefined();
        const entries = persistedEntriesFor(storageManager, first.docId);
        // The stored (stronger) declared entry carried forward; the weakened
        // fresh mint did not land.
        const declared = declaredEntryAt(entries, ["out"]);
        expect(declared?.label.confidentiality).toEqual([CLAUSE_A, CLAUSE_B]);
        // The runtime's mark persisted regardless.
        expect(entries.some((e) => e.origin === "external-ingest")).toBe(true);
        // The violation is on record as a fail-closed reason.
        expect(
          tx.getCfcState().diagnostics.some((d) =>
            d.includes("declared-monotonicity confidentiality")
          ),
        ).toBe(true);
      } finally {
        await runtime.dispose({ closeStorage: false });
        await seeder.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("an added integrity atom rejects (the declared claim may only shrink)", async () => {
      // The pure schema-evolution route (no seeding, flow labels off): the
      // schema merge allows addIntegrity growth, so only this gate stands
      // between the re-mint and a grown declared integrity claim — the
      // characterization block pins that today this commits silently.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcDeclaredMonotonicity: "enforce",
      });
      try {
        const first = await commitWrite(
          runtime,
          "dm-enf-integ",
          SCHEMA_MINT_X,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        const second = await commitWrite(
          runtime,
          "dm-enf-integ",
          SCHEMA_MINT_XY,
          { out: "v2" },
        );
        const message = String((second.error as Error | undefined)?.message);
        expect(message).toContain("declared-monotonicity integrity");
        expect(message).toContain(second.docId);
        expect(message).toContain("at /out");
        expect(message).toContain(JSON.stringify(ATOM_Y));
        const entry = declaredEntryAt(
          persistedEntriesFor(storageManager, second.docId),
          ["out"],
        );
        expect(entry?.label.integrity).toEqual([ATOM_X]);
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });
  });

  describe("enforce: monotone tightenings pass", () => {
    // The gate under enforce: §8.12.1 tightenings pass.

    it("an added clause passes and persists", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcDeclaredMonotonicity: "enforce",
      });
      try {
        const first = await commitWrite(
          runtime,
          "dm-tight-add",
          SCHEMA_ONE_CLAUSE,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        const second = await commitWrite(
          runtime,
          "dm-tight-add",
          SCHEMA_TWO_CLAUSES,
          { out: "v2" },
        );
        expect(second.error).toBeUndefined();
        const entry = declaredEntryAt(
          persistedEntriesFor(storageManager, second.docId),
          ["out"],
        );
        expect(entry?.label.confidentiality).toEqual(
          expect.arrayContaining([CLAUSE_A, CLAUSE_B]),
        );
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("a removed alternative passes (stored A∨B tightens to A)", async () => {
      const result = await seededRemintScenario({
        storageManager: StorageManager.emulate({ as: signer }),
        name: "dm-tight-alt",
        schema: SCHEMA_ONE_CLAUSE,
        dial: "enforce",
        mutateEntry: (entry) => ({
          ...entry,
          label: {
            ...entry.label,
            confidentiality: [{ anyOf: [CLAUSE_A, CLAUSE_B] }],
          },
        }),
      });
      expect(result.error).toBeUndefined();
      const entry = declaredEntryAt(result.entries, ["out"]);
      expect(entry?.label.confidentiality).toEqual([CLAUSE_A]);
    });

    it("a removed integrity atom passes (stored [X,Y] tightens to [X])", async () => {
      const result = await seededRemintScenario({
        storageManager: StorageManager.emulate({ as: signer }),
        name: "dm-tight-integ",
        schema: SCHEMA_MINT_X,
        dial: "enforce",
        flowLabels: "off",
        mutateEntry: (entry) => ({
          ...entry,
          label: { ...entry.label, integrity: [ATOM_X, ATOM_Y] },
        }),
      });
      expect(result.error).toBeUndefined();
      const entry = declaredEntryAt(result.entries, ["out"]);
      expect(entry?.label.integrity).toEqual([ATOM_X]);
    });

    it("removing the final integrity atom clears the declared entry", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcDeclaredMonotonicity: "enforce",
      });
      try {
        const first = await commitWrite(
          runtime,
          "dm-tight-empty-integ",
          SCHEMA_INTEGRITY_X,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        expect(
          declaredEntryAt(
            persistedEntriesFor(storageManager, first.docId),
            ["out"],
          ),
        ).toEqual({
          path: ["out"],
          label: { integrity: [ATOM_X] },
          origin: "declared",
        });
        const second = await commitWrite(
          runtime,
          "dm-tight-empty-integ",
          SCHEMA_EMPTY_INTEGRITY,
          { out: "v2" },
        );
        expect(second.error).toBeUndefined();
        expect(second.docId).toBe(first.docId);
        expect(
          declaredEntryAt(
            persistedEntriesFor(storageManager, second.docId),
            ["out"],
          ),
        ).toBeUndefined();
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("multiple stored declared entries at one path are joined before the integrity check", async () => {
      // Stored duplicates at one path can arrive from peers/hydration. The
      // stored declared CLAIM at the path is their join — keeping an atom
      // that ANY same-path declared entry already claimed is a shrink, not
      // an addition, so proposed [X] against stored entries [X] and [Y]
      // must pass (codex/cubic review on this PR: the per-entry comparison
      // reported X as added while iterating the [Y] entry).
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcDeclaredMonotonicity: "enforce",
      });
      const seeder = makeRuntime({ storageManager });
      try {
        const first = await commitWrite(
          runtime,
          "dm-multi-entry",
          SCHEMA_MINT_X,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        await rewriteStoredEntries(seeder, first.docId, (entries) => [
          ...entries,
          {
            path: ["out"],
            origin: "declared",
            label: { confidentiality: [CLAUSE_A], integrity: [ATOM_Y] },
          },
        ]);
        const second = await commitWrite(
          runtime,
          "dm-multi-entry",
          SCHEMA_MINT_X,
          { out: "v2" },
        );
        expect(second.error).toBeUndefined();
        const entry = declaredEntryAt(
          persistedEntriesFor(storageManager, second.docId),
          ["out"],
        );
        expect(entry?.label.integrity).toEqual([ATOM_X]);
      } finally {
        await runtime.dispose({ closeStorage: false });
        await seeder.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("an atom outside the joined same-path claim still rejects", async () => {
      // The dual guard on the join fix: aggregating stored entries must not
      // hollow the check out — an atom no same-path declared entry claimed
      // is still an addition.
      const schemaMintXZ = {
        type: "object",
        properties: {
          out: {
            type: "string",
            ifc: {
              confidentiality: [CLAUSE_A],
              addIntegrity: [ATOM_X, "integrity-z"],
            },
          },
        },
        required: ["out"],
      } as const satisfies JSONSchema;
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcDeclaredMonotonicity: "enforce",
      });
      const seeder = makeRuntime({ storageManager });
      try {
        const first = await commitWrite(
          runtime,
          "dm-multi-entry-z",
          SCHEMA_MINT_X,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        await rewriteStoredEntries(seeder, first.docId, (entries) => [
          ...entries,
          {
            path: ["out"],
            origin: "declared",
            label: { confidentiality: [CLAUSE_A], integrity: [ATOM_Y] },
          },
        ]);
        const second = await commitWrite(
          runtime,
          "dm-multi-entry-z",
          schemaMintXZ,
          { out: "v2" },
        );
        const message = String((second.error as Error | undefined)?.message);
        expect(message).toContain("declared-monotonicity integrity");
        expect(message).toContain(JSON.stringify("integrity-z"));
        expect(message).not.toContain(`atom ${JSON.stringify(ATOM_X)} added`);
      } finally {
        await runtime.dispose({ closeStorage: false });
        await seeder.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("an identical re-mint passes (equality is monotone)", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcDeclaredMonotonicity: "enforce",
      });
      try {
        const first = await commitWrite(
          runtime,
          "dm-tight-same",
          SCHEMA_MINT_X,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        const second = await commitWrite(
          runtime,
          "dm-tight-same",
          SCHEMA_MINT_X,
          { out: "v2" },
        );
        expect(second.error).toBeUndefined();
        const entry = declaredEntryAt(
          persistedEntriesFor(storageManager, second.docId),
          ["out"],
        );
        expect(entry?.label.confidentiality).toEqual([CLAUSE_A]);
        expect(entry?.label.integrity).toEqual([ATOM_X]);
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });
  });

  describe("component scoping (§8.12.8)", () => {
    // §8.12.8 component scoping: only declared↔declared is ever compared.

    it("legacy (origin-less) stored entries are not gated", async () => {
      // A seeded LEGACY entry whose integrity the fresh declared mint does
      // not cover: were the gate to compare against it, [X] ⊄ [Y] would
      // reject — legacy entries keep the historical combined rules instead.
      const result = await seededRemintScenario({
        storageManager: StorageManager.emulate({ as: signer }),
        name: "dm-scope-legacy",
        schema: SCHEMA_MINT_X,
        dial: "enforce",
        flowLabels: "off",
        mutateEntry: (entry) => {
          const { origin: _origin, ...legacy } = entry;
          return {
            ...legacy,
            label: { ...legacy.label, integrity: [ATOM_Y] },
          };
        },
      });
      expect(result.error).toBeUndefined();
    });

    it("derived stored entries are not gated (replace-on-overwrite stands)", async () => {
      // A seeded DERIVED entry at the written path is replaced/cleared by
      // the flow discipline — a label decrease §8.12.8 explicitly permits
      // and the gate must not reject.
      const result = await seededRemintScenario({
        storageManager: StorageManager.emulate({ as: signer }),
        name: "dm-scope-derived",
        schema: SCHEMA_ONE_CLAUSE,
        dial: "enforce",
        mutateEntry: (entry) => ({
          ...entry,
          origin: "derived",
          label: { confidentiality: [CLAUSE_A, CLAUSE_B] },
        }),
      });
      expect(result.error).toBeUndefined();
    });
  });

  describe("off/observe byte-compat", () => {
    // off/observe: byte-compat with the characterization block.

    it("off: the seeded weakening persists exactly as characterized, no diagnostic", async () => {
      const result = await seededRemintScenario({
        storageManager: StorageManager.emulate({ as: signer }),
        name: "dm-off-drop",
        schema: SCHEMA_ONE_CLAUSE,
        dial: "off",
        mutateEntry: (entry) => ({
          ...entry,
          label: { ...entry.label, confidentiality: [CLAUSE_A, CLAUSE_B] },
        }),
      });
      expect(result.error).toBeUndefined();
      const entry = declaredEntryAt(result.entries, ["out"]);
      expect(entry?.label.confidentiality).toEqual([CLAUSE_A]);
      expect(
        result.diagnostics.some((d) => d.includes("declared-monotonicity")),
      ).toBe(false);
    });

    it("observe: the weakening persists as characterized AND a structured diagnostic records it", async () => {
      const result = await seededRemintScenario({
        storageManager: StorageManager.emulate({ as: signer }),
        name: "dm-obs-drop",
        schema: SCHEMA_ONE_CLAUSE,
        dial: "observe",
        mutateEntry: (entry) => ({
          ...entry,
          label: { ...entry.label, confidentiality: [CLAUSE_A, CLAUSE_B] },
        }),
      });
      expect(result.error).toBeUndefined();
      const entry = declaredEntryAt(result.entries, ["out"]);
      expect(entry?.label.confidentiality).toEqual([CLAUSE_A]);
      expect(
        result.diagnostics.some((d) =>
          d.startsWith("declared-monotonicity(observe):") &&
          d.includes("at /out") &&
          d.includes("§8.12.1")
        ),
      ).toBe(true);
    });

    it("observe: the integrity-add characterization outcome is unchanged, with a diagnostic", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcDeclaredMonotonicity: "observe",
      });
      try {
        const first = await commitWrite(
          runtime,
          "dm-obs-integ",
          SCHEMA_MINT_X,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        const second = await commitWrite(
          runtime,
          "dm-obs-integ",
          SCHEMA_MINT_XY,
          { out: "v2" },
        );
        expect(second.error).toBeUndefined();
        const entry = declaredEntryAt(
          persistedEntriesFor(storageManager, second.docId),
          ["out"],
        );
        expect(entry?.label.integrity).toEqual([ATOM_X, ATOM_Y]);
        expect(
          second.diagnostics.some((d) =>
            d.startsWith("declared-monotonicity(observe):") &&
            d.includes("integrity")
          ),
        ).toBe(true);
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("the schema-declares-nothing case matches pinned behavior under every dial value", async () => {
      for (const dial of ["off", "observe", "enforce"] as const) {
        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = makeRuntime({
          storageManager,
          cfcDeclaredMonotonicity: dial,
        });
        try {
          const first = await commitWrite(
            runtime,
            `dm-none-${dial}`,
            SCHEMA_ONE_CLAUSE,
            { out: "v1" },
          );
          expect(first.error).toBeUndefined();
          const second = await commitWrite(
            runtime,
            `dm-none-${dial}`,
            SCHEMA_NO_IFC,
            { out: "v2" },
          );
          expect(second.error, `dial=${dial}`).toBeUndefined();
          const entry = declaredEntryAt(
            persistedEntriesFor(storageManager, second.docId),
            ["out"],
          );
          expect(entry?.label.confidentiality, `dial=${dial}`).toEqual([
            CLAUSE_A,
          ]);
          expect(
            second.diagnostics.some((d) => d.includes("declared-monotonicity")),
            `dial=${dial}`,
          ).toBe(false);
        } finally {
          await runtime.dispose({ closeStorage: false });
          await storageManager.close();
        }
      }
    });
  });

  describe("enforce: the widening exemption", () => {
    // The exemption seam consumed by the gate (§8.12.7 route 2b semantics).

    const withExemption = (
      clauseDigest: string,
      path: string[] = ["out"],
    ) =>
    (tx: ReturnType<Runtime["edit"]>, docId: string) => {
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "cfc-declassification-event-writer",
      });
      tx.setCfcDeclaredWideningExemption({
        space: signer.did(),
        id: docId,
        path,
        clauseDigest,
      });
      // The event writer's identity must not leak into the ordinary write
      // attribution of the rest of this test transaction.
      setCfcImplementationIdentity(tx, undefined);
    };

    it("a privileged marker exempts exactly its (doc, path, clauseDigest) triple", async () => {
      const result = await seededRemintScenario({
        storageManager: StorageManager.emulate({ as: signer }),
        name: "dm-ex-exact",
        schema: SCHEMA_ONE_CLAUSE,
        dial: "enforce",
        mutateEntry: (entry) => ({
          ...entry,
          label: { ...entry.label, confidentiality: [CLAUSE_A, CLAUSE_B] },
        }),
        beforeSecondCommit: withExemption(cfcCanonicalClauseDigest(CLAUSE_B)),
      });
      expect(result.error).toBeUndefined();
      const entry = declaredEntryAt(result.entries, ["out"]);
      // The widening happened — sanctioned, once, for this clause.
      expect(entry?.label.confidentiality).toEqual([CLAUSE_A]);
    });

    it("a wrong clause digest exempts nothing", async () => {
      const result = await seededRemintScenario({
        storageManager: StorageManager.emulate({ as: signer }),
        name: "dm-ex-wrong-digest",
        schema: SCHEMA_ONE_CLAUSE,
        dial: "enforce",
        mutateEntry: (entry) => ({
          ...entry,
          label: { ...entry.label, confidentiality: [CLAUSE_A, CLAUSE_B] },
        }),
        beforeSecondCommit: withExemption(cfcCanonicalClauseDigest(CLAUSE_A)),
      });
      expect(
        String((result.error as Error | undefined)?.message),
      ).toContain("declared-monotonicity confidentiality");
    });

    it("an exemption naming another doc exempts nothing", async () => {
      const result = await seededRemintScenario({
        storageManager: StorageManager.emulate({ as: signer }),
        name: "dm-ex-other-doc",
        schema: SCHEMA_ONE_CLAUSE,
        dial: "enforce",
        mutateEntry: (entry) => ({
          ...entry,
          label: { ...entry.label, confidentiality: [CLAUSE_A, CLAUSE_B] },
        }),
        beforeSecondCommit: (tx) => {
          setCfcImplementationIdentity(tx, {
            kind: "builtin",
            builtinId: "cfc-declassification-event-writer",
          });
          tx.setCfcDeclaredWideningExemption({
            space: signer.did(),
            id: "of:some-unrelated-doc",
            path: ["out"],
            clauseDigest: cfcCanonicalClauseDigest(CLAUSE_B),
          });
          setCfcImplementationIdentity(tx, undefined);
        },
      });
      expect(
        String((result.error as Error | undefined)?.message),
      ).toContain("declared-monotonicity confidentiality");
    });

    it("an exemption for path A does not exempt path B", async () => {
      const schema = {
        type: "object",
        properties: {
          out: { type: "string", ifc: { confidentiality: [CLAUSE_A] } },
          aux: { type: "string", ifc: { confidentiality: [CLAUSE_A] } },
        },
        required: ["out", "aux"],
      } as const satisfies JSONSchema;
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcFlowLabels: "persist",
        cfcDeclaredMonotonicity: "enforce",
      });
      const seeder = makeRuntime({ storageManager });
      try {
        const first = await commitWrite(runtime, "dm-ex-paths", schema, {
          out: "v1",
          aux: "v1",
        });
        expect(first.error).toBeUndefined();
        await rewriteStoredEntries(
          seeder,
          first.docId,
          (entries) =>
            entries.map((entry) =>
              entry.origin === "declared"
                ? {
                  ...entry,
                  label: {
                    ...entry.label,
                    confidentiality: [CLAUSE_A, CLAUSE_B],
                  },
                }
                : entry
            ),
        );
        const tx = runtime.edit();
        const cell = runtime.getCell(signer.did(), "dm-ex-paths", schema, tx);
        cell.set({ out: "v2", aux: "v2" });
        withExemption(cfcCanonicalClauseDigest(CLAUSE_B), ["out"])(
          tx,
          first.docId,
        );
        tx.prepareCfc();
        const result = await tx.commit();
        const message = String((result.error as Error | undefined)?.message);
        // /out is exempted; /aux still fails closed.
        expect(message).toContain("at /aux");
        expect(message).not.toContain("at /out");
      } finally {
        await runtime.dispose({ closeStorage: false });
        await seeder.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });

    it("integrity violations are never exemptable", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        cfcDeclaredMonotonicity: "enforce",
      });
      try {
        const first = await commitWrite(
          runtime,
          "dm-ex-integ",
          SCHEMA_MINT_X,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        const tx = runtime.edit();
        const cell = runtime.getCell(
          signer.did(),
          "dm-ex-integ",
          SCHEMA_MINT_XY,
          tx,
        );
        cell.set({ out: "v2" });
        withExemption(cfcCanonicalClauseDigest(ATOM_Y))(tx, first.docId);
        tx.prepareCfc();
        const result = await tx.commit();
        expect(
          String((result.error as Error | undefined)?.message),
        ).toContain("declared-monotonicity integrity");
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });
  });

  describe("violation-reason dedup (unit)", () => {
    // Reason dedup on degenerate duplicate entries (direct unit call: the
    // walk mints one declared entry per path and dedups atoms, so the
    // duplicate arms are reachable only through the exported function).

    it("reports each violated clause and added atom once across duplicate entries", () => {
      const violations = collectDeclaredMonotonicityViolations({
        space: signer.did(),
        docId: "of:dedup-doc",
        storedEntries: [
          {
            path: ["out"],
            origin: "declared",
            label: { confidentiality: [CLAUSE_B] },
          },
          {
            path: ["out"],
            origin: "declared",
            label: { confidentiality: [CLAUSE_B] },
          },
        ],
        proposedEntries: [
          {
            path: ["out"],
            origin: "declared",
            label: { confidentiality: [CLAUSE_A], integrity: [ATOM_Y] },
          },
          {
            path: ["out"],
            origin: "declared",
            label: { confidentiality: [CLAUSE_A], integrity: [ATOM_Y] },
          },
        ],
      });
      expect(
        violations.filter((v) => v.includes("confidentiality violation")),
      ).toHaveLength(1);
      expect(
        violations.filter((v) => v.includes("integrity violation")),
      ).toHaveLength(1);
    });
  });

  describe("a personal space's owner (the §8.10.3 witness relation)", () => {
    // The gate's witness is `clauseSubsumes(proposed, stored)`, the same
    // §8.10.3 kernel the ceiling gates use, so the personal-space reading
    // reaches here too — proposed sits in the CEILING position and stored in
    // the LABEL position. Pinned because a change to that kernel changes
    // what this gate calls monotone.

    const OWNER = "did:key:zMonoOwner";
    const userAtom = {
      type: "https://commonfabric.org/cfc/atom/User",
      subject: OWNER,
    };
    const personalSpaceAtom = {
      type: "https://commonfabric.org/cfc/atom/PersonalSpace",
      owner: OWNER,
    };
    const confidentialityViolations = (
      stored: CfcConfClause,
      proposed: CfcConfClause,
    ): string[] =>
      collectDeclaredMonotonicityViolations({
        space: signer.did(),
        docId: "of:spelling-doc",
        storedEntries: [{
          path: ["out"],
          origin: "declared",
          label: { confidentiality: [stored] },
        }],
        proposedEntries: [{
          path: ["out"],
          origin: "declared",
          label: { confidentiality: [proposed] },
        }],
      }).filter((v) => v.includes("confidentiality violation"));

    it("narrowing a declared personal space to its owner is monotone", () => {
      // The owner is one of the space's readers, so naming the owner alone
      // is the tightening direction.
      expect(confidentialityViolations(personalSpaceAtom, userAtom))
        .toEqual([]);
    });

    it("widening a declared owner to their personal space is a violation", () => {
      // The direction the gate exists to catch: a declared policy naming one
      // person re-minted as an atom whose audience is the space's readers.
      expect(confidentialityViolations(userAtom, personalSpaceAtom))
        .toHaveLength(1);
    });

    it("re-spelling a declared owner as a space principal is a violation", () => {
      const spaceAtom = {
        type: "https://commonfabric.org/cfc/atom/Space",
        id: OWNER,
      };
      expect(confidentialityViolations(userAtom, spaceAtom)).toHaveLength(1);
      expect(confidentialityViolations(personalSpaceAtom, spaceAtom))
        .toHaveLength(1);
    });

    it("a different owner is a violation", () => {
      const otherUser = {
        type: "https://commonfabric.org/cfc/atom/User",
        subject: "did:key:zMonoOther",
      };
      expect(confidentialityViolations(personalSpaceAtom, otherUser))
        .toHaveLength(1);
    });
  });

  describe("non-taint", () => {
    // Non-taint: the gate's stored-entry reads ride the internal-verifier
    // meta and must not enter the consumed set.

    it("the observe-mode gate adds nothing to the prepared consumed set", async () => {
      const consumedReadsFor = async (
        dial: CfcDeclaredMonotonicityMode,
      ): Promise<unknown> => {
        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = makeRuntime({
          storageManager,
          // At this rung the writer-fit check flags the second commit and
          // lets it land, so the transaction reaches the prepared decision
          // this reads.
          cfcEnforcementMode: "enforce-explicit",
          cfcFlowLabels: "persist",
          cfcDeclaredMonotonicity: dial,
        });
        const seeder = makeRuntime({ storageManager });
        try {
          const first = await commitWrite(
            runtime,
            "dm-nontaint",
            SCHEMA_ONE_CLAUSE,
            { out: "v1" },
          );
          expect(first.error).toBeUndefined();
          await rewriteStoredEntries(
            seeder,
            first.docId,
            (entries) =>
              entries.map((entry) =>
                entry.origin === "declared" && entry.path.join("/") === "out"
                  ? {
                    ...entry,
                    label: {
                      ...entry.label,
                      confidentiality: [CLAUSE_A, CLAUSE_B],
                    },
                  }
                  : entry
              ),
          );
          const tx = runtime.edit();
          const cell = runtime.getCell(
            signer.did(),
            "dm-nontaint",
            SCHEMA_ONE_CLAUSE,
            tx,
          );
          cell.set({ out: "v2" });
          tx.prepareCfc();
          const prepare = tx.getCfcState().prepare;
          expect(prepare.status).toBe("prepared");
          const consumed = prepare.status === "prepared"
            ? JSON.parse(JSON.stringify(prepare.input.consumedReads))
            : undefined;
          tx.abort();
          return consumed;
        } finally {
          await runtime.dispose({ closeStorage: false });
          await seeder.dispose({ closeStorage: false });
          await storageManager.close();
        }
      };
      // Identical scenario, gate off vs observing a real violation: the
      // consumed-read sets must be byte-identical — the gate's stored-
      // metadata reads never taint.
      const offReads = await consumedReadsFor("off");
      const observeReads = await consumedReadsFor("observe");
      expect(observeReads).toEqual(offReads);
    });
  });
});
