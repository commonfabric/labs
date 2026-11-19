import { UNAVAILABLE_PENDING } from "@commonfabric/data-model/availability";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricPlainObject } from "@commonfabric/data-model";

import {
  computeInputHashFromValue,
  releaseFetchMutexClaim,
  tryWriteResult,
} from "../src/builtins/fetch-utils.ts";
import type { Cell } from "../src/cell.ts";
import type { Runtime } from "../src/runtime.ts";

describe("fetch retry edge paths", () => {
  it("rejects result publication while the live input is unavailable", async () => {
    const input = {
      withTx() {
        return this;
      },
      getRaw() {
        return UNAVAILABLE_PENDING;
      },
    } as unknown as Cell<FabricPlainObject>;
    const runtime = {
      editWithRetry<T>(action: (tx: unknown) => T) {
        return Promise.resolve({ ok: action({}) });
      },
    } as unknown as Runtime;

    const wrote = await tryWriteResult(
      runtime,
      {} as Cell<any>,
      input,
      computeInputHashFromValue({ url: "/value" }),
      () => {
        throw new Error("must not publish");
      },
      (cell) => cell.getRaw() as FabricPlainObject,
    );

    expect(wrote).toEqual({ written: false });
  });

  it("releases only the matching generic-fetch claim", async () => {
    const state = {
      inputHash: "input-hash",
      requestId: "owner",
      lastActivity: 42,
    };
    const internal = {
      withTx() {
        return this;
      },
      get() {
        return { ...state };
      },
      update(value: Partial<typeof state>) {
        Object.assign(state, value);
      },
    } as unknown as Cell<any>;
    const runtime = {
      editWithRetry<T>(action: (tx: unknown) => T) {
        return Promise.resolve({ ok: action({}) });
      },
    } as unknown as Runtime;

    await releaseFetchMutexClaim(runtime, internal, "input-hash", "owner");
    expect(state.requestId).toBe("");
    expect(state.lastActivity).toBe(0);

    state.requestId = "new-owner";
    state.lastActivity = 99;
    await releaseFetchMutexClaim(runtime, internal, "input-hash", "old-owner");
    expect(state.requestId).toBe("new-owner");
    expect(state.lastActivity).toBe(99);
  });
});
