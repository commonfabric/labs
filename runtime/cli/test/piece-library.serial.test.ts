/**
 * The parts of `lib/piece.ts` that write to the process's console or replace
 * a prototype's method to stand in for a deployment: what `loadPieces()` does
 * once the server answers, and the pins `cf piece new` reports.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { type Stub, stub } from "@std/testing/mock";

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  entityIdFrom,
  Runtime,
  type RuntimeProgram,
  UnreportedAuthoredBoundaryError,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { PatternIndexStore } from "@commonfabric/pattern-index/store";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { slugIdForSpace } from "../../runner/src/slugs.ts";
import { runtimeErrorLog } from "../lib/callable.ts";
import {
  loadPieces,
  newPiece,
  pullServed,
  savePiecePattern,
} from "../lib/piece.ts";
import { withEnv } from "./utils.ts";

const API_URL = "https://toolshed.test";
const ENTRY = "Avcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c";

describe("piece-library", () => {
  describe("loadPieces()", () => {
    // `loadPieces` reads the deployment's meta document before it builds a
    // runtime; there is none. The server answers its health check, and the
    // space session opens without a server behind it.
    let stubs: Stub[];
    let keyPath: string;
    let opened: PiecesController[];

    beforeEach(async () => {
      stubs = [
        stub(globalThis, "fetch", (input: RequestInfo | URL) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
          );
          return url.pathname === "/api/meta"
            ? Promise.resolve(new Response(null, { status: 404 }))
            : Promise.reject(new Error(`unexpected request for ${url}`));
        }),
        stub(Runtime.prototype, "healthCheck", () => Promise.resolve(true)),
        stub(
          PiecesController.prototype,
          "ensureSpaceSession",
          () => Promise.resolve(),
        ),
      ];
      const identity = await Identity.fromPassphrase(
        "piece-library loadPieces",
        { implementation: "noble" },
      );
      keyPath = await Deno.makeTempFile();
      await Deno.writeFile(keyPath, identity.toPkcs8());
      opened = [];
    });

    afterEach(async () => {
      for (const pieces of opened) await pieces.dispose();
      for (const replaced of stubs) replaced.restore();
      await Deno.remove(keyPath);
    });

    /** Opens a connection, reporting what it writes to `reports`. */
    async function open(reports: string[]): Promise<PiecesController> {
      const pieces = await loadPieces(
        { apiUrl: API_URL, identity: keyPath, space: "piece-library-load" },
        { report: (message) => reports.push(message) },
      );
      opened.push(pieces);
      return pieces;
    }

    it("reports that the profile delegations could not be loaded, and connects anyway", async () => {
      stubs.push(
        stub(
          Runtime.prototype,
          "loadProfileDelegations",
          () => Promise.reject(new Error("Home is unreadable")),
        ),
      );
      const reports: string[] = [];

      const pieces = await open(reports);

      expect(reports).toEqual([
        "Could not load the profile delegations: Home is unreadable",
      ]);
      expect(pieces.getSpaceName()).toBe("piece-library-load");
    });

    it("reports nothing when the profile delegations load", async () => {
      stubs.push(
        stub(
          Runtime.prototype,
          "loadProfileDelegations",
          () => Promise.resolve(0),
        ),
      );
      const reports: string[] = [];

      await open(reports);

      expect(reports).toEqual([]);
    });

    it("records each error the runtime reports in the connection's error log", async () => {
      stubs.push(
        stub(
          Runtime.prototype,
          "loadProfileDelegations",
          () => Promise.resolve(0),
        ),
        stub(console, "error", () => {}),
      );
      const pieces = await open([]);
      expect(runtimeErrorLog(pieces.runtime)).toEqual([]);

      pieces.runtime.scheduler.reportError(
        Object.assign(new Error("the pattern threw"), {
          pieceId: "fid1:thrower",
          patternId: "pattern-1",
          spellId: "spell-1",
        }),
        () => {},
      );

      const [record, ...rest] = runtimeErrorLog(pieces.runtime);
      expect(rest).toEqual([]);
      expect(record).toEqual({
        message: "the pattern threw",
        pieceId: "fid1:thrower",
        patternId: "pattern-1",
        spellId: "spell-1",
        space: undefined,
        stackTrace: expect.stringContaining("the pattern threw"),
      });
    });

    it("leaves what the connection compiles, and nothing before, in the compiled-module cache under the user's cache directory", async () => {
      stubs.push(
        stub(
          Runtime.prototype,
          "loadProfileDelegations",
          () => Promise.resolve(0),
        ),
      );
      const cacheHome = await Deno.makeTempDir({ prefix: "cf-cache-home-" });
      const modules = join(
        cacheHome,
        "common-fabric",
        "compiled-modules",
        "modules",
      );
      // Every module file under `modules`, or `undefined` where there is no
      // such directory.
      const cachedFiles = async (): Promise<string[] | undefined> => {
        const files: string[] = [];
        try {
          for await (const version of Deno.readDir(modules)) {
            for await (
              const file of Deno.readDir(join(modules, version.name))
            ) {
              files.push(file.name);
            }
          }
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return undefined;
          throw error;
        }
        return files;
      };
      try {
        await withEnv("XDG_CACHE_HOME", cacheHome, async () => {
          const pieces = await open([]);
          expect(await cachedFiles()).toBeUndefined();

          await pieces.runtime.patternManager.compileAndRegisterModules({
            main: "/main.tsx",
            files: [{
              name: "/main.tsx",
              contents: [
                "import { NAME, pattern } from 'commonfabric';",
                "export default pattern(() => ({ [NAME]: 'cached' }));",
              ].join("\n"),
            }],
          });

          expect((await cachedFiles())?.length).toBeGreaterThan(0);
        });
      } finally {
        await Deno.remove(cacheHome, { recursive: true });
      }
    });

    it("reports a failure of the compiled-module cache to the connection's report", async () => {
      stubs.push(
        stub(
          Runtime.prototype,
          "loadProfileDelegations",
          () => Promise.resolve(0),
        ),
      );
      const scratch = await Deno.makeTempDir({ prefix: "cf-cache-home-" });
      const blocker = join(scratch, "a-file");
      await Deno.writeTextFile(blocker, "");
      try {
        await withEnv("XDG_CACHE_HOME", blocker, async () => {
          const reports: string[] = [];
          const pieces = await open(reports);
          expect(reports).toEqual([]);

          await pieces.runtime.patternManager.compileAndRegisterModules({
            main: "/main.tsx",
            files: [{
              name: "/main.tsx",
              contents: [
                "import { NAME, pattern } from 'commonfabric';",
                "export default pattern(() => ({ [NAME]: 'reported' }));",
              ].join("\n"),
            }],
          });

          expect(reports).toEqual([
            expect.stringContaining(
              `[compile-byte-cache] ${
                join(blocker, "common-fabric", "compiled-modules")
              } failed`,
            ),
          ]);
        });
      } finally {
        await Deno.remove(scratch, { recursive: true });
      }
    });
  });

  describe("savePiecePattern()", () => {
    let directory: string;
    let printed: unknown[][];
    let log: Stub;

    beforeEach(async () => {
      directory = await Deno.makeTempDir();
      printed = [];
      log = stub(console, "log", (...args: unknown[]) => {
        printed.push(args);
      });
    });

    afterEach(async () => {
      log.restore();
      await Deno.remove(directory, { recursive: true });
    });

    /** Saves the source of a piece whose stored program is `program`. */
    function save(program: RuntimeProgram | undefined): Promise<void> {
      const pieces = {
        get: () =>
          Promise.resolve({
            id: "fid1:saved",
            getPatternSourceProgram: () => Promise.resolve(program),
          }),
      };
      return savePiecePattern(
        {
          apiUrl: API_URL,
          space: "did:key:z6Mk-saved",
          identity: "/unused/identity.key",
          piece: "fid1:saved",
        },
        directory,
        { loadPieces: () => Promise.resolve(pieces as never) },
      );
    }

    it("throws for a piece that holds no pattern source, and writes nothing", async () => {
      await expect(save(undefined)).rejects.toThrow(
        'Piece "fid1:saved" does not contain a pattern source.',
      );

      expect([...Deno.readDirSync(directory)]).toEqual([]);
      expect(printed).toEqual([]);
    });

    it("names the data files the source does not, after writing every file", async () => {
      await save({
        main: "/main.tsx",
        dataFiles: ["/data/notes.txt"],
        files: [
          { name: "/main.tsx", contents: "export default 1;\n" },
          { name: "/data/notes.txt", contents: "kept as data" },
        ],
      });

      expect(await Deno.readTextFile(join(directory, "data/notes.txt")))
        .toBe("kept as data");
      expect(printed).toEqual([[
        "\nThis pattern carries 1 data file(s) its source does not name.\n" +
        "Pass them on the next setsrc, or they are dropped from that " +
        "revision:\n  --datafile ./data/notes.txt",
      ]]);
    });

    it("prints nothing for a source with no data files", async () => {
      await save({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "export default 1;\n" }],
      });

      expect(await Deno.readTextFile(join(directory, "main.tsx")))
        .toBe("export default 1;\n");
      expect(printed).toEqual([]);
    });
    describe("where the piece came from the pattern index", () => {
      let savedHome: string | undefined;
      let home: string;
      let errors: unknown[][];
      let error: Stub;
      const SOURCE = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "export default 1;\n" }],
      };

      beforeEach(async () => {
        savedHome = Deno.env.get("CF_PATTERN_INDEX_HOME");
        home = await Deno.makeTempDir();
        Deno.env.set("CF_PATTERN_INDEX_HOME", home);
        errors = [];
        error = stub(console, "error", (...args: unknown[]) => {
          errors.push(args);
        });
      });

      afterEach(async () => {
        error.restore();
        if (savedHome === undefined) {
          Deno.env.delete("CF_PATTERN_INDEX_HOME");
        } else {
          Deno.env.set("CF_PATTERN_INDEX_HOME", savedHome);
        }
        await Deno.remove(home, { recursive: true });
      });

      it("records the files it wrote as that pattern's source, in the store that recorded the piece", async () => {
        const store = new PatternIndexStore(join(home, "index.test"));
        await store.recordIndexedPiece("fid1:saved", "pat-1");
        await store.recordIndexedPiece("fid1:other", "pat-2");

        await save(SOURCE);

        expect(await store.sourceOf(join(directory, "main.tsx"))).toBe(
          "pat-1",
        );
        expect(errors).toEqual([]);
      });

      it("records nothing for a piece no store recorded", async () => {
        const store = new PatternIndexStore(join(home, "index.test"));
        await store.recordIndexedPiece("fid1:other", "pat-2");

        await save(SOURCE);

        expect(await store.sourceOf(join(directory, "main.tsx")))
          .toBeUndefined();
        expect(errors).toEqual([]);
      });

      it("warns, having written the source, when the stores cannot be read", async () => {
        const notADirectory = join(home, "file");
        await Deno.writeTextFile(notADirectory, "");
        Deno.env.set("CF_PATTERN_INDEX_HOME", notADirectory);

        await save(SOURCE);

        expect(await Deno.readTextFile(join(directory, "main.tsx")))
          .toBe("export default 1;\n");
        expect(errors).toHaveLength(1);
        expect(String(errors[0][0])).toContain(
          "Could not record where this source came from",
        );
      });
    });
  });

  describe("pullServed()", () => {
    // A deployment whose replica takes no read views, so each pull ends in
    // the warning that what follows reads what the server has stored.
    const NO_VIEWS =
      "This server accepts no read views, so it was not asked to recompute " +
      "this value; reading what it has stored, which may be stale.";
    const space = "did:key:z6Mk-served-space";
    const cell = {
      getAsNormalizedFullLink: () => ({
        space,
        id: "of:fid1:served",
        scope: "space",
        path: [],
      }),
    };
    let warnings: unknown[][];
    let asked: string[];
    let warn: Stub;

    beforeEach(() => {
      warnings = [];
      asked = [];
      warn = stub(console, "warn", (...args: unknown[]) => {
        warnings.push(args);
      });
    });

    afterEach(() => warn.restore());

    /**
     * Pulls through a connection whose server reports `head` and answers a
     * request for its authored boundary with `authored`.
     */
    function pull(
      serverExecution: boolean,
      head: number | undefined,
      authored: () => Promise<number | undefined>,
    ): Promise<void> {
      const pieces = {
        runtime: {
          experimental: { serverExecution },
          storageManager: {
            open: () => ({
              serverHeadSeq: () => {
                asked.push("head");
                return Promise.resolve(head);
              },
              serverAuthoredSeq: () => {
                asked.push("authored");
                return authored();
              },
              replica: {
                supportsViewReplication: () => {
                  asked.push("views");
                  return Promise.resolve(false);
                },
              },
            }),
          },
        },
        getSpace: () => space,
      };
      return pullServed(pieces as never, cell as never);
    }

    it("asks nothing of a deployment that does not serve the piece", async () => {
      await pull(false, 1, () => Promise.resolve(undefined));

      expect(asked).toEqual([]);
      expect(warnings).toEqual([]);
    });

    it("pulls without waiting when the server reports no head", async () => {
      await pull(true, undefined, () => Promise.resolve(undefined));

      expect(asked).toEqual(["head", "views"]);
      expect(warnings).toEqual([[NO_VIEWS]]);
    });

    it("warns that it reads without waiting when the server reports no authored boundary", async () => {
      await pull(
        true,
        3,
        () => Promise.reject(new UnreportedAuthoredBoundaryError()),
      );

      expect(asked).toEqual(["head", "authored", "views"]);
      expect(warnings).toEqual([
        [
          "The serving server does not report authored commit boundaries; " +
          "reading without waiting for the serving runtime, so a run a send " +
          "just started may not show yet.",
        ],
        [NO_VIEWS],
      ]);
    });

    it("throws any other failure to read the authored boundary, and pulls nothing", async () => {
      await expect(
        pull(true, 3, () => Promise.reject(new Error("the session closed"))),
      ).rejects.toThrow("the session closed");

      expect(asked).toEqual(["head", "authored"]);
      expect(warnings).toEqual([]);
    });
  });

  describe("newPiece()", () => {
    let runtime: Runtime;
    let signer: Identity;
    let directory: string;

    beforeEach(async () => {
      signer = await Identity.fromPassphrase("piece-library pins");
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: StorageManager.emulate({ as: signer }),
      });
      directory = await Deno.makeTempDir();
    });

    afterEach(async () => {
      await runtime.dispose();
      await Deno.remove(directory, { recursive: true });
    });

    /**
     * Points `slug` at a piece running the pattern {@link ENTRY}, so that an
     * import of `cf:<slug>` pins to it.
     */
    async function publishPatternAt(slug: string): Promise<void> {
      const space = signer.did();
      const piece = runtime.getCell(space, { space, random: `piece-${slug}` });
      await runtime.editWithRetry((tx) => {
        const pieceWithTx = piece.withTx(tx);
        pieceWithTx.set({ name: "piece" });
        pieceWithTx.setMetaRaw("patternIdentity", {
          identity: ENTRY,
          symbol: "default",
        }, rawMetaWriteAuthorization);
      });
      const slugCell = runtime.getCellFromEntityId(
        space,
        entityIdFrom(slugIdForSpace(space, slug)),
      );
      await runtime.editWithRetry((tx) => {
        const slugWithTx = slugCell.withTx(tx);
        slugWithTx.setRawUntyped(
          piece.withTx(tx).getAsWriteRedirectLink({ base: slugWithTx }),
        );
      });
    }

    it("writes each import it pins to standard error and creates the piece from the pinned source", async () => {
      await publishPatternAt("dep");
      const mainPath = join(directory, "main.tsx");
      await Deno.writeTextFile(
        mainPath,
        `export type Dep = import("cf:dep").Dep;\n`,
      );
      const pieces = new PiecesController(
        createSession({ identity: signer, spaceDid: signer.did() }),
        runtime,
      );
      const created: RuntimeProgram[] = [];
      const creating = new Proxy(pieces, {
        get(target, property) {
          if (property === "ensureDefaultPattern") {
            return () => Promise.resolve();
          }
          if (property === "create") {
            return (program: RuntimeProgram) => {
              created.push(program);
              return Promise.reject(new Error("stopped after the pins"));
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const written: unknown[][] = [];
      const errorOutput = stub(console, "error", (...args: unknown[]) => {
        written.push(args);
      });

      try {
        await expect(
          newPiece(
            {
              apiUrl: API_URL,
              space: signer.did(),
              identity: "/unused/identity.key",
            },
            { mainPath },
            {},
            { loadPieces: () => Promise.resolve(creating) },
          ),
        ).rejects.toThrow("stopped after the pins");
      } finally {
        errorOutput.restore();
      }

      expect(written).toEqual([[`pinned cf:dep -> @${ENTRY}`]]);
      expect(created.map((program) => program.files[0].contents)).toEqual([
        `export type Dep = import("cf:dep@${ENTRY}").Dep;\n`,
      ]);
    });
  });
});
