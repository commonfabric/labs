/**
 * How the worker reads a slug reference: which of the runner's two questions
 * it asks, and what it reports of the answer.
 *
 * The walk itself is covered in `packages/runner/test/slug-resolution.test.ts`,
 * so the fixture here is the smallest thing reference resolution reads —
 * documents stamped with a `patternIdentity`, which is what makes a document a
 * piece, and a board holding its members at `names`. Nothing runs.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { entityRefFromString } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  entityIdFrom,
  getPatternIdentityRef,
  Runtime,
  slugIdForSpace,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { RequestType } from "@/protocol/mod.ts";
import { buildProcessor } from "./build-processor.ts";

const signer = await Identity.fromPassphrase("runtime-client slug resolve");
const space = signer.did();

describe("handleSlugResolve()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let board: Cell<unknown>;
  let item2: Cell<unknown>;

  /** A document that reads as a piece, holding `content`. */
  async function pieceDocument(
    cause: string,
    content: unknown,
  ): Promise<Cell<unknown>> {
    const cell = runtime.getCell(space, { space, random: cause });
    await runtime.editWithRetry((tx) => {
      const withTx = cell.withTx(tx);
      withTx.set(content);
      withTx.setMetaRaw(
        "patternIdentity",
        { identity: `pattern-${cause}`, symbol: "default" },
        rawMetaWriteAuthorization,
      );
    });
    return cell;
  }

  /** Bind `slug` to `target` the way `set-slug` does. */
  async function pointSlug(slug: string, target: Cell<unknown>): Promise<void> {
    const slugCell = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, slug)),
    );
    await runtime.editWithRetry((tx) => {
      const slugWithTx = slugCell.withTx(tx);
      slugWithTx.setRawUntyped(
        target.withTx(tx).getAsWriteRedirectLink({ base: slugWithTx }),
      );
    });
  }

  /** Call the handler over a processor that is nothing but this space. */
  function resolve(slug: string, member?: string) {
    const processor = buildProcessor({
      cc: { getSpace: () => space },
      space,
      runtime,
    });
    return processor.handleSlugResolve({
      type: RequestType.SlugResolve,
      space,
      slug,
      member,
    });
  }

  function idOf(cell: Cell<unknown>): string {
    return cell.getAsNormalizedFullLink().id;
  }

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const item1 = await pieceDocument("item-1", { title: "Glaze recipes" });
    item2 = await pieceDocument("item-2", { title: "Oven schedule" });
    board = await pieceDocument("board", { names: { "1": item1, "2": item2 } });
    await pointSlug("board", board);
    await pointSlug("top", board.key("names"));
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("returns the member a reference names, spending the segment", async () => {
    const response = await resolve("top", "2");
    expect(response).toMatchObject({
      piece: {
        cell: {
          id: idOf(item2),
          space,
          scope: "space",
          path: [],
          cfcReferenceToken: expect.any(String),
        },
      },
      pathAfter: [],
    });
  });

  it("returns the piece that holds a collection named alone", async () => {
    // A name with no member after it asks which piece the name is inside,
    // and a page URL names a piece to render, so that piece is what the
    // shell opens — at its root, not at the collection.
    const response = await resolve("top");
    expect(response).toMatchObject({
      piece: {
        cell: {
          id: idOf(board),
          space,
          scope: "space",
          path: [],
          cfcReferenceToken: expect.any(String),
        },
      },
      pathAfter: [],
    });
  });

  it("returns the piece a slug names at its root", async () => {
    const response = await resolve("board");
    expect(response).toMatchObject({
      piece: {
        cell: {
          id: idOf(board),
          space,
          scope: "space",
          path: [],
          cfcReferenceToken: expect.any(String),
        },
      },
      pathAfter: [],
    });
  });

  it("hands back a member a slug naming a piece never spent", async () => {
    // `board` names a piece at its root, which holds no member namespace, so
    // the segment after it selects nothing: it stays a cell path inside that
    // piece. Reporting it is what lets a caller tell the two apart — the
    // piece is the same either way, and only this says whether the address
    // that reached it included the segment.
    const response = await resolve("board", "2");
    expect(response).toMatchObject({
      piece: {
        cell: {
          id: idOf(board),
          space,
          scope: "space",
          path: [],
          cfcReferenceToken: expect.any(String),
        },
      },
      pathAfter: ["2"],
    });
  });

  it("leaves a watch asleep when a member becomes a piece", async () => {
    // The residue, and the whole reason a poll sits beside the subscription.
    // Whether a document is a piece is metadata — `isPieceRoot` reads
    // `patternIdentity` — and the sink follows values. So a member whose
    // target is not yet a piece resolves as a refusal, and the write that
    // makes it one moves nothing the read set covers.
    const bare = runtime.getCell(space, { space, random: "not-yet-a-piece" });
    await runtime.editWithRetry((tx) => {
      bare.withTx(tx).set({ title: "not yet a piece" });
      board.withTx(tx).key("names").key("6").set(bare);
    });
    const slugCell = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, "top")),
    );
    let woke = 0;
    const cancel = slugCell.sink(() => {
      woke++;
    });
    await runtime.idle();
    const atSubscribe = woke;

    await runtime.editWithRetry((tx) => {
      bare.withTx(tx).setMetaRaw(
        "patternIdentity",
        { identity: "pattern-late", symbol: "default" },
        rawMetaWriteAuthorization,
      );
    });
    await runtime.idle();
    cancel();

    // The write landed — this is a miss, not a no-op.
    expect(getPatternIdentityRef(bare)).toBeDefined();
    expect(woke).toBe(atSubscribe);
  });

  it("opens a cell for the shell that no write to the slug or its target wakes", async () => {
    // What `getSlugCell` in `packages/lib-shell/src/runtime.ts` opens, built
    // the way it builds it: the slug's id is handed to `getCell` as a CAUSE,
    // and `Runtime.getCell` hashes a cause to make an id. So the cell that
    // comes back sits at a hash of the slug's id rather than at the slug, and
    // it is neither the slug document nor the target the slug points at.
    //
    // Everything follows from that. Neither of the two writes a slug
    // reference turns on reaches such a cell — a write inside the target,
    // and the slug being repointed — so `AppView` notices both by
    // re-resolving on its interval and by nothing else. What a watch there
    // would see instead is not measured, and this case claims nothing about
    // it. The two cases above are about the slug document, which the shell
    // never opens; neither is evidence about this.
    const shellCell = runtime.getCell(
      space,
      entityRefFromString(slugIdForSpace(space, "top")),
    );
    const slugDocument = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, "top")),
    );
    expect(shellCell.getAsNormalizedFullLink().id).not.toBe(
      slugDocument.getAsNormalizedFullLink().id,
    );
    expect(shellCell.getAsNormalizedFullLink().id).not.toBe(idOf(board));

    const other = await pieceDocument("board-2", { names: { "9": item2 } });

    let shellWoke = 0;
    const cancelShell = shellCell.sink(() => {
      shellWoke++;
    });
    // Two controls, because the two writes below reach different watchers. A
    // watch on the target catches a write inside it; a watch on the slug
    // document catches the slug being repointed. Each is read at the write it
    // controls and re-baselined afterwards, so no later write can satisfy an
    // earlier control — which is the whole job of a control here, since every
    // assertion about `shellCell` is that a count did NOT move and a write
    // that never landed would satisfy all of them.
    let targetWoke = 0;
    const cancelTarget = board.key("names").sink(() => {
      targetWoke++;
    });
    let documentWoke = 0;
    const cancelDocument = slugDocument.sink(() => {
      documentWoke++;
    });
    await runtime.idle();
    const shellAtSubscribe = shellWoke;
    let targetSince = targetWoke;
    let documentSince = documentWoke;

    // The instrument is plugged in: a sink calls back once with the current
    // value, so a count that never moves below is a watch that saw nothing
    // rather than a sink that was never opened.
    expect(shellAtSubscribe).toBeGreaterThan(0);

    // A write inside the target the slug points at, which is what the two
    // cases above show a watch on the slug document catching.
    await runtime.editWithRetry((tx) => {
      board.withTx(tx).key("names").key("3").set(item2);
    });
    await runtime.idle();
    expect(targetWoke).toBeGreaterThan(targetSince);
    expect(shellWoke).toBe(shellAtSubscribe);
    targetSince = targetWoke;
    documentSince = documentWoke;

    // Repointing the slug, which is what `cf piece new --force` does. The
    // slug document is the only thing this write touches, so the control for
    // it is the watch on that document.
    await pointSlug("top", other.key("names"));
    await runtime.idle();
    expect(documentWoke).toBeGreaterThan(documentSince);
    expect(shellWoke).toBe(shellAtSubscribe);

    cancelShell();
    cancelTarget();
    cancelDocument();
  });

  it("returns a refusal naming the member and the collection", async () => {
    // Data, not a throw: the error channel belongs to faults in asking, and
    // a caller has to tell "this name is not bound" from "ask again".
    expect(await resolve("top", "999")).toEqual({
      refusal: { code: "missing-member", message: "no member 999 in top" },
    });
  });

  it("throws a fault in asking rather than returning it as a refusal", async () => {
    // The separation this handler exists to make. A transport that dropped
    // or a document that will not decode says nothing about whether the name
    // is bound, and folding it into a refusal would tell a reader "no such
    // member" about a collection nobody managed to read.
    const processor = buildProcessor({
      cc: { getSpace: () => space },
      space,
      runtime: {
        getCellFromEntityId: () => {
          throw new Error("the socket went away");
        },
      },
    });
    await expect(
      processor.handleSlugResolve({
        type: RequestType.SlugResolve,
        space,
        slug: "top",
        member: "2",
      }),
    ).rejects.toThrow("the socket went away");
  });

  it("routes a slug reference request to the resolution", async () => {
    // The request type is declared in the enum, the union and the command
    // map, and every one of those can be right while the dispatch switch has
    // no arm for it — in which case the worker answers nothing and the shell
    // waits forever. Only driving the dispatcher proves the wiring.
    const processor = buildProcessor({
      cc: { getSpace: () => space },
      space,
      runtime,
    });
    const response = await processor.handleRequest({
      type: RequestType.SlugResolve,
      space,
      slug: "top",
      member: "2",
    });

    expect(response).toMatchObject({
      piece: {
        cell: {
          id: idOf(item2),
          space,
          scope: "space",
          path: [],
          cfcReferenceToken: expect.any(String),
        },
      },
      pathAfter: [],
    });
  });

  it("wakes a watch on the slug when the collection gains a member", async () => {
    // A sink on the slug document, which is what a caller opening the slug by
    // its id gets. The read set follows the redirect into the map, so a key
    // landing there wakes the watch with no write to the slug document at
    // all.
    //
    // This measures the slug document and nothing else. The cell the shell's
    // watch opens is a different cell, and the case below measures that one
    // separately — a reach shown here is not a reach the shell has.
    //
    // Every write the setup needs happens BEFORE the sink, so that the one
    // write after it is the collection update. A member document created
    // while the sink was live would be a second candidate for the wake, and
    // the count could not tell which of them caused it.
    const item3 = await pieceDocument("item-3", { title: "Kiln log" });
    const slugCell = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, "top")),
    );
    let woke = 0;
    const cancel = slugCell.sink(() => {
      woke++;
    });
    await runtime.idle();
    const atSubscribe = woke;

    // The only write from here to the assertion, and it touches the board's
    // document rather than the slug's.
    await runtime.editWithRetry((tx) => {
      board.withTx(tx).key("names").key("3").set(item3);
    });
    await runtime.idle();
    cancel();

    expect(woke).toBeGreaterThan(atSubscribe);
  });

  it("wakes a watch on the slug when a member it holds changes", async () => {
    // And a sink on the slug document does not stop at the map: a member the
    // map holds is read through it, so a change inside one wakes the watch
    // just as a key landing in the map does. Where it does stop is not
    // measured, so neither case claims it — and the same bound on the claim
    // holds: this is the slug document, not the cell the shell opens.
    const item3 = await pieceDocument("item-3", { title: "Kiln log" });
    await runtime.editWithRetry((tx) => {
      board.withTx(tx).key("names").key("3").set(item3);
    });
    const slugCell = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, "top")),
    );
    let woke = 0;
    const cancel = slugCell.sink(() => {
      woke++;
    });
    await runtime.idle();
    const atSubscribe = woke;

    await runtime.editWithRetry((tx) => {
      item3.withTx(tx).key("title").set("Kiln log, revised");
    });
    await runtime.idle();
    cancel();

    expect(woke).toBeGreaterThan(atSubscribe);
  });
});
