import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { CellBridge } from "../cell-bridge.ts";
import { FsTree } from "../tree.ts";

describe("CellBridge registry callables", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storages: EmulatedStorageManager[];
  let runtimes: Runtime[];
  let bridge: CellBridge;
  let tree: FsTree;
  let mounted: PiecesController;
  let space: string;
  let fixtureId: string;

  beforeEach(async () => {
    server = newLoopbackServer();
    storages = [];
    runtimes = [];
    const signer = await Identity.generate();
    const openRuntime = () => {
      const storageManager = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      storages.push(storageManager);
      const runtime = new Runtime({
        apiUrl: new URL("https://example.invalid"),
        storageManager,
      });
      runtimes.push(runtime);
      return runtime;
    };
    const writer = openRuntime();
    const spaceDid = await writer.createSpace();
    space = spaceDid;
    const session = createSession({ identity: signer, spaceDid });
    const pieces = new PiecesController(session, writer);
    const rootPattern = await writer.patternManager.compilePattern({
      main: "/registry.tsx",
      files: [{
        name: "/registry.tsx",
        contents: `
import { handler, pattern, Writable } from "commonfabric";
const addPiece = handler<{ piece: unknown }, { registry: Writable<unknown[]> }>(
  ({ piece }, { registry }) => { registry.push(piece); },
);
export default pattern(() => {
  const registry = new Writable<unknown[]>([]);
  return { pieceRegistry: registry, addPiece: addPiece({ registry }) };
});
`,
      }],
    }, { space: spaceDid });
    const root = await pieces.runPersistent(rootPattern, {}, "registry");
    await pieces.linkDefaultPattern(root);
    const fixture = await writer.patternManager.compilePattern({
      main: "/fixture.tsx",
      files: [{
        name: "/fixture.tsx",
        contents: `
import { handler, NAME, pattern, Writable } from "commonfabric";
const increment = handler<Record<string, never>, { count: Writable<number> }>(
  (_, { count }) => { count.set(count.get() + 1); },
);
export default pattern(() => {
  const count = new Writable(0);
  return { [NAME]: "Fixture", count, increment: increment({ count }) };
});
`,
      }],
    }, { space: spaceDid });
    const piece = await pieces.runPersistent(fixture, {}, "fixture");
    fixtureId = piece.getAsNormalizedFullLink().id;
    await pieces.add([piece]);
    await writer.idle();
    await pieces.synced();

    mounted = new PiecesController(session, openRuntime());
    tree = new FsTree();
    bridge = new CellBridge(tree, "/tmp/cf-exec", {
      loadPieces: () => Promise.resolve(mounted),
    });
    bridge.init({ apiUrl: "https://example.invalid", identity: "test" });
  });

  afterEach(async () => {
    for (const runtime of runtimes) {
      await runtime.dispose({ closeStorage: false });
    }
    for (const storage of storages) await storage.close();
    await server.close();
  });

  /** Returns the handler projected from a fresh client's registry listing. */
  async function handlerInode(): Promise<bigint> {
    const state = await bridge.connectSpace(space);
    expect(await bridge.prepareLookup(state.piecesIno, "Fixture")).toBe(true);
    const pieceIno = tree.lookup(state.piecesIno, "Fixture");
    expect(pieceIno).toBeDefined();
    await bridge.prepareLookup(pieceIno!, "result");
    const resultIno = tree.lookup(pieceIno!, "result");
    expect(resultIno).toBeDefined();
    await bridge.prepareLookup(resultIno!, "increment.handler");
    const handlerIno = tree.lookup(resultIno!, "increment.handler");
    expect(handlerIno).toBeDefined();
    return handlerIno!;
  }

  it("projects a declared handler after loading a registry entry's document", async () => {
    const ino = await handlerInode();
    expect(tree.getNode(ino)?.kind).toBe("callable");
    const [listed] = await mounted.getRegisteredPieces();
    expect((await listed.getPatternRef())?.identity).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  });

  it("dispatches a mounted handler independently of the registry's read transaction", async () => {
    const [listed] = await mounted.getRegisteredPieces();
    await listed.getCell().sync();
    await bridge.sendToHandlerTarget({
      piece: listed,
      cellProp: "result",
      cellKey: "increment",
    }, {});
    const current = await mounted.get(fixtureId, true);
    expect(await current.result.get(["count"])).toBe(1);
  });
});
