/// <reference path="./clock.d.ts" />

/**
 * Async builtin work must reach `runtime.trackAsyncWork()`, and it must reach
 * it under the run that started it.
 *
 * `settled()` and `settledFor()` are the runtime's "everything has finished"
 * barriers, and a barrier is only as truthful as its registry. Work a builtin
 * never registers is work the barrier cannot see, so the barrier reports
 * quiescence while the builtin is still running. That failure is silent, and it
 * is worse than a deadline: a deadline firing early reports a failure, whereas
 * a barrier returning early reports success with the data missing. An LLM tool
 * call waits on `settledFor()`, so an unregistered builtin hands the model an
 * empty tool result and the conversation continues as if that were the answer.
 *
 * `generateObject` was exactly that hole. Both of its paths built a promise
 * spanning the model call and the writeback, then attached only a `.catch()` to
 * it, so the whole tool-calling subagent shape ran outside the registry.
 *
 * Two halves guard it:
 *
 * - Each builtin below runs with its response held open, and both barriers must
 *   stay open for as long as it is held, while a barrier scoped to an unrelated
 *   cell must return. The pair pins both properties at once: the work reached
 *   the registry, and it reached it under the run that started it rather than
 *   under nobody, which would make every run wait for every other.
 * - The source scan fails when a builtin file grows a post-commit side effect
 *   without registering async work. A builtin added later cannot reopen the
 *   hole without either registering or saying in
 *   `POST_COMMIT_WITHOUT_TRACKED_WORK` why it does not have to.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  addMockObjectResponse,
  addMockResponse,
  clearMockResponses,
  enableMockMode,
  setMockResponseGate,
} from "@commonfabric/llm/client";
import type { BuiltInLLMMessage, BuiltInLLMTool } from "@commonfabric/api";
import { defer } from "@commonfabric/utils/defer";
import type { Cell, JSONSchema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

enableMockMode();

/**
 * Builtin source files that enqueue a post-commit side effect and deliberately
 * do not hand a promise to `trackAsyncWork`, with the reason. Anything absent
 * from this list has to register, and the source scan names it when it does not.
 *
 * Empty: every builtin that enqueues one registers work of its own. Two of them
 * register the settle for an abandoned request rather than the flush, and say
 * at the flush itself why that one is not registered.
 */
const POST_COMMIT_WITHOUT_TRACKED_WORK: Record<string, string> = {};

const OK_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
} as const satisfies JSONSchema;

describe("async builtin work registration", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let builder: ReturnType<typeof createBuilder>["commonfabric"];
  let held: ReturnType<typeof defer<void>>;

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    builder = createTrustedBuilder(runtime).commonfabric;
    // Hold the model's answer so there is a window in which the request is
    // genuinely outstanding. A mock that answers within a microtask leaves no
    // such window, and an unregistered builtin looks correct.
    held = defer<void>();
    setMockResponseGate(() => held.promise);
  });

  afterEach(async () => {
    setMockResponseGate(undefined);
    await tx.commit();
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * Neither the whole-runtime barrier nor the one scoped to this run may return
   * while the response is held, and both must return once it is released with
   * the result already in the cell. A barrier scoped to a cell that owns nothing
   * must return while the response is still held: the work belongs to the run
   * that started it, not to the runtime at large.
   */
  const expectBarriersSpanTheCall = async (
    run: Cell<any>,
    readResult: () => unknown,
    expected: unknown,
  ) => {
    // The built-in is a computation: a reader has to demand it before any
    // request goes out, and the barriers are measured against that demand.
    const cancelDemand = run.sink(() => {});
    let settledReturned = false;
    const settledPromise = runtime.settled().then(() => {
      settledReturned = true;
    });
    let settledForReturned = false;
    const settledForPromise = runtime.settledFor(run).then(() => {
      settledForReturned = true;
    });
    const unrelated = runtime.getCell(space, "async-work-unrelated-run");
    let unrelatedReturned = false;
    const unrelatedPromise = runtime.settledFor(unrelated).then(() => {
      unrelatedReturned = true;
    });

    // Drain every microtask and zero-delay timer to a fixpoint without moving
    // the clock. Anything the runtime was going to do while the response is held
    // has now happened, so a barrier that was going to return early has.
    await clock.settle();
    expect(settledReturned).toBe(false);
    expect(settledForReturned).toBe(false);
    expect(unrelatedReturned).toBe(true);

    held.resolve();
    await settledPromise;
    await settledForPromise;
    await unrelatedPromise;

    // Read straight out of the cell, with no wait between this and the barriers
    // above. Anything that has to be waited for here is work they failed to
    // cover.
    expect(readResult()).toEqual(expected);
    cancelDemand();
  };

  it("registers the generateObject direct path against its run", async () => {
    addMockObjectResponse(
      (req) =>
        req.messages.some((message: BuiltInLLMMessage) =>
          typeof message.content === "string" &&
          message.content.includes("direct-path-prompt")
        ),
      { object: { ok: true }, id: "mock-direct" },
    );

    const testPattern = builder.pattern<Record<string, never>>(() =>
      builder.generateObject({
        prompt: "direct-path-prompt",
        schema: OK_SCHEMA,
      } as any)
    );

    const resultCell = runtime.getCell(
      space,
      "async-work-generate-object-direct",
      testPattern.resultSchema,
      tx,
    );
    const run = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await expectBarriersSpanTheCall(
      run,
      () => run.withTx().key("result").get(),
      { ok: true },
    );
  });

  it("registers the generateObject tool-calling path against its run", async () => {
    addMockResponse(
      (req) => req.tools?.["presentResult"] !== undefined,
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_present_result",
          toolName: "presentResult",
          input: { ok: true },
        }],
        id: "mock-tools",
      },
    );

    const helper = builder.pattern<Record<string, never>, { ok: boolean }>(
      () => ({ ok: true }),
      { type: "object", additionalProperties: false },
      OK_SCHEMA,
    );

    const testPattern = builder.pattern<Record<string, never>>(() =>
      builder.generateObject({
        prompt: "tools-path-prompt",
        schema: OK_SCHEMA,
        tools: {
          helperTool: builder.patternTool(helper) as unknown as BuiltInLLMTool,
        },
      } as any)
    );

    const resultCell = runtime.getCell(
      space,
      "async-work-generate-object-tools",
      testPattern.resultSchema,
      tx,
    );
    const run = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await expectBarriersSpanTheCall(
      run,
      () => run.withTx().key("result").get(),
      { ok: true },
    );
  });

  it("registers a generateText call against its run", async () => {
    addMockResponse(
      (req) =>
        req.messages.some((message: BuiltInLLMMessage) =>
          typeof message.content === "string" &&
          message.content.includes("generate-text-prompt")
        ),
      { role: "assistant", content: "generated", id: "mock-text" },
    );

    const testPattern = builder.pattern<Record<string, never>>(() =>
      builder.generateText({ prompt: "generate-text-prompt" } as any)
    );

    const resultCell = runtime.getCell(
      space,
      "async-work-generate-text",
      testPattern.resultSchema,
      tx,
    );
    const run = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    await expectBarriersSpanTheCall(
      run,
      () => run.withTx().key("result").get(),
      "generated",
    );
  });

  it("registers an llmDialog turn against its run", async () => {
    addMockResponse(
      (req) =>
        req.messages.some((message: BuiltInLLMMessage) =>
          typeof message.content === "string" &&
          message.content.includes("dialog-prompt")
        ),
      { role: "assistant", content: "Hi there!", id: "mock-dialog" },
    );

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

    const testPattern = builder.pattern(
      () => {
        const messages = builder.Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = builder.llmDialog({ messages });
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
      "async-work-llm-dialog",
      resultSchema,
      tx,
    );
    const run = runtime.run(tx, testPattern, {}, resultCell);
    tx.commit();

    const addMessage = await run.key("addMessage").pull();
    addMessage.send({ role: "user", content: "dialog-prompt" });

    await expectBarriersSpanTheCall(
      run,
      () => run.withTx().key("messages").get()?.at(-1)?.content,
      "Hi there!",
    );
  });

  it("has every builtin that enqueues a post-commit effect register its work", async () => {
    const builtinsDir = new URL("../src/builtins/", import.meta.url);
    const unregistered: string[] = [];
    // An exemption that no longer describes its file is a claim nobody is
    // checking, so it is reported rather than left to authorize a future gap.
    const staleExemptions: string[] = [];
    const seen = new Set<string>();

    for await (const entry of Deno.readDir(builtinsDir)) {
      if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
      const source = await Deno.readTextFile(new URL(entry.name, builtinsDir));
      const exempt = entry.name in POST_COMMIT_WITHOUT_TRACKED_WORK;
      if (exempt) seen.add(entry.name);
      const enqueues = source.includes("enqueuePostCommitEffect") ||
        source.includes("enqueueSinkRequestPostCommitEffect");
      const registers = source.includes("trackAsyncWork");
      if (!enqueues || registers) {
        if (exempt) staleExemptions.push(entry.name);
        continue;
      }
      if (!exempt) unregistered.push(entry.name);
    }

    for (const name of Object.keys(POST_COMMIT_WITHOUT_TRACKED_WORK)) {
      if (!seen.has(name)) staleExemptions.push(name);
    }

    expect(unregistered).toEqual([]);
    expect(staleExemptions).toEqual([]);
  });
});
