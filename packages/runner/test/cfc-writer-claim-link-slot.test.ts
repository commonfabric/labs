import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { cfcAtom } from "@commonfabric/api/cfc";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { runtimePresets } from "../src/runtime-presets.ts";
import { loadStoredCfcEnvelope } from "../src/cfc/prepare.ts";
import { setCfcImplementationIdentity } from "../src/cfc/trust-authority.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { Cell } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";

// A slot whose writer claim names a builtin, holding a link to a document
// that builtin created and keeps writing: the room's `box`, which the
// custody seal links to the instance's box in the transaction that writes
// each entry. The claim governs who writes the SLOT. The linked document
// keeps its own schema and its own stamps: a write that replaces the link
// at the slot, or writes the same link again, is a write to the slot, and
// the slot's schema is the slot's, not the linked document's.
//
// `Cell.set()` resolved its policy input through every link to the value —
// the box — while the write itself landed at the slot, so the second seal
// recorded the slot's claimed schema as a candidate envelope for the box.
// Measured: the box's stored schema merged against the room's idea of an
// entry, which requires a field the box's does not, and the seal's commit
// was refused as an incompatible migration; on an earlier build the same
// misattribution rewrote the box's root stamp, so the next seal refused "a
// box the seal did not create".

const signer = await Identity.fromPassphrase("cfc-writer-claim-link-slot");
const space = signer.did();

/** The builtin that creates the box and links it, standing in for the seal. */
const SEAL = "cfc-writer-claim-link-slot-seal";

/** The box as its creator declares it: each entry names its instance. */
const BOX_SCHEMA = {
  type: "object",
  additionalProperties: {
    type: "object",
    properties: { instance: { type: "string" } },
    required: ["instance"],
  },
  ifc: { confidentiality: [cfcAtom.space(space)] },
} as JSONSchema;

/**
 * The room's slot: only the seal writes it, and the room's own idea of an
 * entry asks for one more field than the box's schema does, so a schema of
 * the slot's that reached the box would be an incompatible migration there.
 */
const SLOT_SCHEMA = {
  type: "object",
  additionalProperties: {
    type: "object",
    properties: { instance: { type: "string" }, extra: { type: "string" } },
    required: ["instance", "extra"],
  },
  ifc: { writeAuthorizedBy: [SEAL] },
} as JSONSchema;

const ROOM_SCHEMA = {
  type: "object",
  properties: { box: SLOT_SCHEMA, note: { type: "string" } },
} as JSONSchema;

type Room = { box?: Record<string, { instance: string }>; note: string };

/** Every `writeAuthorizedBy` claim in `schema`, keyed by its JSON pointer. */
const claimsIn = (schema: unknown): string[] => {
  const claims: string[] = [];
  const walk = (node: unknown, pointer: string) => {
    if (!isObjectOrArray(node)) return;
    if (isObjectOrArray(node.ifc) && node.ifc.writeAuthorizedBy !== undefined) {
      claims.push(pointer);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "ifc") continue;
      walk(child, `${pointer}/${key}`);
    }
  };
  walk(schema, "");
  return claims;
};

describe("a claimed slot holding a link", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime(runtimePresets.patternTest({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: {},
    }));
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const asSeal = (write: (tx: IExtendedStorageTransaction) => void) =>
    runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, { kind: "builtin", builtinId: SEAL });
      write(tx);
    });

  const asMember = (write: (tx: IExtendedStorageTransaction) => void) =>
    runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "sha256:member-code",
        symbol: "repoint",
        bindingPath: ["repoint"],
      });
      write(tx);
    });

  /** The stored envelope of the document `cell` addresses. */
  const envelopeOf = (cell: Cell<unknown>) => {
    const link = cell.getAsNormalizedFullLink();
    const tx = runtime.edit();
    try {
      const stored = loadStoredCfcEnvelope(tx, {
        space: link.space,
        id: link.id,
        scope: link.scope,
      });
      expect(stored.status).toBe("loaded");
      if (stored.status !== "loaded") throw new Error("unreachable");
      return { schema: stored.schema };
    } finally {
      tx.abort();
    }
  };

  /** The box as the seal links it: the link carries no schema of its own. */
  const boxLinkFor = (box: Cell<unknown>, tx: IExtendedStorageTransaction) =>
    runtime.getCellFromLink(
      { ...box.getAsNormalizedFullLink(), schema: undefined },
      undefined,
      tx,
    );

  it("keeps the linked document's envelope its own when the writer sets the link again", async () => {
    // The room, with its slot still empty.
    const room = runtime.getCell<Room>(space, "room", ROOM_SCHEMA);
    expect(
      (await runtime.editWithRetry((tx) => {
        room.withTx(tx).set({ note: "" });
      })).error,
    ).toBeUndefined();

    // The first seal: the box comes into being, and the slot links it.
    const box = runtime.getCell<Record<string, { instance: string }>>(
      space,
      "box",
      BOX_SCHEMA,
    );
    expect(
      (await asSeal((tx) => {
        box.withTx(tx).set({});
        room.withTx(tx).key("box").set(boxLinkFor(box, tx) as never);
      })).error,
    ).toBeUndefined();
    await runtime.storageManager.synced();
    const before = envelopeOf(box);
    expect(claimsIn(before.schema)).toEqual([]);

    // The second seal: an entry into the box, and the same link written into
    // the slot again, in one transaction. The slot's schema is the slot's.
    const second = await asSeal((tx) => {
      box.withTx(tx).key("e1").set({ instance: "i1" });
      room.withTx(tx).key("box").set(boxLinkFor(box, tx) as never);
    });
    expect(second.error).toBeUndefined();
    await runtime.storageManager.synced();
    expect(box.get()).toEqual({ e1: { instance: "i1" } });
    const after = envelopeOf(box);
    // The box's schema grew by the entry it was written, as any document's
    // does; nothing of the slot's reached it: no claim, and no requirement
    // of a field the box's own entries do not name.
    expect(claimsIn(after.schema)).toEqual([]);
    expect(JSON.stringify(after.schema)).not.toContain('"extra"');
    expect(
      (after.schema as { additionalProperties?: unknown }).additionalProperties,
    ).toEqual(
      (before.schema as { additionalProperties?: unknown }).additionalProperties,
    );

    // The slot is still the seal's alone.
    const other = runtime.getCell<Record<string, never>>(
      space,
      "other-box",
      BOX_SCHEMA,
    );
    expect(
      (await asMember((tx) => {
        other.withTx(tx).set({});
        room.withTx(tx).key("box").set(boxLinkFor(other, tx) as never);
      })).error,
    ).toMatchObject({
      name: "CfcCommitRefusalError",
      reasons: [expect.stringMatching(/^writeAuthorizedBy /)],
    });
    expect(
      (await asMember((tx) => {
        room.withTx(tx).key("box").set({});
      })).error,
    ).toMatchObject({
      name: "CfcCommitRefusalError",
      reasons: [expect.stringMatching(/^writeAuthorizedBy /)],
    });
    expect(box.get()).toEqual({ e1: { instance: "i1" } });
  });
});
