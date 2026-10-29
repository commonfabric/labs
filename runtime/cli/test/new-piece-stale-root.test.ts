/**
 * `newPiece()` against a space whose root follows a system origin that has
 * since moved: the piece is created and registered through the root the space
 * holds, with and without a request key, and the origin is not asked.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  type Cell,
  DEFAULT_APP_PATTERN_SOURCE,
  getPatternIdentityRef,
  resolveEntryIdentity,
  resolveSystemPatternSource,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { pieceListSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { newPiece } from "../lib/piece.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";

const ROOT_PATH = resolveSystemPatternSource(DEFAULT_APP_PATTERN_SOURCE)!;

/** A space root that registers what its `addPiece` stream receives. */
const rootSource = (marker: string) =>
  [
    "import { handler, pattern, Writable } from 'commonfabric';",
    "const addPiece = handler<",
    "  { piece: Writable<unknown> },",
    "  { pieceRegistry: Writable<Writable<unknown>[]> }",
    ">(({ piece }, { pieceRegistry }) => {",
    "  pieceRegistry.addUnique(piece);",
    "});",
    "export default pattern(() => {",
    "  const pieceRegistry = new Writable<Writable<unknown>[]>([]);",
    `  return { pieceRegistry, addPiece: addPiece({ pieceRegistry }), marker: "${marker}" };`,
    "});",
    "",
  ].join("\n");

const NOTE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `
import { pattern } from "commonfabric";
export default pattern<{ title: string }>(({ title }) => ({ title }));
`,
  }],
};

describe("newPiece()", () => {
  let originalFetch: typeof globalThis.fetch;
  let served: string;
  let originRequests: number;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let signer: Identity;

  beforeEach(async () => {
    resetWriteReceipts();
    // The toolshed serving the root's origin: its identity route and its
    // source, both counted.
    originalFetch = globalThis.fetch;
    served = rootSource("v1");
    originRequests = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
          ? input.href
          : input.url,
      );
      if (url.pathname !== ROOT_PATH) {
        return new Response("not found", { status: 404 });
      }
      originRequests++;
      if (url.searchParams.has("identity")) {
        return new Response(
          await resolveEntryIdentity(
            ROOT_PATH,
            (name) =>
              name === ROOT_PATH
                ? Promise.resolve(served)
                : Promise.reject(new Error(`not found: ${name}`)),
          ),
          { headers: { "content-type": "text/plain" } },
        );
      }
      return new Response(served, {
        headers: { "content-type": "text/typescript-jsx" },
      });
    }) as typeof globalThis.fetch;

    signer = await Identity.fromPassphrase("CLI creation into a stale root");
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      experimental: { serverExecution: false },
    });
    pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: await runtime.createSpace(),
      }),
      runtime,
    );
    await pieces.synced();
    await pieces.ensureDefaultPattern();
    // The origin moves on: the root the space holds is now behind it.
    served = rootSource("v2");
    originRequests = 0;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Creates a note through `newPiece()` in the test's space. */
  function create(options: { requestKey?: string }): Promise<string> {
    return newPiece(
      {
        apiUrl: "http://toolshed.test",
        space: pieces.getSpace(),
        identity: "/unused/identity.key",
      },
      { mainPath: "/main.tsx" },
      { input: { title: "note" }, ...options },
      {
        loadPieces: () => Promise.resolve(pieces),
        loadIdentity: () => Promise.resolve(signer),
        getPinnedProgramFromFile: () => Promise.resolve(NOTE_PROGRAM),
      },
    );
  }

  /** The root the space holds, read without following its origin. */
  async function heldRoot(): Promise<Cell<unknown>> {
    return (await pieces.getDefaultPattern(false))!;
  }

  /** Whether the held root's registry lists the piece `id`. */
  async function registers(id: string): Promise<boolean> {
    const registry = (await heldRoot()).asSchema({
      type: "object",
      properties: { pieceRegistry: pieceListSchema },
    }).key("pieceRegistry") as Cell<Cell<unknown>[]>;
    const members = await registry.pull();
    const piece = (await pieces.getPieceCell(id, false)) as Cell<unknown>;
    return members.some((member) => member.equalLinks(piece));
  }

  for (
    const [mode, options] of [
      ["with a request key", { requestKey: "stale-root-creation" }],
      ["without a request key", {}],
    ] as const
  ) {
    it(`registers the piece through the root the space holds, ${mode}, without asking its origin`, async () => {
      const heldIdentity = getPatternIdentityRef(await heldRoot())?.identity;

      const id = await create(options);

      expect(await registers(id)).toBe(true);
      expect(getPatternIdentityRef(await heldRoot())?.identity).toBe(
        heldIdentity,
      );
      expect(originRequests).toBe(0);
    });
  }
});
