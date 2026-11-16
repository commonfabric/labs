/**
 * A turn cancelled while one of its tool calls runs records neither the tool's
 * result nor a follow-up request, and leaves the dialog idle.
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
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("llm dialog turn cancel");
const space = signer.did();

enableMockMode();

const resultSchema = {
  type: "object",
  properties: {
    addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
    cancelGeneration: { asCell: ["stream"] },
    pending: { type: "boolean" },
    messages: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
  required: ["addMessage", "cancelGeneration"],
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

  describe("a turn cancelled during a tool call", () => {
    it("keeps the call it made and records no result for it", async () => {
      // Only the first response is ever asked for: a request after the tool
      // call would fail the fixture, and the failure would land in the
      // transcript.
      loadConversationFixture({
        description: "one tool call, during which the turn is cancelled",
        responses: [{
          type: "sendRequest",
          expectRequest: { hasTools: ["cancelTurn"] },
          response: {
            role: "assistant",
            content: [{
              type: "tool-call",
              toolCallId: "call_cancel",
              toolName: "cancelTurn",
              input: {},
            }],
            id: "turn-cancel-r1",
          },
        }],
      });

      // The tool cancels the turn that called it, through the dialog's own
      // `cancelGeneration` stream, which the test reads once the dialog runs.
      const turn: { cancelGeneration?: Cell<unknown> } = {};
      let ran = false;
      const { pattern, handler, llmDialog, Cell } = commonfabric;
      const cancelTurn = handler(
        { type: "object", properties: {} },
        { type: "object", properties: {} },
        () => {
          ran = true;
          turn.cancelGeneration?.send({});
        },
      );
      const dialogPattern = pattern(
        () => {
          const messages = Cell.of<BuiltInLLMMessage[]>([]);
          const dialog = llmDialog({
            messages,
            tools: {
              cancelTurn: {
                description: "Cancels the turn that calls it.",
                handler: cancelTurn({}),
              },
            },
          });
          return {
            addMessage: dialog.addMessage,
            cancelGeneration: dialog.cancelGeneration,
            pending: dialog.pending,
            messages,
          };
        },
        false,
        resultSchema,
      );
      const result = runtime.run(
        tx,
        dialogPattern,
        {},
        runtime.getCell(space, "turn cancelled by its tool", resultSchema, tx),
      );
      tx.commit();
      tx = runtime.edit();
      turn.cancelGeneration = await result.key("cancelGeneration")
        .pull() as Cell<
          unknown
        >;

      const addMessage = await result.key("addMessage").pull() as Cell<
        BuiltInLLMMessage
      >;
      addMessage.send({ role: "user", content: "Cancel yourself." });
      await runtime.settled();

      expect(ran).toBe(true);
      const live = result.withTx();
      expect(live.key("pending").get()).toBe(false);
      const messages = live.key("messages").get() as BuiltInLLMMessage[];
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(messages[1].content).toEqual([{
        type: "tool-call",
        toolCallId: "call_cancel",
        toolName: "cancelTurn",
        input: {},
      }]);
    });
  });
});
