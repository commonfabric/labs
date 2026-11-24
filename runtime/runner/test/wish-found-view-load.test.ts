/**
 * Which of a found piece's documents a wish brings to the replica of the
 * runtime that makes it. Two storage managers, each with a replica of its
 * own, connect to one memory server. The first writes the piece, and the
 * second runs or resumes the wisher on a replica holding nothing, so what
 * that replica holds afterwards is what the wisher's reads asked the server
 * for.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { UI } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { vnodeSchema } from "../src/schemas.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("wish found view load");
const homeSpace = signer.did();
const roomSpace = (await Identity.fromPassphrase("wish found view load room"))
  .did();

/**
 * A program whose default export is a pattern with `body` as its body, after
 * a typed wish for the default pattern of its `target`.
 */
const wisherProgram = (output: string, body: string[]): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import {",
      "  type Cell, pattern, UI, type VNode, wish,",
      "} from 'commonfabric';",
      "type Room = { title?: string };",
      "type DID = `did:${string}`;",
      `export default pattern<{ target: DID }, ${output}>(({ target }) => {`,
      "  const root = wish<Cell<Room>>({",
      "    query: '#default',",
      "    scope: [target],",
      "  });",
      ...body,
      "});",
    ].join("\n"),
  }],
});

// A wisher that hands on the piece it found and uses nothing else of the
// wish.
const RESULT_ONLY_PROGRAM = wisherProgram("{ room: unknown }", [
  "  return { room: root.result };",
]);

// A wisher whose own view shows the view of the wish.
const SHOWN_VIEW_PROGRAM = wisherProgram("{ [UI]: VNode }", [
  "  return { [UI]: <div>{root[UI]}</div> };",
]);

/** How many documents a found piece's view is spread over. */
const PARTS = 5;

describe("wish-found-view-load", () => {
  let server: MemoryV2Server.Server;
  let managerA: EmulatedStorageManager;
  let managerB: EmulatedStorageManager;
  let rt1: Runtime;
  let rt2: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    managerA = EmulatedStorageManager.connectTo(server, { as: signer });
    managerB = EmulatedStorageManager.connectTo(server, { as: signer });
    rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
    });
    rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerB,
    });
  });

  afterEach(async () => {
    await rt1.dispose();
    await rt2.dispose();
    await managerA.close();
    await managerB.close();
    await server.close();
  });

  /** Whether the second runtime's replica holds the document `cell` names. */
  function localOnB(cell: Cell<unknown>): boolean {
    const { space, id, scope } = cell.getAsNormalizedFullLink();
    return managerB.open(space).replica.get({
      id,
      type: "application/json",
      scope,
    }) !== undefined;
  }

  /**
   * Writes, through the first runtime, a piece as the default pattern of
   * `space`: its view is a `div` over `PARTS` children, each a view node in
   * a document of its own.
   */
  async function writePieceWithView(
    space: MemorySpace,
  ): Promise<{ found: Cell<unknown>; parts: Cell<unknown>[] }> {
    const tx = rt1.edit();
    const parts = Array.from({ length: PARTS }, (_, index) => {
      const part = rt1.getCell(space, `part ${index}`, undefined, tx);
      part.set({
        type: "vnode",
        name: "span",
        props: {},
        children: [`part ${index}`],
      });
      return part;
    });
    const found = rt1.getCell(space, "found piece", undefined, tx);
    found.set({
      title: "Room",
      [UI]: { type: "vnode", name: "div", props: {}, children: parts },
    });
    rt1.getCell(space, space, undefined, tx).key("defaultPattern").set(found);
    expect((await tx.commit().settled).error).toBeUndefined();
    await rt1.idle();
    await rt1.storageManager.synced();
    return {
      found: found.withTx(undefined),
      parts: parts.map((part) => part.withTx(undefined)),
    };
  }

  /**
   * Runs `program` on `runtime` in `space`, wishing for the default pattern
   * of `target`, and returns its result cell.
   */
  async function runWisher(
    program: RuntimeProgram,
    space: MemorySpace,
    target: MemorySpace,
    runtime: Runtime = rt2,
  ): Promise<Cell<Record<string | symbol, unknown>>> {
    const tx = runtime.edit();
    const compiled = await runtime.patternManager.compilePattern(program, {
      space,
      tx,
    });
    const resultCell = runtime.getCell<Record<string | symbol, unknown>>(
      space,
      "wisher",
      undefined,
      tx,
    );
    const wisher = runtime.run(tx, compiled, { target }, resultCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    return wisher;
  }

  /** Settles the second runtime, and every load its reads started. */
  async function settleB(): Promise<void> {
    await rt2.idle();
    await rt2.storageManager.synced();
    await rt2.idle();
    await rt2.storageManager.synced();
  }

  describe("a wisher that reads only the result", () => {
    // Each case reads the found piece's title through the wish result, which
    // is what puts the piece's own document on the replica and shows the wish
    // resolved before the replica is examined.

    it("leaves the view documents of a piece found in another space off the replica", async () => {
      const { found, parts } = await writePieceWithView(roomSpace);

      const wisher = await runWisher(
        RESULT_ONLY_PROGRAM,
        homeSpace,
        roomSpace,
      );
      const title = wisher.key("room").key("title");
      await title.pull();
      await settleB();

      expect(title.get()).toBe("Room");
      expect(localOnB(found)).toBe(true);
      expect(parts.map(localOnB)).toEqual(parts.map(() => false));
    });

    it("leaves the view documents of a piece found in the wisher's own space off the replica", async () => {
      const { found, parts } = await writePieceWithView(roomSpace);

      const wisher = await runWisher(
        RESULT_ONLY_PROGRAM,
        roomSpace,
        roomSpace,
      );
      const title = wisher.key("room").key("title");
      await title.pull();
      await settleB();

      expect(title.get()).toBe("Room");
      expect(localOnB(found)).toBe(true);
      expect(parts.map(localOnB)).toEqual(parts.map(() => false));
    });

    it("leaves the view documents of a piece found by a wisher resumed there off the replica", async () => {
      // The first runtime runs the wisher and settles it. The second starts
      // the stored piece, as a page load of an existing piece does.

      const { found, parts } = await writePieceWithView(roomSpace);
      const first = await runWisher(
        RESULT_ONLY_PROGRAM,
        homeSpace,
        roomSpace,
        rt1,
      );
      await first.key("room").key("title").pull();
      await rt1.idle();
      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();
      await rt1.idle();
      await rt1.storageManager.synced();

      const wisher = rt2.getCellFromLink<Record<string | symbol, unknown>>(
        first.getAsNormalizedFullLink(),
      );
      await wisher.sync();
      expect(await rt2.start(wisher)).toBeTruthy();
      const title = wisher.key("room").key("title");
      await title.pull();
      await settleB();

      expect(title.get()).toBe("Room");
      expect(localOnB(found)).toBe(true);
      expect(parts.map(localOnB)).toEqual(parts.map(() => false));
    });
  });

  describe("a wisher whose view shows the view of the wish", () => {
    it("brings the found piece's view documents to the replica when the view is read", async () => {
      const { parts } = await writePieceWithView(roomSpace);

      const wisher = await runWisher(SHOWN_VIEW_PROGRAM, homeSpace, roomSpace);
      const view = wisher.key(UI).asSchema(vnodeSchema);
      await view.pull();
      await settleB();

      // The wisher's `div` holds the found piece's `div`, which holds the
      // parts, each a `span` over its text.
      expect(view.get()).toMatchObject({
        name: "div",
        children: [{
          name: "div",
          children: parts.map((_, index) => ({
            name: "span",
            children: [`part ${index}`],
          })),
        }],
      });
      expect(parts.map(localOnB)).toEqual(parts.map(() => true));
    });
  });
});
