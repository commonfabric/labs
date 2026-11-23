import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { Cell } from "../src/cell.ts";
import { isCfcLabelReference } from "../src/cfc/label-documents.ts";
import type { StoredCfcMetadata } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const owner = await Identity.fromPassphrase("runner-home-favorites-cfc-owner");
// The home space is its owner's DID.
const home = owner.did() as MemorySpace;
// The space the favorited pieces live in, as a hosted provider does.
const pieceSpace = (await Identity.fromPassphrase(
  "runner-home-favorites-cfc-pieces",
)).did() as MemorySpace;

/** The clause on a piece only its owner may read. */
const OWNER_ONLY = { type: CFC_ATOM_TYPE.User, subject: home };

// A home whose `addFavorite` also stores the favorited piece's name, which it
// reads from the piece: the read the real home must not make.
const NAME_READING_HOME = `/// <cts-enable />
import { Default, handler, NAME, pattern, Writable } from "commonfabric";

type Favorite = { cell: Writable<{ [NAME]?: string }>; name?: string; id: string };

const addFavorite = handler<
  { piece: Writable<{ [NAME]?: string }>; id?: string },
  { favorites: Writable<Favorite[]> }
>(({ piece, id }, { favorites }) => {
  if (!id) return;
  const entry = favorites.elementById(id);
  entry.set({ cell: piece, name: piece.key(NAME).get() ?? "", id });
  favorites.addUnique(entry);
});

export default pattern<{ favorites: Writable<Default<Favorite[], []>> }>(
  ({ favorites }) => ({ favorites, addFavorite: addFavorite({ favorites }) }),
);
`;

describe("home-favorites-cfc", () => {
  // Home stores a favorite as a link to the piece. These cases favorite pieces
  // whose name only their owner may read, under the strict posture, and hold
  // home's handlers to reading the favorites without reading through them.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let refusals: string[];
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: owner });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    // A refused handler commit is reported here and nowhere the sender sees.
    // Home logs other errors here too, such as a sub-pattern it cannot load
    // outside a shell, so keep only CFC's reports.
    refusals = [];
    originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      const line = args.map((arg) => Deno.inspect(arg)).join(" ");
      if (line.includes("[cfc]")) refusals.push(line);
    };
  });

  afterEach(async () => {
    console.error = originalConsoleError;
    await runtime.dispose();
    await storageManager.close();
  });

  /** A piece named `name`, which only the home's owner may read when `owned`. */
  const seedPiece = async (name: string, owned: boolean) => {
    const piece = runtime.getCell<{ $NAME?: string }>(pieceSpace, name);
    const tx = runtime.edit();
    writeSeedEnvelopeDoc(tx, pieceSpace);
    seedStoredEnvelope(tx, {
      space: pieceSpace,
      scope: "space",
      id: piece.getAsNormalizedFullLink().id as URI,
      path: [],
    }, {
      value: { $NAME: name },
      ...(owned
        ? {
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: [],
                label: { confidentiality: [OWNER_ONLY] },
              }],
            },
          },
        }
        : {}),
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    return piece;
  };

  /** Starts `program` in the home space and returns its result cell. */
  const startHome = async (program: RuntimeProgram) => {
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(program, {
      space: home,
      tx,
    });
    const result = runtime.getCell<{ favorites?: unknown[] }>(
      home,
      "home",
      undefined,
      tx,
    );
    runtime.run(tx, pattern, {}, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await runtime.idle();
    return result;
  };

  const startRealHome = async () =>
    startHome(
      await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        {
          main: fromFileUrl(
            new URL("../../../patterns/system/home/home.tsx", import.meta.url),
          ),
          root: fromFileUrl(new URL("../../..", import.meta.url)),
        },
      ),
    );

  /** Sends `event` to `stream` of `result`, and returns the favorites after. */
  const send = async (
    result: Cell<{ favorites?: unknown[] }>,
    stream: string,
    event: Record<string, unknown>,
  ): Promise<number | undefined> => {
    const tx = runtime.edit();
    // deno-lint-ignore no-explicit-any
    (result.withTx(tx) as any).key(stream).send(event);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    return (await result.pull())?.favorites?.length;
  };

  /** Every confidentiality clause stored on the favorites list's values. */
  const listClauses = (result: Cell<{ favorites?: unknown[] }>): unknown[] => {
    const link = result.key("favorites").resolveAsCell()
      .getAsNormalizedFullLink();
    const stored = runtime.edit().readOrThrow({ ...link, path: [] }) as
      | { cfc?: StoredCfcMetadata }
      | undefined;
    return (stored?.cfc?.labelMap.entries ?? [])
      .filter((entry) => entry.path[0] !== "cfc")
      .flatMap((entry) =>
        isCfcLabelReference(entry.label)
          ? []
          : entry.label.confidentiality ?? []
      );
  };

  describe("removeFavorite", () => {
    it("leaves no owner clause on the list when it removes by id", async () => {
      const result = await startRealHome();
      const owned = await seedPiece("owned", true);
      const other = await seedPiece("other", true);
      expect(await send(result, "addFavorite", { piece: owned, id: "owned" }))
        .toBe(1);
      expect(await send(result, "addFavorite", { piece: other, id: "other" }))
        .toBe(2);

      expect(await send(result, "removeFavorite", { id: "owned" })).toBe(1);
      expect(listClauses(result)).toEqual([]);
    });

    it("leaves no owner clause on the list when it removes by piece", async () => {
      // The fallback for a favorite stored before favorites had ids: it
      // matches the piece among every favorite and rewrites the list.

      const result = await startRealHome();
      const owned = await seedPiece("owned", true);
      const other = await seedPiece("other", true);
      expect(await send(result, "addFavorite", { piece: owned, id: "owned" }))
        .toBe(1);
      expect(await send(result, "addFavorite", { piece: other, id: "other" }))
        .toBe(2);

      expect(await send(result, "removeFavorite", { piece: owned })).toBe(1);
      expect(listClauses(result)).toEqual([]);
    });
  });

  describe("addFavorite", () => {
    it("adds a favorite after an owner-confidential favorite is removed", async () => {
      // The removal is what once left the owner's clause on the list, and the
      // next add read it back and was refused.

      const result = await startRealHome();
      const owned = await seedPiece("owned", true);
      const plain = await seedPiece("plain", false);
      expect(await send(result, "addFavorite", { piece: owned, id: "owned" }))
        .toBe(1);
      expect(await send(result, "removeFavorite", { id: "owned" })).toBe(0);

      expect(await send(result, "addFavorite", { piece: plain, id: "plain" }))
        .toBe(1);
      expect(refusals).toEqual([]);
    });

    it("commits no entry and reports a writer-fit refusal when it reads the owner-confidential piece into it", async () => {
      // The control: what the owner may read still does not reach a document
      // of the space whose policy does not admit it.

      const result = await startHome({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: NAME_READING_HOME }],
      });
      const owned = await seedPiece("owned", true);

      expect(await send(result, "addFavorite", { piece: owned, id: "owned" }))
        .toBe(0);
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain("writer-fit confidentiality misfit");
      expect(refusals[0]).toContain(CFC_ATOM_TYPE.User);
    });
  });
});
