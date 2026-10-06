/**
 * Selects from a stored profile piece through a second runtime, the way a
 * `cf` process reads one. The schema stored with a piece's result is what
 * carries the pattern's write claims (`writeAuthorizedBy` and the claims
 * beside it), and the result cell of the runtime that ran the pattern does
 * not hold that schema, so the reader here is a runtime of its own that loads
 * the piece from storage.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";

import { Identity } from "@commonfabric/identity";
import { PieceController, PiecesController } from "@commonfabric/piece/ops";
import {
  type Cell,
  Runtime,
  runtimePresets,
  type RuntimeProgram,
} from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import {
  deriveSelectedValue,
  parseSelectionFilter,
  parseSelectionProjection,
  parseSelectProjection,
} from "../lib/cell-selection.ts";

const PROFILE_HOME = "/profile-home.tsx";

const PROGRAM: RuntimeProgram = {
  main: PROFILE_HOME,
  files: [{
    name: PROFILE_HOME,
    contents: Deno.readTextFileSync(
      fromFileUrl(
        new URL("../../patterns/system/profile-home.tsx", import.meta.url),
      ),
    ),
  }],
};

const signer = await Identity.fromPassphrase("cf-selection-write-claims");
const space = signer.did();

describe("deriveSelectedValue()", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storages: EmulatedStorageManager[];
  let runtimes: Runtime[];
  let reader: Runtime;
  let readerErrors: Array<{ message: string }>;

  /** The stored result of the profile, loaded the way `cf` loads a piece. */
  let profile: Cell<unknown>;

  // A runtime with the posture `loadPieces()` gives a `cf` process, over a
  // storage connection of its own to the one server.
  const connect = (errors: Array<{ message: string }>): Runtime => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    storages.push(storage);
    const runtime = new Runtime(runtimePresets.remoteClient({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      experimental: {},
      errorHandlers: [(error) => errors.push({ message: error.message })],
    }));
    // deno-lint-ignore no-explicit-any
    (runtime as any)[Symbol.for("cf.cli.runtimeErrorLog")] = errors;
    runtimes.push(runtime);
    return runtime;
  };

  beforeEach(async () => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    storages = [];
    runtimes = [];

    const writerErrors: Array<{ message: string }> = [];
    const writer = connect(writerErrors);
    const tx = writer.edit();
    const pattern = await writer.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
    const resultCell = writer.getCell<Record<string, unknown>>(
      space,
      "selection write claims profile",
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const running = writer.run(tx, pattern as any, {
      initialName: "Ada",
    }, resultCell);
    writer.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await running.pull();
    // Each write below goes through the handler its field names as its
    // writer, which is the only writer the stored claim admits.
    running.key("setName").send({ name: "Ada Lovelace" });
    running.key("setBio").send({ bio: "Wrote the first program." });
    running.key("addExternalLink").send({
      label: "Notes",
      url: "https://example.com/notes",
    });
    await writer.idle();
    await running.pull();
    expect(writerErrors).toEqual([]);
    await writer.patternManager.flushCompileCacheWrites();
    await storages[0].synced();

    readerErrors = [];
    reader = connect(readerErrors);
    const pieces = new PiecesController({ as: signer, space }, reader, {});
    const piece = new PieceController(
      pieces,
      await pieces.getPieceCell(
        running.getAsNormalizedFullLink().id,
        false,
      ),
    );
    profile = await piece.result.getCell();
    // The cases are about a claim the source states, so the source read here
    // has to state one for any of them to say anything.
    const name = profile.key("name").schema as {
      ifc?: Record<string, unknown>;
    };
    expect(name.ifc?.writeAuthorizedBy).toBeDefined();
  });

  afterEach(async () => {
    for (const runtime of runtimes) {
      await runtime.dispose({ closeStorage: false });
    }
    for (const storage of storages) await storage.close();
    await server.close();
  });

  it("returns a selected field its source protects by owner and writer", async () => {
    const selected = await deriveSelectedValue(reader, space, profile, {
      projection: parseSelectProjection("name"),
    });
    expect(selected).toEqual({ name: "Ada Lovelace" });
    expect(readerErrors).toEqual([]);
  });

  it("returns a selected field whose protected schema also states a default", async () => {
    const selected = await deriveSelectedValue(reader, space, profile, {
      projection: parseSelectProjection("bio"),
    });
    expect(selected).toEqual({ bio: "Wrote the first program." });
    expect(readerErrors).toEqual([]);
  });

  it("returns several protected fields selected together", async () => {
    const selected = await deriveSelectedValue(reader, space, profile, {
      projection: parseSelectProjection("name,bio"),
    });
    expect(selected).toEqual({
      name: "Ada Lovelace",
      bio: "Wrote the first program.",
    });
    expect(readerErrors).toEqual([]);
  });

  it("returns the elements of a protected array a projection maps over", async () => {
    const selected = await deriveSelectedValue(
      reader,
      space,
      profile.key("externalLinks"),
      { projection: parseSelectProjection("url") },
    );
    expect(selected).toEqual([{ url: "https://example.com/notes" }]);
    expect(readerErrors).toEqual([]);
  });

  it("returns the elements of a protected array a filter keeps", async () => {
    const selected = await deriveSelectedValue(
      reader,
      space,
      profile.key("externalLinks"),
      { filter: parseSelectionFilter('.label == "Notes"') },
    );
    expect(selected).toEqual([
      { label: "Notes", url: "https://example.com/notes" },
    ]);
    expect(readerErrors).toEqual([]);
  });

  it("returns a protected array selected as a field of its object", async () => {
    const selected = await deriveSelectedValue(reader, space, profile, {
      projection: parseSelectProjection("externalLinks.url"),
    });
    expect(selected).toEqual({
      externalLinks: [{ url: "https://example.com/notes" }],
    });
    expect(readerErrors).toEqual([]);
  });

  it("returns a protected field a JSON projection names", async () => {
    const selected = await deriveSelectedValue(reader, space, profile, {
      projection: await parseSelectionProjection(
        '{"properties":{"name":{"type":"string"}}}',
      ),
    });
    expect(selected).toEqual({ name: "Ada Lovelace" });
    expect(readerErrors).toEqual([]);
  });
});
