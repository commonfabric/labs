/**
 * LLM builtin no-request tests.
 *
 * A builtin that is handed nothing to send — `llm` with an empty message list,
 * `generateText`/`generateObject` with an empty prompt and no messages — must
 * not call the client. It settles the result cell instead: `pending` false,
 * `result` and `error` cleared. The smoke and outbox suites always supply a
 * prompt, so this branch had no coverage.
 *
 * Each test spies the client method the builtin would call and asserts it never
 * fires, then confirms the cell settled with no result. The wait resolves on the
 * `pending` the early return writes, the same signal a real response would clear.
 *
 * A prompt — or `llm`'s message list — can also become empty after having
 * been set, which a pattern that gates its prompt on an input does every time
 * that input is cleared. Further tests cover that transition. Entering the
 * no-request state has to abandon a request already in flight, so a response
 * that lands afterwards writes nothing and runs none of the tool calls it asks
 * for; and it has to forget the request it remembered, so the same prompt
 * coming back is sent again rather than suppressed as a duplicate.
 *
 * Both of those apply to a request the builtin can abandon. A queued request
 * runs to completion under the queue's own lifecycle, so it is remembered
 * across the empty prompt and the same prompt returning does not enqueue a
 * second copy. The queued cases hold that line.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  clearMockResponses,
  enableMockMode,
  resetMockMode,
} from "@commonfabric/llm/client";
import { LLMClient, type LLMResponse } from "@commonfabric/llm";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { waitForLlmSettled } from "./support/llm-result.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

/** One message of the list `llm` is handed. */
type Msg = { role: "user" | "assistant" | "tool"; content: string };

describe("LLM builtin no-request paths", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let builder: ReturnType<typeof createTrustedBuilder>["commonfabric"];
  // A test that parks a request so it can act while it is in flight sets this
  // to what lets it finish. Teardown calls it whether or not the test got that
  // far, so an assertion failing before the release leaves nothing for
  // `settled()` to wait on forever.
  let releaseHeldRequest: (() => void) | undefined;

  beforeEach(() => {
    enableMockMode();
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    ({ commonfabric: builder } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    resetMockMode();
    await tx.commit();
    releaseHeldRequest?.();
    releaseHeldRequest = undefined;
    // The built-in's request chain is async work `idle()` returns ahead of;
    // `settled()` drains it before the runtime is torn down.
    await runtime.settled();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("`llm` makes no request for an empty message list", async () => {
    const original = LLMClient.prototype.sendRequest;
    let calls = 0;
    LLMClient.prototype.sendRequest = () => {
      calls++;
      return Promise.reject(new Error("should not be called"));
    };
    try {
      const testPattern = builder.pattern(() => builder.llm({ messages: [] }));
      const resultCell = runtime.getCell(
        space,
        "no-request-llm",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      const settled = await waitForLlmSettled(runtime, result);

      expect(calls).toBe(0);
      expect(settled.pending).toBe(false);
      expect(result.key("result").get()).toBeUndefined();
      expect(result.key("error").get()).toBeUndefined();
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });

  it("`generateText` makes no request for an empty prompt", async () => {
    const original = LLMClient.prototype.sendRequest;
    let calls = 0;
    LLMClient.prototype.sendRequest = () => {
      calls++;
      return Promise.reject(new Error("should not be called"));
    };
    try {
      const testPattern = builder.pattern(() =>
        builder.generateText({ prompt: "" })
      );
      const resultCell = runtime.getCell(
        space,
        "no-request-generateText",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      const settled = await waitForLlmSettled(runtime, result);

      expect(calls).toBe(0);
      expect(settled.pending).toBe(false);
      expect(result.key("result").get()).toBeUndefined();
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });

  it("`generateObject` makes no request for an empty prompt", async () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
    };
    const original = LLMClient.prototype.generateObject;
    let calls = 0;
    LLMClient.prototype.generateObject = () => {
      calls++;
      return Promise.reject(new Error("should not be called"));
    };
    try {
      const testPattern = builder.pattern(() =>
        builder.generateObject({ prompt: "", schema })
      );
      const resultCell = runtime.getCell(
        space,
        "no-request-generateObject",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      tx.commit();

      const settled = await waitForLlmSettled(runtime, result);

      expect(calls).toBe(0);
      expect(settled.pending).toBe(false);
      expect(result.key("result").get()).toBeUndefined();
    } finally {
      LLMClient.prototype.generateObject = original;
    }
  });
  it("`generateText` leaves no trace of a request a cleared prompt abandoned", async () => {
    const original = LLMClient.prototype.sendRequest;
    const arrived = Promise.withResolvers<void>();
    const held = new Promise<void>((resolve) => {
      releaseHeldRequest = resolve;
    });
    LLMClient.prototype.sendRequest = async () => {
      arrived.resolve();
      await held;
      return { content: "a summary of cats" } as never;
    };
    try {
      const testPattern = builder.pattern<{ prompt: string }>(({ prompt }) =>
        builder.generateText({ prompt })
      );
      const promptCell = runtime.getCell<string>(
        space,
        "cleared-prompt-input",
        undefined,
        tx,
      );
      promptCell.set("summarize cats");
      const resultCell = runtime.getCell(
        space,
        "cleared-prompt",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { prompt: promptCell },
        resultCell,
      );
      // A reader holds the node live across the prompt's transitions; the
      // runtime's disposal ends the subscription.
      result.sink(() => {});
      tx.commit();
      tx = runtime.edit();

      // The request is out and parked inside the client; the response has not
      // been produced yet.
      await arrived.promise;

      const clear = runtime.edit();
      promptCell.withTx(clear).set("");
      clear.commit();
      await runtime.idle();

      releaseHeldRequest!();
      await runtime.settled();

      // `requestHash` is what tells an applied response from an abandoned one.
      // Reading `result` alone cannot: the builtin's action reads the cell it
      // writes, so a response applied after the prompt went empty re-triggers
      // the action, which clears `result` again and hides that anything
      // landed. Only the stamp is left behind, and a hash here means the
      // answer to a prompt that no longer exists was written to the cell.
      expect(result.key("requestHash").get()).toBeUndefined();
      expect(result.key("result").get()).toBeUndefined();
      expect(result.key("partial").get()).toBeUndefined();
      expect(result.key("pending").get()).toBe(false);
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });

  it("`generateText` sends again when a cleared prompt comes back", async () => {
    const original = LLMClient.prototype.sendRequest;
    let calls = 0;
    LLMClient.prototype.sendRequest = () => {
      calls++;
      return Promise.resolve({ content: "a summary of cats" } as never);
    };
    try {
      const testPattern = builder.pattern<{ prompt: string }>(({ prompt }) =>
        builder.generateText({ prompt })
      );
      const promptCell = runtime.getCell<string>(
        space,
        "restored-prompt-input",
        undefined,
        tx,
      );
      promptCell.set("summarize cats");
      const resultCell = runtime.getCell(
        space,
        "restored-prompt",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { prompt: promptCell },
        resultCell,
      );
      // A reader holds the node live across the prompt's transitions; the
      // runtime's disposal ends the subscription.
      result.sink(() => {});
      tx.commit();
      tx = runtime.edit();

      await waitForLlmSettled(runtime, result);
      expect(calls).toBe(1);
      expect(result.key("result").get()).toBe("a summary of cats");

      const clear = runtime.edit();
      promptCell.withTx(clear).set("");
      clear.commit();
      await runtime.settled();
      expect(result.key("result").get()).toBeUndefined();

      const restore = runtime.edit();
      promptCell.withTx(restore).set("summarize cats");
      restore.commit();
      await runtime.settled();

      // The same prompt is a new request, not a duplicate of one whose result
      // was thrown away.
      expect(calls).toBe(2);
      expect(result.key("result").get()).toBe("a summary of cats");
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });

  it("`llm` leaves no trace of a request a cleared message list abandoned", async () => {
    const original = LLMClient.prototype.sendRequest;
    const arrived = Promise.withResolvers<void>();
    const held = new Promise<void>((resolve) => {
      releaseHeldRequest = resolve;
    });
    LLMClient.prototype.sendRequest = async () => {
      arrived.resolve();
      await held;
      return { content: "a summary of cats" } as never;
    };
    try {
      const testPattern = builder.pattern<{ messages: Msg[] }>(
        ({ messages }) => builder.llm({ messages }),
      );
      const messagesCell = runtime.getCell<Msg[]>(
        space,
        "cleared-messages-input",
        undefined,
        tx,
      );
      messagesCell.set([{ role: "user", content: "summarize cats" }]);
      const resultCell = runtime.getCell(
        space,
        "cleared-messages",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { messages: messagesCell },
        resultCell,
      );
      // A reader holds the node live across the message list's transitions; the
      // runtime's disposal ends the subscription.
      result.sink(() => {});
      tx.commit();
      tx = runtime.edit();

      await arrived.promise;

      const clear = runtime.edit();
      messagesCell.withTx(clear).set([]);
      clear.commit();
      await runtime.idle();

      releaseHeldRequest!();
      await runtime.settled();

      // `requestHash` is the field that tells an applied response from an
      // abandoned one, for the reason the `generateText` case above gives.
      expect(result.key("requestHash").get()).toBeUndefined();
      expect(result.key("result").get()).toBeUndefined();
      expect(result.key("partial").get()).toBeUndefined();
      expect(result.key("pending").get()).toBe(false);
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });

  it("`llm` runs no tool call of a request a cleared message list abandoned", async () => {
    // The parked request's response asks for a tool. Its request was abandoned
    // when the list was cleared, so the tools loop stops at the run check it
    // makes once a response arrives, ahead of reading the tool calls out of
    // it. The completion's check on the remembered hash sits past the tools
    // loop, and cannot stand in for this one.
    const original = LLMClient.prototype.sendRequest;
    let calls = 0;
    let toolRan = false;
    const arrived = Promise.withResolvers<void>();
    const held = new Promise<void>((resolve) => {
      releaseHeldRequest = resolve;
    });
    LLMClient.prototype.sendRequest = async (): Promise<LLMResponse> => {
      calls++;
      // A request sent with the tool's result ends the loop, so a loop that
      // does run the tool call comes to rest rather than asking again.
      if (calls > 1) {
        return { id: "abandoned-tools-2", role: "assistant", content: "done" };
      }
      arrived.resolve();
      await held;
      return {
        id: "abandoned-tools-1",
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_lookup",
          toolName: "lookup",
          input: {},
        }],
      };
    };
    try {
      const lookup = builder.handler(
        {
          type: "object",
          properties: { result: { type: "object", asCell: ["cell"] } },
          required: ["result"],
        },
        { type: "object", properties: {} },
        // deno-lint-ignore no-explicit-any
        (args: { result: any }) => {
          toolRan = true;
          args.result.set({ found: true });
        },
      );
      const testPattern = builder.pattern<{ messages: Msg[] }>(
        ({ messages }) =>
          builder.llm({
            messages,
            tools: {
              lookup: {
                description: "Looks something up.",
                handler: lookup({}),
              },
            },
          }),
      );
      const messagesCell = runtime.getCell<Msg[]>(
        space,
        "abandoned-tools-input",
        undefined,
        tx,
      );
      messagesCell.set([{ role: "user", content: "look up cats" }]);
      const resultCell = runtime.getCell(
        space,
        "abandoned-tools",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { messages: messagesCell },
        resultCell,
      );
      // A reader holds the node live across the message list's transitions; the
      // runtime's disposal ends the subscription.
      result.sink(() => {});
      tx.commit();
      tx = runtime.edit();

      await arrived.promise;

      const clear = runtime.edit();
      messagesCell.withTx(clear).set([]);
      clear.commit();
      await runtime.idle();

      releaseHeldRequest!();
      await runtime.settled();

      expect(toolRan).toBe(false);
      expect(calls).toBe(1);
      expect(result.key("pending").get()).toBe(false);
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });

  it("`llm` sends again when a cleared message list comes back", async () => {
    const original = LLMClient.prototype.sendRequest;
    let calls = 0;
    LLMClient.prototype.sendRequest = () => {
      calls++;
      return Promise.resolve({ content: "a summary of cats" } as never);
    };
    try {
      const testPattern = builder.pattern<{ messages: Msg[] }>(
        ({ messages }) => builder.llm({ messages }),
      );
      const messagesCell = runtime.getCell<Msg[]>(
        space,
        "restored-messages-input",
        undefined,
        tx,
      );
      messagesCell.set([{ role: "user", content: "summarize cats" }]);
      const resultCell = runtime.getCell(
        space,
        "restored-messages",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { messages: messagesCell },
        resultCell,
      );
      // A reader holds the node live across the message list's transitions; the
      // runtime's disposal ends the subscription.
      result.sink(() => {});
      tx.commit();
      tx = runtime.edit();

      await waitForLlmSettled(runtime, result);
      expect(calls).toBe(1);
      expect(result.key("result").get()).toBe("a summary of cats");

      const clear = runtime.edit();
      messagesCell.withTx(clear).set([]);
      clear.commit();
      await runtime.settled();
      expect(result.key("result").get()).toBeUndefined();

      const restore = runtime.edit();
      messagesCell.withTx(restore).set([
        { role: "user", content: "summarize cats" },
      ]);
      restore.commit();
      await runtime.settled();

      // The same messages are a new request, not a duplicate of one whose
      // result was thrown away.
      expect(calls).toBe(2);
      expect(result.key("result").get()).toBe("a summary of cats");
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });

  it("`generateObject` sends again when a cleared prompt comes back", async () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
    };
    const original = LLMClient.prototype.generateObject;
    let calls = 0;
    LLMClient.prototype.generateObject = () => {
      calls++;
      return Promise.resolve({ object: { answer: "cats" } } as never);
    };
    try {
      const testPattern = builder.pattern<{ prompt: string }>(({ prompt }) =>
        builder.generateObject({ prompt, schema })
      );
      const promptCell = runtime.getCell<string>(
        space,
        "restored-object-prompt-input",
        undefined,
        tx,
      );
      promptCell.set("name an animal");
      const resultCell = runtime.getCell(
        space,
        "restored-object-prompt",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { prompt: promptCell },
        resultCell,
      );
      // A reader holds the node live across the prompt's transitions; the
      // runtime's disposal ends the subscription.
      result.sink(() => {});
      tx.commit();
      tx = runtime.edit();

      await waitForLlmSettled(runtime, result);
      expect(calls).toBe(1);
      expect(result.key("result").get()).toEqual({ answer: "cats" });

      const clear = runtime.edit();
      promptCell.withTx(clear).set("");
      clear.commit();
      await runtime.settled();
      expect(result.key("result").get()).toBeUndefined();

      const restore = runtime.edit();
      promptCell.withTx(restore).set("name an animal");
      restore.commit();
      await runtime.settled();

      expect(calls).toBe(2);
      expect(result.key("result").get()).toEqual({ answer: "cats" });
    } finally {
      LLMClient.prototype.generateObject = original;
    }
  });

  it("`generateText` keeps a queued request remembered across an empty prompt", async () => {
    const original = LLMClient.prototype.sendRequest;
    let calls = 0;
    LLMClient.prototype.sendRequest = () => {
      calls++;
      return Promise.resolve({ content: "a summary of cats" } as never);
    };
    try {
      const testPattern = builder.pattern<{ prompt: string }>(({ prompt }) =>
        builder.generateText({ prompt, queue: "no-request-queue" })
      );
      const promptCell = runtime.getCell<string>(
        space,
        "queued-prompt-input",
        undefined,
        tx,
      );
      promptCell.set("summarize cats");
      const resultCell = runtime.getCell(
        space,
        "queued-prompt",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { prompt: promptCell },
        resultCell,
      );
      // A reader holds the node live across the prompt's transitions; the
      // runtime's disposal ends the subscription.
      result.sink(() => {});
      tx.commit();
      tx = runtime.edit();

      await waitForLlmSettled(runtime, result);
      expect(calls).toBe(1);

      const clear = runtime.edit();
      promptCell.withTx(clear).set("");
      clear.commit();
      await runtime.settled();

      const restore = runtime.edit();
      promptCell.withTx(restore).set("summarize cats");
      restore.commit();
      await runtime.settled();

      // The queue owns a queued request's lifecycle, so the builtin goes on
      // remembering it and the returning prompt matches rather than enqueuing a
      // second copy of the same call.
      expect(calls).toBe(1);
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });
  it("`generateText` abandons an unqueued request even if `queue` is set later", async () => {
    const original = LLMClient.prototype.sendRequest;
    const arrived = Promise.withResolvers<void>();
    const held = new Promise<void>((resolve) => {
      releaseHeldRequest = resolve;
    });
    LLMClient.prototype.sendRequest = async () => {
      arrived.resolve();
      await held;
      return { content: "a summary of cats" } as never;
    };
    try {
      const testPattern = builder.pattern<{ prompt: string; queue: string }>((
        { prompt, queue },
      ) => builder.generateText({ prompt, queue }));
      const promptCell = runtime.getCell<string>(
        space,
        "late-queue-prompt-input",
        undefined,
        tx,
      );
      promptCell.set("summarize cats");
      const queueCell = runtime.getCell<string>(
        space,
        "late-queue-name-input",
        undefined,
        tx,
      );
      queueCell.set("");
      const resultCell = runtime.getCell(
        space,
        "late-queue-prompt",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { prompt: promptCell, queue: queueCell },
        resultCell,
      );
      // A reader holds the node live across the prompt's transitions; the
      // runtime's disposal ends the subscription.
      result.sink(() => {});
      tx.commit();
      tx = runtime.edit();

      // The request went out unqueued, and is parked inside the client.
      await arrived.promise;

      // `queue` gains a name only now. The request already in flight is still
      // the unqueued one, and clearing the prompt has to abandon it.
      const change = runtime.edit();
      queueCell.withTx(change).set("late-queue");
      promptCell.withTx(change).set("");
      change.commit();
      await runtime.idle();

      releaseHeldRequest!();
      await runtime.settled();

      expect(result.key("requestHash").get()).toBeUndefined();
      expect(result.key("result").get()).toBeUndefined();
      expect(result.key("pending").get()).toBe(false);
    } finally {
      LLMClient.prototype.sendRequest = original;
    }
  });
});
