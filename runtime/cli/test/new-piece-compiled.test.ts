/**
 * `cf piece new` against a deployment that serves compiled pieces: which
 * path a piece takes, from what the pattern compiler says of its program,
 * and the compiled creation itself, set up and registered over an
 * in-process memory store whose root registration action is real. The
 * serving runtime's verdict on the piece is the seam the compiled creation
 * waits on, and its two outcomes are written into the store directly.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  createSession,
  Identity,
  legacySpaceDid,
} from "@commonfabric/identity";
import { pieceId } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  type Cell,
  entityIdFrom,
  Runtime,
  type RuntimeProgram,
  type URI,
} from "@commonfabric/runner";
import { compiledFailureOf } from "@commonfabric/runner/compiled/setup";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { newPieceFromCommand } from "../commands/piece.ts";
import {
  checkCompiledProgram,
  CompiledPieceRefusedError,
  compiledPieceStarted,
  createCompiledPiece,
  newPieceWithReceipt,
} from "../lib/piece.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";
import { captureStderr } from "./utils.ts";

const CONFIG = {
  apiUrl: "https://cf.dev",
  space: "cli-compiled-piece",
  identity: "/unused/identity.key",
};

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `
import { pattern } from "commonfabric";
export default pattern<{ title: string }>(({ title }) => ({ title }));
`,
  }],
};

/** A space root whose registration action registers what it is sent. */
const ROOT_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `
import { handler, pattern, Writable } from "commonfabric";
const addPiece = handler<
  { piece: Writable<unknown> },
  { panels: Writable<Writable<unknown>[]> }
>(({ piece }, { panels }) => {
  panels.addUnique(piece);
});
export default pattern(() => {
  const panels = new Writable<Writable<unknown>[]>([]);
  return { pieceRegistry: panels, addPiece: addPiece({ panels }) };
});
`,
  }],
};

describe("cf piece new where the deployment serves compiled pieces", () => {
  /**
   * A space whose deployment runs the serving loop, with `compiledPatterns`
   * as `compiled` says, and what each creation path was handed.
   */
  const deployment = (compiled: boolean) => {
    const calls: string[] = [];
    const dependencies: NonNullable<
      Parameters<typeof newPieceWithReceipt>[3]
    > = {
      loadPieces: () =>
        Promise.resolve({
          runtime: {
            experimental: {
              serverExecution: true,
              compiledPatterns: compiled,
            },
          },
          getSpace: () => "did:key:test-space",
        } as never),
      getPinnedProgramFromFile: () => Promise.resolve(PROGRAM),
      loadIdentity: () => Promise.resolve({} as never),
      createCompiledPiece: () => {
        calls.push("compiled");
        return Promise.resolve("fid1:compiled");
      },
      instantiatePieceOnServer: () => {
        calls.push("standard");
        return Promise.resolve({
          pieceId: "fid1:standard",
          pattern: { identity: "pattern", symbol: "default" },
          requestKey: "key",
          registration: { status: "handled" },
        });
      },
    };
    return { calls, dependencies };
  };

  const create = (dependencies: Parameters<typeof newPieceWithReceipt>[3]) =>
    newPieceWithReceipt(
      CONFIG,
      { mainPath: "/main.tsx" },
      { start: false },
      dependencies,
    );

  it("creates the piece on the compiled path where the compiler accepts the program", async () => {
    const { calls, dependencies } = deployment(true);

    const receipt = await create({
      ...dependencies,
      checkCompiledProgram: () => Promise.resolve({ accepted: true }),
    });

    expect(receipt).toEqual({ pieceId: "fid1:compiled", path: "compiled" });
    expect(calls).toEqual(["compiled"]);
  });

  it("creates the piece on the standard path where the compiler refuses the program, and says why", async () => {
    const { calls, dependencies } = deployment(true);

    const receipt = await create({
      ...dependencies,
      checkCompiledProgram: () =>
        Promise.resolve({ refused: "The pattern compiler refused it." }),
    });

    expect(receipt).toEqual({
      pieceId: "fid1:standard",
      path: "standard",
      pathNote: "The pattern compiler refused it.",
    });
    expect(calls).toEqual(["standard"]);
  });

  it("takes the compiled path where no compiler is at hand to check, and says so", async () => {
    const { calls, dependencies } = deployment(true);

    const receipt = await create({
      ...dependencies,
      checkCompiledProgram: () =>
        Promise.resolve({ unchecked: "No pattern compiler is at /none." }),
    });

    expect(receipt).toEqual({
      pieceId: "fid1:compiled",
      path: "compiled",
      pathNote: "No pattern compiler is at /none.",
    });
    expect(calls).toEqual(["compiled"]);
  });

  it("checks nothing and names no path where the deployment serves no compiled pieces", async () => {
    const { calls, dependencies } = deployment(false);
    let checked = false;

    const receipt = await create({
      ...dependencies,
      checkCompiledProgram: () => {
        checked = true;
        return Promise.resolve({ accepted: true });
      },
    });

    expect(receipt).toEqual({ pieceId: "fid1:standard" });
    expect(calls).toEqual(["standard"]);
    expect(checked).toBe(false);
  });

  it("says which path the piece took, and why, beside the piece id", async () => {
    const printed: unknown[] = [];
    const notes: string[] = [];
    await captureStderr(() =>
      newPieceFromCommand(
        { ...CONFIG, quiet: true, indexVersion: false },
        "/repo/main.tsx",
        {
          newPiece: () =>
            Promise.resolve({
              pieceId: "fid1:standard",
              path: "standard",
              pathNote: "The pattern compiler refused it.",
            }),
          render: (value) => printed.push(value),
          note: (message) => notes.push(message),
        },
      )
    );

    expect(printed).toEqual(["fid1:standard"]);
    expect(notes).toEqual([
      "Created on the standard path: The pattern compiler refused it.",
    ]);
  });

  it("names the path in the JSON receipt", async () => {
    const printed: unknown[] = [];
    await captureStderr(() =>
      newPieceFromCommand(
        { ...CONFIG, quiet: true, json: true, indexVersion: false },
        "/repo/main.tsx",
        {
          newPiece: () =>
            Promise.resolve({ pieceId: "fid1:compiled", path: "compiled" }),
          render: (value) => printed.push(value),
          note: () => {},
        },
      )
    );

    expect(printed).toEqual([{ pieceId: "fid1:compiled", path: "compiled" }]);
  });
});

describe("checkCompiledProgram()", () => {
  it("checks nothing where no compiler binary is at the path named", async () => {
    const check = await checkCompiledProgram(
      PROGRAM,
      (name) =>
        name === "PATTERN_COMPILER_BINARY" ? "/no/such/compiler" : undefined,
    );

    expect("unchecked" in check && check.unchecked).toContain(
      "/no/such/compiler",
    );
  });
});

describe("a compiled creation", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let signer: Identity;
  let root: Cell<unknown>;

  beforeEach(async () => {
    resetWriteReceipts();
    signer = await Identity.fromPassphrase("CLI compiled creation tests");
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
      // The client runs the root's registration action itself, which a
      // serving loop runs under server execution.
      experimental: { serverExecution: false },
    });
    pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: await legacySpaceDid(CONFIG.space),
      }),
      runtime,
    );
    await pieces.synced();
    root = (await pieces.create(ROOT_PROGRAM)).getCell();
    await pieces.linkDefaultPattern(root);
  });

  afterEach(async () => {
    await runtime?.dispose();
    await server?.close();
  });

  /** The address of the root of the entity `id` in the space. */
  const at = (id: string) => ({
    space: pieces.getSpace(),
    id: id as URI,
    path: [],
    scope: "space" as const,
  });

  /** Commits `value` at the root of the entity `id`, as another writer would. */
  const write = async (id: string, value: unknown) => {
    const outcome = await runtime.editWithRetry((tx) => {
      tx.writeValueOrThrow(at(id), value as never);
    });
    expect(outcome.error).toBeUndefined();
  };

  const createdWith = (
    started: (pieces: PiecesController, id: string) => Promise<void>,
  ) =>
    createCompiledPiece(
      CONFIG,
      pieces,
      PROGRAM,
      { input: { title: "compiled" }, requestKey: "compiled" },
      {
        loadIdentity: () => Promise.resolve(signer),
        compiledPieceStarted: started,
      },
      (start) => start,
    );

  it("registers the piece the serving runtime started, whose input is the argument it was set up with", async () => {
    const id = await createdWith(() => Promise.resolve());

    expect((await pieces.getRegisteredPieces()).map((entry) => entry.id))
      .toEqual([id]);
    expect(await (await pieces.get(id)).input.get()).toEqual({
      title: "compiled",
    });
  });

  it("registers nothing where the serving runtime refused the piece, and reports its reason", async () => {
    const failure = await createdWith((_pieces, id) =>
      Promise.reject(new CompiledPieceRefusedError(id, "refused: `$h`"))
    ).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(CompiledPieceRefusedError);
    expect((failure as Error).message).toContain("refused: `$h`");
    expect(await pieces.getRegisteredPieces()).toEqual([]);
  });

  it("is told the piece started once its result document holds a value", async () => {
    const result = runtime.getCell(pieces.getSpace(), "a compiled result");
    const id = pieceId(result)!;
    const started = compiledPieceStarted(pieces, id);

    await write(`of:${id}`, { title: "derived" });

    await expect(started).resolves.toBeUndefined();
  });

  it("is told the reason the serving runtime stored where it refused the piece", async () => {
    const result = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(pieceId(runtime.getCell(pieces.getSpace(), "refused"))!),
    );
    const id = pieceId(result)!;
    // Handled from the start, since it rejects while the write is awaited.
    const refused = compiledPieceStarted(pieces, id).then(
      () => undefined,
      (error: unknown) => error,
    );

    await write(compiledFailureOf(`of:${id}`), { reason: "refused: `$h`" });

    const failure = await refused;
    expect(failure).toBeInstanceOf(CompiledPieceRefusedError);
    expect((failure as Error).message).toContain("refused: `$h`");
  });
});
