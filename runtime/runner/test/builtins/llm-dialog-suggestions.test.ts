/**
 * A dialog on the `suggestions` queue records each result it presents in the
 * space's suggestion history, through the `recordSuggestion` stream the space's
 * default pattern exports.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { BuiltInLLMMessage, JSONSchema } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import {
  clearMockResponses,
  enableMockMode,
  loadConversationFixture,
} from "@commonfabric/llm/client";

import type { createBuilder } from "../../src/builder/factory.ts";
import { LLMMessageSchema } from "../../src/builtins/llm-schemas.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime, spaceCellSchema } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { waitForLlmMessages } from "../support/llm-result.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("llm dialog suggestions");
const space = signer.did();

enableMockMode();

type Recorded = { answer: string; messageCount: number; timestamp: string };

const historySchema = {
  type: "array",
  items: { type: "object", additionalProperties: true },
} as const satisfies JSONSchema;

const dialogResultSchema = {
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

describe("llm-dialog", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: ReturnType<typeof createBuilder>["commonfabric"];

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    commonfabric = createTrustedBuilder(runtime).commonfabric;
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose({ closeStorage: false });
    await storageManager?.close();
  });

  /**
   * Installs a default pattern whose `recordSuggestion` stream appends what it
   * is sent to a history, and returns that pattern's result.
   */
  function installDefaultPattern() {
    const { pattern, handler, Cell } = commonfabric;
    const record = handler(
      {
        type: "object",
        properties: {
          result: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
          messages: { type: "array" },
          timestamp: { type: "string" },
        },
      },
      {
        type: "object",
        properties: { history: { ...historySchema, asCell: ["cell"] } },
        required: ["history"],
      },
      (
        event: {
          result: { answer: string };
          messages: unknown[];
          timestamp: string;
        },
        { history }: { history: Cell<Recorded[]> },
      ) => {
        history.push({
          answer: event.result.answer,
          messageCount: event.messages.length,
          timestamp: event.timestamp,
        });
      },
    );
    const home = pattern(
      () => {
        const history = Cell.of<Recorded[]>([]);
        return { history, recordSuggestion: record({ history }) };
      },
      false,
      {
        type: "object",
        properties: {
          history: historySchema,
          recordSuggestion: { asCell: ["stream"] },
        },
      },
    );
    const homeResult = runtime.run(
      tx,
      home,
      {},
      runtime.getCell(space, "default pattern", undefined, tx),
    );
    (runtime.getCell(space, space, spaceCellSchema, tx) as Cell<
      Record<string, unknown>
    >).key("defaultPattern").set(homeResult as never);
    return homeResult;
  }

  /** Runs a dialog that presents a result, on the queue named `queue`. */
  function runDialog(cause: string, queue: string) {
    const { pattern, llmDialog, Cell } = commonfabric;
    const dialogPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({
          messages,
          resultSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
          queue,
        });
        return {
          addMessage: dialog.addMessage,
          pending: dialog.pending,
          messages,
        };
      },
      false,
      dialogResultSchema,
    );
    return runtime.run(
      tx,
      dialogPattern,
      {},
      runtime.getCell(space, cause, dialogResultSchema, tx),
    );
  }

  function presentingFixture() {
    loadConversationFixture({
      description: "a turn that presents a result, then finishes",
      responses: [
        {
          type: "sendRequest",
          expectRequest: { hasTools: ["presentResult"] },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "present",
              toolName: "presentResult",
              input: { answer: "forty-two" },
            }],
            id: "suggestion-r1",
          },
        },
        {
          type: "sendRequest",
          response: {
            role: "assistant",
            content: "Done.",
            id: "suggestion-r2",
          },
        },
      ],
    });
  }

  async function converse(dialog: Cell<unknown>) {
    const addMessage = await dialog.key("addMessage").pull() as Cell<
      BuiltInLLMMessage
    >;
    addMessage.send({ role: "user", content: "Suggest something." });
    await waitForLlmMessages(runtime, dialog, 4);
    await runtime.settled();
  }

  describe("the `suggestions` queue", () => {
    it("records a presented result in the space's suggestion history", async () => {
      presentingFixture();
      const home = installDefaultPattern();
      const dialog = runDialog("suggesting dialog", "suggestions");
      tx.commit();
      tx = runtime.edit();

      await converse(dialog);

      const history = await home.key("history").pull() as Recorded[];
      expect(history).toHaveLength(1);
      expect(history[0].answer).toBe("forty-two");
      // The user's message, the call, and its result had been pushed when the
      // result was recorded.
      expect(history[0].messageCount).toBe(3);
      expect(Number.isNaN(Date.parse(history[0].timestamp))).toBe(false);
    });

    it("records nothing for a dialog on another queue", async () => {
      presentingFixture();
      const home = installDefaultPattern();
      const dialog = runDialog("other-queue dialog", "elsewhere");
      tx.commit();
      tx = runtime.edit();

      await converse(dialog);

      expect(await home.key("history").pull()).toEqual([]);
    });
  });
});
