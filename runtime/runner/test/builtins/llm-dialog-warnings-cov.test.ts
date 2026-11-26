/**
 * What the dialog's logger says when a tool call's write is refused, and when a
 * presented suggestion cannot be recorded in the space's history.
 */

import { expect } from "@std/expect";

import type {
  BuiltInLLMMessage,
  BuiltInLLMToolCallPart,
  JSONSchema,
} from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import {
  clearMockResponses,
  enableMockMode,
  loadConversationFixture,
} from "@commonfabric/llm/client";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { createBuilder } from "../../src/builder/factory.ts";
import type { Pattern } from "../../src/builder/types.ts";
import { llmToolExecutionHelpers } from "../../src/builtins/llm-dialog.ts";
import { LLMMessageSchema } from "../../src/builtins/llm-schemas.ts";
import type { Cell } from "../../src/cell.ts";
import { createLLMFriendlyLink } from "../../src/link-utils.ts";
import { Runtime, spaceCellSchema } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { captureLogs } from "../support/captured-logs.ts";
import { waitForLlmMessages } from "../support/llm-result.ts";
import {
  createTrustedBuilder,
  trustExecutable,
} from "../support/trusted-builder.ts";

const { buildToolCatalog, executeToolCalls } = llmToolExecutionHelpers;

const signer = await Identity.fromPassphrase("llm dialog warnings");
const space = signer.did();

enableMockMode();

/** The refusal a stand-in runtime gives every commit it is asked for. */
const REFUSAL = {
  name: "AuthorizationError",
  message: "the space refused the write",
} as const;

/** A pattern that doubles its `value` argument into `doubled`. */
const doubler: Pattern = {
  argumentSchema: {
    type: "object",
    properties: { value: { type: "number" } },
  },
  resultSchema: {
    type: "object",
    properties: { doubled: { type: "number" } },
  },
  result: { doubled: { $alias: { partialCause: "doubled", path: [] } } },
  nodes: [
    {
      module: {
        type: "javascript",
        implementation: (v: number) => v * 2,
      },
      inputs: { $alias: { cell: "argument", path: ["value"] } },
      outputs: { $alias: { partialCause: "doubled", path: [] } },
    },
  ],
};

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

function call(
  toolName: string,
  input: Record<string, unknown>,
): BuiltInLLMToolCallPart {
  return { type: "tool-call", toolCallId: `call-${toolName}`, toolName, input };
}

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

  /** Commits the open transaction and opens the next. */
  async function commit() {
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await runtime.idle();
    tx = runtime.edit();
  }

  describe("a tool call whose write is refused", () => {
    /**
     * A runtime whose commits are all refused, and which otherwise resolves
     * the cells it is asked for through the real one.
     */
    function refusingRuntime(): Runtime {
      return {
        getCellFromLink: (...args: Parameters<Runtime["getCellFromLink"]>) =>
          runtime.getCellFromLink(...args),
        editWithRetry: () => Promise.resolve({ error: REFUSAL }),
      } as unknown as Runtime;
    }

    /** The built-in tools alone, as a dialog with no tools of its own has them. */
    async function builtinCatalog() {
      const tools = runtime.getCell<Record<string, never>>(
        space,
        "no tools of its own",
        undefined,
        tx,
      );
      tools.set({});
      await commit();
      return buildToolCatalog(tools, true);
    }

    async function pinnedCells(pinned: { path: string; name: string }[]) {
      const cell = runtime.getCell<{ path: string; name: string }[]>(
        space,
        "pinned cells",
        undefined,
        tx,
      );
      cell.set(pinned);
      await commit();
      return cell;
    }

    /** Runs `calls` against `on`, returning what was logged under `key`. */
    async function warnedUnder(
      key: string,
      on: Runtime,
      calls: BuiltInLLMToolCallPart[],
      pinned?: Cell<{ path: string; name: string }[]>,
    ): Promise<string[]> {
      const catalog = await builtinCatalog();
      using logs = captureLogs("llm-dialog");
      await executeToolCalls(on, space, catalog, calls, pinned);
      return logs.textsOf(key);
    }

    it("logs the path of a pin that did not commit, and the refusal", async () => {
      const pinned = await pinnedCells([]);
      const pin = call("pin", { path: "/of:bafypinned", name: "Pinned" });

      expect(
        await warnedUnder(
          "pin-commit-failed",
          refusingRuntime(),
          [pin],
          pinned,
        ),
      ).toEqual([
        expect.stringMatching(
          /^pin of \/of:bafypinned failed to commit .*the space refused the write/,
        ),
      ]);
      expect(await warnedUnder("pin-commit-failed", runtime, [pin], pinned))
        .toEqual([]);
    });

    it("logs the path of an unpin that did not commit, and the refusal", async () => {
      const pinned = await pinnedCells([
        { path: "/of:bafypinned", name: "Pinned" },
      ]);
      const unpin = call("unpin", { path: "/of:bafypinned" });

      expect(
        await warnedUnder(
          "unpin-commit-failed",
          refusingRuntime(),
          [unpin],
          pinned,
        ),
      ).toEqual([
        expect.stringMatching(
          /^unpin of \/of:bafypinned failed to commit .*the space refused the write/,
        ),
      ]);
      expect(await warnedUnder("unpin-commit-failed", runtime, [unpin], pinned))
        .toEqual([]);
    });

    it("logs an argument update that did not commit, and the refusal", async () => {
      const result = await runtime.runSynced(
        runtime.getCell(space, "refused update target"),
        trustExecutable(runtime, doubler),
        { value: 21 },
      );
      await result.pull();
      await runtime.idle();
      const update = call("updateArgument", {
        path: createLLMFriendlyLink(result.getAsNormalizedFullLink(), space),
        updates: { value: 5 },
      });

      expect(
        await warnedUnder(
          "update-argument-commit-failed",
          refusingRuntime(),
          [update],
        ),
      ).toEqual([
        expect.stringMatching(
          /^updateArgument failed to commit .*the space refused the write/,
        ),
      ]);
      expect(
        await warnedUnder("update-argument-commit-failed", runtime, [update]),
      ).toEqual([]);
    });
  });

  describe("a presented suggestion", () => {
    /** Runs a dialog on the `suggestions` queue that presents one result. */
    async function presentSuggestion(cause: string) {
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
              id: `${cause}-r1`,
            },
          },
          {
            type: "sendRequest",
            response: {
              role: "assistant",
              content: "Done.",
              id: `${cause}-r2`,
            },
          },
        ],
      });
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
            queue: "suggestions",
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
      const dialog = runtime.run(
        tx,
        dialogPattern,
        {},
        runtime.getCell(space, cause, dialogResultSchema, tx),
      );
      await commit();
      const addMessage = await dialog.key("addMessage").pull() as Cell<
        BuiltInLLMMessage
      >;
      addMessage.send({ role: "user", content: "Suggest something." });
      await waitForLlmMessages(runtime, dialog, 4);
      await runtime.settled();
      return dialog;
    }

    /** Installs a default pattern whose `recordSuggestion` ignores its events. */
    async function installDefaultPattern() {
      const { pattern, handler } = commonfabric;
      const ignore = handler(
        { type: "object", properties: {} },
        { type: "object", properties: {} },
        () => {},
      );
      const home = pattern(
        () => ({ recordSuggestion: ignore({}) }),
        false,
        {
          type: "object",
          properties: { recordSuggestion: { asCell: ["stream"] } },
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
      await commit();
    }

    it("logs a warning and finishes the turn when the space's default pattern cannot be reached", async () => {
      // The space's `defaultPattern` is a link to a document holding a link
      // back to it, so sending to its `recordSuggestion` throws on the cycle.
      const spaceCell = runtime.getCell(space, space, spaceCellSchema, tx);
      const loop = runtime.getCell(
        space,
        "default pattern loop",
        undefined,
        tx,
      );
      loop.setRaw(spaceCell.key("defaultPattern").getAsLink());
      spaceCell.key("defaultPattern").setRaw(loop.getAsLink() as never);
      await commit();

      using logs = captureLogs("llm-dialog");
      const dialog = await presentSuggestion("unrecorded suggestion");

      expect(
        logs.textsOf("llm").filter((text) =>
          text.startsWith("Failed to record suggestion history entry")
        ),
      ).toEqual([
        expect.stringMatching(
          /^Failed to record suggestion history entry Link cycle detected/,
        ),
      ]);
      expect(dialog.key("pending").get()).toBe(false);
      expect(
        (dialog.key("messages").get() as BuiltInLLMMessage[]).map((message) =>
          message.role
        ),
      ).toEqual(["user", "assistant", "tool", "assistant"]);
    });

    it("logs no warning when the space's default pattern records it", async () => {
      await installDefaultPattern();
      using logs = captureLogs("llm-dialog");
      await presentSuggestion("recorded suggestion");

      expect(
        logs.textsOf("llm").filter((text) =>
          text.startsWith("Failed to record suggestion history entry")
        ),
      ).toEqual([]);
    });
  });
});
