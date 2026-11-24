/// <reference path="../clock.d.ts" />

/**
 * A dialog node driven directly, with its handlers and the model in the test's
 * hands: what a stopped dialog does with a late action or message, how a
 * refused turn's ending publishes without a publication binding and leaves a
 * newer turn's claim alone, what teardown logs when releasing a claim fails,
 * and how a turn whose tool-call step throws ends.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { BuiltInLLMMessage, CellScope } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { LLMClient, type LLMResponse } from "@commonfabric/llm";

import { llmDialog } from "../../src/builtins/llm-dialog.ts";
import { LLMMessageSchema } from "../../src/builtins/llm-schemas.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { createTransactionCommitReceipt } from "../../src/storage/commit-receipt.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { captureLogs } from "../support/captured-logs.ts";

const signer = await Identity.fromPassphrase("dialog lifecycle coverage");

/** The refusal a stand-in commit reports. */
const REFUSAL = {
  name: "AuthorizationError",
  message: "the space refused the write",
} as const;

/**
 * One dialog node over real cells. With `bound` false the node is given no
 * publication binding, as a caller that predates that coordinate gives none.
 */
async function fixture({ bound }: { bound: boolean }) {
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    servingPosture: true,
    experimental: { serverExecution: true },
  });
  const input = runtime.getCell<any>(signer.did(), "dialog-input");
  const parent = runtime.getCell<any>(signer.did(), "dialog-parent");
  const handlers = new Map<
    string,
    (tx: IExtendedStorageTransaction, event: any) => void
  >();
  const cancellations: (() => void)[] = [];
  const requests: ReturnType<typeof Promise.withResolvers<LLMResponse>>[] = [];
  const publications: CellScope[] = [];
  const cells = new Map<CellScope, Cell<BuiltInLLMMessage[]>>();
  let output: Cell<any> | undefined;
  let changed = Promise.withResolvers<void>();
  const originalSend = LLMClient.prototype.sendRequest;
  const originalHandler = runtime.scheduler.addEventHandler;
  await input.sync();
  await parent.sync();
  runtime.scheduler.addEventHandler = (handler, ref) => {
    handlers.set(`${ref.scope ?? "space"}/${ref.path.at(-1)}`, handler);
    return () => {};
  };
  LLMClient.prototype.sendRequest = () => {
    const response = Promise.withResolvers<LLMResponse>();
    requests.push(response);
    const prior = changed;
    changed = Promise.withResolvers<void>();
    prior.resolve();
    return response.promise;
  };
  const { action } = llmDialog(
    input,
    (tx, result) => {
      output = result;
      publications.push(result.getAsNormalizedFullLink().scope ?? "space");
      parent.withTx(tx).set({ output: result });
    },
    (cancel) => cancellations.push(cancel),
    "dialog-test",
    parent,
    runtime,
    undefined,
    undefined,
    bound ? parent.key("output").getAsNormalizedFullLink() : undefined,
  );

  /** The messages cell the input selects for `scope`, made on first use. */
  const messagesFor = (scope: CellScope, tx: IExtendedStorageTransaction) => {
    let messages = cells.get(scope);
    if (!messages) {
      messages = runtime.getCell<BuiltInLLMMessage[]>(
        signer.did(),
        "messages",
        { type: "array", items: LLMMessageSchema },
        tx,
        scope,
      );
      messages.withTx(tx).set([]);
      cells.set(scope, messages.withTx());
    }
    return messages;
  };

  return {
    runtime,
    requests,
    publications,
    handlers,
    get output() {
      return output!;
    },
    messages(scope: CellScope) {
      return cells.get(scope)!.get().map((message) => ({
        role: message.role,
        content: message.content,
      }));
    },
    /** Stops the node, as the runner does when its piece stops. */
    stop() {
      cancellations[0]();
    },
    /** Points the input at `scope`'s messages and runs the node's action. */
    async select(scope: CellScope) {
      const tx = runtime.edit();
      input.withTx(tx).set({ messages: messagesFor(scope, tx) });
      action(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
    },
    /** Sends `content` to `scope`'s `addMessage` handler in an open transaction. */
    stage(scope: CellScope, content: string) {
      const tx = runtime.edit();
      handlers.get(`${scope}/addMessage`)!(tx, { role: "user", content });
      return tx;
    },
    /** Answers every request made so far, and waits for the runtime to settle. */
    async drain() {
      for (const request of requests) {
        request.resolve({ role: "assistant", content: "drained", id: "x" });
      }
      await runtime.settled();
    },
    async issued(count: number) {
      while (requests.length < count) await changed.promise;
    },
    async close() {
      runtime.clearSealDestination();
      for (const request of requests) {
        request.resolve({ role: "assistant", content: "cleanup", id: "x" });
      }
      try {
        await runtime.settled();
        await runtime.dispose({ closeStorage: false });
        await storage.close();
      } finally {
        LLMClient.prototype.sendRequest = originalSend;
        runtime.scheduler.addEventHandler = originalHandler;
      }
    },
  };
}

/** Abandons a staged turn, as a refused commit does. */
function refuse(tx: IExtendedStorageTransaction) {
  const reason = {
    name: "StorageTransactionAborted",
    message: "Test refusal",
    reason: "Test refusal",
  } as const;
  tx.abort(reason);
  tx.abandonStagedWork(reason);
}

type EditOptions = Parameters<Runtime["editWithRetry"]>[2];

const REQUEST_ID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

describe("llm-dialog", () => {
  describe("a stopped dialog", () => {
    it("registers no handlers and publishes nothing when its action runs again", async () => {
      const f = await fixture({ bound: true });
      try {
        await f.select("space");
        expect(f.handlers.has("space/addMessage")).toBe(true);

        f.stop();
        const published = f.publications.length;
        await f.select("user");

        expect(f.handlers.has("user/addMessage")).toBe(false);
        expect(f.publications).toHaveLength(published);
      } finally {
        await f.close();
      }
    });

    it("drops a message its `addMessage` handler is given, where a running one takes it", async () => {
      const f = await fixture({ bound: true });
      try {
        await f.select("space");
        const taken = f.stage("space", "taken");
        expect((await taken.commit().settled).error).toBeUndefined();
        await taken.postCommitEffectsSettled();
        await f.issued(1);
        expect(f.messages("space")).toEqual([
          { role: "user", content: "taken" },
        ]);

        await f.select("user");
        f.stop();
        const dropped = f.stage("user", "dropped");
        expect((await dropped.commit().settled).error).toBeUndefined();

        expect(f.messages("user")).toEqual([]);
        expect(f.requests).toHaveLength(1);
      } finally {
        await f.close();
      }
    });
  });

  describe("the ending of a refused turn", () => {
    it("publishes the result when the node has no publication binding and the input still selects the turn's scope", async () => {
      const f = await fixture({ bound: false });
      try {
        await f.select("space");
        const published = f.publications.length;
        refuse(f.stage("space", "refused"));
        await f.runtime.settled();

        expect(f.publications.slice(published)).toEqual(["space"]);
        expect(f.output.key("pending").get()).toBe(false);
        expect(f.requests).toHaveLength(0);
      } finally {
        await f.close();
      }
    });

    it("publishes nothing when the node has no publication binding and the input moved to another scope", async () => {
      const f = await fixture({ bound: false });
      try {
        await f.select("space");
        const tx = f.stage("space", "refused");
        await f.select("user");
        const published = f.publications.length;
        refuse(tx);
        await f.runtime.settled();

        expect(f.publications).toHaveLength(published);
        expect(f.publications.at(-1)).toBe("user");
      } finally {
        await f.close();
      }
    });

    it("leaves pending set when a newer turn took the claim", async () => {
      const f = await fixture({ bound: true });
      try {
        await f.select("space");
        const older = f.stage("space", "older");
        const newer = f.stage("space", "newer");
        expect((await newer.commit().settled).error).toBeUndefined();
        // The newer turn's request stays unanswered, so the runtime does not
        // settle; the older turn's ending is waited for by its own edit.
        const editWithRetry = f.runtime.editWithRetry;
        const edits: Promise<unknown>[] = [];
        f.runtime.editWithRetry = <T = void>(
          fn: (tx: IExtendedStorageTransaction) => T,
          maxRetries?: number,
          options?: EditOptions,
        ) => {
          const edit = Reflect.apply(editWithRetry, f.runtime, [
            fn,
            maxRetries,
            options,
          ]);
          edits.push(edit);
          return edit;
        };
        try {
          refuse(older);
          await f.issued(1);
          expect(edits.length).toBeGreaterThan(0);
          await Promise.all(edits);
        } finally {
          f.runtime.editWithRetry = editWithRetry;
        }

        expect(f.output.key("pending").get()).toBe(true);
        expect(f.messages("space")).toEqual([
          { role: "user", content: "newer" },
        ]);
      } finally {
        await f.close();
      }
    });
  });

  describe("teardown", () => {
    /** Starts one live turn in each scope. */
    async function liveTurns(f: Awaited<ReturnType<typeof fixture>>) {
      for (const scope of ["space", "user"] as const) {
        await f.select(scope);
        const tx = f.stage(scope, scope);
        expect((await tx.commit().settled).error).toBeUndefined();
        await tx.postCommitEffectsSettled();
      }
      await f.issued(2);
    }

    it("logs the request whose claim release threw, and only that one", async () => {
      const f = await fixture({ bound: true });
      const edit = f.runtime.edit;
      try {
        await liveTurns(f);
        let attempts = 0;
        f.runtime.edit = (...args) => {
          if (++attempts === 1) throw new Error("teardown failure");
          return edit.apply(f.runtime, args);
        };
        using logs = captureLogs("llm-dialog");
        f.stop();
        await f.drain();

        expect(logs.textsOf("dialog-claim-cleanup-failed")).toEqual([
          expect.stringMatching(new RegExp(`^${REQUEST_ID} teardown failure$`)),
        ]);
      } finally {
        f.runtime.edit = edit;
        await f.close();
      }
    });

    it("logs each request whose claim release did not commit", async () => {
      const f = await fixture({ bound: true });
      const edit = f.runtime.edit;
      try {
        await liveTurns(f);
        f.runtime.edit = (...args) => {
          const opened = edit.apply(f.runtime, args);
          opened.commit = () => {
            opened.abort(REFUSAL);
            return createTransactionCommitReceipt(
              Promise.resolve({ error: REFUSAL }),
            );
          };
          return opened;
        };
        using logs = captureLogs("llm-dialog");
        f.stop();
        await f.drain();

        const logged = logs.textsOf("dialog-claim-cleanup-failed");
        expect(logged).toHaveLength(2);
        for (const text of logged) {
          expect(text).toMatch(
            new RegExp(`^${REQUEST_ID} .*the space refused the write`),
          );
        }
      } finally {
        f.runtime.edit = edit;
        await f.close();
      }
    });
  });

  describe("a turn whose tool-call step throws", () => {
    it("ends with an error message and pending cleared", async () => {
      const f = await fixture({ bound: true });
      const editWithRetry = f.runtime.editWithRetry;
      try {
        await f.select("space");
        const tx = f.stage("space", "call a tool");
        expect((await tx.commit().settled).error).toBeUndefined();
        await f.issued(1);
        let thrown = false;
        f.runtime.editWithRetry = <T = void>(
          fn: (tx: IExtendedStorageTransaction) => T,
          maxRetries?: number,
          options?: EditOptions,
        ) => {
          if (!thrown) {
            thrown = true;
            throw new Error("tool step failed");
          }
          return Reflect.apply(editWithRetry, f.runtime, [
            fn,
            maxRetries,
            options,
          ]);
        };
        f.requests[0].resolve({
          role: "assistant",
          content: [{
            type: "tool-call",
            toolCallId: "call",
            toolName: "someTool",
            input: {},
          }],
          id: "tool-step-r1",
        });
        await f.runtime.settled();

        expect(thrown).toBe(true);
        expect(f.output.key("pending").get()).toBe(false);
        expect(f.messages("space")).toEqual([
          { role: "user", content: "call a tool" },
          {
            role: "assistant",
            content:
              "I encountered an error generating a response: tool step failed",
          },
        ]);
      } finally {
        f.runtime.editWithRetry = editWithRetry;
        await f.close();
      }
    });
  });
});
