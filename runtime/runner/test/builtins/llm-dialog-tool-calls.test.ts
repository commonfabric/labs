/**
 * The tool calls a model's turn makes, run through `executeToolCalls()` the way
 * a dialog runs them: the built-in `read`, `invoke` and `updateArgument` tools
 * against real cells and running patterns, external tools that run a handler
 * or a pattern, and what each reports when its write is refused or the turn is
 * cancelled under it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { BuiltInLLMToolCallPart, JSONSchema } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";

import type { Pattern } from "../../src/builder/types.ts";
import {
  llmDialogTestHelpers,
  llmToolExecutionHelpers,
} from "../../src/builtins/llm-dialog.ts";
import type { Cell } from "../../src/cell.ts";
import { createLLMFriendlyLink, getMetaLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import {
  createTrustedBuilder,
  trustExecutable,
} from "../support/trusted-builder.ts";

const { buildToolCatalog, executeToolCalls } = llmToolExecutionHelpers;
const { editWithRetryUnlessAborted } = llmDialogTestHelpers;

const signer = await Identity.fromPassphrase("llm dialog tool calls");
const space = signer.did();

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

function call(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId = `call-${toolName}`,
): BuiltInLLMToolCallPart {
  return { type: "tool-call", toolCallId, toolName, input };
}

describe("llm-dialog", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let builder: ReturnType<typeof createTrustedBuilder>["commonfabric"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    builder = createTrustedBuilder(runtime).commonfabric;
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Commits the open transaction and opens the next. */
  async function commit() {
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await runtime.idle();
    tx = runtime.edit();
  }

  /** The handle a model names `cell` by. */
  function handleOf(cell: Cell<unknown>): string {
    return createLLMFriendlyLink(cell.getAsNormalizedFullLink(), space);
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

  /** Runs `doubler` on `{ value }` and returns its result cell. */
  async function runDoubler(cause: string, value: number) {
    const result = await runtime.runSynced(
      runtime.getCell(space, cause),
      trustExecutable(runtime, doubler),
      { value },
    );
    await result.pull();
    await runtime.idle();
    return result;
  }

  describe("the `read` tool", () => {
    it("returns the value and schema of the cell it names", async () => {
      const schema = {
        type: "object",
        properties: { title: { type: "string" } },
      } as const satisfies JSONSchema;
      const cell = runtime.getCell(space, "read target", schema, tx);
      cell.set({ title: "Quarterly report" });
      await commit();

      const [read] = await executeToolCalls(
        runtime,
        space,
        await builtinCatalog(),
        [call("read", { path: handleOf(cell) })],
      );

      // A handle names a document and carries no schema, so the schema
      // returned is the one read off the value.
      expect(read.error).toBeUndefined();
      expect(read.result).toEqual({
        type: "json",
        value: { title: "Quarterly report" },
        schema: { type: "object", properties: { title: true } },
      });
    });

    it("reads the result a cell holding no value of its own links back to", async () => {
      // A pattern's argument cell links back to the result cell it feeds. Run
      // with no argument, it holds nothing, so reading it reads that result.
      const noArgument = builder.pattern(
        () => ({ greeting: "hello" }),
        false,
        {
          type: "object",
          properties: { greeting: { type: "string" } },
        },
      );
      const result = runtime.run(
        tx,
        noArgument,
        undefined,
        runtime.getCell(space, "no-argument piece", undefined, tx),
      );
      await commit();
      await result.pull();
      const argumentLink = getMetaLink(result, "argument");
      expect(argumentLink).toBeDefined();
      const argument = runtime.getCellFromLink(argumentLink!);
      expect(argument.getRaw()).toBeUndefined();

      const [read] = await executeToolCalls(
        runtime,
        space,
        await builtinCatalog(),
        [call("read", { path: handleOf(argument) })],
      );

      expect(read.error).toBeUndefined();
      expect(read.result?.value).toEqual({ greeting: "hello" });
    });
  });

  describe("the `updateArgument` tool", () => {
    it("updates a running pattern's argument, which the pattern re-runs on", async () => {
      const result = await runDoubler("update target", 21);
      expect(result.key("doubled").get()).toBe(42);

      const [updated] = await executeToolCalls(
        runtime,
        space,
        await builtinCatalog(),
        [call("updateArgument", {
          path: handleOf(result),
          updates: { value: 5 },
        })],
      );
      await runtime.idle();

      expect(updated.result?.value).toEqual({
        success: true,
        message: "Arguments updated. Pattern will re-execute automatically.",
      });
      expect(await result.key("doubled").pull()).toBe(10);
    });

    it("replaces a running pattern's argument with the cell a link in the updates names", async () => {
      const result = await runDoubler("update target by link", 21);
      const replacement = runtime.getCell(space, "replacement argument", {
        type: "object",
        properties: { value: { type: "number" } },
      }, tx);
      replacement.set({ value: 7 });
      await commit();

      const [updated] = await executeToolCalls(
        runtime,
        space,
        await builtinCatalog(),
        [call("updateArgument", {
          path: handleOf(result),
          updates: { "@link": handleOf(replacement) },
        })],
      );
      await runtime.idle();

      expect(updated.result?.value).toMatchObject({ success: true });
      expect(await result.key("doubled").pull()).toBe(14);
    });

    it("returns an error for a cell that is not a pattern instance", async () => {
      const plain = runtime.getCell(space, "not a pattern", undefined, tx);
      plain.set({ value: 1 });
      await commit();

      const [updated] = await executeToolCalls(
        runtime,
        space,
        await builtinCatalog(),
        [call("updateArgument", {
          path: handleOf(plain),
          updates: { value: 5 },
        })],
      );

      expect(updated.error).toContain(
        "Target is not a pattern instance - no argument cell found.",
      );
      expect(plain.get()).toEqual({ value: 1 });
    });
  });

  describe("a refused commit", () => {
    /** How many warnings the dialog's logger has logged under `key`. */
    function warningsUnder(key: string): number {
      return getLogger("llm-dialog").countsByKey[key]?.warn ?? 0;
    }

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

    it("reports a pin that did not commit, and pins nothing", async () => {
      const pinned = await pinnedCells([]);

      const warned = warningsUnder("pin-commit-failed");
      const [pin] = await executeToolCalls(
        refusingRuntime(),
        space,
        await builtinCatalog(),
        [call("pin", { path: "/of:bafypinned", name: "Pinned" })],
        pinned,
      );

      expect(pin.result?.value).toEqual({
        success: false,
        message: "Pin failed to commit: the space refused the write",
      });
      expect(pinned.get()).toEqual([]);
      expect(warningsUnder("pin-commit-failed")).toBe(warned + 1);
    });

    it("reports an unpin that did not commit, and keeps the pin", async () => {
      const pinned = await pinnedCells([
        { path: "/of:bafypinned", name: "Pinned" },
      ]);

      const warned = warningsUnder("unpin-commit-failed");
      const [unpin] = await executeToolCalls(
        refusingRuntime(),
        space,
        await builtinCatalog(),
        [call("unpin", { path: "/of:bafypinned" })],
        pinned,
      );

      expect(unpin.result?.value).toEqual({
        success: false,
        message: "Unpin failed to commit: the space refused the write",
      });
      expect(pinned.get()).toEqual([{
        path: "/of:bafypinned",
        name: "Pinned",
      }]);
      expect(warningsUnder("unpin-commit-failed")).toBe(warned + 1);
    });

    it("reports an argument update that did not commit, and leaves the pattern as it was", async () => {
      const result = await runDoubler("refused update target", 21);

      const warned = warningsUnder("update-argument-commit-failed");
      const [updated] = await executeToolCalls(
        refusingRuntime(),
        space,
        await builtinCatalog(),
        [call("updateArgument", {
          path: handleOf(result),
          updates: { value: 5 },
        })],
      );
      await runtime.idle();

      expect(updated.result?.value).toEqual({
        success: false,
        message:
          "Argument update failed to commit: the space refused the write",
      });
      expect(await result.key("doubled").pull()).toBe(42);
      expect(warningsUnder("update-argument-commit-failed")).toBe(warned + 1);
    });
  });

  describe("the `invoke` tool on a path", () => {
    it("runs the pattern a tool at that path holds", async () => {
      const doubled = builder.pattern<{ value: number }, { doubled: number }>(
        ({ value }) => ({ doubled: builder.lift((v: number) => v * 2)(value) }),
        {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        {
          type: "object",
          properties: { doubled: { type: "number" } },
        },
      );
      const holder = builder.pattern(
        () => ({ tool: builder.patternTool(doubled) }),
        false,
        { type: "object", properties: { tool: true } },
      );
      const result = runtime.run(
        tx,
        holder,
        undefined,
        runtime.getCell(space, "pattern tool holder", undefined, tx),
      );
      await commit();
      await result.pull();

      const [invoked] = await executeToolCalls(
        runtime,
        space,
        await builtinCatalog(),
        [call("invoke", {
          path: handleOf(result.key("tool")),
          args: { value: 4 },
        })],
      );

      expect(invoked.error).toBeUndefined();
      const ran = runtime.getCell<{ doubled: number }>(space, "call-invoke");
      expect(invoked.result?.value).toMatchObject({
        "@resultLocation": handleOf(ran),
      });
      expect(await ran.key("doubled").pull()).toBe(8);
    });

    it("returns an error for a tool whose stored pattern cannot be loaded", async () => {
      const holder = runtime.getCell(
        space,
        "unloadable pattern",
        undefined,
        tx,
      );
      holder.set({
        pattern: {
          $patternRef: { identity: "keyless:not-in-session", symbol: "x" },
        },
      });
      await commit();

      const [invoked] = await executeToolCalls(
        runtime,
        space,
        await builtinCatalog(),
        [call("invoke", { path: handleOf(holder), args: {} })],
      );

      expect(invoked.error).toBe("Tool has neither pattern nor handler");
    });
  });

  describe("a cancelled turn", () => {
    it("reports every tool call as cancelled once the turn is, and runs none of them", async () => {
      const pinned = runtime.getCell<{ path: string; name: string }[]>(
        space,
        "pinned cells of a cancelled turn",
        undefined,
        tx,
      );
      pinned.set([]);
      await commit();
      const controller = new AbortController();
      controller.abort("turn cancelled");

      const results = await executeToolCalls(
        runtime,
        space,
        await builtinCatalog(),
        [
          call("pin", { path: "/of:bafyfirst", name: "First" }, "first"),
          call("pin", { path: "/of:bafysecond", name: "Second" }, "second"),
        ],
        pinned,
        undefined,
        undefined,
        controller.signal,
      );

      expect(results).toEqual([
        { id: "first", toolName: "pin", error: "Tool call cancelled" },
        { id: "second", toolName: "pin", error: "Tool call cancelled" },
      ]);
      expect(pinned.get()).toEqual([]);
    });

    /**
     * A catalog holding one external tool, named `tool`, which `makeTool`
     * builds inside the pattern that holds it.
     */
    async function catalogWith(
      cause: string,
      makeTool: () => Record<string, unknown>,
    ) {
      const holder = builder.pattern(
        () => ({ tools: { tool: makeTool() } }),
        false,
        { type: "object", properties: { tools: true } },
      );
      const result = runtime.run(
        tx,
        holder,
        undefined,
        runtime.getCell(space, cause, undefined, tx),
      );
      await commit();
      await result.pull();
      return buildToolCatalog(
        result.key("tools") as Cell<Record<string, never>>,
        false,
      );
    }

    it("returns a cancellation for a handler tool whose turn is cancelled while it runs", async () => {
      const controller = new AbortController();
      let ran = false;
      const cancelling = builder.handler(
        { type: "object", properties: {} },
        { type: "object", properties: {} },
        () => {
          ran = true;
          controller.abort("turn cancelled");
        },
      );
      const catalog = await catalogWith("cancelling handler tool", () => ({
        description: "Cancels the turn it runs in.",
        handler: cancelling({}),
      }));

      const [invoked] = await executeToolCalls(
        runtime,
        space,
        catalog,
        [call("tool", {})],
        undefined,
        undefined,
        undefined,
        controller.signal,
      );

      await runtime.idle();
      expect(ran).toBe(true);
      expect(invoked.error).toBe("Tool call cancelled");
    });

    it("returns a cancellation for a pattern tool whose turn is cancelled while it runs, and stops the pattern", async () => {
      const controller = new AbortController();
      let runs = 0;
      // The pattern's result is what the computation returns, so the tool's
      // wait for that result is what runs it.
      const cancelling = builder.pattern<{ value: number }, { seen: number }>(
        ({ value }) =>
          builder.lift((v: number) => {
            runs++;
            controller.abort("turn cancelled");
            return { seen: v };
          })(value),
        {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        { type: "object", properties: { seen: { type: "number" } } },
      );
      const catalog = await catalogWith("cancelling pattern tool", () => ({
        description: "Cancels the turn it runs in.",
        ...builder.patternTool(cancelling),
      }));

      const [invoked] = await executeToolCalls(
        runtime,
        space,
        catalog,
        [call("tool", { value: 1 }, "cancelled-pattern")],
        undefined,
        undefined,
        undefined,
        controller.signal,
      );
      expect(invoked.error).toBe("Tool call cancelled");
      expect(runs).toBe(1);

      // The run behind the tool call was stopped, so a change to what it read
      // does not run it again.
      const resultCell = runtime.getCell<{ value: number }>(
        space,
        "cancelled-pattern",
      );
      const argumentLink = getMetaLink(resultCell, "argument");
      expect(argumentLink).toBeDefined();
      const argument = runtime.getCellFromLink<{ value: number }>(
        argumentLink!,
        undefined,
        tx,
      );
      argument.set({ value: 2 });
      await commit();
      await resultCell.pull();
      expect(runs).toBe(1);
    });
  });

  describe("editWithRetryUnlessAborted()", () => {
    it("commits the edit when the turn is running", async () => {
      const cell = runtime.getCell<number>(space, "edited while running");

      const committed = await editWithRetryUnlessAborted(
        runtime,
        new AbortController().signal,
        (editTx) => cell.withTx(editTx).set(7),
      );

      expect(committed.error).toBeUndefined();
      expect(await cell.pull()).toBe(7);
    });

    it("returns an error and writes nothing when the turn is cancelled", async () => {
      const cell = runtime.getCell<number>(space, "edited after cancel");
      const controller = new AbortController();
      controller.abort("turn cancelled");
      let ran = false;

      const committed = await editWithRetryUnlessAborted(
        runtime,
        controller.signal,
        (editTx) => {
          ran = true;
          cell.withTx(editTx).set(7);
        },
      );

      expect(committed.error?.message).toContain("Tool call cancelled");
      expect(ran).toBe(false);
      expect(await cell.pull()).toBeUndefined();
    });
  });
});
