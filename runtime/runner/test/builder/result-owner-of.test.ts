import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";

import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { resultOwnerOf } from "../../src/builder/result-owner-of.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { asStoredValue, seedStoredEnvelope } from "../cfc-seed-envelope.ts";

const alice = await Identity.fromPassphrase("result-owner-of alice");
const space: MemorySpace = alice.did();

describe("resultOwnerOf()", () => {
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

  /**
   * Calls `resultOwnerOf(target, field)` in a `kind` frame, a computation's
   * unless given, over a fresh transaction.
   */
  const callIn = (
    target: unknown,
    { field, kind = "lift" }: { field?: string; kind?: "handler" | "lift" } =
      {},
  ) => {
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
      return resultOwnerOf(target, field);
    } finally {
      popFrame(frame);
    }
  };

  /** The id of the document `cause` names. */
  const idOf = (cause: string): URI =>
    runtime.getCell(space, cause).getAsNormalizedFullLink().id;

  /**
   * Stores `value` at the document `cause` names, with a `result` back-link
   * to the document `owner` names when given, as setup writes one, and
   * returns the document's cell.
   */
  const seed = async (
    cause: string,
    value: FabricValue,
    owner?: string,
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    seedStoredEnvelope(
      tx,
      { space, scope: "space", id: idOf(cause), path: [] },
      {
        value,
        ...(owner === undefined ? {} : {
          result: asStoredValue(runtime.getCell(space, owner).getAsLink()),
        }),
      },
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    return runtime.getCell(space, cause);
  };

  it("names the result two documents one result owns back-link, in a computation and in a handler", async () => {
    const first = await seed("first", [], "owner");
    const second = await seed("second", {}, "owner");
    const owner = `${space}/${idOf("owner")}`;

    expect(callIn(first)).toBe(owner);
    expect(
      callIn(second.asSchema({ type: "object" }).key("anything"), {
        kind: "handler",
      }),
    )
      .toBe(owner);
  });

  it("names another result for a document another result owns", async () => {
    const mine = await seed("mine", [], "owner");
    const theirs = await seed("theirs", [], "another owner");

    expect(callIn(theirs)).not.toBe(callIn(mine));
  });

  it("names the result, given a field, only for the document that result's own field is", async () => {
    const mine = await seed("mine", [], "owner");
    const other = await seed("other", [], "owner");
    const tx = runtime.edit();
    seedStoredEnvelope(
      tx,
      { space, scope: "space", id: idOf("owner"), path: [] },
      {
        value: {
          mine: asStoredValue(mine.getAsWriteRedirectLink()),
          other: asStoredValue(other.getAsWriteRedirectLink()),
        },
      },
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    const owner = `${space}/${idOf("owner")}`;

    expect(callIn(mine, { field: "mine" })).toBe(owner);
    expect(callIn(other, { field: "other", kind: "handler" })).toBe(owner);
    expect(callIn(mine, { field: "other" })).toBeUndefined();
    expect(callIn(mine, { field: "absent" })).toBeUndefined();
  });

  it("returns `undefined` for a document no result owns, and for a target of `undefined`", async () => {
    expect(callIn(await seed("unowned", []))).toBeUndefined();
    expect(callIn(undefined)).toBeUndefined();
  });

  it("throws when called outside a handler or a reactive computation", async () => {
    const owned = await seed("owned", [], "owner");

    expect(() => resultOwnerOf(owned)).toThrow(
      "can only be called from a handler or a reactive computation",
    );
  });
});
