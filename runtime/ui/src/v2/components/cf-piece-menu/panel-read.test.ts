import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  $conn,
  CellHandle,
  type CellRef,
  RequestType,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import {
  createMockCellHandle,
  pushRefusal,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";
import { NOT_READ, PanelRead } from "./panel-read.ts";

const REF: CellRef = {
  id: "of:panel-read" as CellRef["id"],
  space: "did:key:panel-read" as CellRef["space"],
  scope: "space",
  path: [],
  schema: { type: "object" },
};

/**
 * A record cell whose worker leaves each request for its list of fields
 * unanswered until the test answers it through `lists`, in the order asked.
 */
function cellWithHeldFieldLists(): {
  cell: CellHandle<Record<string, unknown>>;
  lists: Array<PromiseWithResolvers<unknown>>;
} {
  const lists: Array<PromiseWithResolvers<unknown>> = [];
  const conn = {
    subscribe: () => {},
    unsubscribe: () => Promise.resolve(),
    peersOf: () => [],
    request: (request: { type: string }) => {
      if (request.type !== RequestType.CellFields) return Promise.resolve({});
      const list = Promise.withResolvers<unknown>();
      lists.push(list);
      return list.promise;
    },
  };
  const runtime = {
    [$conn]: () => conn,
    signal: { aborted: false },
  } as unknown as RuntimeClient;
  return {
    cell: new CellHandle<Record<string, unknown>>(runtime, REF, {
      value: { title: "first" },
    }),
    lists,
  };
}

describe("PanelRead", () => {
  it("is neither loaded nor ready, and shows nothing, until the worker answers", () => {
    const cell = createMockCellHandle<Record<string, unknown>>();
    let changes = 0;
    const read = new PanelRead(cell, () => changes++);

    expect(read.loaded).toBe(false);
    expect(read.ready).toBe(false);
    expect(read.shown()).toBeUndefined();
    expect(changes).toBe(0);

    pushUpdate(cell, { title: "answered" });

    expect(read.loaded).toBe(true);
    expect(read.ready).toBe(true);
    expect(read.shown()).toEqual({ title: "answered" });
    expect(changes).toBe(1);
    read.cancel();
  });

  it("takes no failed list of fields asked for before the whole was admitted again", async () => {
    // The list asked for under the first refusal fails after the whole was
    // admitted. Under the second refusal the panel waits on its own list,
    // rather than showing the stale failure as not read.
    const time = new FakeTime();
    const { cell, lists } = cellWithHeldFieldLists();
    const read = new PanelRead(cell, () => {});
    try {
      pushRefusal(cell);
      pushUpdate(cell, { title: "admitted" });
      lists[0].reject(new Error("the space refused the worker"));
      await time.runMicrotasks();
      pushRefusal(cell);
      await time.runMicrotasks();

      expect(lists).toHaveLength(2);
      expect(read.refused).toBe(true);
      expect(read.ready).toBe(false);
      expect(read.shown()).not.toBe(NOT_READ);
    } finally {
      read.cancel();
      time.restore();
    }
  });
});
