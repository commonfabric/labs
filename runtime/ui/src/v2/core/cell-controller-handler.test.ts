import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { ReactiveControllerHost } from "lit";

import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  $conn,
  $onCellUpdate,
  CellHandle,
  type InitializedRuntimeConnection,
  type IPCClientRequest,
  NotificationType,
  RequestType,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import { createCellRef } from "../../../../runtime-client/src/backends/utils.ts";
import type { WorkerClient } from "../../../../runtime-client/src/backends/worker-client.ts";
import { buildProcessor } from "../../../../runtime-client/test/backends/build-processor.ts";
import { StringCellController } from "./cell-controller.ts";

/**
 * A controller and a handle over a real runtime, behind an in-process
 * processor whose channel the test controls: each write's answer waits for
 * `release`, and what the worker posted is delivered before each answer, as
 * the channel's order has it, or when the test says.
 */
async function setup(passphrase: string) {
  const signer = await Identity.fromPassphrase(passphrase);
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const schema = { type: "string" } as const;
  const draft = runtime.getCell<string>(signer.did(), "draft", schema);
  const seed = runtime.edit();
  draft.withTx(seed).set("initial");
  runtime.prepareTxForCommit(seed);
  expect((await seed.commit().settled).error).toBeUndefined();
  const processor = buildProcessor({ runtime });
  const held: unknown[] = [];
  const delivered: unknown[] = [];
  const reads: Promise<unknown>[] = [];
  const posts = new Map<unknown, PromiseWithResolvers<void>>();
  /** Settles once the worker has posted `value`. */
  const posted = (value: unknown) => {
    let post = posts.get(value);
    if (post === undefined) {
      post = Promise.withResolvers<void>();
      posts.set(value, post);
    }
    return post.promise;
  };
  const deliver = () => {
    for (const value of held.splice(0)) {
      delivered.push(value);
      handle[$onCellUpdate](value);
    }
  };
  const workerClient: WorkerClient = {
    id: 1,
    post(message) {
      if ("type" in message && message.type === NotificationType.CellUpdate) {
        held.push(message.value);
        void posted(message.value);
        posts.get(message.value)!.resolve();
      }
      return true;
    },
  };
  const release = Promise.withResolvers<void>();
  const connection = {
    signal: new AbortController().signal,
    peersOf: () => [],
    request: async (request: IPCClientRequest) => {
      const answer = await processor.handleRequest(request, workerClient);
      if (request.type === RequestType.CellSet) await release.promise;
      deliver();
      return answer;
    },
    subscribe: (cell: CellHandle) =>
      Promise.resolve(processor.handleCellSubscribe({
        type: RequestType.CellSubscribe,
        cell: cell.ref(),
      }, workerClient)),
    unsubscribe: (cell: CellHandle) =>
      Promise.resolve(processor.handleCellUnsubscribe({
        type: RequestType.CellUnsubscribe,
        cell: cell.ref(),
      }, workerClient)),
  } as unknown as InitializedRuntimeConnection;
  const client = {
    [$conn]: () => connection,
    signal: new AbortController().signal,
  } as unknown as RuntimeClient;
  const handle = new CellHandle<string>(client, createCellRef(draft, schema));
  const pull = handle.pull.bind(handle);
  handle.pull = (options) => {
    const read = pull(options);
    reads.push(read);
    return read;
  };
  const host: ReactiveControllerHost = {
    addController() {},
    removeController() {},
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
  };
  const controller = new StringCellController(host, {
    timing: { strategy: "immediate" },
  });
  return {
    runtime,
    signer,
    draft,
    client,
    handle,
    controller,
    delivered,
    deliver,
    posted,
    release,
    reads: () => Promise.all(reads.map((read) => read.catch(() => {}))),
    async dispose() {
      release.resolve();
      controller.hostDisconnected();
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

describe("CellController", () => {
  it("shows a handler clear delivered before the input write acknowledgment", async () => {
    // The write commits; its acknowledgment is held while a handler clears
    // the draft and that clear reaches the handle. No delivery follows the
    // acknowledgment.

    const f = await setup("ui-handler-reconciliation");
    const eventSchema = { asCell: ["stream"], type: "object" } as const;
    const submit = f.runtime.getCell(f.signer.did(), "submit", eventSchema);
    const event = new CellHandle(f.client, createCellRef(submit, eventSchema));
    const written = Promise.withResolvers<void>();
    const originalCommit = f.runtime.commitUiCellWrite.bind(f.runtime);
    using _commit = stub(f.runtime, "commitUiCellWrite", async (...args) => {
      const result = await originalCommit(...args);
      written.resolve();
      return result;
    });
    let writing: Promise<void> | undefined;
    const originalSet = f.handle.setForUI.bind(f.handle);
    using _set = stub(
      f.handle,
      "setForUI",
      (value) => writing = originalSet(value),
    );
    let cancelHandler: (() => void) | undefined;
    try {
      f.controller.bind(f.handle);
      const submitted: string[] = [];
      cancelHandler = f.runtime.scheduler.addEventHandler((tx) => {
        submitted.push(f.draft.withTx(tx).get());
        f.draft.withTx(tx).set("");
      }, submit.getAsNormalizedFullLink());

      f.controller.setValue("hello");
      await written.promise;
      await event.send({});
      await f.posted("");
      f.deliver();
      expect(submitted).toEqual(["hello"]);
      expect(f.delivered).toEqual(["initial", "hello", ""]);
      expect(f.handle.get()).toBe("");
      expect(f.controller.getValue()).toBe("hello");
      f.release.resolve();
      await writing;
      await f.reads();
      expect(f.controller.getValue()).toBe("");
    } finally {
      f.release.resolve();
      await writing;
      cancelHandler?.();
      await f.dispose();
    }
  });

  it("keeps a typed value through the subscription's first delivery and the write's echo", async () => {
    // The subscription's first delivery, of the pre-write value, precedes
    // the commit's acknowledgment; the write's echo may follow it.

    const f = await setup("ui-stale-before-commit");
    let writing: Promise<void> | undefined;
    const originalSet = f.handle.setForUI.bind(f.handle);
    using _set = stub(
      f.handle,
      "setForUI",
      (value) => writing = originalSet(value),
    );
    try {
      f.controller.bind(f.handle);
      f.controller.setValue("hello");
      f.release.resolve();
      await writing;
      expect(f.delivered[0]).toBe("initial");
      expect(f.controller.getValue()).toBe("hello");
      await f.reads();
      expect(f.controller.getValue()).toBe("hello");
      await f.posted("hello");
      f.deliver();
      expect(f.delivered).toEqual(["initial", "hello"]);
      expect(f.controller.getValue()).toBe("hello");
      expect(f.handle.get()).toBe("hello");
    } finally {
      await writing;
      await f.dispose();
    }
  });
});
