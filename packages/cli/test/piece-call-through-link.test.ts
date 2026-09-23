/**
 * Drives `cf piece call` with a target that carries a path, in-process over
 * one loopback storage server: a holder piece whose result links to an inbox
 * piece, the inbox exposing a handler stream. Only the connection is stubbed
 * — each `loadPieces()` answers with a real controller over a runtime of its
 * own, as a second connection from one process is — so link resolution, the
 * switch of space, and the dispatch are the production ones.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  type MemorySpace,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "@commonfabric/piece/ops";

import {
  callFromCommand,
  type PieceCallCLIOptions,
} from "../commands/piece.ts";
import {
  executePieceCallable,
  NAMES_NO_PIECE,
  type SpaceConfig,
} from "../lib/piece.ts";

const INBOX_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { action, pattern, type Stream, Writable } from "commonfabric";',
      "",
      "interface Offer { id: string; }",
      "interface Output {",
      "  offers: Offer[];",
      "  about: { label: string };",
      "  receive: Stream<Offer, { count: number }>;",
      "}",
      "",
      "export default pattern<Record<string, never>, Output>(() => {",
      "  const offers = new Writable<Offer[]>([]);",
      "  const receive = action<Offer, { count: number }>((event) => {",
      "    offers.push({ id: event.id });",
      "    return { count: (offers.get() ?? []).length };",
      "  });",
      "  return { offers, about: { label: 'inbox' }, receive };",
      "});",
    ].join("\n"),
  }],
};

const HOLDER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { pattern } from "commonfabric";',
      "",
      "interface Held {",
      "  inbox: { piece: unknown };",
      "  inside: unknown;",
      "  insideDocument: unknown;",
      "  bare: unknown;",
      "  title: string;",
      "}",
      "",
      "export default pattern<Held, Held>(({ inbox, inside, insideDocument, bare, title }) => {",
      "  return { inbox, inside, insideDocument, bare, title };",
      "});",
    ].join("\n"),
  }],
};

const signer = await Identity.fromPassphrase("cf-piece-call-through-link");
const holderSpace = signer.did();
const inboxSpace = (await Identity.fromPassphrase("cf-piece-call-inbox"))
  .did();

describe("piece-call-through-link", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let manager: EmulatedStorageManager;
  let runtime: Runtime;
  let inbox: Cell<unknown>;
  let holder: Cell<unknown>;
  let sameSpaceHolder: Cell<unknown>;
  let connections: string[];
  let errors: string[];
  let hints: string[];
  let opened: PiecesController[];
  let loadPieces: (config: SpaceConfig) => Promise<PiecesController>;

  /** Runs `program` as a piece in `space`, and returns its result cell. */
  async function runPiece(
    program: RuntimeProgram,
    space: MemorySpace,
    cause: string,
    argument: Record<string, unknown>,
  ): Promise<Cell<unknown>> {
    const tx = runtime.edit();
    const compiled = await runtime.patternManager.compilePattern(program, {
      space,
      tx,
    });
    const resultCell = runtime.getCell<unknown>(space, cause, undefined, tx);
    // deno-lint-ignore no-explicit-any
    const piece = runtime.run(tx, compiled as any, argument, resultCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await piece.pull();
    return piece;
  }

  /** Reads `cell` at `path` from a runtime that has seen none of the setup. */
  async function readFresh(
    cell: Cell<unknown>,
    path: string[],
    read: "value" | "raw" = "value",
  ): Promise<unknown> {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const reader = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const { space, id } = cell.getAsNormalizedFullLink();
      const fresh = reader.getCellFromEntityId<unknown>(space, id, path);
      await fresh.pull();
      return JSON.parse(
        JSON.stringify(read === "raw" ? fresh.getRaw() : fresh.get()) ??
          "null",
      );
    } finally {
      await reader.dispose({ closeStorage: false });
      await storage.close();
    }
  }

  /** The reference form of `cell`, with `path` written after it. */
  function reference(cell: Cell<unknown>, path: string): string {
    const { space, id } = cell.getAsNormalizedFullLink();
    return `//${space}/${id}/${path}`;
  }

  /**
   * Runs `cf piece call <target> receive <payload>`, and resolves to the exit
   * code it ended with, or `undefined` when it ended by returning.
   */
  async function call(
    target: string,
    flags: Partial<PieceCallCLIOptions> = {},
    event: unknown = { id: "offer-1" },
  ): Promise<number | undefined> {
    const payload = JSON.stringify(event);
    let code: number | undefined;
    const viaFlag = flags.cell !== undefined;
    try {
      await callFromCommand(
        {
          apiUrl: "http://127.0.0.1:8000",
          identity: "/unread.key",
          invocation: "inv:through-link",
          invocationSession: "ses:through-link",
          quiet: true,
          ...flags,
        },
        "piece call",
        viaFlag ? "receive" : target,
        viaFlag ? [payload] : ["receive", payload],
        viaFlag
          ? ["--cell", target, "receive", payload]
          : [target, "receive", payload],
        [],
        {
          executePieceCallable: (config, name, args, deps = {}) =>
            executePieceCallable(config, name, args, { ...deps, loadPieces }),
          render: () => {},
          hint: (message) => hints.push(message),
          announce: () => {},
          printError: (message) => errors.push(message),
          exit: (exitCode) => {
            code = exitCode;
            throw new Error(`exit ${exitCode}`);
          },
        },
      );
    } catch (error) {
      if (code === undefined) throw error;
    }
    return code;
  }

  beforeEach(async () => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    manager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    inbox = await runPiece(INBOX_PROGRAM, inboxSpace, "inbox", {});
    const tx = runtime.edit();
    const bare = runtime.getCell<unknown>(inboxSpace, "bare", undefined, tx);
    bare.set({ note: "a document no pattern runs" });
    expect((await tx.commit()).error).toBeUndefined();
    const held = {
      bare,
      inbox: { piece: inbox },
      inside: inbox.key("about").key("label"),
      insideDocument: inbox.key("offers"),
      title: "plain",
    };
    holder = await runPiece(HOLDER_PROGRAM, holderSpace, "holder", held);
    sameSpaceHolder = await runPiece(
      HOLDER_PROGRAM,
      inboxSpace,
      "same-space holder",
      held,
    );
    await runtime.idle();
    await manager.synced();

    connections = [];
    errors = [];
    hints = [];
    opened = [];
    loadPieces = (config) => {
      connections.push(config.space);
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const own = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      const pieces = new PiecesController(
        { as: signer, space: config.space as MemorySpace },
        own,
        { deferSpaceCellSync: true },
      );
      let disposed = false;
      pieces.dispose = async () => {
        if (disposed) return;
        disposed = true;
        await own.dispose({ closeStorage: false });
        await storage.close();
      };
      opened.push(pieces);
      return Promise.resolve(pieces);
    };
  });

  afterEach(async () => {
    // The command leaves its last connection to the process's exit, so the
    // ones a case opened are closed here.
    for (const pieces of opened) await pieces.dispose();
    await runtime.dispose({ closeStorage: false });
    await manager.close();
    await server.close();
  });

  describe("a path that links to a piece in another space", () => {
    it("calls the linked piece's handler over a connection to its space", async () => {
      const code = await call(reference(holder, "inbox/piece"));
      expect(errors).toEqual([]);
      expect(code).toBeUndefined();
      expect(connections).toEqual([holderSpace, inboxSpace]);
      expect(await readFresh(inbox, ["offers"])).toEqual([{ id: "offer-1" }]);
    });

    it("writes nothing into the piece that holds the link", async () => {
      const before = await readFresh(holder, [], "raw");
      await call(reference(holder, "inbox/piece"));
      expect(await readFresh(holder, [], "raw")).toEqual(before);
    });

    it("points a refused payload's hint at the linked piece", async () => {
      const code = await call(reference(holder, "inbox/piece"), {}, { id: 5 });
      expect(code).toBe(1);
      const { space, id } = inbox.getAsNormalizedFullLink();
      expect(hints.join("\n")).toContain(
        `--cell //${space}/${id.replace(/^of:/, "")}@space `,
      );
      expect(await readFresh(inbox, ["offers"])).toEqual([]);
    });

    it("takes the same reference on `--cell`", async () => {
      const code = await call("unused", {
        cell: reference(holder, "inbox/piece"),
      });
      expect(code).toBeUndefined();
      expect(await readFresh(inbox, ["offers"])).toEqual([{ id: "offer-1" }]);
    });
  });

  describe("a path that links to a piece in the same space", () => {
    it("calls the linked piece's handler over the connection it has", async () => {
      const code = await call(reference(sameSpaceHolder, "inbox/piece"));
      expect(errors).toEqual([]);
      expect(code).toBeUndefined();
      expect(connections).toEqual([inboxSpace]);
      expect(await readFresh(inbox, ["offers"])).toEqual([{ id: "offer-1" }]);
    });
  });

  describe("a path that leads to no piece", () => {
    it("refuses a plain value, saying the path names no piece", async () => {
      expect(await call(reference(holder, "title"))).toBe(1);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain(NAMES_NO_PIECE);
      expect(errors[0]).toContain('"title"');
    });

    it("refuses a position that holds nothing, in the same words", async () => {
      expect(await call(reference(holder, "inbox/absent"))).toBe(1);
      expect(errors[0]).toContain(NAMES_NO_PIECE);
    });

    it("refuses a link to a document that is no piece, in the same words", async () => {
      expect(await call(reference(holder, "bare"))).toBe(1);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain(NAMES_NO_PIECE);
      expect(errors[0]).toContain("is not a piece");
    });

    it("refuses a link that names a path inside a piece", async () => {
      expect(await call(reference(holder, "inside"))).toBe(1);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("links to a cell inside a piece");
      expect(errors[0]).not.toContain(NAMES_NO_PIECE);
      expect(await readFresh(inbox, ["offers"])).toEqual([]);
    });

    it("refuses a link that names a document a piece owns", async () => {
      expect(await call(reference(holder, "insideDocument"))).toBe(1);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("links to a cell inside a piece");
      expect(errors[0]).not.toContain(NAMES_NO_PIECE);
    });
  });
});
