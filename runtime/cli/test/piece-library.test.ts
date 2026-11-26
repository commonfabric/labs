/**
 * Functions of `lib/piece.ts`, each handed the connection, runtime, or
 * deadline a deployment would otherwise supply.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { createSession, Identity } from "@commonfabric/identity";
import { pieceId, SlugResolutionError } from "@commonfabric/piece";
import { PieceController, PiecesController } from "@commonfabric/piece/ops";
import {
  createBuilder,
  NAME,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import type { NameSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { FabricPlainObject } from "@commonfabric/data-model";
import {
  getMemoryProtocolFlags,
  type MemoryProtocolFlags,
} from "@commonfabric/memory/v2";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { externalRefTo } from "../../runner/test/schema-ref-helpers.ts";
import {
  CF_RUNTIME_ERROR_LOG,
  type CliRuntimeErrorRecord,
} from "../lib/callable.ts";
import type { LifecycleClientConfig } from "../lib/pattern-lifecycle.ts";
import {
  createSpace,
  inspectPiece,
  linkPieces,
  linkSqliteDiskSource,
  LinkValidationError,
  newPiece,
  resolveLinkEndpointAddress,
  withDeclaredFieldProse,
} from "../lib/piece.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";

const signer = await Identity.fromPassphrase("piece-library");
const space = signer.did();

const CONFIG = {
  apiUrl: "https://cf.dev",
  space,
  identity: "/unused/identity.key",
  quiet: true,
};

const PROGRAM = { main: "/main.tsx", files: [] };

/**
 * `target`, answering each property `overrides` holds with the override, and
 * every other property with `target`'s own, bound to `target`.
 */
function overriding<T extends object>(
  target: T,
  overrides: Partial<T>,
): T {
  return new Proxy(target, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) {
        return Reflect.get(overrides, property);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Gives each case of the enclosing `describe()` a `PiecesController` for
 * `space` over an emulated store, which the returned function reads.
 */
function piecesPerCase(): () => PiecesController {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    pieces = new PiecesController(
      createSession({ identity: signer, spaceDid: space }),
      runtime,
    );
  });
  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });
  return () => pieces;
}

describe("piece-library", () => {
  describe("inspectPiece()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      pieces = new PiecesController(
        createSession({
          identity: signer,
          spaceDid: (await Identity.generate()).did(),
        }),
        runtime,
      );
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
    });

    const target = (piece: string) => ({
      ...CONFIG,
      space: pieces.getSpace(),
      piece,
    });

    /** Runs a piece named `name` that publishes `value`. */
    async function run(name: string, value: number): Promise<string> {
      const { commonfabric } = createBuilder();
      const named = commonfabric.pattern<{ value: number }>(({ value }) => ({
        [NAME]: name,
        value,
      }));
      const cell = await pieces.runPersistent(named, { value }, name);
      await pieces.synced();
      return pieceId(cell)!;
    }

    it("names the pieces a piece reads from and the pieces that read it", async () => {
      // Which pieces read which is the space registry's answer, which needs a
      // root pattern; the controller here stands in with a fixed answer, and
      // what is asserted is how each piece in it is reported.
      const inspected = await run("inspected", 1);
      const upstream = new PieceController(
        pieces,
        await pieces.getPieceCell(await run("upstream", 2), false),
      );
      const downstream = new PieceController(
        pieces,
        await pieces.getPieceCell(await run("downstream", 3), false),
      );
      const related = overriding(pieces, {
        get: async (...args: Parameters<PiecesController["get"]>) =>
          overriding(await pieces.get(...args), {
            readingFrom: () => Promise.resolve([upstream]),
            readBy: () => Promise.resolve([downstream]),
          }),
      });

      const inspection = await inspectPiece(target(inspected), {
        loadPieces: () => Promise.resolve(related),
      });

      expect(inspection.id).toBe(inspected);
      expect(inspection.name).toBe("inspected");
      expect(inspection.readingFrom).toEqual([
        { id: upstream.id, name: "upstream" },
      ]);
      expect(inspection.readBy).toEqual([
        { id: downstream.id, name: "downstream" },
      ]);
    });
  });

  describe("withDeclaredFieldProse()", () => {
    it("serves a reference to a document nothing registered as it is", () => {
      const served = externalRefTo({
        type: "string",
        description: "piece-library: a document nobody registers",
      });

      expect(withDeclaredFieldProse(served, undefined)).toBe(served);
    });
  });

  describe("linkPieces()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;
    let counter: string;
    let form: string;

    /** A program whose main module is `contents`. */
    const program = (contents: string): RuntimeProgram => ({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents }],
    });

    /** Compiles and runs `source` with `input`, returning the piece's id. */
    async function run(source: RuntimeProgram, input: object) {
      const pattern = await runtime.patternManager.compilePattern(source, {
        space: pieces.getSpace(),
      });
      const cell = await pieces.runPersistent(pattern, input, undefined, {
        start: true,
      });
      await pieces.synced();
      return pieceId(cell)!;
    }

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      pieces = new PiecesController(
        createSession({
          identity: signer,
          spaceDid: (await Identity.generate()).did(),
        }),
        runtime,
      );
      await pieces.synced();
      counter = await run(
        program(`
import { pattern } from "commonfabric";
export default pattern<{ count: number }>(({ count }) => ({ count }));
`),
        { count: 1 },
      );
      form = await run(
        program(`
import { pattern } from "commonfabric";
export default pattern<{ title: string; settings: string | Record<string, string> }>(
  ({ title }) => ({ title }),
);
`),
        { title: "Form", settings: "dark" },
      );
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
    });

    const link = (
      targetPath: string[],
      options?: { allowNonExisting?: boolean },
    ) =>
      linkPieces(
        { ...CONFIG, space: pieces.getSpace() },
        counter,
        ["count"],
        form,
        targetPath,
        options,
        { loadPieces: () => Promise.resolve(pieces) },
      );

    it("refuses a target path that runs through a value with no fields", async () => {
      const refusal = await link(["settings", "theme"]).catch((error) => error);

      expect(refusal).toBeInstanceOf(LinkValidationError);
      expect(refusal.message).toBe(
        `Target path "settings/theme" does not exist on piece ${form}\n\n` +
          "Use --allow-non-existing to link anyway.",
      );
    });

    it("throws the link's own failure as itself rather than as a refusal", async () => {
      const failure = await link(["title"], { allowNonExisting: true })
        .catch((error) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(LinkValidationError);
      expect(failure.message).toMatch(
        new RegExp(`^Cannot link ${counter}/count to ${form}/title: `),
      );
    });

    it("refuses a target path the input schema does not declare", async () => {
      const failure = await link(["undeclared"], { allowNonExisting: true })
        .catch((error) => error);

      expect(failure).toBeInstanceOf(LinkValidationError);
      expect(failure.message).toBe(
        'Cannot access path "undeclared" - property "undeclared" not found ' +
          "in the current pattern's input schema. Update the target pattern " +
          "with cf piece setsrc to declare this input before linking, " +
          "reading, or writing it. --allow-non-existing does not override " +
          "the input schema.",
      );
    });
  });

  describe("linkSqliteDiskSource()", () => {
    let runtime: Runtime;

    beforeEach(() => {
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: StorageManager.emulate({ as: signer }),
      });
    });

    afterEach(async () => {
      await runtime.dispose();
    });

    it("throws the failure of the write that seeds the handle, and registers nothing", async () => {
      const refused = new Error("the space refused the handle");
      const asked: string[] = [];
      const refusing = new Proxy(runtime, {
        get(target, property) {
          if (property === "editWithRetry") {
            return () => Promise.resolve({ error: refused });
          }
          if (property === "storageManager") {
            asked.push("storageManager");
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const pieces = new PiecesController(
        createSession({ identity: signer, spaceDid: space }),
        runtime,
      );
      const failure = linkSqliteDiskSource(
        CONFIG,
        "/data/reference.db",
        "fid1:holder",
        ["refDb"],
        {},
        {
          loadPieces: () =>
            Promise.resolve(overriding(pieces, { runtime: refusing })),
        },
      );

      await expect(failure).rejects.toBe(refused);
      expect(asked).toEqual([]);
    });
  });

  describe("createSpace()", () => {
    const pieces = piecesPerCase();
    beforeEach(() => resetWriteReceipts());

    it("creates the space through a connection to the identity's Home, under the label given", async () => {
      const opened: unknown[] = [];
      const labels: unknown[] = [];
      using _createSpace = stub(pieces(), "createSpace", (label) => {
        labels.push(label);
        return Promise.resolve("did:key:z6Mk-created");
      });

      const created = await createSpace(
        { apiUrl: CONFIG.apiUrl, identity: CONFIG.identity },
        "Team lunch",
        {
          loadIdentity: () => Promise.resolve(signer),
          loadPieces: (config) => {
            opened.push(config);
            return Promise.resolve(pieces());
          },
        },
      );

      expect(created).toBe("did:key:z6Mk-created");
      expect(opened).toEqual([{
        apiUrl: CONFIG.apiUrl,
        identity: CONFIG.identity,
        space: signer.did(),
      }]);
      expect(labels).toEqual(["Team lunch"]);
    });
  });

  describe("resolveLinkEndpointAddress()", () => {
    const pieces = piecesPerCase();
    const missing = () =>
      Promise.reject(new SlugResolutionError("No slug document.", "missing"));

    it("returns an id-shaped token no slug document names as the piece, under the fallback", async () => {
      const resolved = await resolveLinkEndpointAddress(
        pieces(),
        "fid1:not-yet-seen",
        ["items", 0],
        { resolvePieceAddress: missing },
        { allowMissingSlugFallback: true },
      );

      expect(resolved).toEqual({
        piece: "fid1:not-yet-seen",
        pathAfter: ["items", 0],
      });
    });

    it("throws for the same token without the fallback", async () => {
      await expect(
        resolveLinkEndpointAddress(
          pieces(),
          "fid1:not-yet-seen",
          [],
          { resolvePieceAddress: missing },
        ),
      ).rejects.toThrow("No slug document.");
    });
  });

  describe("newPiece()", () => {
    const pieces = piecesPerCase();
    beforeEach(() => resetWriteReceipts());

    /**
     * Creates a piece against a serving deployment whose storage manager
     * answers each method `storageManager` holds with that one, handing the
     * served-verb client to `use` in place of sending the creation verb.
     */
    function createServed(
      storageManager: Pick<
        Runtime["storageManager"],
        "runPatternLifecycle" | "serverFlags"
      >,
      use: (client: LifecycleClientConfig) => Promise<unknown>,
    ): Promise<string> {
      return newPiece(
        CONFIG,
        { mainPath: "/main.tsx" },
        { start: false },
        {
          loadPieces: () =>
            Promise.resolve(overriding(pieces(), {
              runtime: overriding(pieces().runtime, {
                experimental: { serverExecution: true },
                storageManager: overriding(
                  pieces().runtime.storageManager,
                  storageManager,
                ),
              }),
            })),
          getPinnedProgramFromFile: () => Promise.resolve(PROGRAM),
          instantiatePieceOnServer: async (client) => {
            await use(client);
            return {
              pieceId: "fid1:served",
              pattern: { identity: "pattern", symbol: "default" },
              requestKey: "served",
              registration: { status: "handled" },
            };
          },
        },
      );
    }

    describe("the start's deadline", () => {
      /**
       * Creates a piece on this client whose runtime has recorded `errors`,
       * starting it with `start`, which may record more, under `deadline`.
       */
      function createLocal(
        errors: CliRuntimeErrorRecord[],
        start: () => Promise<unknown>,
        deadline: (settled: AbortSignal) => Promise<void>,
      ): Promise<string> {
        // Held apart from the call so the error log, which the runtime keeps
        // under a symbol its type does not declare, can ride along.
        const runtimeOverrides = {
          experimental: { serverExecution: false },
          [CF_RUNTIME_ERROR_LOG]: errors,
        };
        return newPiece(
          CONFIG,
          { mainPath: "/main.tsx" },
          {},
          {
            loadPieces: () =>
              Promise.resolve(overriding(pieces(), {
                runtime: overriding(pieces().runtime, runtimeOverrides),
                ensureDefaultPattern: () =>
                  Promise.resolve(
                    new PieceController(
                      pieces(),
                      pieces().runtime.getCell<NameSchema>(space, "root"),
                    ),
                  ),
                create: start as PiecesController["create"],
                add: () => Promise.resolve(),
              })),
            getPinnedProgramFromFile: () => Promise.resolve(PROGRAM),
            startDeadline: deadline,
          },
        );
      }

      const never = () => new Promise<never>(() => {});

      it("reports the runtime error recorded while the piece started once the deadline passes", async () => {
        const errors: CliRuntimeErrorRecord[] = [{ message: "before" }];

        await expect(
          createLocal(
            errors,
            () => {
              errors.push({ message: "the pattern threw while starting" });
              return never();
            },
            () => Promise.resolve(),
          ),
        ).rejects.toThrow(
          "Piece created but failed to start within 60s. A runtime error " +
            "was reported while it started: the pattern threw while starting",
        );
      });

      it("points at the server logs once the deadline passes with no error recorded since the start", async () => {
        await expect(
          createLocal([{ message: "before" }], never, () => Promise.resolve()),
        ).rejects.toThrow(
          "Piece created but failed to start within 60s. Check toolshed " +
            "logs for runtime errors.",
        );
      });

      it("returns the piece and stops the deadline when the piece starts first", async () => {
        const deadlines: AbortSignal[] = [];

        const id = await createLocal(
          [],
          () => Promise.resolve({ id: "fid1:started", getCell: () => ({}) }),
          (settled) => {
            deadlines.push(settled);
            return never();
          },
        );

        expect(id).toBe("fid1:started");
        expect(deadlines.map((settled) => settled.aborted)).toEqual([true]);
      });
    });

    describe("the served-verb client", () => {
      it("sends a verb on the storage manager's memory session for the space", async () => {
        const sent: unknown[][] = [];
        let answer: FabricPlainObject | undefined;
        const id = await createServed(
          {
            runPatternLifecycle: (...args: unknown[]) => {
              sent.push(args);
              return Promise.resolve({ ok: true });
            },
          },
          async (client) => {
            answer = await client.session(space, "instantiate", { a: 1 });
          },
        );

        expect(id).toBe("fid1:served");
        expect(sent).toEqual([[space, "instantiate", { a: 1 }]]);
        expect(answer).toEqual({ ok: true });
      });

      it("throws naming the verb when the storage manager has no memory sessions", async () => {
        await expect(
          createServed(
            { runPatternLifecycle: undefined },
            (client) =>
              Promise.resolve().then(() =>
                client.session(space, "instantiate", {})
              ),
          ),
        ).rejects.toThrow(
          "This connection's storage manager has no memory sessions to " +
            "send the `instantiate` verb on",
        );
      });

      it("reads whether the deployment takes origins and scopes from its server flags", async () => {
        const asked: string[] = [];
        const current = getMemoryProtocolFlags();
        // A server older than the two flags advertises neither.
        const {
          patternLifecycleOrigins: _origins,
          patternLifecycleScopes: _scopes,
          ...older
        } = current;
        let flags: MemoryProtocolFlags | undefined = current;
        const answers: unknown[] = [];
        await createServed(
          {
            serverFlags: (of) => {
              asked.push(of);
              return Promise.resolve(flags);
            },
          },
          async (client) => {
            answers.push(await client.takesOrigins?.(space));
            answers.push(await client.takesScopes?.(space));
            flags = older;
            answers.push(await client.takesOrigins?.(space));
            answers.push(await client.takesScopes?.(space));
            flags = undefined;
            answers.push(await client.takesOrigins?.(space));
          },
        );

        expect(answers).toEqual([true, true, false, undefined, undefined]);
        expect(asked).toEqual([space, space, space, space, space]);
      });
    });
  });
});
