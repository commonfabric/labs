import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { ViewInterest, ViewPlan } from "@commonfabric/memory/v2";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { Runtime } from "../src/runtime.ts";
import { pullFromServer } from "../src/served-read.ts";

/** A replica's view surface, whose owner and plans a case drives by hand. */
function fixture(
  options: {
    supports?: boolean;
    set?: () => Promise<boolean>;
    schema?: JSONSchema;
  } = {},
) {
  const state: {
    views: ViewInterest[];
    released: boolean;
    supported: boolean;
    retire?: () => void;
    plans?: (plans: readonly ViewPlan[]) => void;
    registered: PromiseWithResolvers<void>;
  } = {
    views: [],
    released: false,
    supported: true,
    registered: Promise.withResolvers(),
  };
  const replica = {
    supportsViewReplication: () => Promise.resolve(options.supports ?? true),
    viewReplicationSupported: () => state.supported,
    acquireViewInterests: (onReplaced: () => void) => {
      state.retire = onReplaced;
      return {
        nextRevision: () => 7,
        set: (views: ViewInterest[]) => {
          state.views = views;
          state.registered.resolve();
          return options.set?.() ?? Promise.resolve(true);
        },
        release: () => {
          state.released = true;
        },
      };
    },
    subscribeViewPlans: (observer: (plans: readonly ViewPlan[]) => void) => {
      state.plans = observer;
      return () => {
        state.plans = undefined;
      };
    },
  };
  const runtime = {
    storageManager: { open: () => ({ replica }) },
  } as unknown as Runtime;
  const cell = {
    path: ["index"],
    getAsNormalizedFullLink: () => ({
      space: "did:key:space",
      id: "of:board",
      scope: "space",
      path: ["index"],
      schema: "schema" in options ? options.schema : { type: "array" },
    }),
  } as unknown as Cell<unknown>;
  const plan = (fields: Partial<ViewPlan>): ViewPlan => ({
    id: state.views[0].id,
    revision: 7,
    generation: 1,
    eligibleActions: [],
    pieces: [],
    ...fields,
  });
  return { state, runtime, cell, plan };
}

describe("pullFromServer()", () => {
  it("registers a `read` view over the cell's document, path and schema", async () => {
    const { state, runtime, cell, plan } = fixture();

    const pulling = pullFromServer(runtime, cell);
    await state.registered.promise;

    expect(state.views).toHaveLength(1);
    expect(state.views[0].mode).toBe("read");
    expect(state.views[0].query.roots).toEqual([{
      id: "of:board",
      scope: "space",
      selector: { path: ["index"], schema: { type: "array" } },
    }]);
    state.plans!([plan({ settled: true })]);
    await pulling;
  });

  it("registers no schema for a cell that has none or that declares a stream", async () => {
    const stream: JSONSchema = { asCell: ["stream"] };
    for (const schema of [undefined, stream]) {
      const { state, runtime, cell, plan } = fixture({ schema });

      const pulling = pullFromServer(runtime, cell);
      await state.registered.promise;

      expect(state.views[0].query.roots[0].selector.schema).toBe(false);
      state.plans!([plan({ settled: true })]);
      await pulling;
    }
  });

  it("returns `true` for its own view's plan marked `settled`, and releases the view", async () => {
    const { state, runtime, cell, plan } = fixture();

    const pulling = pullFromServer(runtime, cell);
    await state.registered.promise;
    state.plans!([plan({ settled: true })]);

    expect(await pulling).toBe(true);
    expect(state.released).toBe(true);
    expect(state.plans).toBeUndefined();
  });

  it("waits past a plan with no `settled` mark, and past another view's or revision's", async () => {
    const { state, runtime, cell, plan } = fixture();
    let answered = false;

    const pulling = pullFromServer(runtime, cell).then((answer) => {
      answered = true;
      return answer;
    });
    await state.registered.promise;
    state.plans!([plan({})]);
    state.plans!([plan({ id: "another", settled: true })]);
    state.plans!([plan({ revision: 6, settled: true })]);
    await Promise.resolve();
    expect(answered).toBe(false);

    state.plans!([plan({ settled: true })]);
    expect(await pulling).toBe(true);
  });

  it("returns `false` from a server with no view protocol, registering nothing", async () => {
    const { state, runtime, cell } = fixture({ supports: false });

    expect(await pullFromServer(runtime, cell)).toBe(false);
    expect(state.views).toEqual([]);
  });

  it("returns `false` when the registration is not current", async () => {
    const { runtime, cell } = fixture({ set: () => Promise.resolve(false) });

    expect(await pullFromServer(runtime, cell)).toBe(false);
  });

  it("returns `false` from a server that refuses the view's mode", async () => {
    const refused = new Error("Unable to parse memory message");
    refused.name = "InvalidMessageError";
    const { state, runtime, cell } = fixture({
      set: () => Promise.reject(refused),
    });

    expect(await pullFromServer(runtime, cell)).toBe(false);
    expect(state.released).toBe(true);
  });

  it("rethrows a refusal of any other kind", async () => {
    const refused = new Error("A changed view requires a newer revision");
    refused.name = "ProtocolError";
    const { runtime, cell } = fixture({ set: () => Promise.reject(refused) });

    await expect(pullFromServer(runtime, cell)).rejects.toThrow(
      "newer revision",
    );
  });

  it("returns `false` when a reconnect finds the view protocol gone", async () => {
    const { state, runtime, cell } = fixture();

    const pulling = pullFromServer(runtime, cell);
    await state.registered.promise;
    state.supported = false;
    state.plans!([]);

    expect(await pulling).toBe(false);
  });

  it("rethrows a registration failure of any other kind", async () => {
    const { runtime, cell } = fixture({
      set: () => Promise.reject(new Error("the socket closed")),
    });

    await expect(pullFromServer(runtime, cell)).rejects.toThrow(
      "the socket closed",
    );
  });

  it("throws when another view owner replaces this one", async () => {
    const { state, runtime, cell } = fixture();

    const pulling = pullFromServer(runtime, cell);
    await state.registered.promise;
    state.retire!();

    await expect(pulling).rejects.toThrow("replaced this read");
  });
});
