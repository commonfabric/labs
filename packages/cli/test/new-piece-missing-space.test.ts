/**
 * What `newPiece()` reports when the space it is pointed at cannot take a
 * piece: one that does not exist, and one whose root cannot be ensured.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  createSession,
  Identity,
  legacySpaceDid,
} from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { cliCommand } from "../lib/cli-name.ts";
import { newPiece } from "../lib/piece.ts";

const SPACE_NAME = "cli-piece-new-missing-space";

describe("newPiece()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let signer: Identity;
  let programReads: number;

  beforeEach(async () => {
    signer = await Identity.generate();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: false },
    });
    programReads = 0;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Runs `newPiece()` against `pieces`, counting reads of the program. */
  function createIn(pieces: PiecesController): Promise<string> {
    return newPiece(
      {
        apiUrl: "https://cf.dev",
        space: pieces.getSpaceName() ?? pieces.getSpace(),
        identity: "/unused/identity.key",
      },
      { mainPath: "/notes/main.tsx" },
      {},
      {
        loadPieces: () => Promise.resolve(pieces),
        getPinnedProgramFromFile: () => {
          programReads++;
          return Promise.reject(new Error("the program is never read"));
        },
      },
    );
  }

  it("reports a space name that reaches no space, naming the command that creates one", async () => {
    const space = await legacySpaceDid(SPACE_NAME);
    const pieces = new PiecesController(
      createSession({ identity: signer, spaceDid: space }),
      runtime,
      { spaceName: SPACE_NAME },
    );

    const error = await createIn(pieces).then(() => undefined, (e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      `No space answers to the name "${SPACE_NAME}" (${space}). Opening a ` +
        `space never creates one; create one with: ` +
        cliCommand(["space", "create"]),
    );
    expect(error.cause?.name).toBe("SpaceNotFoundError");
    expect(programReads).toBe(0);
    expect(await runtime.spaceExists(space)).toBe(false);
  });

  it("reports any other failure to ensure the root with the `recreate-root` hint", async () => {
    const space = await runtime.createSpace();
    const pieces = new PiecesController(
      createSession({ identity: signer, spaceDid: space }),
      runtime,
    );
    const failure = new Error("root pattern unreadable");
    const failing = new Proxy(pieces, {
      get(target, property) {
        if (property === "ensureDefaultPattern") {
          return () => Promise.reject(failure);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const error = await createIn(failing).then(() => undefined, (e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(
      "Could not initialize the space's default pattern: " +
        "root pattern unreadable",
    );
    expect(error.message).toContain(cliCommand(["space", "recreate-root"]));
    expect(error.message).not.toContain(cliCommand(["space", "create"]));
    expect(error.cause).toBe(failure);
    expect(programReads).toBe(0);
  });
});
