/** Drives held model requests through the real serving host and outbox. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { LLMClient, type LLMResponse } from "@commonfabric/llm";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { maxOf } from "@commonfabric/utils/math";

import type { Cell } from "../src/cell.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { SpaceOutbox } from "../src/executor/outbox.ts";
import { waitForSettled } from "../src/executor/watermark.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("llm supersession space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("llm supersession service");
const userSigner = await Identity.fromPassphrase("llm supersession user");
const otherSigner = await Identity.fromPassphrase("llm supersession other");

/** Public result observed by the client. */
type View = {
  /** Model work remains pending. */
  pending?: boolean;

  /** Completed model output. */
  result?: unknown;

  /** Streaming text. */
  partial?: string;

  /** Settled model failure. */
  error?: string;

  /** Selected or completed request identity. */
  requestHash?: string;
};

/** One model request held at its transport boundary. */
type Request = {
  /** Prompt observed by the model client. */
  prompt: string;

  /** Releases the model response. */
  release: (text?: string) => void;

  /** Rejects the transport response. */
  reject: (error: Error) => void;

  /** Emits a streaming update when supported. */
  partial?: (text: string) => void;
};

describe("executor-llm-supersession", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost;
  let clientManager: EmulatedStorageManager;
  let client: Runtime;
  let runtimes: Runtime[];
  let requests: Request[];
  let works: Promise<unknown>[];
  let outboxes: Set<SpaceOutbox>;
  let admitted: string[];
  let keys: string[];
  let changed: ReturnType<typeof Promise.withResolvers<void>>;
  let errors: unknown[];
  let restore: () => void;

  /** Wakes observers after a request or admission edge. */
  function notify() {
    const prior = changed;
    changed = Promise.withResolvers<void>();
    prior.resolve();
  }

  /** Waits for instrumented lifecycle transitions. */
  async function until(predicate: () => boolean) {
    while (!predicate()) await changed.promise;
  }

  beforeEach(() => {
    requests = [];
    works = [];
    runtimes = [];
    outboxes = new Set();
    admitted = [];
    keys = [];
    errors = [];
    changed = Promise.withResolvers<void>();
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    const sendRequest = LLMClient.prototype.sendRequest;
    const generateObject = LLMClient.prototype.generateObject;
    const admit = SpaceOutbox.prototype.admitSealedEffects;
    const observe = SpaceOutbox.prototype.observeAsyncWork;
    SpaceOutbox.prototype.observeAsyncWork = function (work) {
      works.push(work);
      observe.call(this, work);
    };
    LLMClient.prototype.sendRequest = (request, partial) => {
      const prompt = String(request.messages[0].content);
      const response = Promise.withResolvers<LLMResponse>();
      requests.push({
        prompt,
        partial,
        reject: response.reject,
        release: (text) =>
          response.resolve({
            role: "assistant",
            content: text ?? `${prompt}-result`,
            id: `${prompt}-response`,
          }),
      });
      if (requests.length > 2) {
        response.reject(new Error("unexpected extra model request"));
      }
      notify();
      return response.promise;
    };
    LLMClient.prototype.generateObject = (request) => {
      const prompt = String(request.messages[0].content);
      const response = Promise.withResolvers<
        Awaited<ReturnType<typeof generateObject>>
      >();
      requests.push({
        prompt,
        reject: response.reject,
        release: (text) =>
          response.resolve({
            object: { answer: text ?? `${prompt}-result` },
            id: `${prompt}-response`,
          }),
      });
      if (requests.length > 2) {
        response.reject(new Error("unexpected extra model request"));
      }
      notify();
      return response.promise;
    };
    SpaceOutbox.prototype.admitSealedEffects = function (batches) {
      outboxes.add(this);
      admit.call(this, batches);
      for (const batch of batches) {
        for (const effect of batch.effects) {
          if (/^(llm|generateText|generateObject)-start$/.test(effect.kind)) {
            admitted.push(effect.id);
            keys.push(effect.idempotencyKey ?? effect.id);
          }
        }
      }
      notify();
    };
    restore = () => {
      LLMClient.prototype.sendRequest = sendRequest;
      LLMClient.prototype.generateObject = generateObject;
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
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose().catch(async (error) => {
              await manager.close();
              throw error;
            });
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: userSigner,
    });
    client = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    for (const request of requests) request.release();
    await Promise.all(runtimes.map((runtime) => runtime.settled()));
    await Promise.all([...outboxes].map((outbox) => outbox.settle()));
    await host.close();
    await client.dispose().catch(async (error) => {
      await clientManager.close();
      throw error;
    });
    await server.close();
    restore();
  });

  /** Writes an authored prompt and waits for its demanded derivation. */
  async function setPrompt(argument: Cell<{ prompt: string }>, prompt: string) {
    const tx = client.edit();
    argument.withTx(tx).set({ prompt });
    expect((await tx.commit().settled).error).toBeUndefined();
    const engine = await server.engineForSpace(space);
    const seq = maxOf(
      Engine.selectCommitsSince(engine, { fromSeq: 0 })
        .filter((commit) => commit.class === "authored")
        .map((commit) => commit.seq),
    );
    await waitForSettled(client, space, seq);
  }

  for (const builtin of ["llm", "generateText", "generateObject"]) {
    for (const returnToA of [false, true]) {
      for (const fails of [false, true]) {
        it(`settles ${builtin} after ${returnToA ? "A to B to A" : "A to B"} while A remains in flight${fails ? " and the model fails" : ""}`, async () => {
          const expression = builtin === "llm"
            ? "llm({ messages: [{ role: 'user', content: prompt }] })"
            : builtin === "generateObject"
            ? "generateObject({ prompt, schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } })"
            : "generateText({ prompt })";
          const source = `
import { ${builtin}, pattern } from "commonfabric";
export default pattern<{ prompt: string }, { output: any }>(({ prompt }) => ({
  output: ${expression},
}));`;
          const pattern = await client.patternManager.compilePattern({
            main: "/main.tsx",
            files: [{ name: "/main.tsx", contents: source }],
          }, { space });
          const argument = client.getCell<{ prompt: string }>(
            space,
            "llm-argument",
            pattern.argumentSchema,
          );
          const result = client.getCell<{ output: View }>(
            space,
            "llm-result",
            pattern.resultSchema,
          );
          await argument.sync();
          await result.sync();
          const tx = client.edit();
          argument.withTx(tx).set({ prompt: "A" });
          client.run(tx, pattern, argument, result);
          expect((await tx.commit().settled).error).toBeUndefined();
          const cancel = result.sink(() => {});
          try {
            await until(() => requests.length === 1 && admitted.length >= 1);
            const firstWorks = works.slice();
            requests[0].partial?.("A-partial");
            await setPrompt(argument, "B");
            await until(() => requests.length === 2 && admitted.length >= 2);
            const secondWorks = works.slice(firstWorks.length);
            if (returnToA) {
              await setPrompt(argument, "A");
              await until(() => admitted.length >= 3);
              const transitions = admitted.filter((id, index) =>
                id !== admitted[index - 1]
              );
              expect(transitions).toHaveLength(3);
              expect(transitions[2]).toBe(transitions[0]);
            }
            expect(requests.map((request) => request.prompt)).toEqual([
              "A",
              "B",
            ]);
            requests[1].partial?.("B-partial");
            requests[0].partial?.("A-resumed-partial");
            await Promise.all(runtimes.map((runtime) => runtime.idle()));
            const output = result.key("output").resolveAsCell();
            const engine = await server.engineForSpace(space);
            const target = { id: output.getAsNormalizedFullLink().id };
            const pending = Engine.readState(engine, target)?.document
              ?.value as View;
            expect(pending.pending).toBe(true);
            expect(pending.partial).toBeUndefined();
            const current = returnToA ? 0 : 1;
            const stale = returnToA ? 1 : 0;
            if (fails) {
              requests[current].reject(
                new Error(`${returnToA ? "A" : "B"}-failure`),
              );
            } else requests[current].release();
            await Promise.all(returnToA ? firstWorks : secondWorks);
            const settled = Engine.readState(engine, target)?.document
              ?.value as View;
            expect(settled.pending).toBe(false);
            if (fails) {
              requests[stale].reject(
                new Error(`${returnToA ? "B" : "A"}-failure`),
              );
            } else requests[stale].release();
            await Promise.all(runtimes.map((runtime) => runtime.settled()));
            await Promise.all([...outboxes].map((outbox) => outbox.settle()));
            await result.key("output").resolveAsCell().pull();
            await client.idle();
            const actual = Engine.readState(engine, target)?.document
              ?.value as View;
            expect(errors).toEqual([]);
            expect(actual.pending).toBe(false);
            if (fails) {
              expect(actual.error).toBe(`${returnToA ? "A" : "B"}-failure`);
              expect(actual.result).toBeUndefined();
            } else {
              expect(actual.error).toBeUndefined();
              const wanted = `${returnToA ? "A" : "B"}-result`;
              expect(actual.result).toEqual(
                builtin === "generateObject" ? { answer: wanted } : wanted,
              );
            }
          } finally {
            cancel();
          }
        });
      }
    }
  }
  for (const builtin of ["llm", "generateText", "generateObject"]) {
    for (const scope of ["user", "session"] as const) {
      it(`keeps concurrent ${builtin} responses in their ${scope} instances`, async () => {
        const expression = builtin === "llm"
          ? "llm({ messages: [{ role: 'user', content: prompt }] })"
          : builtin === "generateObject"
          ? "generateObject({ prompt, schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } })"
          : "generateText({ prompt })";
        const scopeType = scope === "user" ? "PerUser" : "PerSession";
        const source = `
import { ${builtin}, pattern, ${scopeType}, Writable } from "commonfabric";
export default pattern<{ prompt: ${scopeType}<Writable<string>> }, { output: any }>(({ prompt }) => ({
  output: ${expression},
}));`;
        const pattern = await client.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: source }],
        }, { space });
        const argument = client.getCell<{ prompt: string }>(
          space,
          "scoped-argument",
          pattern.argumentSchema,
        );
        const result = client.getCell<{ output: View }>(
          space,
          "scoped-result",
          pattern.resultSchema,
        );
        await argument.sync();
        await result.sync();
        const seed = client.edit();
        argument.withTx(seed).key("prompt").set("same");
        expect((await seed.commit().settled).error).toBeUndefined();
        const setup = client.edit();
        client.run(setup, pattern, argument, result);
        expect((await setup.commit().settled).error).toBeUndefined();
        const cancel = result.sink(() => {});
        const manager = EmulatedStorageManager.connectTo(server, {
          as: scope === "user" ? otherSigner : userSigner,
        });
        const peer = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          experimental: { serverExecution: true },
        });
        let cancelPeer: (() => void) | undefined;
        try {
          await until(() => requests.length === 1);
          const peerArgument = peer.getCell<{ prompt: string }>(
            space,
            "scoped-argument",
            pattern.argumentSchema,
          );
          const peerResult = peer.getCell<{ output: View }>(
            space,
            "scoped-result",
            pattern.resultSchema,
          );
          await peerArgument.sync();
          await peerResult.sync();
          const edit = peer.edit();
          peerArgument.withTx(edit).key("prompt").set("same");
          expect((await edit.commit().settled).error).toBeUndefined();
          cancelPeer = peerResult.sink(() => {});
          await until(() => requests.length === 2);
          expect(requests.map((request) => request.prompt)).toEqual([
            "same",
            "same",
          ]);
          requests[1].release("second-instance");
          requests[0].release("first-instance");
          await Promise.all(runtimes.map((runtime) => runtime.settled()));
          await Promise.all([...outboxes].map((outbox) => outbox.settle()));
          const engine = await server.engineForSpace(space);
          const target = result.key("output").resolveAsCell()
            .getAsNormalizedFullLink();
          expect(requests).toHaveLength(2);
          expect(target.scope).toBe(scope);
          for (
            const [reader, expected] of [[client, "first-instance"], [
              peer,
              "second-instance",
            ]] as const
          ) {
            const value = Engine.readState(engine, {
              id: target.id,
              scopeKey: resolveScopeKey(scope, reader.scopeKeyIdentity),
            })?.document?.value as View;
            expect(value.pending).toBe(false);
            expect(value.error).toBeUndefined();
            expect(value.result).toEqual(
              builtin === "generateObject" ? { answer: expected } : expected,
            );
          }
          expect(Engine.readState(engine, {
            id: target.id,
            scopeKey: resolveScopeKey(scope, runtimes[0].scopeKeyIdentity),
          })).toBeNull();
          expect(errors).toEqual([]);
        } finally {
          for (const request of requests) request.release();
          await Promise.all(runtimes.map((runtime) => runtime.settled()));
          cancelPeer?.();
          cancel();
          await peer.dispose().catch(async (error) => {
            await manager.close();
            throw error;
          });
        }
      });
    }
  }
});
