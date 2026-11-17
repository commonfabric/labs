/**
 * The `cf piece` paths that write straight to the process's console: the
 * status lines `piece render --watch` prints around each render, and the
 * warning `piece map` prints for a piece it could not inspect. Each case
 * replaces `console.log` and `console.error` to read them, so the file runs on
 * its own.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { defer } from "@commonfabric/async/defer";
import { createSession, Identity } from "@commonfabric/identity";
import type { DID } from "@commonfabric/identity/did";
import { PieceController, PiecesController } from "@commonfabric/piece/ops";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import {
  mapSpaceFromCommand,
  type PieceCommandDependencies,
  renderPieceFromCommand,
} from "../commands/piece.ts";

const signer = await Identity.fromPassphrase("piece-command-actions");

const CARD: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `
import { Default, NAME, pattern, UI } from "commonfabric";

interface Input {
  title: Default<string, "Untitled">;
}

export default pattern<Input>(({ title }) => ({
  [NAME]: title,
  [UI]: <p>{title}</p>,
  title,
}));
`,
  }],
};

describe("piece-command-actions", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let pieces: PiecesController;
  let space: DID;
  let stdout: string[];
  let stderr: string[];
  const originalLog = console.log;
  const originalError = console.error;

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
    stdout = [];
    stderr = [];
    console.log = (...args: unknown[]) => stdout.push(args.join(" "));
    console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    await runtime?.dispose();
    await storage?.close();
    await server?.close();
  });

  function target(piece?: string) {
    return {
      apiUrl: "http://localhost:9999",
      identity: "/nonexistent/keyfile",
      space,
      explicitSpace: true,
      ...(piece === undefined ? {} : { cell: piece }),
    };
  }

  async function create(title: string): Promise<PieceController> {
    const pattern = await runtime.patternManager.compilePattern(CARD, {
      space,
    });
    const cell = await pieces.runPersistent(pattern, { title }, undefined, {
      start: true,
    });
    await pieces.synced();
    return new PieceController(pieces, cell);
  }

  describe("renderPieceFromCommand() under `watch`", () => {
    /**
     * Runs a watch over `card`, retitles it once the first render arrives,
     * and stops the watch once the second does. Returns what was rendered.
     */
    async function watchThroughOneChange(
      card: PieceController,
      json: boolean,
    ): Promise<{ value: unknown; json: boolean }[]> {
      const rendered: { value: unknown; json: boolean }[] = [];
      const first = defer<void>();
      const second = defer<void>();
      const interrupted = defer<void>();
      const deps: PieceCommandDependencies = {
        loadPieces: () => Promise.resolve(pieces),
        render: (value: unknown, options?: { json?: boolean }) => {
          rendered.push({ value, json: options?.json === true });
          (rendered.length === 1 ? first : second).resolve();
        },
        interrupted: () => interrupted.promise,
      };

      const watching = renderPieceFromCommand(
        { ...target(card.id), watch: true, json },
        deps,
      );
      await first.promise;
      await card.input.set("Second", ["title"]);
      await second.promise;
      interrupted.resolve();
      await watching;
      return rendered;
    }

    it("renders each settled view and frames the run with status lines on stdout", async () => {
      const card = await create("First");

      const rendered = await watchThroughOneChange(card, false);

      expect(rendered).toEqual([
        { value: "<p>First</p>", json: false },
        { value: "<p>Second</p>", json: false },
      ]);
      expect(stdout).toEqual([
        "Watching for changes... Press Ctrl+C to exit.\n",
        "Rendering piece: First",
        "\n--- Render #1 ---",
        "\n--- Render #2 ---",
        "\nStopping watch mode...",
      ]);
    });

    it("renders numbered JSON objects and moves the status lines to stderr under `json`", async () => {
      const card = await create("First");

      const rendered = await watchThroughOneChange(card, true);

      expect(rendered).toEqual([
        { value: { html: "<p>First</p>", renderCount: 1 }, json: true },
        { value: { html: "<p>Second</p>", renderCount: 2 }, json: true },
      ]);
      expect(stdout).toEqual([]);
      expect(stderr).toContain("\nStopping watch mode...");
      expect(stderr).toContain("\n--- Render #2 ---");
    });
  });

  describe("mapSpaceFromCommand()", () => {
    it("warns about a piece it cannot inspect and still lists it, with no connections", async () => {
      const readable = await create("Readable");
      const unreadable = await create("Unreadable");
      pieces.getRegisteredPieces = () =>
        Promise.resolve([readable, unreadable]);
      const rendered: unknown[] = [];

      await mapSpaceFromCommand(target(), {
        loadPieces: () => Promise.resolve(pieces),
        resolvePieceAddress: (_pieces, token) =>
          token === unreadable.id
            ? Promise.reject(new Error("not readable"))
            : Promise.resolve(token),
        render: (value: unknown) => rendered.push(value),
      });

      expect(stderr).toEqual([
        `Warning: Could not inspect piece ${unreadable.id}: not readable`,
      ]);
      const [map] = rendered;
      expect(map).toContain("📦 Readable");
      expect(map).toContain("📦 Unreadable");
      expect(String(map).match(/\(no connections\)/g)).toHaveLength(2);
    });
  });
});
