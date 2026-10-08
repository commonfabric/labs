/**
 * What `CellHandle.sendReviewed()`, and `sendStrict()` with and without
 * `awaitHandling`, deliver. Each case drives a real `RuntimeClient` over a
 * `MessageChannel` to a real processor serving a runtime that runs a pattern
 * whose one writer is gated on a reviewed action, so that what a send claims
 * is held to what that writer's commit does. The cases run twice: once with
 * the handler run in the worker, and once under server execution, with the
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
  newLoopbackServer,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import { withStuckNet } from "@commonfabric/test-support/stuck-net";

import type { RuntimeProcessor } from "@/backends/mod.ts";
import { RuntimeClients } from "@/backends/client-registry.ts";
import { createCellRef } from "@/backends/utils.ts";
import type { CellHandle } from "@/cell-handle.ts";
import { MessagePortRuntimeTransport } from "@/client/transports/message-port/transport-message-port.ts";
import { RequestType } from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";
import {
  isRendererTrustedEvent,
  isTrustedGesture,
  trustedEventMatchesUiContract,
} from "../../runner/src/cfc/ui-contract.ts";
import { buildProcessor } from "./backends/build-processor.ts";

const signer = await Identity.fromPassphrase("send-reviewed", {
  implementation: "noble",
});
const space = signer.did();
const bob = await Identity.fromPassphrase("send-reviewed bob", {
  implementation: "noble",
});
const carol = await Identity.fromPassphrase("send-reviewed carol", {
  implementation: "noble",
});
// What `buildProcessor()` runs the processor under, which the client asserts.
const apiUrl = "http://localhost/";

/** The surface and action the pattern's writer is gated on. */
const chatSend = { surface: "ChatSendSurface", action: "ChatSend" };

/** The `UiAction` contract a `TrustedActionWrite` for `ChatSend` declares. */
const chatSendPolicy = {
  helper: "UiAction" as const,
  action: "ChatSend",
  trustedPattern: "ChatSendSurface",
  requiredEventIntegrity: ["ChatSendSurface"],
};

/** The provenance an event bound to `control` carries. */
const nativeProvenance = (control: { surface: string; action: string }) => ({
  origin: "native",
  trusted: true,
  ui: {
    pattern: control.surface,
    eventIntegrity: [control.surface],
    uiContractDataset: { uiAction: control.action },
  },
});

/** A pattern whose one writer is gated on `ChatSend` from `ChatSendSurface`. */
const chatPatternSource = `
  import {
    AuthoredByCurrentUser,
    handler,
    pattern,
    TrustedActionWrite,
    Writable,
  } from "commonfabric";

  type AuthoredMessage = AuthoredByCurrentUser<
    TrustedActionWrite<{ body: string }, typeof save, "ChatSend", "ChatSendSurface">
  >;

  const save = handler<{ body: string }, { items: Writable<{ body: string }[]> }>(
    (event, { items }) => {
      const record = new Writable<AuthoredMessage>();
      record.set({ body: event.body });
      items.push(record);
    },
  );

  export default pattern(() => {
    const items = new Writable<AuthoredMessage[]>([]);
    return { items, save: save({ items }) };
  });
`;

/** The surface and action a host's add-member control is bound to. */
const addMember = { surface: "MembersSurface", action: "AddMember" };

/**
 * A pattern whose `grant` handler admits the principal its event names to the
 * space the pattern runs in, as `OWNER`, and records them.
 */
const accessPatternSource = `
  import { grantSpaceAccess, handler, pattern, Writable } from "commonfabric";
  import type { DID } from "commonfabric";

  const grant = handler<{ principal: DID }, { added: Writable<string[]> }>(
    (event, { added }) => {
      grantSpaceAccess(added, event.principal, "OWNER");
      added.push(event.principal);
    },
  );

  export default pattern(() => {
    const added = new Writable<string[]>([]);
    return { added, grant: grant({ added }) };
  });
`;

/**
 * What a refused gated write rejects an awaited handling with. Under server
 * execution the reason is the one the served run recorded as the event's
 * consequence.
 */
const refusalOf = (serverExecution: boolean) =>
  `${
    serverExecution ? "event handling errored: " : ""
  }CFC enforcement rejected commit`;

/**
 * Expects `handling`, the awaited handling of a send whose handler run throws,
 * to reject, with `reason` in its message under server execution, where the
 * reason is the one the served run recorded. A run in the worker that throws
 * rejects with its aborted transaction's own message, which does not carry the
 * reason.
 */
const expectThrownRefusal = (
  serverExecution: boolean,
  handling: Promise<unknown>,
  reason: string,
): Promise<void> => {
  const refused = expect(handling).rejects;
  // TODO(danfuzz): Assert `reason` in the worker too, once the runtime
  // processor's `#sendCellEvent()` rejects with an aborted run's `reason`
  // rather than with the transaction's own message.
  return serverExecution ? refused.toThrow(reason) : refused.toThrow();
};

type ChatOutput = { items: { body: string }[]; save: unknown };

/**
 * A client attached over a channel to a processor serving `runtime`, as a host
 * attaches to the worker it owns.
 */
async function attachClient(runtime: Runtime): Promise<RuntimeClient> {
  const clients = new RuntimeClients({
    setConsoleBridge: () => {},
    owner: { id: 0, post: () => true },
    initializeRuntime: () =>
      Promise.resolve(
        buildProcessor({
          runtime,
          identity: signer,
          space,
        }) as unknown as RuntimeProcessor,
      ),
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
  return await RuntimeClient.attach(
    new MessagePortRuntimeTransport({ port: channel.port1 }),
    { apiUrl: new URL(apiUrl), identity: signer.did(), spaceDid: space },
  );
}

/**
 * A runtime running the chat pattern, and a client attached to it over a
 * channel, holding a handle on the pattern's `save` stream. With
 * `serverExecution`, the runtime is a client of a serving memory server, and
 * the handler's authoritative run is the served one.
 */
async function chatRoom(serverExecution: boolean) {
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
    files: [{ name: "/main.tsx", contents: chatPatternSource }],
  }, { space });
  const output = runtime.getCell<ChatOutput>(
    space,
    `send-reviewed-${crypto.randomUUID()}`,
  );
  const result: Cell<ChatOutput> = await runtime.runSynced(
    output,
    compiled,
    {},
  );

  const client = await attachClient(runtime);
  const save: CellHandle<Record<string, unknown>> = client.getCellFromRef(
    createCellRef(result.key("save")),
  );

  /**
   * The bodies of the messages the pattern stored. Under server execution
   * the runtime shows its own speculative run of a handler until the served
   * one lands, so the bodies are read by a runtime of their own, which runs
   * nothing and reads what the memory server holds.
   */
  const stored = async () => {
    await runtime.idle();
    if (serving === undefined) {
      await result.pull();
      return (result.key("items").get() ?? []).map(({ body }) => body);
    }
    const readerStorage = EmulatedStorageManager.connectTo(serving.server, {
      as: signer,
    });
    const reader = new Runtime({
      apiUrl: new URL(apiUrl),
      storageManager: readerStorage,
      experimental: { serverExecution: true },
    });
    try {
      const items = reader.getCellFromLink<{ body: string }[]>(
        result.key("items").getAsNormalizedFullLink(),
      );
      await items.pull();
      return (items.get() ?? []).map(({ body }) => body);
    } finally {
      await reader.dispose();
      await readerStorage.close();
    }
  };

  return {
    runtime,
    client,
    save,
    stored,
    [Symbol.asyncDispose]: async () => {
      await client.dispose();
      await runtime.dispose();
      await storage.close();
      await serving?.close();
    },
  };
}

/**
 * A runtime acting as `signer` running the access pattern in a space of its
 * own whose access list starts as `acl`, and a client attached to it, holding
 * a handle on the pattern's `grant` stream. With `serverExecution`, the
 * runtime is a client of a serving memory server, and the handler's
 * authoritative run is the served one.
 */
async function membersRoom(
  serverExecution: boolean,
  acl: Record<string, "READ" | "WRITE" | "OWNER">,
) {
  const serving = serverExecution
    ? await startServingMemoryServer({
      apiUrl: new URL(import.meta.url),
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    })
    : undefined;
  const server = serving?.server ??
    newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(apiUrl),
    storageManager: storage,
    ...(serverExecution && { experimental: { serverExecution: true } }),
  });
  const room = await storage.createSpace(acl);
  const compiled = await runtime.patternManager.compilePattern({
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: accessPatternSource }],
  }, { space: room });
  const result: Cell<{ added: string[]; grant: unknown }> = await runtime
    .runSynced(
      runtime.getCell(room, `send-reviewed-members-${crypto.randomUUID()}`),
      compiled,
      {},
    );
  const client = await attachClient(runtime);
  const grant: CellHandle<Record<string, unknown>> = client.getCellFromRef(
    createCellRef(result.key("grant")),
  );

  return {
    grant,
    /** The room's access list, as the memory server holds it. */
    storedAcl: async () => {
      await runtime.idle();
      return (await server.readDocument(room, `of:${room}`))?.value;
    },
    [Symbol.asyncDispose]: async () => {
      await client.dispose();
      await runtime.dispose();
      await storage.close();
      await (serving?.close() ?? server.close());
    },
  };
}

/**
 * `promise`, under a stuck-condition net when a serving loop is running,
 * whose lease timer keeps the process from going quiet on a send that never
 * settles.
 */
const settled = <T>(
  serverExecution: boolean,
  promise: Promise<T>,
  label: string,
): Promise<T> => serverExecution ? withStuckNet(promise, label) : promise;

describe("send-reviewed", () => {
  describe("the event the worker sends", () => {
    it("holds `native` provenance for the bound surface and action in place of the payload's, is renderer-trusted, matches the bound contract, and is a trusted gesture, where `sendStrict()` sends one that is none of those", async () => {
      // A handler of the scheduler's own reads the event the worker sends,
      // which a pattern's handler cannot inspect for the renderer-trust mark.

      await using room = await chatRoom(false);
      const stream = room.runtime.getCell(
        space,
        `send-reviewed-probe-${crypto.randomUUID()}`,
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
        const handle = room.client.getCellFromRef<Record<string, unknown>>(
          createCellRef(stream),
        );
        await handle.sendReviewed(
          {
            body: "reviewed",
            provenance: nativeProvenance({
              surface: "ChatDeleteSurface",
              action: "ChatDelete",
            }),
          },
          chatSend,
        );
        await handle.sendStrict({
          body: "unmarked",
          provenance: nativeProvenance(chatSend),
        }, { awaitHandling: true });
      } finally {
        cancel();
      }

      expect(events).toEqual([
        { body: "reviewed", provenance: nativeProvenance(chatSend) },
        { body: "unmarked", provenance: nativeProvenance(chatSend) },
      ]);
      const [reviewed, unmarked] = events;
      expect(isRendererTrustedEvent(reviewed)).toBe(true);
      expect(trustedEventMatchesUiContract(reviewed, chatSendPolicy)).toBe(
        true,
      );
      expect(isTrustedGesture(reviewed)).toBe(true);
      expect(isRendererTrustedEvent(unmarked)).toBe(false);
      expect(trustedEventMatchesUiContract(unmarked, chatSendPolicy)).toBe(
        false,
      );
      expect(isTrustedGesture(unmarked)).toBe(false);
    });
  });

  describe("the request the worker refuses", () => {
    it("rejects a payload that is not a record, and a blank surface or action, and sends nothing", async () => {
      await using room = await chatRoom(false);
      const stream = room.runtime.getCell(
        space,
        `send-reviewed-refused-${crypto.randomUUID()}`,
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
        const handle = room.client.getCellFromRef<unknown>(
          createCellRef(stream),
        );
        for (const payload of ["text", ["body"], null]) {
          await expect(handle.sendReviewed(payload, chatSend)).rejects
            .toThrow("A reviewed action's event must be a record.");
        }
        for (
          const control of [
            { surface: " ", action: "ChatSend" },
            { surface: "ChatSendSurface", action: "" },
          ]
        ) {
          await expect(handle.sendReviewed({ body: "blank" }, control))
            .rejects.toThrow(
              "A native UI control requires a surface and an action.",
            );
        }
        // Events on one stream are handled in the order they were sent, so
        // once this one is handled any sent above it have been too.
        await handle.sendReviewed({ body: "barrier" }, chatSend);
      } finally {
        cancel();
      }

      expect(events).toEqual([
        { body: "barrier", provenance: nativeProvenance(chatSend) },
      ]);
    });
  });

  for (const serverExecution of [false, true]) {
    describe(
      serverExecution ? "under server execution" : "run in the worker",
      () => {
        it("commits a write gated on the bound surface and action", async () => {
          await using room = await chatRoom(serverExecution);
          await settled(
            serverExecution,
            room.save.sendReviewed({ body: "  exact text  " }, chatSend),
            "the reviewed send's handling",
          );

          expect(await room.stored()).toEqual(["  exact text  "]);
        });

        it("rejects with the refusal, and commits nothing, when bound to another surface or action", async () => {
          await using room = await chatRoom(serverExecution);
          for (
            const control of [
              { surface: "ChatSendSurface", action: "ChatDelete" },
              { surface: "ChatDeleteSurface", action: "ChatSend" },
            ]
          ) {
            await expect(settled(
              serverExecution,
              room.save.sendReviewed({ body: "refused" }, control),
              "the mismatched send's handling",
            )).rejects.toThrow(refusalOf(serverExecution));
          }

          expect(await room.stored()).toEqual([]);
        });

        it("decides by the bound surface and action, not by a `provenance` the payload carries", async () => {
          await using room = await chatRoom(serverExecution);
          const chatDelete = {
            surface: "ChatSendSurface",
            action: "ChatDelete",
          };
          await expect(settled(
            serverExecution,
            room.save.sendReviewed(
              {
                body: "claims ChatSend",
                provenance: nativeProvenance(chatSend),
              },
              chatDelete,
            ),
            "the send claiming another action",
          )).rejects.toThrow(refusalOf(serverExecution));
          await settled(
            serverExecution,
            room.save.sendReviewed(
              {
                body: "claims ChatDelete",
                provenance: nativeProvenance(chatDelete),
              },
              chatSend,
            ),
            "the send claiming the bound action's surface",
          );

          expect(await room.stored()).toEqual(["claims ChatDelete"]);
        });

        it("refuses the same payload, its provenance included, through `sendStrict()`", async () => {
          await using room = await chatRoom(serverExecution);
          await expect(settled(
            serverExecution,
            room.save.sendStrict(
              { body: "unmarked", provenance: nativeProvenance(chatSend) },
              { awaitHandling: true },
            ),
            "the unmarked send's handling",
          )).rejects.toThrow(refusalOf(serverExecution));

          expect(await room.stored()).toEqual([]);
        });

        it("resolves `sendStrict()` on a refused handling without `awaitHandling`", async () => {
          await using room = await chatRoom(serverExecution);
          await room.save.sendStrict({ body: "unmarked" });
          // Events on one stream are handled in the order they were sent, so
          // once this one is handled the one above has been too.
          await settled(
            serverExecution,
            room.save.sendReviewed({ body: "reviewed" }, chatSend),
            "the barrier send's handling",
          );

          expect(await room.stored()).toEqual(["reviewed"]);
        });

        it("commits a change to the space's access list for an `OWNER`, since the event is a trusted gesture", async () => {
          await using room = await membersRoom(serverExecution, {
            [signer.did()]: "OWNER",
          });
          await settled(
            serverExecution,
            room.grant.sendReviewed({ principal: bob.did() }, addMember),
            "the reviewed grant's handling",
          );

          expect(await room.storedAcl()).toEqual({
            [signer.did()]: "OWNER",
            [bob.did()]: "OWNER",
          });
        });

        it("rejects a reviewed grant from an actor without `OWNER`, and changes nothing", async () => {
          await using room = await membersRoom(serverExecution, {
            [carol.did()]: "OWNER",
            [signer.did()]: "WRITE",
          });
          await expectThrownRefusal(
            serverExecution,
            settled(
              serverExecution,
              room.grant.sendReviewed({ principal: bob.did() }, addMember),
              "the non-owner's grant's handling",
            ),
            `which ${signer.did()} does not hold`,
          );

          expect(await room.storedAcl()).toEqual({
            [carol.did()]: "OWNER",
            [signer.did()]: "WRITE",
          });
        });

        it("rejects a grant sent through `sendStrict()` with a reviewed action's provenance, and changes nothing", async () => {
          await using room = await membersRoom(serverExecution, {
            [signer.did()]: "OWNER",
          });
          await expectThrownRefusal(
            serverExecution,
            settled(
              serverExecution,
              room.grant.sendStrict(
                {
                  principal: bob.did(),
                  provenance: nativeProvenance(addMember),
                },
                { awaitHandling: true },
              ),
              "the forged grant's handling",
            ),
            "requires the handler's event to be a trusted gesture",
          );

          expect(await room.storedAcl()).toEqual({ [signer.did()]: "OWNER" });
        });
      },
    );
  }
});
