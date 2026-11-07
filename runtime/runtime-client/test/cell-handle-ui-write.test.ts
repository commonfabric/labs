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

/** A request as the tests here record it. */
type Recorded = {
  type: RequestType;
  value?: unknown;
  values?: unknown[];
  awaitCommit?: boolean;
};

/** A runtime client whose connection answers each request through `answer`. */
function client(
  answer: (request: Recorded) => Promise<unknown>,
): RuntimeClient {
  return {
    [$conn]: () => ({
      request: answer,
      signal: new AbortController().signal,
      peersOf: () => [],
      subscribe: () => Promise.resolve(),
      unsubscribe: () => Promise.resolve(),
    }),
    signal: new AbortController().signal,
  } as unknown as RuntimeClient;
}

describe("cell-handle-ui-write", () => {
  describe("CellHandle.setForUI()", () => {
    it("shows the value at once and settles once the write commits", async () => {
      const commit = Promise.withResolvers<void>();
      const requests: Recorded[] = [];
      const cell = new CellHandle(
        client((request) => {
          requests.push(request);
          return commit.promise;
        }),
        ref,
        { value: "initial" },
      );
      const delivered: Array<string | undefined> = [];
      cell.subscribe((value) => {
        delivered.push(value);
      }, { onRefused() {} });
      let done = false;
      const writing = cell.setForUI("typed").then(() => {
        done = true;
      });
      try {
        expect(cell.get()).toBe("typed");
        expect(delivered).toEqual(["initial", "typed"]);
        await Promise.resolve();
        expect(requests).toEqual([{
          type: RequestType.CellSet,
          cell: ref,
          value: "typed",
          awaitCommit: true,
        }]);
        expect(done).toBe(false);
        commit.resolve();
        await writing;
        expect(done).toBe(true);
      } finally {
        commit.resolve();
        await writing;
      }
    });

    it("dispatches successive input and a following event before either write commits", async () => {
      const first = Promise.withResolvers<void>();
      const second = Promise.withResolvers<void>();
      const requests: Recorded[] = [];
      const cell = new CellHandle(
        client((request) => {
          requests.push(request);
          if (request.type === RequestType.CellSet) {
            return request.value === "first" ? first.promise : second.promise;
          }
          return Promise.resolve();
        }),
        ref,
        { value: "initial" },
      );
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
        expect(cell.get()).toBe("second");

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

    it("lets an update queued behind it compute from the value it wrote", async () => {
      const commit = Promise.withResolvers<void>();
      const written: unknown[] = [];
      const cell = new CellHandle(
        client((request) => {
          if (request.type !== RequestType.CellSet) return Promise.resolve();
          written.push(request.value);
          return written.length === 1 ? commit.promise : Promise.resolve();
        }),
        ref,
        { value: "initial" },
      );
      const writing = cell.setForUI("typed");
      try {
        await cell.update((current) => `${current}!`);
        expect(written).toEqual(["typed", "typed!"]);
        expect(cell.get()).toBe("typed!");
      } finally {
        commit.resolve();
        await writing;
      }
    });

    it("rejects refusal and keeps the value shown for its subscribers to replace", async () => {
      const cell = new CellHandle(
        client(() => Promise.reject(new Error("refused"))),
        ref,
        { value: "initial" },
      );
      await expect(cell.setForUI("requested")).rejects.toThrow("refused");
      expect(cell.get()).toBe("requested");
      cell[$onCellUpdate]("initial");
      expect(cell.get()).toBe("initial");
    });

    it("rejects a synchronous dispatch failure and accepts subsequent operations", async () => {
      const failure = new Error("transport send failed");
      const values: unknown[] = [];
      const cell = new CellHandle(
        client((request) => {
          if (request.value === "refused") throw failure;
          values.push(request.value);
          return Promise.resolve();
        }),
        ref,
        { value: "initial" },
      );
      await expect(cell.setForUI("refused")).rejects.toBe(failure);
      await cell.setForUI("accepted");
      await cell.send("submit");
      expect(values).toHaveLength(2);
      expect(values[0]).toBe("accepted");
    });

    it("leaves a queued strict operation ahead of the UI dispatch", async () => {
      const strict = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const requests: unknown[] = [];
      const cell = new CellHandle(
        client((request) => {
          requests.push(request.value);
          if (request.value === "strict") {
            started.resolve();
            return strict.promise;
          }
          return Promise.resolve();
        }),
        ref,
        { value: "initial" },
      );
      const first = cell.setStrict("strict");
      const second = cell.setForUI("ui");
      try {
        await started.promise;
        expect(requests).toEqual(["strict"]);
        strict.resolve();
        await Promise.all([first, second]);
        expect(requests).toEqual(["strict", "ui"]);
        // The earlier strict receipt must not publish over newer UI intent.
        expect(cell.get()).toBe("ui");
      } finally {
        strict.resolve();
        await Promise.all([first, second]);
      }
    });
  });

  describe("CellHandle.update() with awaitCommit", () => {
    it("settles once the write commits, rejecting its refusal", async () => {
      const commit = Promise.withResolvers<void>();
      const requests: Recorded[] = [];
      const cell = new CellHandle<number>(
        client((request) => {
          requests.push(request);
          return commit.promise;
        }),
        { ...ref, schema: { type: "number" } },
        { value: 1 },
      );
      let done = false;
      const writing = cell.update((current) => (current ?? 0) + 1, {
        awaitCommit: true,
      }).then(() => {
        done = true;
      });
      try {
        await Promise.resolve();
        expect(cell.get()).toBe(2);
        expect(requests).toEqual([{
          type: RequestType.CellSet,
          cell: { ...ref, schema: { type: "number" } },
          value: 2,
          awaitCommit: true,
        }]);
        expect(done).toBe(false);
        commit.reject(new Error("refused"));
        await expect(writing).rejects.toThrow("refused");
      } finally {
        commit.reject(new Error("refused"));
        await writing.catch(() => {});
      }
    });

    it("ends its turn as the write is sent, with the next update computing from it", async () => {
      const commit = Promise.withResolvers<void>();
      const written: unknown[] = [];
      const cell = new CellHandle<number>(
        client((request) => {
          written.push(request.value);
          return written.length === 1 ? commit.promise : Promise.resolve();
        }),
        { ...ref, schema: { type: "number" } },
        { value: 1 },
      );
      const first = cell.update((current) => (current ?? 0) + 1, {
        awaitCommit: true,
      });
      try {
        await cell.update((current) => (current ?? 0) * 10);
        expect(written).toEqual([2, 20]);
        expect(cell.get()).toBe(20);
      } finally {
        commit.resolve();
        await first;
      }
    });
  });
});
