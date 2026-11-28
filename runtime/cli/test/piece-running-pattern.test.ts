/**
 * What a source update reports as deployed, and what `readRunningPattern()`
 * reads back afterwards, over a real runtime and an in-process memory store.
 * Each read opens its own connection, as a separate CLI invocation does,
 * because the read closes the connection it is given.
 */

import { expect } from "@std/expect";

import { createSession, Identity } from "@commonfabric/identity";
import type { DID } from "@commonfabric/identity/did";
import { pieceId } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  createBuilder,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
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
  type DeployedProgram,
  readRunningPattern,
  setPiecePattern,
} from "../lib/piece.ts";

const signer = await Identity.fromPassphrase("cli running pattern tests");

const CONFIG = {
  apiUrl: "https://cf.dev",
  space: "running-pattern",
  identity: "/unused/identity.key",
};

/** A connection that records whether it was closed. */
class RecordingPieces extends PiecesController {
  closed = false;

  override async dispose(): Promise<void> {
    this.closed = true;
    await super.dispose();
  }
}

/** A self-contained program for the production pattern compiler. */
function program(contents: string): RuntimeProgram {
  return { main: "/main.tsx", files: [{ name: "/main.tsx", contents }] };
}

const FIRST = program(`
import { pattern } from "commonfabric";
export default pattern<{ title: string }>(({ title }) => ({ title }));
`);

const SECOND = program(`
import { pattern } from "commonfabric";
export default pattern<{ title: string }>(({ title }) => ({ title, second: true }));
`);

describe("readRunningPattern()", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let spaceDid: DID;
  let opened: Runtime[];

  beforeEach(async () => {
    server = newLoopbackServer();
    spaceDid = (await Identity.generate()).did();
    opened = [];
  });

  afterEach(async () => {
    for (const runtime of opened) await runtime.dispose();
    await server.close();
  });

  /** Opens a connection to the space, as one CLI invocation does. */
  async function connect(serverExecution = false): Promise<RecordingPieces> {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
      experimental: { serverExecution },
    });
    opened.push(runtime);
    const pieces = new RecordingPieces(
      createSession({ identity: signer, spaceDid }),
      runtime,
    );
    await pieces.synced();
    return pieces;
  }

  /** Creates a piece running `source`, answering its id. */
  async function create(source: RuntimeProgram): Promise<string> {
    const pieces = await connect();
    const piece = await pieces.create(source, {
      input: { title: "Notes" },
      start: false,
    });
    await pieces.synced();
    return piece.id;
  }

  /** Reads what `id` runs over a fresh connection, which the read closes. */
  async function read(id: string) {
    const pieces = await connect();
    const running = await readRunningPattern({ ...CONFIG, piece: id }, {
      loadPieces: () => Promise.resolve(pieces),
      resolvePieceAddress: (_pieces, token) => Promise.resolve(token),
    });
    expect(pieces.closed).toBe(true);
    return running;
  }

  /** The source files `program` carries, as a read answers them. */
  const files = (source: RuntimeProgram) =>
    source.files.map(({ name, contents }) => ({ name, contents }));

  it("answers the piece's pattern id and the source it was created from", async () => {
    const id = await create(FIRST);

    const running = await read(id);

    expect(running.space).toBe(spaceDid);
    expect(running.id).toBe(id);
    expect(running.patternId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(running.program.main).toBe("/main.tsx");
    expect(running.program.mainExport).toBe("default");
    expect(running.program.files).toEqual(files(FIRST));
    expect(running).not.toHaveProperty("origin");
  });

  it("answers the source a client-side update applied, under the id the update told onDeployed", async () => {
    const id = await create(FIRST);
    const before = await read(id);
    const deployed: DeployedProgram[] = [];
    const pieces = await connect();

    const receipt = await setPiecePattern(
      { ...CONFIG, piece: id },
      { mainPath: "/main.tsx" },
      { onDeployed: (told) => deployed.push(told) },
      {
        loadPieces: () => Promise.resolve(pieces),
        resolvePieceAddress: (_pieces, token) => Promise.resolve(token),
        getPinnedProgramFromFile: () => Promise.resolve(SECOND),
      },
    );
    await pieces.synced();

    expect(receipt.status).toBe("committed");
    expect(deployed).toHaveLength(1);
    expect(deployed[0].piece).toEqual({ space: spaceDid, id });
    expect(deployed[0].program).toBe(SECOND);
    const patternId = await deployed[0].patternId();
    expect(patternId).toBe(receipt.ref.identity);
    expect(patternId).not.toBe(before.patternId);

    const after = await read(id);
    expect(after.patternId).toBe(patternId);
    expect(after.program.files).toEqual(files(SECOND));
    expect(after.program.files).not.toEqual(files(FIRST));
  });

  it("tells onDeployed the pattern id a serving deployment's receipt names", async () => {
    const id = await create(FIRST);
    const deployed: DeployedProgram[] = [];
    const servedIdentity = "B".repeat(43);
    const pieces = await connect(true);

    const receipt = await setPiecePattern(
      { ...CONFIG, piece: id },
      { mainPath: "/main.tsx" },
      { onDeployed: (told) => deployed.push(told) },
      {
        loadPieces: () => Promise.resolve(pieces),
        resolvePieceAddress: (_pieces, token) => Promise.resolve(token),
        getPinnedProgramFromFile: () => Promise.resolve(SECOND),
        setPieceSourceOnServer: () =>
          Promise.resolve({
            pieceId: id,
            pattern: { identity: servedIdentity, symbol: "default" },
            revisionId: "revision-2",
            seq: 12,
            detachedOrigin: null,
          }),
        pullServed: () => Promise.resolve(),
      },
    );

    expect(receipt.ref.identity).toBe(servedIdentity);
    expect(deployed).toHaveLength(1);
    expect(deployed[0].piece).toEqual({ space: spaceDid, id });
    expect(deployed[0].program).toBe(SECOND);
    expect(await deployed[0].patternId()).toBe(servedIdentity);
    // The serving deployment applies the source; this connection wrote no
    // pointer of its own.
    expect((await read(id)).program.files).toEqual(files(FIRST));
  });

  it("refuses a piece whose pattern has no source in the space, and still closes the connection", async () => {
    const writer = await connect();
    const { commonfabric } = createBuilder();
    const builtInProcess = commonfabric.pattern<{ title: string }>((
      { title },
    ) => ({ title }));
    const id = pieceId(
      await writer.runPersistent(builtInProcess, { title: "Notes" }, "built"),
    )!;
    await writer.synced();
    const pieces = await connect();

    await expect(
      readRunningPattern({ ...CONFIG, piece: id }, {
        loadPieces: () => Promise.resolve(pieces),
        resolvePieceAddress: (_pieces, token) => Promise.resolve(token),
      }),
    ).rejects.toThrow(`Piece "${id}" does not contain a pattern source.`);
    expect(pieces.closed).toBe(true);
  });
});
