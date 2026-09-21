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

describe("CellController", () => {
  it("shows a handler clear delivered before the input write acknowledgment", async () => {
    const signer = await Identity.fromPassphrase("ui-handler-reconciliation");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const schema = { type: "string" } as const;
    const draft = runtime.getCell<string>(signer.did(), "draft", schema);
    const eventSchema = { asCell: ["stream"], type: "object" } as const;
    const submit = runtime.getCell(signer.did(), "submit", eventSchema);
    const release = Promise.withResolvers<void>();
    const written = Promise.withResolvers<void>();
    const cleared = Promise.withResolvers<void>();
    let writing: Promise<void> | undefined;
    let controller: StringCellController | undefined;
    let cancelHandler: (() => void) | undefined;
    const originalCommit = runtime.commitUiCellWrite.bind(runtime);
    // Hold completion after the real storage commit. The scheduler remains
    // free to run a following event while the caller still awaits its receipt.
    using _commit = stub(runtime, "commitUiCellWrite", async (...args) => {
      const result = await originalCommit(...args);
      written.resolve();
      await release.promise;
      return result;
    });
    try {
      const seed = runtime.edit();
      draft.withTx(seed).set("initial");
      runtime.prepareTxForCommit(seed);
      expect((await seed.commit()).error).toBeUndefined();
      const processor = buildProcessor({ runtime });
      const workerClient: WorkerClient = {
        id: 1,
        post(message) {
          if (
            "type" in message && message.type === NotificationType.CellUpdate
          ) {
            handle[$onCellUpdate](message.value);
            if (message.value === "") cleared.resolve();
          }
          return true;
        },
      };
      const connection = {
        request: (request: IPCClientRequest) =>
          processor.handleRequest(request, workerClient),
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
      const handle = new CellHandle<string>(
        client,
        createCellRef(draft, schema),
      );
      const event = new CellHandle(client, createCellRef(submit, eventSchema));
      const originalSet = handle.setForUI.bind(handle);
      using _set = stub(
        handle,
        "setForUI",
        (value) => writing = originalSet(value),
      );
      const host: ReactiveControllerHost = {
        addController() {},
        removeController() {},
        requestUpdate() {},
        updateComplete: Promise.resolve(true),
      };
      controller = new StringCellController(host, {
        timing: { strategy: "immediate" },
      });
      controller.bind(handle);
      const submitted: string[] = [];
      cancelHandler = runtime.scheduler.addEventHandler((tx) => {
        submitted.push(draft.withTx(tx).get());
        draft.withTx(tx).set("");
      }, submit.getAsNormalizedFullLink());

      controller.setValue("hello");
      await written.promise;
      await event.send({});
      await cleared.promise;
      expect(submitted).toEqual(["hello"]);
      expect(handle.get()).toBe("");
      expect(controller.getValue()).toBe("hello");
      release.resolve();
      await writing;
      // A queued read fences the controller's post-commit reconciliation.
      await handle.sync();
      expect(controller.getValue()).toBe("");
    } finally {
      release.resolve();
      await writing;
      controller?.hostDisconnected();
      cancelHandler?.();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
