import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  $conn,
  $onCellUpdate,
  CellHandle,
  type CellRef,
  RequestType,
  type RuntimeClient,
} from "@/mod.ts";

/** Address shared by the test's independently controlled handles. */
const ref: CellRef = {
  id: "of:ui-write" as CellRef["id"],
  space: "did:key:test",
  scope: "space",
  path: [],
  schema: { type: "string" },
};

describe("CellHandle.setForUI()", () => {
  it("dispatches successive input and a following event before either write commits", async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const requests: Array<
      { type: RequestType; value?: string; awaitCommit?: boolean }
    > = [];
    const runtime = {
      [$conn]: () => ({
        request: (request: typeof requests[number]) => {
          requests.push(request);
          if (request.type === RequestType.CellSet) {
            return request.value === "first" ? first.promise : second.promise;
          }
          return Promise.resolve();
        },
      }),
    } as unknown as RuntimeClient;
    const cell = new CellHandle(runtime, ref, "initial");
    let firstDone = false;
    let secondDone = false;
    const writingFirst = cell.setForUI("first").then(() => {
      firstDone = true;
    });
    const writingSecond = cell.setForUI("second").then(() => {
      secondDone = true;
    });
    try {
      await cell.send("submit");
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.CellSet,
        RequestType.CellSet,
        RequestType.CellSend,
      ]);
      expect(requests.slice(0, 2).map(({ awaitCommit }) => awaitCommit))
        .toEqual([true, true]);
      expect(firstDone).toBe(false);
      expect(secondDone).toBe(false);
      expect(cell.get()).toBe("initial");

      cell[$onCellUpdate]("second");
      second.resolve();
      await writingSecond;
      expect(firstDone).toBe(false);
      first.resolve();
      await writingFirst;
      expect(cell.get()).toBe("second");
    } finally {
      first.resolve();
      second.resolve();
      await Promise.all([writingFirst, writingSecond]);
    }
  });

  it("rejects refusal without publishing the requested value", async () => {
    const runtime = {
      [$conn]: () => ({ request: () => Promise.reject(new Error("refused")) }),
    } as unknown as RuntimeClient;
    const cell = new CellHandle(runtime, ref, "initial");
    await expect(cell.setForUI("requested")).rejects.toThrow("refused");
    expect(cell.get()).toBe("initial");
  });

  it("rejects a synchronous dispatch failure and accepts subsequent operations", async () => {
    const failure = new Error("transport send failed");
    const values: string[] = [];
    const runtime = {
      [$conn]: () => ({
        request: (request: { type: RequestType; value: string }) => {
          if (request.value === "refused") throw failure;
          values.push(request.value);
          return Promise.resolve();
        },
      }),
    } as unknown as RuntimeClient;
    const cell = new CellHandle(runtime, ref, "initial");
    await expect(cell.setForUI("refused")).rejects.toBe(failure);
    expect(cell.get()).toBe("initial");
    await cell.setForUI("accepted");
    await cell.send("submit");
    expect(values).toHaveLength(2);
    expect(values[0]).toBe("accepted");
  });

  it("leaves a queued strict operation ahead of the UI dispatch", async () => {
    const strict = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const requests: string[] = [];
    const runtime = {
      [$conn]: () => ({
        request: (request: { value: string }) => {
          requests.push(request.value);
          if (request.value === "strict") {
            started.resolve();
            return strict.promise;
          }
          return Promise.resolve();
        },
      }),
    } as unknown as RuntimeClient;
    const cell = new CellHandle(runtime, ref, "initial");
    const first = cell.setStrict("strict");
    const second = cell.setForUI("ui");
    try {
      await started.promise;
      expect(requests).toEqual(["strict"]);
      strict.resolve();
      await Promise.all([first, second]);
      expect(requests).toEqual(["strict", "ui"]);
      // The earlier strict receipt must not publish over newer UI intent.
      expect(cell.get()).toBe("initial");
    } finally {
      strict.resolve();
      await Promise.all([first, second]);
    }
  });

  it("preserves dispatch order through a UI replacement and a native append", async () => {
    const gate = Promise.withResolvers<void>();
    const requests: Array<
      { type: RequestType; value?: unknown; values?: unknown[] }
    > = [];
    const runtime = {
      [$conn]: () => ({
        request: (request: typeof requests[number]) => {
          requests.push(request);
          if (
            request.type === RequestType.CellSet && request.value !== undefined
          ) {
            return (request.value as number[])[0] === 1
              ? gate.promise
              : Promise.resolve();
          }
          return Promise.resolve();
        },
      }),
    } as unknown as RuntimeClient;
    const cell = new CellHandle<number[]>(runtime, {
      ...ref,
      schema: { type: "array", items: { type: "number" } },
    }, [0]);
    const first = cell.setStrict([1]);
    const ui = cell.setForUI([2]);
    const append = cell.pushStrict(3);
    gate.resolve();
    await Promise.all([first, ui, append]);
    expect(requests.map(({ type }) => type)).toEqual([
      RequestType.CellSet,
      RequestType.CellSet,
      RequestType.CellPush,
    ]);
    expect(requests[1].value).toEqual([2]);
    expect(requests[2].values).toEqual([3]);
    cell[$onCellUpdate]([2, 3]);
    expect(cell.get()).toEqual([2, 3]);
  });
});
