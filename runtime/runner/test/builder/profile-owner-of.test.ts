import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";

import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { profileOwnerOf } from "../../src/builder/profile-owner-of.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const alice = await Identity.fromPassphrase("profile-owner-of alice");
const bob = await Identity.fromPassphrase("profile-owner-of bob");
const space: MemorySpace = alice.did();

/** An entry at the root claiming the profile represents each of `subjects`. */
const representing = (...subjects: string[]) => ({
  path: [],
  label: {
    integrity: subjects.map((subject) => ({
      kind: "represents-principal",
      subject,
    })),
  },
  origin: "declared",
});

describe("profileOwnerOf()", () => {
  let runtime: Runtime;
  let storage: ReturnType<typeof StorageManager.emulate>;
  let openTxs: IExtendedStorageTransaction[];

  beforeEach(() => {
    openTxs = [];
    storage = StorageManager.emulate({ as: alice });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    for (const tx of openTxs) tx.abort(new Error("test-only"));
    await runtime.idle();
    await runtime.dispose();
    await storage.close();
  });

  /** Calls `profileOwnerOf(target)` in a `kind` frame over a fresh transaction. */
  const callIn = (target: unknown, kind: "handler" | "lift" = "lift") => {
    const tx = runtime.edit();
    openTxs.push(tx);
    const frame = pushFrame({
      runtime,
      tx,
      space,
      frameKind: kind,
      ...(kind === "handler" ? { inHandler: true } : {}),
    });
    try {
      return profileOwnerOf(target);
    } finally {
      popFrame(frame);
    }
  };

  /** The id of the document `cause` names. */
  const idOf = (cause: string): URI =>
    runtime.getCell(space, cause).getAsNormalizedFullLink().id;

  /**
   * Stores `value` at the document `cause` names with a root label claiming
   * it represents each of `subjects`, or with no label for none.
   */
  const seed = async (
    cause: string,
    value: FabricValue,
    ...subjects: string[]
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(
      tx,
      { space, scope: "space", id: idOf(cause), path: [] },
      {
        value,
        ...(subjects.length === 0 ? {} : {
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: { version: 1, entries: [representing(...subjects)] },
          },
        }),
      },
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    return runtime.getCell(space, cause);
  };

  it("returns the principal a profile whose name it holds itself represents, in a computation and in a handler", async () => {
    const profile = await seed("profile", { name: "Bob" }, bob.did());

    expect(callIn(profile)).toBe(bob.did());
    expect(callIn(profile, "handler")).toBe(bob.did());
  });

  it("returns `undefined` for a document carrying no label", async () => {
    expect(callIn(await seed("profile", { name: "Bob" }))).toBeUndefined();
  });

  it("returns `undefined` for a profile said to represent two principals", async () => {
    const profile = await seed(
      "profile",
      { name: "Bob" },
      bob.did(),
      alice.did(),
    );

    expect(callIn(profile)).toBeUndefined();
  });

  it("returns `undefined` for a profile whose name links to a document beside it that names no owner", async () => {
    const name = await seed("a name", "Bob");
    const profile = await seed(
      "profile",
      { name: name.getAsLink() },
      bob.did(),
    );

    expect(callIn(profile)).toBeUndefined();
  });

  it("returns `undefined` for a target of `undefined`", () => {
    expect(callIn(undefined)).toBeUndefined();
  });

  it("throws when called outside a handler or a reactive computation", async () => {
    const profile = await seed("profile", { name: "Bob" }, bob.did());

    expect(() => profileOwnerOf(profile)).toThrow(
      "can only be called from a handler or a reactive computation",
    );
  });
});
