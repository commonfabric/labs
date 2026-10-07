/** Exercises dialog turns across client and serving identities. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { BuiltInLLMMessage } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  LLMClient,
  type LLMRequest,
  type LLMResponse,
} from "@commonfabric/llm";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { maxOf } from "@commonfabric/utils/math";

import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";
import { sendEvent } from "../src/cell.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { waitForSettled } from "../src/executor/watermark.ts";
import { SpaceOutbox } from "../src/executor/outbox.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("dialog serving space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("dialog serving service");
const userSigner = await Identity.fromPassphrase("dialog serving user");
const otherSigner = await Identity.fromPassphrase("dialog serving other");

describe("executor-llm-dialog", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost;
  let client: Runtime;
  let runtimes: Runtime[];
  let outboxes: Set<SpaceOutbox>;
  let requests: LLMRequest["messages"][];
  let responses: ReturnType<typeof Promise.withResolvers<LLMResponse>>[];
  let hold: boolean;
  let responseMode: "reply" | "tool" | "error";
  let signals: (AbortSignal | undefined)[];
  let works: Promise<unknown>[];
  let changed: ReturnType<typeof Promise.withResolvers<void>>;
  let errors: unknown[];
  let restore: () => void;

  beforeEach(() => {
    runtimes = [];
    outboxes = new Set();
    requests = [];
    responses = [];
    hold = false;
    responseMode = "reply";
    signals = [];
    works = [];
    changed = Promise.withResolvers<void>();
    errors = [];
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    const sendRequest = LLMClient.prototype.sendRequest;
    const admit = SpaceOutbox.prototype.admitSealedEffects;
    const observe = SpaceOutbox.prototype.observeAsyncWork;
    SpaceOutbox.prototype.observeAsyncWork = function (work) {
      works.push(work);
      observe.call(this, work);
    };
    LLMClient.prototype.sendRequest = (request, _partial, signal) => {
      signals.push(signal);
      requests.push(request.messages);
      const response = Promise.withResolvers<LLMResponse>();
      responses.push(response);
      if (!hold) {
        if (responseMode === "error") {
          response.reject(new Error("model unavailable"));
        } else {response.resolve({
            role: "assistant",
            id: "dialog-response",
            content: responseMode === "tool" && requests.length === 1
              ? [{
                type: "tool-call",
                toolCallId: "present",
                toolName: "presentResult",
                input: { answer: "structured" },
              }]
              : "assistant reply",
          });}
      }
      const prior = changed;
      changed = Promise.withResolvers<void>();
      prior.resolve();
      return response.promise;
    };
    SpaceOutbox.prototype.admitSealedEffects = function (batches) {
      outboxes.add(this);
      admit.call(this, batches);
    };
    restore = () => {
      LLMClient.prototype.sendRequest = sendRequest;
      SpaceOutbox.prototype.admitSealedEffects = admit;
      SpaceOutbox.prototype.observeAsyncWork = observe;
    };
    host = new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        runtimes.push(runtime);
        runtime.scheduler.onError((error) => errors.push(error));
        return { runtime, dispose: () => runtime.dispose() };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });
    const manager = EmulatedStorageManager.connectTo(server, {
      as: userSigner,
    });
    client = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    try {
      for (const response of responses) {
        response.resolve({
          role: "assistant",
          content: "cleanup",
          id: "cleanup",
        });
      }
      try {
        await host?.close();
      } finally {
        try {
          await client?.dispose();
        } finally {
          await server?.close();
        }
      }
    } finally {
      restore?.();
    }
  });

  for (const scope of ["space", "user", "session"] as const) {
    for (const mode of ["reply", "tool", "error"] as const) {
      it(`reads and completes the caller's ${scope} dialog ${mode}`, async () => {
        responseMode = mode;
        const messagesType = scope === "space"
          ? "Writable<BuiltInLLMMessage[]>"
          : `${
            scope === "user" ? "PerUser" : "PerSession"
          }<Writable<BuiltInLLMMessage[]>>`;
        const source = `
import { BuiltInLLMMessage, llmDialog, pattern, PerSession, PerUser, Writable } from "commonfabric";
export default pattern<{ messages: ${messagesType} }, { dialog: any; messages: any }>(({ messages }) => ({
  dialog: llmDialog({ messages, builtinTools: false${
          mode === "tool"
            ? ", resultSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }"
            : ""
        } }),
  messages,
}));`;
        const pattern = await client.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: source }],
        }, { space });
        const argument = client.getCell<{ messages: BuiltInLLMMessage[] }>(
          space,
          "dialog-argument",
          pattern.argumentSchema,
        );
        const result = client.getCell<{ dialog: any; messages: any }>(
          space,
          "dialog-result",
          pattern.resultSchema,
        );
        await argument.sync();
        await result.sync();
        const seed = client.edit();
        argument.withTx(seed).key("messages").set([]);
        expect((await seed.commit().settled).error).toBeUndefined();
        const setup = client.edit();
        client.run(setup, pattern, argument, result);
        expect((await setup.commit().settled).error).toBeUndefined();
        const cancel = result.sink(() => {});
        try {
          await waitForCellValue(
            client,
            result.key("dialog"),
            (value: any) => !!value?.addMessage,
          );
          const accepted = Promise.withResolvers<void>();
          sendEvent(
            result.key("dialog").key("addMessage").asSchema({
              ...LLMMessageSchema,
              asCell: ["stream"],
            }),
            { role: "user", content: "caller message" },
            (tx) => {
              expect(tx.status().status).toBe("done");
              accepted.resolve();
            },
          );
          await accepted.promise;
          await Promise.all([...outboxes].map((outbox) => outbox.settle()));
          await Promise.all(runtimes.map((runtime) => runtime.settled()));
          const engine = await server.engineForSpace(space);
          const target = result.key("dialog").resolveAsCell()
            .getAsNormalizedFullLink();
          const value = Engine.readState(engine, {
            id: target.id,
            scopeKey: resolveScopeKey(target.scope, client.scopeKeyIdentity),
          })?.document?.value as { pending?: boolean };
          expect(requests).toHaveLength(mode === "tool" ? 2 : 1);
          expect(requests[0]).toEqual(expect.arrayContaining([
            expect.objectContaining({
              role: "user",
              content: "caller message",
            }),
          ]));
          expect(target.scope).toBe(scope);
          expect(value.pending).toBe(false);
          if (scope !== "space") {
            expect(
              Engine.readState(engine, {
                id: target.id,
                scopeKey: resolveScopeKey(scope, runtimes[0].scopeKeyIdentity),
              }),
            ).toBeNull();
          }
          if (mode === "tool") {
            expect(requests[1].map((message) => message.role)).toEqual([
              "user",
              "assistant",
              "tool",
            ]);
            expect(requests[1][1].content).toEqual([
              expect.objectContaining({
                type: "tool-call",
                toolCallId: "present",
              }),
            ]);
            expect(requests[1][2].content).toEqual([
              expect.objectContaining({
                type: "tool-result",
                toolCallId: "present",
              }),
            ]);
          }
          const messages = argument.key("messages").asSchema({
            type: "array",
            items: LLMMessageSchema,
          });
          await messages.pull();
          expect(messages.get()).toEqual([
            expect.objectContaining({
              role: "user",
              content: "caller message",
            }),
            ...(mode === "tool"
              ? [
                expect.objectContaining({ role: "assistant" }),
                expect.objectContaining({ role: "tool" }),
              ]
              : []),
            expect.objectContaining({
              role: "assistant",
              content: mode === "error"
                ? "I encountered an error generating a response: model unavailable"
                : "assistant reply",
            }),
          ]);
          expect(errors).toEqual([]);
        } finally {
          cancel();
        }
      });
    }
  }

  for (const scope of ["user", "session"] as const) {
    for (const supersede of [false, true]) {
      it(`keeps two concurrent ${scope} dialog turns independent${supersede ? " while replacing one turn" : ""}`, async () => {
        hold = true;
        const scopeType = scope === "user" ? "PerUser" : "PerSession";
        const source = `
import { BuiltInLLMMessage, llmDialog, pattern, ${scopeType}, Writable } from "commonfabric";
export default pattern<{ messages: ${scopeType}<Writable<BuiltInLLMMessage[]>> }, { dialog: any; messages: any }>(({ messages }) => ({
  dialog: llmDialog({ messages, builtinTools: false }), messages,
}));`;
        const pattern = await client.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: source }],
        }, { space });
        const argument = client.getCell<{ messages: BuiltInLLMMessage[] }>(
          space,
          "dialog-argument",
          pattern.argumentSchema,
        );
        const result = client.getCell<{ dialog: any; messages: any }>(
          space,
          "dialog-result",
          pattern.resultSchema,
        );
        await argument.sync();
        await result.sync();
        const seed = client.edit();
        argument.withTx(seed).key("messages").set([]);
        expect((await seed.commit().settled).error).toBeUndefined();
        const setup = client.edit();
        client.run(setup, pattern, argument, result);
        expect((await setup.commit().settled).error).toBeUndefined();
        const cancel = result.sink(() => {});
        const peerManager = EmulatedStorageManager.connectTo(server, {
          as: scope === "user" ? otherSigner : userSigner,
        });
        const peer = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: peerManager,
          experimental: { serverExecution: true },
        });
        let cancelPeer: (() => void) | undefined;
        try {
          await waitForCellValue(
            client,
            result.key("dialog"),
            (value: any) => !!value?.addMessage,
          );
          const firstAck = Promise.withResolvers<void>();
          sendEvent(
            result.key("dialog").key("addMessage").asSchema({
              ...LLMMessageSchema,
              asCell: ["stream"],
            }),
            { role: "user", content: "first caller" },
            () => firstAck.resolve(),
          );
          await firstAck.promise;
          while (requests.length < 1) await changed.promise;
          const peerArgument = peer.getCell<{ messages: BuiltInLLMMessage[] }>(
            space,
            "dialog-argument",
            pattern.argumentSchema,
          );
          const peerResult = peer.getCell<{ dialog: any; messages: any }>(
            space,
            "dialog-result",
            pattern.resultSchema,
          );
          await peerArgument.sync();
          await peerResult.sync();
          const seedPeer = peer.edit();
          peerArgument.withTx(seedPeer).key("messages").set([]);
          expect((await seedPeer.commit().settled).error).toBeUndefined();
          cancelPeer = peerResult.sink(() => {});
          const engine = await server.engineForSpace(space);
          const seq = maxOf(
            Engine.selectCommitsSince(engine, { fromSeq: 0 }).filter((
              entry,
            ) => entry.class === "authored").map((entry) => entry.seq),
          );
          await waitForSettled(peer, space, seq);
          await peerResult.key("dialog").pull();
          await waitForCellValue<{ addMessage?: unknown }>(
            peer,
            peerResult.key("dialog"),
            (dialog) => dialog?.addMessage !== undefined,
          );
          expect(peerResult.key("dialog").get()?.addMessage).toBeDefined();
          const secondAck = Promise.withResolvers<void>();
          sendEvent(
            peerResult.key("dialog").key("addMessage").asSchema({
              ...LLMMessageSchema,
              asCell: ["stream"],
            }),
            { role: "user", content: "second caller" },
            () => secondAck.resolve(),
          );
          await secondAck.promise;
          while (requests.length < 2) await changed.promise;
          expect(signals.map((signal) => signal?.aborted)).toEqual([
            false,
            false,
          ]);
          expect(requests).toEqual([
            [expect.objectContaining({ content: "first caller" })],
            [expect.objectContaining({ content: "second caller" })],
          ]);
          if (supersede) {
            const originalWork = works[0];
            const cancelAck = Promise.withResolvers<void>();
            sendEvent(
              result.key("dialog").key("cancelGeneration").asSchema({
                asCell: ["stream"],
              }),
              undefined,
              () => cancelAck.resolve(),
            );
            await cancelAck.promise;
            await Promise.all(runtimes.map((runtime) => runtime.idle()));
            expect(signals.map((signal) => signal?.aborted)).toEqual([
              true,
              false,
            ]);
            const replacementAck = Promise.withResolvers<void>();
            sendEvent(
              result.key("dialog").key("addMessage").asSchema({
                ...LLMMessageSchema,
                asCell: ["stream"],
              }),
              { role: "user", content: "first replacement" },
              () => replacementAck.resolve(),
            );
            await replacementAck.promise;
            while (requests.length < 3) await changed.promise;
            responses[0].resolve({
              role: "assistant",
              content: "stale reply",
              id: "stale",
            });
            expect(originalWork).toBeDefined();
            await originalWork;
            const target = result.key("dialog").resolveAsCell()
              .getAsNormalizedFullLink();
            expect(
              (Engine.readState(engine, {
                id: target.id,
                scopeKey: resolveScopeKey(scope, client.scopeKeyIdentity),
              })?.document?.value as any)?.pending,
            ).toBe(true);
            responses[2].resolve({
              role: "assistant",
              content: "first reply",
              id: "replacement",
            });
          } else {responses[0].resolve({
              role: "assistant",
              content: "first reply",
              id: "first",
            });}
          responses[1].resolve({
            role: "assistant",
            content: "second reply",
            id: "second",
          });
          await Promise.all(runtimes.map((runtime) => runtime.settled()));
          await Promise.all([...outboxes].map((outbox) => outbox.settle()));
          for (
            const [reader, input, expected] of [[client, argument, "first"], [
              peer,
              peerArgument,
              "second",
            ]] as const
          ) {
            const messages = input.key("messages").asSchema({
              type: "array",
              items: LLMMessageSchema,
            });
            await messages.pull();
            expect(messages.get()).toEqual([
              expect.objectContaining({ content: `${expected} caller` }),
              ...(supersede && expected === "first"
                ? [expect.objectContaining({ content: "first replacement" })]
                : []),
              expect.objectContaining({ content: `${expected} reply` }),
            ]);
            const target = result.key("dialog").resolveAsCell()
              .getAsNormalizedFullLink();
            expect(
              (Engine.readState(engine, {
                id: target.id,
                scopeKey: resolveScopeKey(scope, reader.scopeKeyIdentity),
              })?.document?.value as any)?.pending,
            ).toBe(false);
          }
          expect(errors).toEqual([]);
        } finally {
          for (const response of responses) {
            response.resolve({
              role: "assistant",
              content: "cleanup",
              id: "cleanup",
            });
          }
          await Promise.all(runtimes.map((runtime) => runtime.settled()));
          cancelPeer?.();
          cancel();
          await peer.dispose();
        }
      });
    }
  }
});
