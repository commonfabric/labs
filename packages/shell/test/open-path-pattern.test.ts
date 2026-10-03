/**
 * The shell's `?path=` deep link against compiled patterns and a real worker:
 * a `RuntimeProcessor` over a runtime that runs each piece, answering the
 * host's `CellHandle` across an in-process transport. A handler a pattern
 * exports is stored as a link whose schema declares the stream, and the host
 * sees that schema only as a reference it cannot resolve, so these are the
 * cases a stand-in connection cannot speak for.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  $conn,
  CellHandle,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import { ensureCompilerStack } from "../../runner/src/harness/deferred-compiler-stack.ts";
import type { RuntimeProcessor } from "../../runtime-client/src/backends/runtime-processor.ts";
import { createCellRef } from "../../runtime-client/src/backends/utils.ts";
import { RuntimeConnection } from "../../runtime-client/src/client/connection.ts";
import { EventEmitter } from "../../runtime-client/src/client/emitter.ts";
import type {
  RuntimeTransport,
  RuntimeTransportEvents,
} from "../../runtime-client/src/client/transport.ts";
import {
  type InitializationData,
  type IPCClientMessage,
  type IPCClientNotification,
  type IPCRemoteMessage,
  RequestType,
} from "../../runtime-client/src/protocol/mod.ts";
import { buildProcessor } from "../../runtime-client/test/backends/build-processor.ts";
import { deliverOpenPath } from "../src/lib/open-path.ts";

await ensureCompilerStack();

/**
 * Hands each request to `processor` and each answer back, through the realm
 * encoding the real channel uses, as the worker entry does.
 */
class InProcessTransport extends EventEmitter<RuntimeTransportEvents>
  implements RuntimeTransport {
  readonly #processor: RuntimeProcessor;

  constructor(processor: RuntimeProcessor) {
    super();
    this.#processor = processor;
  }

  send(original: IPCClientMessage | IPCClientNotification): void {
    const message = cross(original);
    if (!("msgId" in message)) return;
    const { msgId, data } = message;
    if (
      data.type === RequestType.Initialize || data.type === RequestType.Dispose
    ) {
      queueMicrotask(() => this.emit("message", { msgId }));
      return;
    }
    void Promise.resolve()
      .then(() => this.#processor.handleRequest(data))
      .then(
        (response) =>
          this.emit(
            "message",
            cross(
              response === undefined ? { msgId } : { msgId, data: response },
            ),
          ),
        (error) =>
          this.emit("message", {
            msgId,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

/** `message`, encoded, cloned and decoded, as it crosses the channel. */
function cross<M>(message: M): M {
  return fabricFromRealmValue(
    structuredClone(realmFromFabricValue(message as never)),
  ) as M;
}

/**
 * A pattern exporting `exported` beside `opened`, which its handler records
 * each event into, and `settings`, a record that is no stream.
 */
function source(exported: string): string {
  return `/// <cts-enable />
    import { Default, handler, pattern, Writable } from "commonfabric";
    const open = handler<{ path: string }, { opened: Writable<string[]> }>(
      (event, { opened }) => {
        opened.set([...opened.get(), event.path]);
      },
    );
    export default pattern<{
      opened: Writable<Default<string[], []>>;
      settings: Writable<Default<{ mode: string }, { mode: "list" }>>;
    }>(({ opened, settings }) => ({ opened, settings, ${exported} }));
  `;
}

describe("deliverOpenPath() on compiled patterns", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let connection: RuntimeConnection;
  let space: ReturnType<Identity["did"]>;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("open-path pattern");
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://open-path-pattern.test"),
      storageManager,
    });
    connection = await new RuntimeConnection(
      new InProcessTransport(buildProcessor({ runtime, space })),
    ).initialize({} as InitializationData);
  });

  afterEach(async () => {
    await connection.dispose();
    await runtime.storageManager.synced();
    await runtime.dispose();
    await storageManager.close();
  });

  /** Runs the pattern `source(exported)` makes as a piece, and its handle. */
  async function piece(exported: string, cause: string) {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source(exported) }],
    });
    const tx = runtime.edit();
    const result: Cell<{ opened: string[]; settings: unknown }> = runtime.run(
      tx,
      compiled,
      {},
      runtime.getCell(space, cause, compiled.resultSchema, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    const cancel = result.sink(() => {});
    await runtime.idle();
    const client = { [$conn]: () => connection } as unknown as RuntimeClient;
    return {
      handle: new CellHandle<unknown>(client, createCellRef(result)),
      opened: async () => {
        await runtime.idle();
        return result.key("opened").get();
      },
      /** What the piece's result stores, as stored, and its settings. */
      stored: async () => {
        await runtime.idle();
        return JSON.stringify([result.getRaw(), result.key("settings").get()]);
      },
      cancel,
    };
  }

  it("sends the path to the handler a piece exports as `openPath`", async () => {
    const { handle, opened, cancel } = await piece(
      "openPath: open({ opened })",
      "exports-handler",
    );
    try {
      expect(await deliverOpenPath(handle, "/notes/today", () => true))
        .toBe(true);
      expect(await opened()).toEqual(["/notes/today"]);
    } finally {
      cancel();
    }
  });

  it("writes nothing to a piece whose `openPath` links to a record that is no stream", async () => {
    const { handle, opened, stored, cancel } = await piece(
      "openPath: settings",
      "exports-plain-cell",
    );
    try {
      const before = await stored();
      expect(await deliverOpenPath(handle, "/notes/today", () => true))
        .toBe(false);
      expect(await opened()).toEqual([]);
      expect(await stored()).toBe(before);
    } finally {
      cancel();
    }
  });

  it("writes nothing to a piece with no `openPath`", async () => {
    const { handle, opened, stored, cancel } = await piece(
      "other: open({ opened })",
      "exports-none",
    );
    try {
      const before = await stored();
      expect(await deliverOpenPath(handle, "/notes/today", () => true))
        .toBe(false);
      expect(await opened()).toEqual([]);
      expect(await stored()).toBe(before);
    } finally {
      cancel();
    }
  });
});
