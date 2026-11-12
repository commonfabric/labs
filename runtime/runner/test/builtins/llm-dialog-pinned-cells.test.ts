/**
 * The cells a dialog's user pins through its `pinCell` and `unpinAllCells`
 * streams: what the dialog reports as pinned, and the system prompt of the
 * next turn, which documents what is pinned.
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
import { createLLMFriendlyLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { waitForLlmMessages } from "../support/llm-result.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("llm dialog pinned cells");
const space = signer.did();

enableMockMode();

type PinnedCell = { path: string; name: string };

const resultSchema = {
  type: "object",
  properties: {
    addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
    pinCell: {
      type: "object",
      properties: { path: { type: "string" }, name: { type: "string" } },
      required: ["path", "name"],
      asCell: ["stream"],
    },
    unpinAllCells: { asCell: ["stream"] },
    pinnedCells: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, name: { type: "string" } },
      },
    },
    pending: { type: "boolean" },
    messages: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
  required: ["addMessage", "pinCell", "unpinAllCells"],
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
    // `closeStorage: false` drains the runtime's outstanding work first, so a
    // handler's commit still in flight lands rather than being refused.
    await runtime?.dispose({ closeStorage: false });
    await storageManager?.close();
  });

  /** Runs a dialog exposing its pinning streams, and returns its result. */
  function runDialog(cause: string) {
    const { pattern, llmDialog, Cell } = commonfabric;
    const dialogPattern = pattern(
      () => {
        const messages = Cell.of<BuiltInLLMMessage[]>([]);
        const dialog = llmDialog({ messages });
        return {
          addMessage: dialog.addMessage,
          pinCell: dialog.pinCell,
          unpinAllCells: dialog.unpinAllCells,
          pinnedCells: dialog.pinnedCells,
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
      runtime.getCell(space, cause, resultSchema, tx),
    );
    tx.commit();
    tx = runtime.edit();
    return result;
  }

  async function pin(result: Cell<unknown>, pinned: PinnedCell) {
    const pinCell = await result.key("pinCell").pull() as Cell<PinnedCell>;
    pinCell.send(pinned);
    await runtime.idle();
  }

  async function pinnedCellsOf(result: Cell<unknown>) {
    return await result.key("pinnedCells").pull() as PinnedCell[] | undefined;
  }

  describe("pinCell", () => {
    it("reports each pinned path once, however often it is pinned", async () => {
      const result = runDialog("pin twice");

      await pin(result, { path: "/of:bafyfirst", name: "First" });
      await pin(result, { path: "/of:bafysecond", name: "Second" });
      await pin(result, { path: "/of:bafyfirst", name: "First again" });

      expect(await pinnedCellsOf(result)).toEqual([
        { path: "/of:bafyfirst", name: "First" },
        { path: "/of:bafysecond", name: "Second" },
      ]);
    });
  });

  describe("unpinAllCells", () => {
    it("reports nothing pinned after every pinned cell is unpinned", async () => {
      const result = runDialog("unpin all");
      await pin(result, { path: "/of:bafyfirst", name: "First" });
      await pin(result, { path: "/of:bafysecond", name: "Second" });
      expect(await pinnedCellsOf(result)).toHaveLength(2);

      const unpinAll = await result.key("unpinAllCells").pull() as Cell<
        unknown
      >;
      unpinAll.send({});
      await runtime.idle();

      expect(await pinnedCellsOf(result)).toEqual([]);
    });
  });

  describe("a turn after a cell is pinned", () => {
    it("documents the pinned cell's value in the system prompt", async () => {
      const notes = runtime.getCell<{ text: string }>(
        space,
        "pinned notes",
        undefined,
        tx,
      );
      notes.set({ text: "remember the milk" });
      tx.commit();
      tx = runtime.edit();
      loadConversationFixture({
        description: "one turn whose system prompt documents a pinned cell",
        responses: [{
          type: "sendRequest",
          expectRequest: { systemContains: "remember the milk" },
          response: { role: "assistant", content: "Noted.", id: "pinned-r1" },
        }],
      });
      const result = runDialog("turn with a pinned cell");
      await pin(result, {
        path: createLLMFriendlyLink(notes.getAsNormalizedFullLink(), space),
        name: "Notes",
      });

      const addMessage = await result.key("addMessage").pull() as Cell<
        BuiltInLLMMessage
      >;
      addMessage.send({ role: "user", content: "What is pinned?" });
      const settled = await waitForLlmMessages(runtime, result, 2);

      expect(
        (settled.messages?.at(-1) as BuiltInLLMMessage | undefined)?.content,
      ).toBe("Noted.");
    });
  });
});
