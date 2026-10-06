/**
 * End-to-end: `cf piece setsrc` over a piece holding a LIVE, LINKED injected
 * SQLite capability input.
 *
 * Regression coverage for the restore path rejecting every retained link into
 * an `asCell`-declaring input slot ("sqlite capability cannot be exposed as an
 * ordinary alias"): raw storage holds SERIALIZED links, which are never
 * `isCell()`, so a piece with a linked capability input could be deployed but
 * never source-updated again. The fix is the `linksPreservedVerbatim` option
 * on `assertSuppliedLinkSchemasCompatible`, set at the `setPattern` call site;
 * removing it there fails this test with exactly that error.
 *
 * Everything here is real except the network hop: the emulated StorageManager
 * is a loopback client against a real MemoryV2Server, so
 * `registerSqliteDiskSource` + `sqliteQuery` hit the server's real disk-source
 * registry and really attach the on-disk file read-only.
 *
 * Shape mirrors Loom's sqlite-injection reconciler:
 *   deriveDiskHandleId(space, realPath) -> seed handle cell at that id ->
 *   provider.registerSqliteDiskSource(handleId, path) ->
 *   pieces.link(handleId, [], pieceId, ["db"])
 * then `PieceController.setPattern(<different program>)`, which is exactly
 * what `cf piece setsrc` drives.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  createRef,
  entityIdFrom,
  isLink,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
// Test-only dependency; pinned in this package's deno.jsonc (see the comment
// on the entry there).
import { Database } from "@db/sqlite";

import { PieceController } from "../src/ops/piece-controller.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("setsrc-e2e-sqlite");

type Row = { k: string; v: string };

/** The result shape every version of the test pattern below produces. */
interface PanelResult {
  version: string;
  rows: { pending: boolean; result?: Row[]; error?: unknown };
}

/** Byte-for-byte the derivation in packages/cli/lib/sqlite-source.ts. */
function deriveDiskHandleId(space: string, absPath: string): string {
  return createRef({ disk: { path: absPath } }, {
    space,
    scheme: "sqlite",
  }).taggedHashString;
}

function seedDiskDb(path: string): void {
  const seed = new Database(path);
  seed.exec("CREATE TABLE lookup (k TEXT, v TEXT)");
  seed.exec(
    "INSERT INTO lookup (k, v) VALUES ('a', '1'), ('b', '2'), ('c', '3')",
  );
  seed.close();
}

/**
 * A genuinely different program per version: different NAME, different
 * `version` literal, and a different LIMIT so the query itself changes (the
 * read-through assertion can then tell v1 from v2 by row COUNT, not just by a
 * string the pattern echoes). Produces {@link PanelResult}.
 */
function panelProgram(version: string, limit: number): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "/// <cts-enable />",
        "import { NAME, pattern, type SqliteDb } from 'commonfabric';",
        "interface Row { k: string; v: string; }",
        "interface In { db: SqliteDb; }",
        "interface Out {",
        "  [NAME]: string;",
        "  version: string;",
        "  rows: { pending: boolean; result?: Row[]; error?: unknown };",
        "}",
        "const Panel = pattern<In, Out>(({ db }) => {",
        `  const rows = db.query<Row>("SELECT k, v FROM lookup ORDER BY k LIMIT ${limit}");`,
        "  return {",
        `    [NAME]: ${JSON.stringify("panel-" + version)},`,
        `    version: ${JSON.stringify(version)},`,
        "    rows,",
        "  };",
        "});",
        "export default Panel;",
      ].join("\n"),
    }],
  };
}

describe("setsrc over a retained injected sqlite capability link", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let diskPath: string;

  beforeEach(async () => {
    diskPath = Deno.makeTempFileSync({ suffix: ".sqlite" });
    seedDiskDb(diskPath);
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });
    const session = createSession({
      identity: signer,
      spaceDid: await runtime.createSpace(),
    });
    pieces = new PiecesController(session, runtime);
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    try {
      Deno.removeSync(diskPath);
    } catch { /* ignore */ }
  });

  it("updates the source and keeps reading through the capability", async () => {
    const space = pieces.getSpace();
    const realPath = Deno.realPathSync(diskPath);

    // 1. Deploy the piece from v1 (LIMIT 2). No `db` argument yet — the
    //    reconciler links it in afterwards, exactly as Loom does.
    const v1 = await runtime.patternManager.compilePattern(
      panelProgram("v1", 2),
      { space },
    );
    const piece = await pieces.runPersistent(
      v1,
      {},
      "setsrc-e2e-piece-" + crypto.randomUUID(),
      { start: true },
    );
    const pieceId = entityRefToString(piece.entityId);

    // 2. Seed the handle cell at the deterministic id + register the on-disk
    //    source with the server (sqlite-injection.ts steps 1 and 2).
    const handleId = deriveDiskHandleId(space, realPath);
    const handle = runtime.getCellFromEntityId(
      space,
      entityIdFrom(handleId),
      [],
      undefined,
    );
    const seedRes = await runtime.editWithRetry((tx) => {
      handle.withTx(tx).set({ id: handleId, tables: {}, rev: 0 });
    });
    if (seedRes.error) throw seedRes.error;
    const provider = runtime.storageManager.open(space);
    expect(typeof provider.registerSqliteDiskSource).toBe("function");
    await provider.registerSqliteDiskSource!(handleId, realPath);

    // 3. Link the handle into the piece's `db` input (sqlite-injection.ts
    //    step 3: `PiecesController.link(handleId, [], pieceId, [dbField])`).
    await pieces.link(handleId, [], pieceId, ["db"]);
    await runtime.idle();
    await pieces.synced();

    const result = pieces.getResult(piece) as Cell<PanelResult>;
    const cancel = result.sink(() => {});
    try {
      const rowsOf = () => result.key("rows").key("result").get();
      const waitFor = async (
        desc: string,
        pred: () => boolean,
        ms = 20_000,
      ) => {
        const deadline = Date.now() + ms;
        let last: unknown;
        while (Date.now() < deadline) {
          await runtime.idle();
          await runtime.storageManager.synced();
          try {
            if (pred()) return;
          } catch (e) {
            last = e;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(
          `timeout waiting for ${desc}` + (last ? ` (last: ${last})` : "") +
            ` — rows=${JSON.stringify(rowsOf())} version=${
              JSON.stringify(result.key("version").get())
            } error=${JSON.stringify(result.key("rows").key("error").get())}`,
        );
      };

      // 4. PRE-CHECK: the capability really is live — the query returns the
      //    on-disk rows through the injected handle, windowed by v1's LIMIT 2.
      await waitFor(
        "v1 to read 2 rows through the injected source",
        () => (rowsOf()?.length ?? -1) === 2,
      );
      expect(rowsOf()).toEqual([{ k: "a", v: "1" }, { k: "b", v: "2" }]);
      expect(result.key("version").get()).toBe("v1");

      // The `db` argument really is a SERIALIZED link in raw storage (the
      // premise of the bug: the restore path never sees a live Cell).
      const rawArgument = () =>
        pieces.getArgument(piece)!.getRaw() as { db?: unknown };
      const rawArgumentBefore = rawArgument();
      expect(isLink(rawArgumentBefore.db)).toBe(true);

      // 5. THE ACT UNDER TEST: `cf piece setsrc` with a CHANGED program.
      const controller = new PieceController(pieces, piece);
      await controller.setPattern(panelProgram("v2", 3));
      await runtime.idle();
      await pieces.synced();

      // 6. The link survived, and still points at the SAME handle.
      const rawArgumentAfter = rawArgument();
      expect(isLink(rawArgumentAfter.db)).toBe(true);
      expect(JSON.stringify(rawArgumentAfter.db)).toBe(
        JSON.stringify(rawArgumentBefore.db),
      );

      // 7. And it is not merely preserved-but-dead: the NEW program reads
      //    through the capability and gets the on-disk rows back, now
      //    windowed by v2's LIMIT 3.
      await waitFor(
        "v2 to read 3 rows through the same injected source",
        () =>
          result.key("version").get() === "v2" &&
          (rowsOf()?.length ?? -1) === 3,
      );
      expect(rowsOf()).toEqual([
        { k: "a", v: "1" },
        { k: "b", v: "2" },
        { k: "c", v: "3" },
      ]);
      // 8. Loom's reconciler retries setsrc on every pass, so a SECOND
      //    consecutive update over the (now once-restored) link must work too.
      await controller.setPattern(panelProgram("v3", 1));
      await runtime.idle();
      await pieces.synced();
      const rawArgumentThird = rawArgument();
      expect(JSON.stringify(rawArgumentThird.db)).toBe(
        JSON.stringify(rawArgumentBefore.db),
      );
      await waitFor(
        "v3 to read 1 row through the same injected source",
        () =>
          result.key("version").get() === "v3" &&
          (rowsOf()?.length ?? -1) === 1,
      );
      expect(rowsOf()).toEqual([{ k: "a", v: "1" }]);
    } finally {
      cancel();
    }

    // 9. Cold reload: a FRESH runtime over the same (already-registered)
    //    storage must load the updated piece and still read through the
    //    retained link — i.e. the durable state setsrc left behind is
    //    coherent, not just the in-memory one.
    const freshSession = createSession({
      identity: signer,
      spaceDid: pieces.getSpace(),
    });
    const freshRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });
    const freshPieces = new PiecesController(freshSession, freshRuntime);
    try {
      await freshPieces.synced();
      const freshPiece = await freshPieces.get(pieceId, true);
      const freshResult = freshPieces.getResult(
        freshPiece.getCell(),
      ) as Cell<PanelResult>;
      const stop = freshResult.sink(() => {});
      try {
        const deadline = Date.now() + 20_000;
        let rows: unknown;
        while (Date.now() < deadline) {
          await freshRuntime.idle();
          await freshRuntime.storageManager.synced();
          rows = freshResult.key("rows").key("result").get();
          if (Array.isArray(rows) && rows.length === 1) break;
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(freshResult.key("version").get()).toBe("v3");
        expect(rows).toEqual([{ k: "a", v: "1" }]);
      } finally {
        stop();
      }
    } finally {
      await freshRuntime.dispose();
    }
  });
});
