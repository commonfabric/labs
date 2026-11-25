import { expect } from "@std/expect";

import { createSession, Identity } from "@commonfabric/identity";
import type { DID } from "@commonfabric/identity/did";
import { PieceController, PiecesController } from "@commonfabric/piece/ops";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { executePieceCallable } from "../lib/piece.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";

const signer = await Identity.fromPassphrase("callable tool");

/** A piece exposing one tool, which echoes its query into its result. */
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

describe("callable", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let pieces: PiecesController;
  let space: DID;
  let stderr: string[];
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
    resetWriteReceipts();
    stderr = [];
    console.error = (...args: unknown[]) => {
      stderr.push(args.map(String).join(" "));
    };
  });

  afterEach(async () => {
    console.error = originalError;
    resetWriteReceipts();
    await runtime?.dispose();
    await storage?.close();
    await server?.close();
  });

  describe("executeResolvedCallable on a tool", () => {
    it("receipts the space its result was written to", async () => {
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
      // Starting the piece is a write of its own; only the tool's is in
      // question here.
      resetWriteReceipts();
      stderr = [];

      const executed = await executePieceCallable(
        {
          apiUrl: "http://localhost:9999",
          space,
          identity: "/nonexistent/keyfile",
          piece: new PieceController(pieces, cell).id,
        },
        "lookup",
        ["--query", "ping"],
        { loadPieces: () => Promise.resolve(pieces) },
      );

      expect(JSON.parse(executed.outputText ?? "null")).toEqual({
        echoed: "ping",
      });
      expect(stderr).toEqual([`wrote to space ${space}`]);
    });
  });
});
