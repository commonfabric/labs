/**
 * `cf piece link sqlite:<path> <target>` through the command action, over a
 * runtime this process holds. The memory server that would attach the file
 * is not running, so each case states what the storage provider's
 * registration does.
 */

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

import {
  linkPiecesFromCommand,
  type PieceCommandDependencies,
} from "../commands/piece.ts";
import { deriveDiskHandleId } from "../lib/sqlite-source.ts";

const signer = await Identity.fromPassphrase("piece-link-sqlite");
const DISK_PATH = "/data/reference.db";

const HOLDER: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `
import { pattern } from "commonfabric";

interface Input {
  refDb?: Record<string, string>;
}

export default pattern<Input, Input>(({ refDb }) => ({ refDb }));
`,
  }],
};

describe("piece-link-sqlite", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let pieces: PiecesController;
  let space: DID;
  let rendered: unknown[];
  let hints: string[];
  let deps: PieceCommandDependencies;

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
    rendered = [];
    hints = [];
    deps = {
      loadPieces: () => Promise.resolve(pieces),
      render: (value: unknown) => rendered.push(value),
      hint: (message) => hints.push(message),
    };
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storage?.close();
    await server?.close();
  });

  const target = {
    apiUrl: "http://localhost:9999",
    identity: "/nonexistent/keyfile",
    explicitSpace: true,
  };

  async function holder(): Promise<PieceController> {
    const pattern = await runtime.patternManager.compilePattern(HOLDER, {
      space,
    });
    const cell = await pieces.runPersistent(pattern, {}, undefined, {
      start: true,
    });
    await pieces.synced();
    return new PieceController(pieces, cell);
  }

  it("registers the file under its handle, links the handle, and renders the link", async () => {
    const piece = await holder();
    const registered: [string, string][] = [];
    runtime.storageManager.open(space).registerSqliteDiskSource = (
      id,
      path,
    ) => {
      registered.push([id, path]);
      return Promise.resolve({ registered: true });
    };

    await linkPiecesFromCommand(
      { ...target, space },
      `sqlite:${DISK_PATH}`,
      `${piece.id}/refDb`,
      deps,
    );

    const handle = deriveDiskHandleId(space, DISK_PATH);
    expect(registered).toEqual([[handle, DISK_PATH]]);
    expect((await piece.input.getCell()).key("refDb").getRaw()).toEqual({
      "/": { "link@1": { id: `of:${handle}`, path: [] } },
    });
    expect(rendered).toEqual([
      `Linked sqlite:${DISK_PATH} to ${piece.id}/refDb (read-only on-disk source)`,
    ]);
    expect(hints.join("\n")).toContain(`cf piece inspect --cell ${piece.id}`);
  });

  it("throws where the storage provider cannot register a file, rendering nothing", async () => {
    const piece = await holder();
    runtime.storageManager.open(space).registerSqliteDiskSource = undefined;

    await expect(
      linkPiecesFromCommand(
        { ...target, space },
        `sqlite:${DISK_PATH}`,
        `${piece.id}/refDb`,
        deps,
      ),
    ).rejects.toThrow(
      "storage provider does not support injected sqlite disk sources",
    );
    expect(rendered).toEqual([]);
  });
});
