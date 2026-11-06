import { expect } from "@std/expect";

import {
  $conn,
  $onCellUpdate,
  type CellGetRequest,
  CellHandle,
  type CellPullRequest,
  type CellRef,
  type CellSetRequest,
  type InitializedRuntimeConnection,
  RequestType,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import { CFInput } from "./index.ts";

/**
 * A real `cf-input` over a controlled worker: each `cell:set` is answered
 * once the test commits it, and reads answer with what the worker holds.
 */
function setup() {
  const commits: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  const writes: Promise<void>[] = [];
  const reads: Promise<unknown>[] = [];
  let stored = "spaces";
  const connection = {
    signal: new AbortController().signal,
    peersOf: () => [],
    request: (request: CellGetRequest | CellPullRequest | CellSetRequest) => {
      if (request.type === RequestType.CellSet) {
        stored = request.value as string;
        const commit = Promise.withResolvers<void>();
        commits.push(commit);
        return commit.promise;
      }
      return Promise.resolve({ value: stored });
    },
    subscribe() {},
    unsubscribe() {},
  } as unknown as InitializedRuntimeConnection;
  const runtime = {
    [$conn]: () => connection,
    signal: new AbortController().signal,
  } as unknown as RuntimeClient;
  const cell = new CellHandle<string>(runtime, {
    id: "of:input-commit" as CellRef["id"],
    space: "did:key:test",
    scope: "space",
    path: [],
    schema: { type: "string" },
  }, { value: "spaces" });
  const setForUI = cell.setForUI.bind(cell);
  cell.setForUI = (value) => {
    const write = setForUI(value);
    writes.push(write);
    return write;
  };
  const pull = cell.pull.bind(cell);
  cell.pull = (options) => {
    const read = pull(options);
    reads.push(read);
    return read;
  };
  const element = document.createElement("cf-input") as CFInput;
  element.value = cell;
  element.timingStrategy = "immediate";
  const changes: string[] = [];
  element.addEventListener("cf-change", (event) => {
    changes.push((event as CustomEvent<{ value: string }>).detail.value);
  });
  document.body.append(element);
  return {
    cell,
    element,
    changes,
    store: (value: string) => stored = value,
    async type(value: string) {
      await element.updateComplete;
      expect(element).toBeInstanceOf(CFInput);
      const input = element.shadowRoot!.querySelector("input")!;
      input.value = value;
      input.dispatchEvent(
        new Event("input", { bubbles: true, composed: true }),
      );
      return input;
    },
    /** Commits every write so far and lets the reads that follow answer. */
    async commit() {
      for (const commit of commits.splice(0)) commit.resolve();
      // The controller observes each write's commit before the test does,
      // so its read has been asked for once the write has settled here.
      await Promise.all(writes);
      await Promise.all(reads);
      await element.updateComplete;
    },
  };
}

Deno.test("cf-input keeps a typed value over a stale delivery until its write commits", async () => {
  const f = setup();
  try {
    const input = await f.type("profile");
    await f.element.updateComplete;
    expect(input.value).toBe("profile");
    f.changes.length = 0;
    // The pre-write value, delivered before the commit, is stale.
    f.cell[$onCellUpdate]("spaces");
    await f.element.updateComplete;
    expect(input.value).toBe("profile");
    expect(f.changes).toEqual([]);

    await f.commit();
    expect(input.value).toBe("profile");
    expect(f.changes).toEqual([]);
    f.cell[$onCellUpdate]("favorites");
    await f.element.updateComplete;
    expect(input.value).toBe("favorites");
    expect(f.changes).toEqual(["favorites"]);
  } finally {
    await f.commit();
    f.element.remove();
  }
});

Deno.test("cf-input shows a handler's clear delivered before its write commits", async () => {
  const f = setup();
  try {
    const input = await f.type("hello");
    await f.element.updateComplete;
    f.changes.length = 0;
    // A handler clears the draft; its delivery precedes the commit's answer,
    // and nothing follows it.
    f.store("");
    f.cell[$onCellUpdate]("");
    await f.element.updateComplete;
    expect(input.value).toBe("hello");

    await f.commit();
    expect(input.value).toBe("");
    expect(f.changes).toEqual([""]);
  } finally {
    await f.commit();
    f.element.remove();
  }
});
