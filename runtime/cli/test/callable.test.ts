import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { createSession, Identity } from "@commonfabric/identity";
import type { DID } from "@commonfabric/identity/did";
import { PieceController, PiecesController } from "@commonfabric/piece/ops";
import { Runtime, type RuntimeProgram, sendEvent } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { callableCommandSpec, CyclicResultError } from "../lib/callable.ts";
import { callPieceHandler } from "../lib/piece.ts";

const signer = await Identity.fromPassphrase("callable");

/**
 * An item that files children under itself. Its result lists `children`
 * before `parent`, so a walk over a returned container passes a child's
 * acyclic `children` before it reaches the `parent` that closes the circle.
 * `fileLoose` hands the container back behind `unknown`, which bounds
 * nothing; `refuse` throws.
 */
const ITEM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { action, type Default, pattern, type PatternFactory, SELF, type Stream, Writable } from "commonfabric";',
      "interface FileEvent { title: string; }",
      "interface RefuseEvent { reason: string; }",
      "export interface ItemOutput {",
      "  title: string;",
      "  children: ItemOutput[];",
      "  parent: ItemOutput | null;",
      "  fileLoose: Stream<FileEvent, { container: unknown }>;",
      "  refuse: Stream<RefuseEvent, void>;",
      "}",
      "interface ItemInput { title: string; parent?: ItemOutput | null | Default<null>; }",
      "export const Item: PatternFactory<ItemInput, ItemOutput> = pattern<ItemInput, ItemOutput>(",
      "  ({ title, parent, [SELF]: self }) => {",
      "    const children = new Writable<ItemOutput[]>([]);",
      "    const fileLoose = action<FileEvent, { container: unknown }>((event) => {",
      "      children.push(Item({ title: event.title, parent: self }));",
      "      return { container: self as unknown };",
      "    });",
      "    const refuse = action<RefuseEvent, void>((event) => {",
      "      throw new Error(event.reason);",
      "    });",
      "    return { title, children, parent, fileLoose, refuse };",
      "  },",
      ");",
      "export default Item;",
    ].join("\n"),
  }],
};

/** A piece exposing one tool and no handler. */
const TOOLED: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `
import { pattern, patternTool } from "commonfabric";

const echo = pattern<{ query: string }, { echoed: string }>(
  ({ query }) => ({ echoed: query }),
);

export default pattern<{ label: string }>(({ label }) => ({
  label,
  lookup: patternTool(echo),
}));
`,
  }],
};

/**
 * Sends the way a client under server execution sees a send: the event append
 * is reported delivered, and the handling's own transaction, failed or not,
 * arrives afterwards on the commit callback.
 */
const sendAsServed: typeof sendEvent = (stream, event, onCommit, options) => {
  const { onAppended, ...rest } = options ?? {};
  sendEvent(stream, event, (tx) => {
    onAppended?.({ delivered: true }, tx);
    onCommit?.(tx);
  }, rest);
};

describe("callable", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let pieces: PiecesController;
  let space: DID;

  beforeEach(async () => {
    server = newLoopbackServer();
    storage = EmulatedStorageManager.connectTo(server, { as: signer });
    space = (await Identity.generate()).did();
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: storage,
    });
    pieces = new PiecesController(
      createSession({ identity: signer, spaceDid: space }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storage?.close();
    await server?.close();
  });

  /** Run the item program as a root item and return its cell and the call
   * config. */
  async function startItem() {
    const pattern = await runtime.patternManager.compilePattern(ITEM, {
      space,
    });
    const cell = await pieces.runPersistent(
      pattern,
      { title: "Root" },
      undefined,
      { start: true },
    );
    await pieces.synced();
    const config = {
      apiUrl: "http://localhost:9999",
      space,
      identity: "/nonexistent/keyfile",
      piece: new PieceController(pieces, cell).id,
    };
    return { cell, config };
  }

  describe("callPieceHandler()", () => {
    it("throws the handling's failure when it fails after its append was delivered", async () => {
      const { config } = await startItem();

      await expect(
        callPieceHandler(config, "refuse", { reason: "not today" }, {
          loadPieces: () => Promise.resolve(pieces),
          invocation: { id: "inv-refuse", session: "ses:callable" },
          sendEvent: sendAsServed,
        }),
      ).rejects.toThrow(/^Handler "refuse" failed: .*not today/);
    });

    it("returns normally when the handling after a delivered append succeeds, having run the handler", async () => {
      const { cell, config } = await startItem();

      await expect(
        callPieceHandler(config, "fileLoose", { title: "Fine" }, {
          loadPieces: () => Promise.resolve(pieces),
          sendEvent: sendAsServed,
        }),
      ).resolves.toBeUndefined();
      const children = await cell.key("children").pull();
      expect(children).toHaveLength(1);
      expect(children[0].title).toBe("Fine");
    });

    it("names the closing position past an acyclic subtree in a cyclic-result refusal", async () => {
      const { config } = await startItem();

      const error = await callPieceHandler(
        config,
        "fileLoose",
        { title: "Child" },
        {
          loadPieces: () => Promise.resolve(pieces),
          invocation: { id: "inv-loose", session: "ses:callable" },
        },
      ).then(() => undefined, (thrown: unknown) => thrown);

      // The child's `children` is walked whole and found acyclic before its
      // `parent`, which is the container itself.
      expect(error).toBeInstanceOf(CyclicResultError);
      expect(error instanceof Error ? error.message : "").toContain(
        'closes a circle at "/container/children/0/parent"',
      );
    });

    it("throws for a callable that is a tool rather than a handler", async () => {
      const pattern = await runtime.patternManager.compilePattern(TOOLED, {
        space,
      });
      const cell = await pieces.runPersistent(
        pattern,
        { label: "x" },
        undefined,
        { start: true },
      );
      await pieces.synced();

      await expect(
        callPieceHandler(
          {
            apiUrl: "http://localhost:9999",
            space,
            identity: "/nonexistent/keyfile",
            piece: new PieceController(pieces, cell).id,
          },
          "lookup",
          { query: "q" },
          { loadPieces: () => Promise.resolve(pieces) },
        ),
      ).rejects.toThrow('Callable "lookup" is not a handler');
    });
  });

  describe("callableCommandSpec", () => {
    async function toolCell(value: unknown) {
      const tx = runtime.edit();
      const cell = runtime.getCell<unknown>(
        space,
        crypto.randomUUID(),
        undefined,
        tx,
      );
      cell.set(value);
      await tx.commit().settled;
      return cell;
    }

    it("offers an open input and no output summary for a pattern slot that is not a record", async () => {
      const cell = await toolCell({
        pattern: "not-a-pattern",
        extraParams: {},
      });

      expect(callableCommandSpec(cell, "tool")).toEqual({
        callableKind: "tool",
        defaultVerb: "run",
        inputSchema: true,
        outputSchemaSummary: undefined,
      });
    });

    it("offers the stored pattern's schemas for a pattern slot that is a record", async () => {
      const argumentSchema = {
        type: "object",
        properties: { query: { type: "string" } },
      };
      const resultSchema = { type: "string" };
      const cell = await toolCell({
        pattern: { argumentSchema, resultSchema },
        extraParams: {},
      });

      expect(callableCommandSpec(cell, "tool")).toEqual({
        callableKind: "tool",
        defaultVerb: "run",
        inputSchema: argumentSchema,
        outputSchemaSummary: resultSchema,
      });
    });
  });
});
