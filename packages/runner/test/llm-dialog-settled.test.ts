/**
 * `runtime.settled()` must span a whole llmDialog turn.
 *
 * `settled()` is the runtime's "everything has finished, including async
 * builtin I/O" barrier, and it is what lets a caller wait on an LLM turn
 * without a deadline or a poll. It only covers work a builtin hands to
 * `runtime.trackAsyncWork()`, so a builtin that tracks a promise settling
 * before its real work is done makes the barrier lie: `settled()` returns while
 * the request is still in flight, and the only ways left to wait are watching a
 * value or arming a timer.
 *
 * This reads the dialog immediately after `settled()` returns, with no other
 * wait in between, so it fails if the barrier does not cover the turn.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  clearMockResponses,
  enableMockMode,
  loadConversationFixture,
  setMockResponseGate,
} from "@commonfabric/llm/client";
import type { BuiltInLLMMessage, JSONSchema } from "@commonfabric/api";
import { defer } from "@commonfabric/utils/defer";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

enableMockMode();

describe("runtime.settled() and llmDialog", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let Cell: ReturnType<typeof createBuilder>["commonfabric"]["Cell"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let llmDialog: ReturnType<typeof createBuilder>["commonfabric"]["llmDialog"];

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({ pattern, llmDialog, Cell } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("settles a dialog turn before returning", async () => {
    loadConversationFixture({
      description: "One turn, so settled() has a request to cover",
      responses: [
        {
          type: "sendRequest",
          expectRequest: { messagesContain: ["Hello"], messageCount: 1 },
          response: { role: "assistant", content: "Hi there!", id: "r1" },
        },
      ],
    });

    const resultSchema = {
      type: "object",
      properties: {
        addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
        pending: { type: "boolean" },
        messages: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["addMessage"],
    } as const satisfies JSONSchema;

    const testPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({ messages });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          messages,
        };
      },
      false,
      resultSchema,
    );

    const resultCell = runtime.getCell(
      space,
      "llmDialog-settled-test",
      resultSchema,
      tx,
    );

    const result = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    // Hold the model's answer so there is a window in which the request is
    // genuinely outstanding. A mock that answers within a microtask leaves no
    // such window, and the barrier looks correct whether or not it covers the
    // request.
    const held = defer<void>();
    setMockResponseGate(() => held.promise);

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "Hello" });

    let settledReturned = false;
    const settledPromise = runtime.settled().then(() => {
      settledReturned = true;
    });

    // Drain every microtask and zero-delay timer to a fixpoint without moving
    // the clock. Anything the runtime was going to do while the request is held
    // has now happened, so a barrier that was going to return early has.
    await clock.settle();
    expect(settledReturned).toBe(false);

    held.resolve();
    await settledPromise;

    // Read straight out of the cell, with no wait between this and the barrier
    // above. Anything that has to be waited for here is work it failed to
    // cover.
    const live = result.withTx();
    expect(live.key("pending").get()).toBe(false);
    expect(live.key("messages").get()?.length).toBe(2);
    expect(live.key("messages").get()?.at(-1)?.content).toBe("Hi there!");
  });
});
