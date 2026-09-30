import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  entityIdFrom,
  type MemorySpace,
  Runtime,
  type URI,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import { parseLink } from "../../runner/src/link-utils.ts";
import { slugIdForSpace, slugIndexIdForSpace } from "../../runner/src/slugs.ts";
import { pieceId } from "../src/piece-id.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import {
  assignSlug,
  listSlugs,
  readSlugBinding,
  resolvePieceAddress,
  resolvePieceReference,
  resolveSlugTarget,
  resolveSlugTargetCell,
  setSlugLink,
  SlugAssignedError,
  SlugReleasedError,
  SlugResolutionError,
} from "../src/slugs.ts";

const signer = await Identity.fromPassphrase("piece slug tests");

describe("piece slugs", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
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
  });

  async function createPiece(cause: string) {
    const { commonfabric } = createBuilder();
    const piecePattern = commonfabric.pattern<{ value: number }>((
      { value },
    ) => ({ value }));
    return await pieces.runPersistent(piecePattern, { value: 1 }, cause);
  }

  /** What `work` rejected with, or `undefined` when it resolved. */
  async function failureOf(work: Promise<unknown>): Promise<unknown> {
    return await work.then(() => undefined, (error: unknown) => error);
  }

  function readRootMeta(id: string, key: string): unknown {
    return runtime.readTx().readOrThrow({
      space: pieces.getSpace(),
      id: `of:${id}` as URI,
      scope: "space",
      path: [key],
    });
  }

  it("stores slug metadata and resolves through the slug document redirect", async () => {
    const piece = await createPiece("slug-target");
    const id = pieceId(piece)!;

    await assignSlug(pieces, piece, "demo");

    const slugId = slugIdForSpace(pieces.getSpace(), "demo");
    expect(readRootMeta(id, "slug")).toBe("demo");
    expect(readRootMeta(slugId, "slug")).toBe("demo");
    expect(await resolvePieceAddress(pieces, "demo")).toBe(id);
  });

  it("throws naming the storage failure when the slug transaction is rejected", async () => {
    // A rejected slug transaction must reach the caller. Resolving normally
    // would report a slug that never landed, and the next read would find
    // the name unassigned.
    const piece = await createPiece("slug-rejected");
    const rejection = {
      name: "StorageTransactionAborted",
      message: "storage refused the commit",
      reason: new Error("refused"),
    };
    const originalEditWithRetry = runtime.editWithRetry;
    runtime.editWithRetry =
      (() =>
        Promise.resolve({ error: rejection })) as typeof runtime.editWithRetry;
    let failure: unknown;
    try {
      failure = await setSlugLink(pieces, "rejected", piece).then(
        () => undefined,
        (error: unknown) => error,
      );
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }

    expect(failure).toBeInstanceOf(Error);
    const error = failure as Error;
    expect(error.message).toContain("rejected");
    expect(error.message).toContain("StorageTransactionAborted");
    expect(error.message).toContain("storage refused the commit");
    // The storage rejection stays reachable for a caller that wants to tell
    // a conflict from a refusal.
    expect(error.cause).toBe(rejection);
    // The name is not listed, because the transaction carrying it never
    // committed.
    expect(await listSlugs(pieces)).not.toContain("rejected");
    // The slug document was not written either: resolving the name still
    // reports it missing.
    await expect(resolvePieceAddress(pieces, "rejected")).rejects.toThrow(
      /Slug "rejected" not found/,
    );
  });

  it("lists every assigned slug, once, however many times a name is set", async () => {
    const piece = await createPiece("index-target");
    const other = await createPiece("index-other");

    await assignSlug(pieces, piece, "board");
    await setSlugLink(pieces, "tracker", other);
    // Repointing a name changes where it resolves, never how it is listed.
    await setSlugLink(pieces, "board", other, { force: true });

    expect(await listSlugs(pieces)).toEqual(["board", "tracker"]);
    expect(await resolvePieceAddress(pieces, "board")).toBe(pieceId(other)!);
  });

  it("lists no slugs for a space that assigned none", async () => {
    expect(await listSlugs(pieces)).toEqual([]);
  });

  it("sets slug redirects to arbitrary cell links", async () => {
    const piece = await createPiece("slug-link-target");
    const slugId = slugIdForSpace(pieces.getSpace(), "value-link");
    const slugCell = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugId),
    );

    await setSlugLink(pieces, "value-link", piece.key("value"));

    await slugCell.sync();
    const link = parseLink(slugCell.getRaw(), slugCell);
    expect(link?.overwrite).toBe("redirect");
    expect(link?.id).toBe(piece.getAsNormalizedFullLink().id);
    expect(link?.path).toEqual(["value"]);
    expect(readRootMeta(slugId, "slug")).toBe("value-link");
    // The index write is unconditional: a slug to a cell path is as much a
    // name the space has as one to a piece root.
    expect(await listSlugs(pieces)).toEqual(["value-link"]);
  });

  it("resolves slug redirects to arbitrary cells without treating them as pieces", async () => {
    const cell = runtime.getCell(
      pieces.getSpace(),
      { space: pieces.getSpace(), random: "slug-cell-target" },
    );
    await runtime.editWithRetry((tx) => {
      cell.withTx(tx).set({ value: 1 });
    });

    await setSlugLink(pieces, "value-link", cell);

    const target = await resolveSlugTargetCell(pieces, "value-link");
    expect(target.getAsNormalizedFullLink().id).toBe(
      cell.getAsNormalizedFullLink().id,
    );
    expect(target.getAsNormalizedFullLink().path).toEqual([]);
    expect(target.get()).toEqual({ value: 1 });

    await expect(resolvePieceAddress(pieces, "value-link")).rejects.toThrow(
      /not a piece/,
    );
  });

  it("can resolve source links before setting a slug redirect", async () => {
    const piece = await createPiece("slug-resolved-link-target");
    await setSlugLink(pieces, "first-link", piece);

    const firstSlugCell = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugIdForSpace(pieces.getSpace(), "first-link")),
    );
    const secondSlugCell = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugIdForSpace(pieces.getSpace(), "second-link")),
    );

    await setSlugLink(pieces, "second-link", firstSlugCell, {
      resolveBeforeLinking: true,
    });

    await secondSlugCell.sync();
    const link = parseLink(secondSlugCell.getRaw(), secondSlugCell);
    expect(link?.overwrite).toBe("redirect");
    expect(link?.id).toBe(piece.getAsNormalizedFullLink().id);
    expect(readRootMeta(pieceId(piece)!, "slug")).toBe("second-link");
  });

  it("stores slug metadata on the fully resolved target", async () => {
    const output = runtime.getCell(
      pieces.getSpace(),
      { space: pieces.getSpace(), random: "slug-final-target" },
    );
    const intermediate = runtime.getCell(
      pieces.getSpace(),
      { space: pieces.getSpace(), random: "slug-intermediate-target" },
    );

    await runtime.editWithRetry((tx) => {
      output.withTx(tx).set({ value: 1 });
      intermediate.withTx(tx).key("child").setRawUntyped(
        output.withTx(tx).getAsWriteRedirectLink({
          base: intermediate.withTx(tx).key("child"),
        }),
      );
    });

    await setSlugLink(pieces, "resolved-target", intermediate.key("child"), {
      writeTargetMetadata: true,
    });

    const slugCell = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugIdForSpace(pieces.getSpace(), "resolved-target")),
    );
    await slugCell.sync();
    const link = parseLink(slugCell.getRaw(), slugCell);
    expect(link?.overwrite).toBe("redirect");
    expect(link?.id).toBe(intermediate.getAsNormalizedFullLink().id);
    expect(link?.path).toEqual(["child"]);
    expect(readRootMeta(
      String(output.getAsNormalizedFullLink().id).replace(/^of:/, ""),
      "slug",
    )).toBe("resolved-target");
  });

  it("preserves resolved slug redirect paths", async () => {
    const piece = await createPiece("slug-resolved-path-target");
    await setSlugLink(pieces, "first-path-link", piece.key("value"));

    const firstSlugCell = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugIdForSpace(pieces.getSpace(), "first-path-link")),
    );
    const secondSlugCell = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugIdForSpace(pieces.getSpace(), "second-path-link")),
    );

    await setSlugLink(pieces, "second-path-link", firstSlugCell, {
      resolveBeforeLinking: true,
    });

    await secondSlugCell.sync();
    const resolvedFirstLink = firstSlugCell.resolveAsCell()
      .getAsNormalizedFullLink();
    const link = parseLink(secondSlugCell.getRaw(), secondSlugCell);
    expect(link?.overwrite).toBe("redirect");
    expect(link?.id).toBe(resolvedFirstLink.id);
    expect(link?.path).toEqual(resolvedFirstLink.path);
  });

  it("preserves URI-shaped piece addresses", async () => {
    expect(await resolvePieceAddress(pieces, "fid1:piece-123")).toBe(
      "fid1:piece-123",
    );
    expect(await resolvePieceAddress(pieces, "of:fid1:piece-123")).toBe(
      "of:fid1:piece-123",
    );
  });

  it("refuses a name that is already bound, naming what it points at", async () => {
    const held = await createPiece("slug-held");
    const taking = await createPiece("slug-taking");
    await assignSlug(pieces, held, "demo");

    const failure = await failureOf(setSlugLink(pieces, "demo", taking));

    expect(failure).toBeInstanceOf(SlugAssignedError);
    const refusal = failure as SlugAssignedError;
    expect(refusal.slug).toBe("demo");
    // The target is a reference the caller can read and write back, so the
    // refusal says what taking the name would have cost.
    expect(refusal.target).toBe(
      `/${held.getAsNormalizedFullLink().id}`,
    );
    expect(refusal.message).toContain(refusal.target);
    // The name still points where it did: the refusal protected the address
    // rather than merely reporting on it.
    expect(await resolvePieceAddress(pieces, "demo")).toBe(pieceId(held));
  });

  it("takes a bound name when the caller forces it", async () => {
    const held = await createPiece("slug-held");
    const taking = await createPiece("slug-taking");
    await assignSlug(pieces, held, "demo");

    await assignSlug(pieces, taking, "demo", { force: true });

    expect(await resolvePieceAddress(pieces, "demo")).toBe(pieceId(taking));
  });

  it("clears the name from the holder a forced assignment takes it from", async () => {
    const held = await createPiece("slug-held");
    const taking = await createPiece("slug-taking");
    await assignSlug(pieces, held, "demo");
    expect(readRootMeta(pieceId(held)!, "slug")).toBe("demo");

    await assignSlug(pieces, taking, "demo", { force: true });

    // Both sides, because a test of the new side alone passes against a
    // system that never clears the old one.
    expect(readRootMeta(pieceId(taking)!, "slug")).toBe("demo");
    expect(readRootMeta(pieceId(held)!, "slug")).toBeUndefined();
  });

  it("clears the name from a holder reached through a redirect with a path", async () => {
    // The stamp lands on the RESOLVED root, so the clear has to ask the same
    // question of the old holder. A stored redirect carrying a path can still
    // resolve to a root: reading the path off the redirect answers about the
    // redirect, and the root it reaches keeps the name it no longer holds —
    // two roots stamped `demo`, which is the state the reverse map cannot
    // represent.
    const output = runtime.getCell(
      pieces.getSpace(),
      { space: pieces.getSpace(), random: "redirect-output" },
    );
    const intermediate = runtime.getCell(
      pieces.getSpace(),
      { space: pieces.getSpace(), random: "redirect-intermediate" },
    );
    await runtime.editWithRetry((tx) => {
      output.withTx(tx).set({ value: 1 });
      intermediate.withTx(tx).key("child").setRawUntyped(
        output.withTx(tx).getAsWriteRedirectLink({
          base: intermediate.withTx(tx).key("child"),
        }),
      );
    });
    const outputId = String(output.getAsNormalizedFullLink().id)
      .replace(/^of:/, "");
    await setSlugLink(pieces, "demo", intermediate.key("child"), {
      writeTargetMetadata: true,
    });
    expect(readRootMeta(outputId, "slug")).toBe("demo");
    const taking = await createPiece("slug-taking");

    await assignSlug(pieces, taking, "demo", { force: true });

    expect(readRootMeta(pieceId(taking)!, "slug")).toBe("demo");
    expect(readRootMeta(outputId, "slug")).toBeUndefined();
  });

  it("leaves a holder's own name alone when the name taken from it is another", async () => {
    // The entry is single-valued, so the last name assigned is the one the
    // root claims. Taking `demo` back must not drop the claim to `latest`,
    // which is a different name that still resolves here.
    const held = await createPiece("slug-held");
    const taking = await createPiece("slug-taking");
    await assignSlug(pieces, held, "demo");
    await assignSlug(pieces, held, "latest");
    expect(readRootMeta(pieceId(held)!, "slug")).toBe("latest");

    await assignSlug(pieces, taking, "demo", { force: true });

    expect(readRootMeta(pieceId(held)!, "slug")).toBe("latest");
  });

  it("takes a name still pointing where the caller last read it", async () => {
    // A caller whose own rule calls this state free carries that answer in
    // rather than forcing over whatever is there.
    const held = await createPiece("slug-held");
    const taking = await createPiece("slug-taking");
    await assignSlug(pieces, held, "demo");

    const seen = await readSlugBinding(pieces, "demo");
    await assignSlug(pieces, taking, "demo", { takeFrom: seen });

    expect(await resolvePieceAddress(pieces, "demo")).toBe(pieceId(taking));
  });

  it("refuses a name that moved since the caller read it, naming where it went", async () => {
    const first = await createPiece("slug-first");
    const moved = await createPiece("slug-moved");
    const taking = await createPiece("slug-taking");
    await assignSlug(pieces, first, "demo");
    const seen = await readSlugBinding(pieces, "demo");
    // Somebody else takes the name between the caller's read and its write.
    await assignSlug(pieces, moved, "demo", { force: true });

    const failure = await failureOf(
      assignSlug(pieces, taking, "demo", { takeFrom: seen }),
    );

    expect(failure).toBeInstanceOf(SlugAssignedError);
    expect((failure as SlugAssignedError).target).toBe(
      `/${moved.getAsNormalizedFullLink().id}`,
    );
    expect(await resolvePieceAddress(pieces, "demo")).toBe(pieceId(moved));
  });

  it("refuses a name the caller named a target for that now points nowhere", async () => {
    // The fifth state of the claim, and the one an extra clause used to let
    // through: `takeFrom` says commit only while the name points at that
    // target, and a name pointing NOWHERE is not that target. A caller that
    // named none is asking for a free name and gets one — the tests above —
    // so nothing about the default rests on this.
    const taking = await createPiece("slug-taking");
    const elsewhere = await createPiece("slug-elsewhere");
    const gone = `/${elsewhere.getAsNormalizedFullLink().id}`;

    const failure = await failureOf(
      assignSlug(pieces, taking, "demo", { takeFrom: gone }),
    );

    expect(failure).toBeInstanceOf(SlugReleasedError);
    // Both halves of what a caller acts on: which name to read again, and
    // the target its rule was about.
    expect((failure as SlugReleasedError).slug).toBe("demo");
    expect((failure as SlugReleasedError).expected).toBe(gone);
    // Refused, so the name was not written: the caller's rule was about a
    // target that is not there, and taking it anyway is what it excluded.
    await expect(resolvePieceAddress(pieces, "demo")).rejects.toThrow(
      /Slug "demo" not found/,
    );
  });

  it("assigns over a name whose document holds a payload no redirect can be read from", async () => {
    // A slug document can be written by a foreign client over the memory
    // protocol, and this runtime's own write path rejects such a value — so
    // the read is where one has to be presented. `parseSlugRedirect` folds a
    // sigil-shaped payload with broken internals into the same "points
    // nowhere" the resolver reports as malformed; reading it any other way
    // throws out of an assignment over a name nothing resolves through.
    const piece = await createPiece("malformed-target");
    const slugEntity = JSON.stringify(
      entityIdFrom(slugIdForSpace(pieces.getSpace(), "demo")),
    );
    const poisoned = {
      "/": {
        "link@1": {
          id: "of:fid1:whatever",
          path: "not-an-array",
          overwrite: "redirect",
        },
      },
    };
    const poison = (cell: Cell<unknown>): Cell<unknown> =>
      new Proxy(cell, {
        get(target, property) {
          if (property === "getRaw") return () => poisoned;
          if (property === "withTx") {
            return (tx: unknown) =>
              poison(
                (target.withTx as (tx: unknown) => Cell<unknown>)(tx),
              );
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const originalGetCell = runtime.getCellFromEntityId.bind(runtime);
    runtime.getCellFromEntityId = ((
      ...args: Parameters<Runtime["getCellFromEntityId"]>
    ) => {
      const cell = originalGetCell(...args);
      return JSON.stringify(args[1]) === slugEntity ? poison(cell) : cell;
    }) as Runtime["getCellFromEntityId"];

    try {
      await assignSlug(pieces, piece, "demo");
    } finally {
      runtime.getCellFromEntityId = originalGetCell;
    }

    expect(await resolvePieceAddress(pieces, "demo")).toBe(pieceId(piece));
  });

  it("refuses when the target the caller judged free has become a piece", async () => {
    // The rule a `takeFrom` caller applies can read the TARGET — the harness
    // calls a name free when it resolves to no piece — and the redirect does
    // not change when the target becomes one. A claim over the pointer alone
    // would match and repoint a name that now names a piece, which is the
    // race this whole guard exists to close, one level down.
    const plain = runtime.getCell(
      pieces.getSpace(),
      { space: pieces.getSpace(), random: "becomes-a-piece" },
    );
    await runtime.editWithRetry((tx) => {
      plain.withTx(tx).set({ value: 1 });
    });
    await setSlugLink(pieces, "demo", plain);
    const seen = await readSlugBinding(pieces, "demo");
    // The target gains a pattern identity, so the same redirect now names a
    // piece and the caller's rule would no longer call the name free.
    await runtime.editWithRetry((tx) => {
      plain.withTx(tx).setMetaRaw(
        "patternIdentity",
        { identity: "pattern-late", symbol: "default" },
        rawMetaWriteAuthorization,
      );
    });
    const taking = await createPiece("slug-taking");

    const failure = await failureOf(
      assignSlug(pieces, taking, "demo", { takeFrom: seen }),
    );

    expect(failure).toBeInstanceOf(SlugAssignedError);
    expect(await resolveSlugTarget(pieces, "demo")).toEqual({
      piece: String(plain.getAsNormalizedFullLink().id).replace(/^of:/, ""),
      pathInside: [],
    });
  });

  it("takes a name whose value is a link cycle, which is what forcing is for", async () => {
    // The state an operator forces to escape. Two things have to hold at
    // once: the write must land on a name whose own value cycles, and the
    // cleanup that rides along must not resolve that cycle and throw — an
    // old target that will not resolve has no root carrying the name, which
    // is nothing to clear rather than a reason to refuse. Both shapes,
    // because a self-cycle is the one an assignment can point a name at and
    // a two-step cycle is the one two of them can.
    const slugCell = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugIdForSpace(pieces.getSpace(), "demo")),
    );
    await runtime.editWithRetry((tx) => {
      const cell = slugCell.withTx(tx);
      cell.setRawUntyped(cell.getAsWriteRedirectLink({ base: cell }));
    });
    const first = await createPiece("cycle-first");

    await assignSlug(pieces, first, "demo", { force: true });

    expect(await resolvePieceAddress(pieces, "demo")).toBe(pieceId(first));

    const left = runtime.getCell(
      pieces.getSpace(),
      { space: pieces.getSpace(), random: "cycle-left" },
    );
    const right = runtime.getCell(
      pieces.getSpace(),
      { space: pieces.getSpace(), random: "cycle-right" },
    );
    await runtime.editWithRetry((tx) => {
      left.withTx(tx).setRawUntyped(
        right.withTx(tx).getAsWriteRedirectLink({ base: left.withTx(tx) }),
      );
      right.withTx(tx).setRawUntyped(
        left.withTx(tx).getAsWriteRedirectLink({ base: right.withTx(tx) }),
      );
      slugCell.withTx(tx).setRawUntyped(
        left.withTx(tx).getAsWriteRedirectLink({ base: slugCell.withTx(tx) }),
      );
    });
    const second = await createPiece("cycle-second");

    await assignSlug(pieces, second, "demo", { force: true });

    expect(await resolvePieceAddress(pieces, "demo")).toBe(pieceId(second));
  });

  it("reads a name whose target is a redirect cycle as its own state", async () => {
    // A cycle is a state a caller's rule has to be able to hold an opinion
    // about, so the claim records it rather than throwing out of the read.
    // It compares like any other: a name stops resolving nowhere only by
    // being written.
    const slugCell = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugIdForSpace(pieces.getSpace(), "demo")),
    );
    await runtime.editWithRetry((tx) => {
      const cell = slugCell.withTx(tx);
      cell.setRawUntyped(cell.getAsWriteRedirectLink({ base: cell }));
    });

    const seen = await readSlugBinding(pieces, "demo");

    expect(seen).toContain("unresolvable");
  });

  it("gives one name to the first of two assignments and refuses the second", async () => {
    // Two assignments of one free name, started together and settling one
    // after the other. What this asserts is the outcome — exactly one writer
    // takes the name — and nothing about the interleaving: the assertions
    // hold whether the two overlapped or ran in sequence, so the test does
    // not establish which, and no comment here should claim one.
    //
    // What the runtime guarantees is separate and stated where it is pinned:
    // the claim's read joins the commit's read set, so a commit racing
    // another is rejected and the body re-runs against the new holder and
    // then declines. The pair under "the read a refusal claims on" below is
    // what establishes that read, over two sessions where the losing
    // replica is provably behind.
    //
    // The two targets differ, so a guard that let both through would leave
    // the loser's target standing, which the last assertion would see.
    const first = await createPiece("slug-race-first");
    const second = await createPiece("slug-race-second");
    expect(pieceId(first)).not.toBe(pieceId(second));

    const outcomes = await Promise.all([
      failureOf(setSlugLink(pieces, "contested", first)),
      failureOf(setSlugLink(pieces, "contested", second)),
    ]);

    const [winner, loser] = outcomes[0] === undefined
      ? [first, second]
      : [second, first];
    expect(outcomes.filter((outcome) => outcome === undefined)).toHaveLength(1);
    const refusal = outcomes.find((outcome) => outcome !== undefined);
    expect(refusal).toBeInstanceOf(SlugAssignedError);
    // The refusal names the holder the loser lost to, not its own target.
    expect((refusal as SlugAssignedError).target).toBe(
      `/${winner.getAsNormalizedFullLink().id}`,
    );
    expect(await resolvePieceAddress(pieces, "contested")).toBe(
      pieceId(winner),
    );
    expect(await resolvePieceAddress(pieces, "contested")).not.toBe(
      pieceId(loser),
    );
  });

  it("reports missing and malformed slug documents", async () => {
    await expect(resolvePieceAddress(pieces, "missing")).rejects.toThrow(
      /Slug "missing" not found/,
    );

    const slugId = slugIdForSpace(pieces.getSpace(), "malformed");
    const slugCell = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(slugId),
    );
    await runtime.editWithRetry((tx) => {
      slugCell.withTx(tx).setRawUntyped("not a redirect");
    });

    await expect(resolvePieceAddress(pieces, "malformed")).rejects.toThrow(
      /does not contain a valid redirect/,
    );
  });

  describe("a slug that names a collection", () => {
    // The members are pieces the controller ran. The board is a document
    // stamped as a piece's, holding its collection at `names` keyed by member
    // name, with one key holding a plain value for a member that is no
    // piece. `top` points at the collection and `one` at the first member.

    let board: Cell<unknown>;
    let boardId: string;
    let item1: Cell<unknown>;
    let item2: Cell<unknown>;

    beforeEach(async () => {
      item1 = await createPiece("member-1");
      item2 = await createPiece("member-2");
      board = runtime.getCell(
        pieces.getSpace(),
        { space: pieces.getSpace(), random: "board" },
      );
      await runtime.editWithRetry((tx) => {
        const withTx = board.withTx(tx);
        withTx.set({ names: { "1": item1, "2": item2, "3": { plain: true } } });
        withTx.setMetaRaw(
          "patternIdentity",
          { identity: "pattern-board", symbol: "default" },
          rawMetaWriteAuthorization,
        );
      });
      boardId = pieceId(board)!;
      await setSlugLink(pieces, "top", board.key("names"));
      await assignSlug(pieces, item1, "one");
    });

    describe("resolvePieceReference()", () => {
      it("returns the member the first segment selects, and the rest of the path", async () => {
        expect(await resolvePieceReference(pieces, "top", ["2", "value"]))
          .toEqual({ piece: pieceId(item2), pathAfter: ["value"] });
      });

      it("reads a numeric segment as the member name it denotes", async () => {
        expect(await resolvePieceReference(pieces, "top", [1]))
          .toEqual({ piece: pieceId(item1), pathAfter: [] });
      });

      it("returns the piece and the whole path when the slug names a piece root", async () => {
        expect(await resolvePieceReference(pieces, "one", ["value"]))
          .toEqual({ piece: pieceId(item1), pathAfter: ["value"] });
      });

      it("returns a handle and its path untouched", async () => {
        expect(await resolvePieceReference(pieces, "of:fid1:piece-123", ["x"]))
          .toEqual({ piece: "of:fid1:piece-123", pathAfter: ["x"] });
      });

      it("fails with `missing-member` when the collection holds no such name", async () => {
        const error = await failureOf(
          resolvePieceReference(pieces, "top", ["999"]),
        );
        expect(error).toBeInstanceOf(SlugResolutionError);
        expect((error as SlugResolutionError).code).toBe("missing-member");
        expect((error as Error).message).toBe("no member 999 in top");
      });

      it("fails with `inside-piece` naming the containing piece when no member follows the collection's name", async () => {
        for (
          const work of [
            resolvePieceReference(pieces, "top", []),
            resolvePieceAddress(pieces, "top"),
          ]
        ) {
          const error = await failureOf(work);
          expect(error).toBeInstanceOf(SlugResolutionError);
          expect((error as SlugResolutionError).code).toBe("inside-piece");
          expect((error as Error).message).toContain(
            `inside piece ${boardId}`,
          );
          expect((error as Error).message).toContain("top/<name>");
        }
      });

      it("fails with `not-piece` when the member holds no piece", async () => {
        const error = await failureOf(
          resolvePieceReference(pieces, "top", ["3"]),
        );
        expect(error).toBeInstanceOf(SlugResolutionError);
        expect((error as SlugResolutionError).code).toBe("not-piece");
        expect((error as Error).message).toMatch(
          /"top\/3" does not name a piece/,
        );
      });
    });

    describe("resolveSlugTarget()", () => {
      it("returns the containing piece and the path for a slug into a piece", async () => {
        expect(await resolveSlugTarget(pieces, "top"))
          .toEqual({ piece: boardId, pathInside: ["names"] });
      });

      it("returns an empty path for a slug that names a piece", async () => {
        expect(await resolveSlugTarget(pieces, "one"))
          .toEqual({ piece: pieceId(item1), pathInside: [] });
      });

      it("fails with `not-piece` for a slug to a plain document", async () => {
        const plain = runtime.getCell(
          pieces.getSpace(),
          { space: pieces.getSpace(), random: "plain" },
        );
        await runtime.editWithRetry((tx) => {
          plain.withTx(tx).set({ value: 1 });
        });
        await setSlugLink(pieces, "plain", plain);

        const error = await failureOf(resolveSlugTarget(pieces, "plain"));
        expect(error).toBeInstanceOf(SlugResolutionError);
        expect((error as SlugResolutionError).code).toBe("not-piece");
      });
    });
  });
  describe("the read a refusal claims on", () => {
    // What `setSlugLink`'s refusal rests on: whether reading the name inside
    // the transaction puts it in the commit's read set, so that binding the
    // name under an assignment rejects the assignment instead of letting it
    // write over the new holder.
    //
    // Two sessions on one server with fan-out held manual, so a stale basis
    // is a gated state rather than a timing accident. The write under test
    // lands on the slug INDEX, a different document from the slug the body
    // reads, so nothing but the read can carry a conflict — the pair of
    // tests differs in the read alone.

    let server: ReturnType<typeof newLoopbackServer>;
    let holderStorage: EmulatedStorageManager;
    let holderRuntime: Runtime;
    let takerStorage: EmulatedStorageManager;
    let takerRuntime: Runtime;
    let space: MemorySpace;
    let slugCellId: string;

    /** A cell in the shared space, addressed the same way from either side. */
    function cellOf(runtime: Runtime, id: string) {
      return runtime.getCellFromEntityId(space, entityIdFrom(id));
    }

    beforeEach(async () => {
      server = newLoopbackServer({ subscriptionRefreshDelayMs: "manual" });
      holderStorage = EmulatedStorageManager.connectTo(server, { as: signer });
      holderRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: holderStorage,
      });
      takerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
      takerRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: takerStorage,
      });
      space = signer.did() as MemorySpace;
      slugCellId = slugIdForSpace(space, "contested");

      // The name starts bound to the first target, and both sessions hold
      // that basis.
      const first = holderRuntime.getCell(space, "contested-first");
      const seed = holderRuntime.edit();
      cellOf(holderRuntime, slugCellId).withTx(seed).setRawUntyped(
        first.withTx(seed).getAsWriteRedirectLink({
          base: cellOf(holderRuntime, slugCellId).withTx(seed),
        }),
      );
      await seed.commit({ resolveAt: "verdict" });
      await holderRuntime.storageManager.synced();
      await cellOf(takerRuntime, slugCellId).sync();
      await cellOf(takerRuntime, slugCellId).pull();
      await cellOf(takerRuntime, slugIndexIdForSpace(space)).sync();

      // The holder rebinds the name. The taker's basis is now behind, and
      // the held fan-out keeps it there.
      const second = holderRuntime.getCell(space, "contested-second");
      const rebind = holderRuntime.edit();
      cellOf(holderRuntime, slugCellId).withTx(rebind).setRawUntyped(
        second.withTx(rebind).getAsWriteRedirectLink({
          base: cellOf(holderRuntime, slugCellId).withTx(rebind),
        }),
      );
      await rebind.commit({ resolveAt: "verdict" });
      await holderRuntime.storageManager.synced();
    });

    afterEach(async () => {
      await takerRuntime?.dispose();
      await holderRuntime?.dispose();
      await takerStorage?.close();
      await holderStorage?.close();
      await server?.close();
    });

    /**
     * The taker's transaction: it writes the slug index the way an
     * assignment does, having first read the name it is claiming when
     * `readName` says so. Answers the commit's rejection, or `undefined`.
     */
    async function commitFromStaleBasis(
      readName: boolean,
    ): Promise<{ name?: string } | undefined> {
      const tx = takerRuntime.edit();
      if (readName) cellOf(takerRuntime, slugCellId).withTx(tx).getRaw();
      cellOf(takerRuntime, slugIndexIdForSpace(space)).withTx(tx)
        .key("contested").set(true);
      const { error } = await tx.commit({ resolveAt: "verdict" });
      return error;
    }

    it("rejects the commit when the body read the name another writer had bound", async () => {
      expect((await commitFromStaleBasis(true))?.name).toBe("ConflictError");
    });

    it("commits the same write when the body did not read that name", async () => {
      expect(await commitFromStaleBasis(false)).toBeUndefined();
    });
  });
});
