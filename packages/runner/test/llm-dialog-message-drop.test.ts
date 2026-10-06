/// <reference path="./clock.d.ts" />

/**
 * A message added while a dialog turn is already running is dropped, and how
 * `addMessage` decides a turn is still running depends on who is running it.
 *
 * A dialog is durable and runs in more than one replica, so a turn started in
 * one tab is visible in another as `pending` being true. For a turn belonging
 * to another replica the only signal available is `internal.lastActivity`, a
 * heartbeat refreshed on every durable write of the turn, and `REQUEST_TIMEOUT`
 * is the bound past which that replica is presumed gone. Nothing distinguishes
 * a crashed peer from a slow one, so the bound stays.
 *
 * For a turn this replica is running there is nothing to detect: it knows the
 * turn is alive, because it is the one running it. The four cases below pin
 * that split. The second is the one that used to be wrong: a turn making no
 * durable writes for longer than the bound had the replica running it declare
 * the turn dead and start a second request against itself. A single model call
 * that runs that long produces such a turn. So does a tool call, which nothing
 * bounds, and so does a round of several, which run one after another and write
 * their results only once they have all returned.
 *
 * The two peer cases put `pending` back to true with no turn running locally.
 * That the write reaches the dialog's own durable cell is what the
 * within-the-bound case proves, by dropping a message that a dialog reading
 * `pending` as false would have taken; the past-the-bound case rests on it.
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
import { llmDialogTestHelpers } from "../src/builtins/llm-dialog.ts";

const { REQUEST_TIMEOUT } = llmDialogTestHelpers;

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

enableMockMode();

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

describe("llmDialog drops messages added during a running turn", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let Cell: ReturnType<typeof createBuilder>["commonfabric"]["Cell"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let llmDialog: ReturnType<typeof createBuilder>["commonfabric"]["llmDialog"];

  beforeEach(() => {
    clearMockResponses();
    clock.reset();
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

  // Start the dialog and return its result cell. The caller sends messages
  // through `addMessage` and reads `messages` and `pending` back. The setup
  // commit is awaited so a failure to write the dialog into place is reported
  // here rather than as whatever the rest of the case does without it.
  const startDialog = async (cause: string) => {
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

    const resultCell = runtime.getCell(space, cause, resultSchema, tx);
    const result = runtime.run(tx, testPattern, {}, resultCell);
    const { error } = await tx.commit().settled;
    if (error) throw error;
    return result;
  };

  // deno-lint-ignore no-explicit-any
  const contentsOf = (result: any) =>
    (result.withTx().key("messages").get() ?? []).map(
      (message: BuiltInLLMMessage) => message.content,
    );

  it("drops while its own turn runs within the staleness bound", async () => {
    loadConversationFixture({
      description: "one answer for the held turn, one a second request would " +
        "take if the dropped message started one",
      responses: [
        {
          type: "sendRequest",
          response: { role: "assistant", content: "Hi there!", id: "r1" },
        },
        {
          type: "sendRequest",
          response: { role: "assistant", content: "Second answer", id: "r2" },
        },
      ],
    });

    const result = await startDialog("llmDialog-message-drop-own-fresh-turn");

    let requestsSeen = 0;
    const requestReached = defer<void>();
    const held = defer<void>();
    setMockResponseGate(() => {
      requestsSeen++;
      requestReached.resolve();
      return held.promise;
    });

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "First" });
    await requestReached.promise;

    // The ordinary case, and what the whole `pending` block was there for
    // before any of this: a second message arrives while the turn that is
    // running is young enough that the heartbeat would have caught it too.
    addMessage.send({ role: "user", content: "Second" });
    await clock.settle();

    held.resolve();
    await runtime.settled();

    expect(contentsOf(result)).toEqual(["First", "Hi there!"]);
    expect(requestsSeen).toBe(1);
    expect(result.withTx().key("pending").get()).toBe(false);
  });

  it("keeps dropping while its own turn runs past the staleness bound", async () => {
    loadConversationFixture({
      description: "one answer for the held turn, one a second request would " +
        "take if the dropped message started one",
      responses: [
        {
          type: "sendRequest",
          response: { role: "assistant", content: "Hi there!", id: "r1" },
        },
        {
          type: "sendRequest",
          response: { role: "assistant", content: "Second answer", id: "r2" },
        },
      ],
    });

    const result = await startDialog("llmDialog-message-drop-own-turn");

    // Hold the model's answer so the turn stays genuinely in flight, and count
    // the requests that reach the model. A dropped message starts no request,
    // so the count is what separates the two outcomes.
    let requestsSeen = 0;
    const requestReached = defer<void>();
    const held = defer<void>();
    setMockResponseGate(() => {
      requestsSeen++;
      requestReached.resolve();
      return held.promise;
    });

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "First" });

    // The gate is entered from inside the turn, so this is the turn announcing
    // that it is running rather than a guess that it has started by now.
    await requestReached.promise;
    expect(result.withTx().key("pending").get()).toBe(true);

    // Move logical time past the staleness bound while the turn is held. This
    // is the shape of a long tool call: the turn is running and writing
    // nothing durable, so the heartbeat it would refresh stands still and goes
    // stale under a replica that is plainly alive.
    const before = Date.now();
    await clock.tick(REQUEST_TIMEOUT + 60_000);
    expect(Date.now() - before).toBeGreaterThan(REQUEST_TIMEOUT);

    addMessage.send({ role: "user", content: "Second" });
    // Drain reactive work to a fixpoint, so a second request this message was
    // going to start has started by the time the gate count is read.
    await clock.settle();
    expect(requestsSeen).toBe(1);

    held.resolve();
    await runtime.settled();

    // The dropped message never reached the conversation, and the held turn
    // finished as the only turn there was.
    expect(contentsOf(result)).toEqual(["First", "Hi there!"]);
    expect(requestsSeen).toBe(1);
    expect(result.withTx().key("pending").get()).toBe(false);
  });

  it("drops while another replica's turn is within the staleness bound", async () => {
    loadConversationFixture({
      description: "one answer, plus one a second request would take",
      responses: [
        {
          type: "sendRequest",
          response: { role: "assistant", content: "Hi there!", id: "r1" },
        },
        {
          type: "sendRequest",
          response: { role: "assistant", content: "Second answer", id: "r2" },
        },
      ],
    });

    const result = await startDialog("llmDialog-message-drop-live-peer");

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "First" });
    await runtime.settled();
    expect(contentsOf(result)).toEqual(["First", "Hi there!"]);

    // The finished turn left a fresh heartbeat behind. Putting `pending` back
    // to true is what this replica sees when another one starts a turn: the
    // flag is durable, and only the replica running the turn holds anything
    // more than the heartbeat.
    let requestsSeen = 0;
    setMockResponseGate(() => {
      requestsSeen++;
      return Promise.resolve();
    });
    const pendingTx = runtime.edit();
    result.withTx(pendingTx).key("pending").set(true);
    await pendingTx.commit().settled;
    await runtime.settled();

    addMessage.send({ role: "user", content: "Second" });
    await runtime.settled();

    expect(contentsOf(result)).toEqual(["First", "Hi there!"]);
    expect(requestsSeen).toBe(0);
  });

  it("accepts once another replica's turn passes the staleness bound", async () => {
    loadConversationFixture({
      description: "one answer, then the answer to the message that takes " +
        "over from the presumed-gone replica",
      responses: [
        {
          type: "sendRequest",
          response: { role: "assistant", content: "Hi there!", id: "r1" },
        },
        {
          type: "sendRequest",
          response: { role: "assistant", content: "Second answer", id: "r2" },
        },
      ],
    });

    const result = await startDialog("llmDialog-message-drop-gone-peer");

    const addMessage = await result.key("addMessage").pull();
    addMessage.send({ role: "user", content: "First" });
    await runtime.settled();
    expect(contentsOf(result)).toEqual(["First", "Hi there!"]);

    let requestsSeen = 0;
    setMockResponseGate(() => {
      requestsSeen++;
      return Promise.resolve();
    });
    const pendingTx = runtime.edit();
    result.withTx(pendingTx).key("pending").set(true);
    await pendingTx.commit().settled;
    await runtime.settled();

    // No replica refreshed the heartbeat for longer than the bound, so the one
    // that started the turn is presumed gone and the message is taken. This
    // replica is running no turn of its own, so it has nothing better to go on.
    await clock.tick(REQUEST_TIMEOUT + 60_000);

    addMessage.send({ role: "user", content: "Second" });
    await runtime.settled();

    expect(contentsOf(result)).toEqual([
      "First",
      "Hi there!",
      "Second",
      "Second answer",
    ]);
    expect(requestsSeen).toBe(1);
  });
});
