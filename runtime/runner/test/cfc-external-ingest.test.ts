import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import {
  stampExternalFetchIngest,
  stampExternalIngest,
} from "../src/cfc/external-ingest.ts";
import type { IFCLabel } from "../src/cfc/mod.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("runner-cfc-external-ingest");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: IFCLabel;
  origin?: string;
};

describe("CFC external-ingest provenance mint (split-mint)", () => {
  // The Vouched Ingest Channel split-mint: a builtin-authored ExternalIngest
  // provenance mark, derived only from the verified channel metadata stamped on
  // the tx, that survives the runtime-minted gate while a copy smuggled into
  // the payload is stripped.

  const makeRuntime = (
    overrides: {
      cfcWriteFloor?: string;
    } = {},
  ) => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime(
      {
        apiUrl: new URL("https://example.com"),
        storageManager,
        // Disabled enforcement is the mint's hardest case: the ingest stamp is
        // the only thing marking the transaction CFC-relevant. It also commits
        // a transaction that recorded a refusal reason, which is the
        // `expect(error).toBeUndefined()` that both "persists the mark even
        // when the payload fails ..." tests turn on.
        cfcEnforcementMode: "disabled",
        ...overrides,
      } as ConstructorParameters<typeof Runtime>[0],
    );
    return { storageManager, runtime };
  };

  type StoredDocument = {
    value?: unknown;
    cfc?: { labelMap?: { entries: StoredEntry[] } };
  } | undefined;

  const storedDocument = (
    storageManager: ReturnType<typeof StorageManager.emulate>,
    id: string,
  ): StoredDocument =>
    (storageManager.open(space).replica as unknown as {
      getDocument(id: string): StoredDocument;
    }).getDocument(id);

  const entriesOf = (
    storageManager: ReturnType<typeof StorageManager.emulate>,
    id: string,
  ): StoredEntry[] =>
    storedDocument(storageManager, id)?.cfc?.labelMap?.entries ?? [];

  const ingestEntries = (
    storageManager: ReturnType<typeof StorageManager.emulate>,
    id: string,
  ): StoredEntry[] =>
    entriesOf(storageManager, id).filter((e) => e.origin === "external-ingest");

  const meta = (id: string, valueDigest: string) => ({
    channel: "did:key:channel",
    audience: "did:key:presenter",
    receivedAt: "2026-06-26T12:00:00.000Z",
    valueDigest,
    target: { space, id: id as never, scope: "space" as const, path: [] },
  });

  const externalIngestAtom = (valueDigest: string) => ({
    type: CFC_ATOM_TYPE.ExternalIngest,
    channel: "did:key:channel",
    audience: "did:key:presenter",
    receivedAt: "2026-06-26T12:00:00.000Z",
    valueDigest,
  });

  const fetchMeta = (id: string, valueDigest: string) => ({
    pinnedSource: {
      url:
        "https://raw.githubusercontent.com/owner/repo/0123456789abcdef0123456789abcdef01234567/skills/plaid/SKILL.md",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    },
    receivedAt: "2026-09-01T12:00:00.000Z",
    valueDigest,
    target: { space, id: id as never, scope: "space" as const, path: [] },
  });

  const externalFetchIngestAtom = (valueDigest: string) => ({
    type: CFC_ATOM_TYPE.ExternalIngest,
    kind: "fetch",
    pinnedSource: {
      url:
        "https://raw.githubusercontent.com/owner/repo/0123456789abcdef0123456789abcdef01234567/skills/plaid/SKILL.md",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    },
    receivedAt: "2026-09-01T12:00:00.000Z",
    valueDigest,
  });

  it("mints the mark on the ingest target even when CFC is disabled", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const { error } = await runtime.editWithRetry((tx) => {
        const cell = runtime.getCell(space, "ingest-a", undefined, tx);
        const id = cell.getAsNormalizedFullLink().id;
        stampExternalIngest(tx, meta(id, "sha256:payload-1"));
        stampExternalIngest(tx, meta(id, "sha256:ignored-second-stamp"));
        tx.writeOrThrow({ space, scope: "space", id, path: ["value"] }, {
          hello: "world",
        });
      });
      expect(error).toBeUndefined();

      const id =
        runtime.getCell(space, "ingest-a").getAsNormalizedFullLink().id;
      const entries = ingestEntries(storageManager, id);
      expect(entries.length).toBe(1);
      expect(entries[0].label.integrity).toContainEqual(
        externalIngestAtom("sha256:payload-1"),
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("mints fetch provenance without a vouched channel or audience", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const id = runtime.getCell(space, "fetch-ingest-a")
        .getAsNormalizedFullLink().id;
      const { error } = await runtime.editWithRetry((tx) => {
        stampExternalFetchIngest(
          tx,
          fetchMeta(id, "sha256:fetched-payload"),
        );
        stampExternalFetchIngest(
          tx,
          fetchMeta(id, "sha256:ignored-second-stamp"),
        );
        tx.writeOrThrow(
          { space, scope: "space", id, path: ["value"] },
          "skill text",
        );
      });
      expect(error).toBeUndefined();

      const atoms = ingestEntries(storageManager, id)
        .flatMap((entry) => entry.label.integrity ?? []);
      expect(atoms).toEqual([
        externalFetchIngestAtom("sha256:fetched-payload"),
      ]);
      expect(atoms[0]).not.toHaveProperty("channel");
      expect(atoms[0]).not.toHaveProperty("audience");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("re-mints (replaces) on a second ingest — no stale-digest accumulation", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const id =
        runtime.getCell(space, "ingest-b").getAsNormalizedFullLink().id;

      for (const [digest, payload] of [["sha256:p1", 1], ["sha256:p2", 2]]) {
        const { error } = await runtime.editWithRetry((tx) => {
          stampExternalIngest(tx, meta(id, digest as string));
          // The real append idiom: read-modify-write the whole array.
          const cell = runtime.getCell(space, "ingest-b", undefined, tx);
          const current = (cell.getRaw() as { value?: number[] })?.value ?? [];
          tx.writeOrThrow({ space, scope: "space", id, path: ["value"] }, [
            ...current,
            payload,
          ]);
        });
        expect(error).toBeUndefined();
      }

      const entries = ingestEntries(storageManager, id);
      // Exactly one mark, carrying the LATEST payload's digest — the first
      // ingest's mark must not survive with its stale digest.
      expect(entries.length).toBe(1);
      expect(entries[0].label.integrity).toContainEqual(
        externalIngestAtom("sha256:p2"),
      );
      expect(entries[0].label.integrity).not.toContainEqual(
        externalIngestAtom("sha256:p1"),
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("mints the mark when `push()` creates the ingest target's list", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const id = runtime.getCell(space, "ingest-push-creates")
        .getAsNormalizedFullLink().id;
      const { error } = await runtime.editWithRetry((tx) => {
        stampExternalIngest(tx, meta(id, "sha256:first-record"));
        runtime.getCell<{ at: string }[]>(
          space,
          "ingest-push-creates",
          undefined,
          tx,
        ).push({ at: "first" });
      });
      expect(error).toBeUndefined();

      expect(storedDocument(storageManager, id)?.value).toHaveLength(1);
      const entries = ingestEntries(storageManager, id);
      expect(entries.length).toBe(1);
      expect(entries[0].label.integrity).toContainEqual(
        externalIngestAtom("sha256:first-record"),
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps the labels the store holds when the appending session has not loaded the list", async () => {
    // The appending session's first attempt sees no list, so it computes the
    // envelope from that absence. The store refuses it, and the retry appends
    // to the loaded list, whose envelope the mark then joins.
    const labeledListSchema = {
      type: "array",
      items: { type: "string" },
      ifc: { confidentiality: ["secret"] },
    } as const satisfies JSONSchema;
    const server = newSharedServer();
    const seedingStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const appendingStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const seeding = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: seedingStorage,
    });
    const appending = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: appendingStorage,
    });
    try {
      const cause = "ingest-unloaded-labeled-list";
      const id = seeding.getCell(space, cause).getAsNormalizedFullLink().id;
      const seeded = await seeding.editWithRetry((tx) => {
        seeding.getCell(space, cause, labeledListSchema, tx).set(["a"]);
      });
      expect(seeded.error).toBeUndefined();
      await seeding.storageManager.synced();

      const appended = await appending.editWithRetry((tx) => {
        stampExternalIngest(tx, meta(id, "sha256:second-record"));
        appending.getCell<string[]>(space, cause, undefined, tx).push("b");
      });
      expect(appended.error).toBeUndefined();
      await appending.storageManager.synced();

      const stored = (appendingStorage.open(space).replica as unknown as {
        getDocument(id: string): StoredDocument;
      }).getDocument(id);
      expect(stored?.value).toEqual(["a", "b"]);
      const entries = stored?.cfc?.labelMap?.entries ?? [];
      expect(entries.flatMap((entry) => entry.label.confidentiality ?? []))
        .toEqual(["secret"]);
      expect(entries.flatMap((entry) => entry.label.integrity ?? []))
        .toContainEqual(externalIngestAtom("sha256:second-record"));
    } finally {
      await seeding.dispose();
      await appending.dispose();
      await seedingStorage.close();
      await appendingStorage.close();
      await server.close();
    }
  });

  it("strips a smuggled ExternalIngest from the payload while the minted mark survives", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      // An attacker controls the payload and tries to forge the provenance
      // mark by declaring an ExternalIngest atom in the value's schema. The
      // payload is authored under the (unattributed, non-builtin) member
      // identity, so the runtime-minted gate must strip it.
      const forged = internSchema(
        {
          type: "object",
          properties: {
            field: {
              type: "string",
              ifc: {
                integrity: [
                  cfcAtom.externalIngest(
                    "did:key:attacker-channel",
                    "did:key:attacker",
                    "1999-01-01T00:00:00.000Z",
                    "sha256:evil",
                  ),
                  "plain-claim",
                ],
              },
            },
          },
          required: ["field"],
        } satisfies JSONSchema,
        true,
      );

      const id =
        runtime.getCell(space, "ingest-forge").getAsNormalizedFullLink().id;
      const { error } = await runtime.editWithRetry((tx) => {
        stampExternalIngest(tx, meta(id, "sha256:real-payload"));
        const cell = runtime.getCell(space, "ingest-forge", forged.schema, tx);
        cell.set({ field: "hello" });
      });
      expect(error).toBeUndefined();

      const declared = entriesOf(storageManager, id)
        .filter((e) => e.origin === "declared")
        .flatMap((e) => e.label.integrity ?? []);
      // The author keeps their plain claim, but the forged ExternalIngest is
      // gone — bytes cannot mint the trusted mark.
      expect(declared).toContainEqual("plain-claim");
      expect(declared).not.toContainEqual(
        externalIngestAtom("sha256:evil"),
      );
      expect(
        declared.some((a) =>
          (a as { type?: string })?.type === CFC_ATOM_TYPE.ExternalIngest
        ),
      ).toBe(false);

      // The ONLY ExternalIngest mark on the doc is the runtime-minted one,
      // carrying the operator's verified metadata — not the attacker's.
      const ingest = ingestEntries(storageManager, id)
        .flatMap((e) => e.label.integrity ?? []);
      expect(ingest).toEqual([externalIngestAtom("sha256:real-payload")]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists the mark even when the payload fails schema verification", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      // A field carrying an ifc claim the runner does not implement makes
      // verifyInputRequirements fail for this write target. Before the fix that
      // failure `continue`d past the ingest mint, silently dropping the mark on
      // a committing (disabled/observe) tx. The mark is runtime-authored
      // provenance, orthogonal to whether the payload satisfies its schema, so
      // it must still persist here (enforcing modes still abort the whole tx via
      // the recorded reason, so nothing — payload or mark — lands there).
      const unsupported = internSchema(
        {
          type: "object",
          properties: {
            field: {
              type: "string",
              // A valid confidentiality claim (would produce a declared label)
              // plus `transformation`, which the runner does not implement (so
              // verifyInputRequirements fails for this target).
              ifc: { confidentiality: ["secret"], transformation: true },
            },
          },
          required: ["field"],
        } as JSONSchema,
        true,
      );

      const id = runtime.getCell(space, "ingest-unsupported")
        .getAsNormalizedFullLink().id;
      const { error } = await runtime.editWithRetry((tx) => {
        stampExternalIngest(tx, meta(id, "sha256:despite-failure"));
        const cell = runtime.getCell(
          space,
          "ingest-unsupported",
          unsupported.schema,
          tx,
        );
        cell.set({ field: "hello" });
      });
      // Disabled mode commits despite the recorded verification reason.
      expect(error).toBeUndefined();

      const marks = entriesOf(storageManager, id)
        .flatMap((e) => e.label.integrity ?? []);
      expect(marks).toContainEqual(
        externalIngestAtom("sha256:despite-failure"),
      );

      // ...but the payload's own (unverified) declared policy label did NOT
      // persist — a failed write must not store unverified policy metadata.
      const declared = entriesOf(storageManager, id)
        .filter((e) => e.origin === "declared");
      expect(declared.length).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists the mark even when the payload fails the write floor", async () => {
    // Same invariant as the schema-verification case, for the D3 write floor:
    // an ingest payload violating a requiredIntegrity floor records the reason
    // (enforcing modes abort the whole tx), but on a committing (disabled)
    // runtime the runtime-authored mark still persists and only the payload's
    // declared policy label is dropped. Exercises the floor's ingest-target
    // branch (ingestVerificationFailed instead of skipping the mint).
    const { storageManager, runtime } = makeRuntime({
      // The floor rejects the unendorsed payload, which is the rejection the
      // mark has to survive.
      cfcWriteFloor: "enforce",
    });
    try {
      const floored = internSchema(
        {
          type: "object",
          properties: {
            field: {
              type: "string",
              ifc: { requiredIntegrity: ["ingest-endorsement"] },
            },
          },
          required: ["field"],
        } as JSONSchema,
        true,
      );

      const id = runtime.getCell(space, "ingest-floored")
        .getAsNormalizedFullLink().id;
      const { error } = await runtime.editWithRetry((tx) => {
        stampExternalIngest(tx, meta(id, "sha256:floor-miss"));
        const cell = runtime.getCell(
          space,
          "ingest-floored",
          floored.schema,
          tx,
        );
        cell.set({ field: "unendorsed" });
      });
      // Disabled enforcement commits despite the recorded floor reason.
      expect(error).toBeUndefined();

      const marks = entriesOf(storageManager, id)
        .flatMap((e) => e.label.integrity ?? []);
      expect(marks).toContainEqual(externalIngestAtom("sha256:floor-miss"));

      const declared = entriesOf(storageManager, id)
        .filter((e) => e.origin === "declared");
      expect(declared.length).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not mint a mark when the tx is not stamped", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const { error } = await runtime.editWithRetry((tx) => {
        const cell = runtime.getCell(space, "ingest-c", undefined, tx);
        const id = cell.getAsNormalizedFullLink().id;
        tx.writeOrThrow({ space, scope: "space", id, path: ["value"] }, {
          hello: "world",
        });
      });
      expect(error).toBeUndefined();

      const id =
        runtime.getCell(space, "ingest-c").getAsNormalizedFullLink().id;
      // The stored value pins the document the marks are read from, so the
      // empty mark list below is that document's own.
      expect(storedDocument(storageManager, id)?.value).toEqual({
        hello: "world",
      });
      expect(ingestEntries(storageManager, id).length).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
