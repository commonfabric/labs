/**
 * What a send that waits for its handling returns: `sendForReceipt()` on a
 * `CellHandle`, and the worker's answers to `cell:send` and
 * `cell:send-reviewed`. Each case drives a real `RuntimeClient` over a
 * `MessageChannel` to a real processor serving a runtime that runs a pattern
 * whose verbs declare a result, so that what a receipt holds is what the
 * handler returned. The cases that read a receipt run twice: once with the
 * handler run in the worker, and once under server execution, with the
 * handler run served by a serving loop over an in-process memory server.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import {
  type ServingMemoryServer,
  startServingMemoryServer,
} from "@commonfabric/runner/executor/serving-memory-server.deno";
import {
  EmulatedStorageManager,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import { withStuckNet } from "@commonfabric/test-support/stuck-net";

import { RuntimeClients } from "@/backends/client-registry.ts";
import type { RuntimeProcessor } from "@/backends/mod.ts";
import { createCellRef } from "@/backends/utils.ts";
import type { CellHandle } from "@/cell-handle.ts";
import { MessagePortRuntimeTransport } from "@/client/transports/message-port/transport-message-port.ts";
import { RequestType } from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";
import { buildProcessor } from "./backends/build-processor.ts";

const signer = await Identity.fromPassphrase("send-for-receipt", {
  implementation: "noble",
});
const space = signer.did();
// What `buildProcessor()` runs the processor under, which the client asserts.
const apiUrl = "http://localhost/";

/** The result `complete` declares. */
const candidatesSchema = {
  type: "object",
  properties: {
    candidates: { type: "array", items: { type: "string" } },
  },
  required: ["candidates"],
} as const;

/**
 * A pattern with a verb that returns completion candidates for a prefix, and
 * one that turns every event down.
 */
const completerPatternSource = `
  import { action, pattern, Stream } from "commonfabric";

  interface Ask {
    prefix: string;
  }

  interface Candidates {
    candidates: string[];
  }

  interface Verbs {
    complete: Stream<Ask, Candidates>;
    decline: Stream<Ask>;
  }

  export default pattern<Record<string, never>, Verbs>(() => {
    const complete = action<Ask, Candidates>((event) => ({
      candidates: [event.prefix + "ly", event.prefix + "ness"],
    }));
    const decline = action((event: Ask) => {
      throw new Error("No candidates for " + event.prefix);
    });
    return { complete, decline };
  });
`;

type CompleterOutput = { complete: unknown; decline: unknown };

/**
 * A runtime running the completer pattern, the processor serving it, and a
 * client attached to that processor over a channel. With `serverExecution`,
 * the runtime is a client of a serving memory server, and the handler's
 * authoritative run is the served one.
 */
async function completerRoom(serverExecution: boolean) {
  let serving: ServingMemoryServer | undefined;
  let storage: StorageManager;
  if (serverExecution) {
    serving = await startServingMemoryServer({
      apiUrl: new URL(import.meta.url),
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });
    storage = EmulatedStorageManager.connectTo(serving.server, { as: signer });
  } else {
    storage = StorageManager.emulate({ as: signer });
  }
  const runtime = new Runtime({
    apiUrl: new URL(apiUrl),
    storageManager: storage,
    ...(serverExecution && { experimental: { serverExecution: true } }),
  });
  const compiled = await runtime.patternManager.compilePattern({
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: completerPatternSource }],
  }, { space });
  const output = runtime.getCell<CompleterOutput>(
    space,
    `send-for-receipt-${crypto.randomUUID()}`,
  );
  const result: Cell<CompleterOutput> = await runtime.runSynced(
    output,
    compiled,
    {},
  );

  const processor = buildProcessor({ runtime, identity: signer, space });
  const clients = new RuntimeClients({
    setConsoleBridge: () => {},
    owner: { id: 0, post: () => true },
    initializeRuntime: () =>
      Promise.resolve(processor as unknown as RuntimeProcessor),
  });
  await clients.handleMessage(
    clients.owner,
    new MessageEvent("message", {
      data: realmFromFabricValue({
        msgId: 1,
        data: {
          type: RequestType.Initialize,
          data: { apiUrl, identity: { placeholder: true }, spaceDid: space },
        },
      } as never),
    }),
  );
  const channel = new MessageChannel();
  clients.attach(channel.port2);
  const client = await RuntimeClient.attach(
    new MessagePortRuntimeTransport({ port: channel.port1 }),
    { apiUrl: new URL(apiUrl), identity: signer.did(), spaceDid: space },
  );
  const handle = (key: keyof CompleterOutput) =>
    client.getCellFromRef<{ prefix: string }>(createCellRef(result.key(key)));

  return {
    runtime,
    processor,
    client,
    complete: handle("complete"),
    decline: handle("decline"),
    [Symbol.asyncDispose]: async () => {
      await client.dispose();
      await runtime.dispose();
      await storage.close();
      await serving?.close();
    },
  };
}

/**
 * `promise`, under a stuck-condition net when a serving loop is running,
 * whose lease timer keeps the process from going quiet on a send, or a read
 * of the receipt it wrote, that never settles.
 */
const settled = <T>(
  serverExecution: boolean,
  promise: Promise<T>,
  label: string,
): Promise<T> => serverExecution ? withStuckNet(promise, label) : promise;

/** What a declining handler's refusal rejects an awaited handling with. */
const refusalOf = (serverExecution: boolean) =>
  `${serverExecution ? "event handling errored: " : ""}No candidates for un`;

describe("send-for-receipt", () => {
  for (const serverExecution of [false, true]) {
    describe(
      serverExecution ? "under server execution" : "run in the worker",
      () => {
        it("returns a handle on the receipt, which reads the handler's declared result", async () => {
          await using room = await completerRoom(serverExecution);
          const receipt = await settled(
            serverExecution,
            room.complete.sendForReceipt({ prefix: "kind" }),
            "the completion's handling",
          );

          expect(receipt).toBeDefined();
          expect(
            await settled(
              serverExecution,
              receipt!.asSchema(candidatesSchema).pull(),
              "the completion's receipt",
            ),
          ).toEqual({ candidates: ["kindly", "kindness"] });
        });

        it("returns a receipt of each handling's own", async () => {
          await using room = await completerRoom(serverExecution);
          const first = await settled(
            serverExecution,
            room.complete.sendForReceipt({ prefix: "bold" }),
            "the first completion's handling",
          );
          const second = await settled(
            serverExecution,
            room.complete.sendForReceipt({ prefix: "dark" }),
            "the second completion's handling",
          );

          expect(first!.equals(second)).toBe(false);
          expect(
            await settled(
              serverExecution,
              first!.asSchema(candidatesSchema).pull(),
              "the first completion's receipt",
            ),
          ).toEqual({ candidates: ["boldly", "boldness"] });
          expect(
            await settled(
              serverExecution,
              second!.asSchema(candidatesSchema).pull(),
              "the second completion's receipt",
            ),
          ).toEqual({ candidates: ["darkly", "darkness"] });
        });

        it("rejects with the reason when the handling is refused, as `sendStrict()` with `awaitHandling` does", async () => {
          await using room = await completerRoom(serverExecution);
          await expect(settled(
            serverExecution,
            room.decline.sendForReceipt({ prefix: "un" }),
            "the declined send's handling",
          )).rejects.toThrow(refusalOf(serverExecution));
          await expect(settled(
            serverExecution,
            room.decline.sendStrict({ prefix: "un" }, {
              awaitHandling: true,
            }),
            "the declined strict send's handling",
          )).rejects.toThrow(refusalOf(serverExecution));
        });

        it("answers `cell:send-reviewed` with the handling's receipt", async () => {
          await using room = await completerRoom(serverExecution);
          const answer = await settled(
            serverExecution,
            room.processor.handleCellSendReviewed({
              type: RequestType.CellSendReviewed,
              cell: room.complete.ref(),
              event: { prefix: "glad" },
              surface: "CompleterSurface",
              action: "Complete",
            }),
            "the reviewed completion's handling",
          );

          expect(answer.receipt).toBeDefined();
          const receipt = room.client.getCellFromRef(answer.receipt!);
          expect(
            await settled(
              serverExecution,
              receipt.asSchema(candidatesSchema).pull(),
              "the reviewed completion's receipt",
            ),
          ).toEqual({ candidates: ["gladly", "gladness"] });
        });
      },
    );
  }

  describe("a handling that writes no receipt", () => {
    // A handler the scheduler runs directly is not a pattern's, and the
    // runner, which writes a pattern handler's receipt, never sees its event.
    // The case runs in the worker alone: under server execution every served
    // run of a pattern's handler writes its receipt, and a serving loop drops
    // an event for a stream no pattern handles, which rejects the send.

    it("returns `undefined`", async () => {
      await using room = await completerRoom(false);
      const stream = room.runtime.getCell(
        space,
        `send-for-receipt-bare-${crypto.randomUUID()}`,
        { asCell: ["stream"] },
      );
      const events: unknown[] = [];
      const cancel = room.runtime.scheduler.addEventHandler(
        (_tx, event) => {
          events.push(event);
        },
        stream.getAsNormalizedFullLink(),
      );
      try {
        const handle: CellHandle<{ prefix: string }> = room.client
          .getCellFromRef(createCellRef(stream));
        expect(await handle.sendForReceipt({ prefix: "bare" }))
          .toBeUndefined();
      } finally {
        cancel();
      }

      expect(events).toEqual([{ prefix: "bare" }]);
    });
  });

  describe("a send that does not wait for its handling", () => {
    it("is answered with nothing", async () => {
      await using room = await completerRoom(false);

      expect(
        await room.processor.handleCellSend({
          type: RequestType.CellSend,
          cell: room.complete.ref(),
          event: { prefix: "quick" },
          awaitCommit: true,
        }),
      ).toBeUndefined();
    });
  });
});
