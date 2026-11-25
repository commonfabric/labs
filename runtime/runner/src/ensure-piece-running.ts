import { isKeyableObjectOrArray } from "@commonfabric/data-model";
import { getLogger } from "@commonfabric/logger";
import type { Cell } from "./cell.ts";
import {
  areNormalizedLinksSame,
  getMetaLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import { addressKey } from "./link-types.ts";
import { asPatternIdentityRef } from "./meta-seam.ts";
import {
  getPieceReconciliation,
  type PieceReconciliationReason,
} from "./piece-reconciliation.ts";
import type { RunnerStartOptions } from "./runner.ts";
import type { Runtime } from "./runtime.ts";
import { PieceStateMovedError } from "./stored-setup-build.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import { ignoreReadForScheduling } from "./storage/reactivity-log.ts";

const logger = getLogger("ensure-piece-running", {
  enabled: false,
  level: "debug",
});

/**
 * Warns where an open starts a piece without a piece its inputs come from
 * (`startWithInputSources()`), whose handlers then read what that source
 * derived last.
 */
const openLogger = getLogger("ensure-piece-running.open", {
  enabled: true,
  level: "warn",
});

const MAX_RESULT_LINK_DEPTH = 10;

/**
 * What `work` produces for each of `items`, started for all of them at once,
 * once every one has settled. The first failure in the order of `items` is
 * thrown, so nothing is left running past a failure and which one is
 * reported does not depend on timing.
 */
async function eachAtOnce<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const settled = await Promise.allSettled(
    items.map(async (item) => await work(item)),
  );
  return settled.map((outcome) => {
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  });
}

/**
 * Follows `result` backlinks from `rootCell` to the result document that
 * owns the chain, naming each document before its metadata is read: the
 * store delivers a backlink as data on the document that carries it, never
 * its target, so a replica reaches the next hop — and the pattern pointer
 * at the end — only by syncing it. Returns `undefined` on a cycle or past
 * `MAX_RESULT_LINK_DEPTH`.
 */
async function followResultCellChain(
  runtime: Runtime,
  rootCell: Cell<any>,
  tx: IExtendedStorageTransaction,
  observedDocIds: string[],
  observedDocs: OwningRootAddress[],
  signal?: AbortSignal,
): Promise<Cell<any> | undefined> {
  let currentCell = rootCell;
  const visited: NormalizedFullLink[] = [];
  let depth = 0;

  while (true) {
    const link = currentCell.getAsNormalizedFullLink();
    if (visited.some((previous) => areNormalizedLinksSame(previous, link))) {
      logger.debug("ensure-piece", () => [
        `Cycle found while following result metadata at ${currentCell.getAsNormalizedFullLink().id}`,
      ]);
      return undefined;
    }
    visited.push(link);
    const currentId = link.id;
    if (!observedDocIds.includes(currentId)) observedDocIds.push(currentId);
    observedDocs.push({ space: link.space, id: link.id, scope: link.scope });

    await currentCell.sync();
    signal?.throwIfAborted();
    const resultLink = getMetaLink(currentCell, "result");
    if (resultLink === undefined) return currentCell;

    if (depth >= MAX_RESULT_LINK_DEPTH) {
      logger.debug("ensure-piece", () => [
        `Exceeded result metadata traversal depth from ${rootCell.getAsNormalizedFullLink().id}`,
      ]);
      return undefined;
    }

    currentCell = runtime.getCellFromLink(resultLink, undefined, tx);
    depth++;
  }
}

/**
 * Starts the pieces that derive what the piece at `owner` takes as input: the
 * owning roots of the documents its stored argument links to, at any depth,
 * in `owner`'s space, other than `owner` and the roots in `visited`, that are
 * not already running. A nested pattern's instance links its inputs into the
 * instance enclosing it, so for one of those this starts the enclosing
 * instance, whose graph sets the nested one up as its child; a link to the
 * enclosing instance's own argument starts it too, for that reason, though
 * the input it names is current without it. Each source's own sources start
 * first, so an instance nested more than one level deep starts from the
 * outermost. The caller's `admitStart` and `originFollowed` are asked about
 * each source as about `owner`: a source the caller declines leaves `owner`
 * to start on its own, and a source whose follow is still owed is not
 * started, and its `origin-pending` verdict is returned so that `owner` waits
 * for the follow too, rather than run against what the source derived from
 * the source it had. Any other source that cannot start leaves `owner` to
 * start on its own, but an argument whose links cannot be read fails
 * `owner`'s start, as a chain of its own that cannot be read does: a handler
 * started without its sources reads what they derived last. Each source that
 * could not start, other than a linked document that is no piece's, is added
 * to `unstarted` with its verdict. With `EnsurePieceOptions.sourcesRequired`,
 * the first such source's verdict is returned instead, and an error starting a
 * source is thrown, wrapped to name the source unless it is an abort or a
 * `PieceStateMovedError`, so `owner` does not start without it.
 * `EnsurePieceOptions.onSourceRoot` is told of each source the walk finds,
 * running or not. `opened` says that `owner` is a root a caller named on its
 * own, which can carry a `result` backlink, rather than the end of a `result`
 * chain, which carries none.
 */
async function startInputSources(
  runtime: Runtime,
  owner: OwningRootAddress,
  options: EnsurePieceOptions | undefined,
  visited: Set<string>,
  unstarted?: { source: NormalizedFullLink; verdict: EnsurePieceVerdict }[],
  opened = false,
): Promise<EnsurePieceVerdict | undefined> {
  const signal = options?.signal;
  const required = options?.sourcesRequired === true;
  const sources = options?.enclosingSourcesOnly === true
    ? await enclosingPieceOf(runtime, owner, signal, opened)
    : await inputSourcesOf(runtime, owner, signal);
  for (const source of sources) {
    const key = rootKey(source);
    if (visited.has(key)) continue;
    visited.add(key);
    options?.onSourceRoot?.(source, owner);
    if (runtime.runner.isRunning(runtime.getCellFromLink(source))) continue;
    let verdict: EnsurePieceVerdict;
    try {
      verdict = await ensureVerdict(
        runtime,
        source,
        {
          startInputSources: true,
          ...(signal !== undefined && { signal }),
          ...(options?.admitStart !== undefined &&
            { admitStart: options.admitStart }),
          ...(options?.originFollowed !== undefined &&
            { originFollowed: options.originFollowed }),
          ...(options?.forEvent !== undefined &&
            { forEvent: options.forEvent }),
          ...(options?.enclosingSourcesOnly !== undefined &&
            { enclosingSourcesOnly: options.enclosingSourcesOnly }),
          ...(required && { sourcesRequired: true, propagateErrors: true }),
          ...(options?.onSourceRoot !== undefined &&
            { onSourceRoot: options.onSourceRoot }),
        },
        visited,
        unstarted,
      );
    } catch (error) {
      // Under `sourcesRequired`, say which piece's start failed. A refusal
      // keeps its own type, which names the refused piece, and an abort is
      // the caller's own.
      if (
        !required || signal?.aborted || error instanceof PieceStateMovedError
      ) {
        throw error;
      }
      throw new Error(
        `The start of ${source.id}, which the start of ${owner.id} requires, ` +
          "failed",
        { cause: error },
      );
    }
    signal?.throwIfAborted();
    if (verdict.started || verdict.reason === "no-pattern-meta") continue;
    if (required || verdict.reason === "origin-pending") {
      return { ...verdict, heldBy: verdict.heldBy ?? source };
    }
    unstarted?.push({ source, verdict });
  }
  return undefined;
}

/**
 * The owning roots, other than `owner`, of the documents in `owner`'s space
 * that `owner`'s stored argument links to, at any depth. Each argument and
 * derived document a setup writes carries a `result` backlink to the piece it
 * belongs to, which `followResultCellChain()` follows, once for each document
 * however many links name it. With `internalOnly`, a linked document that is
 * its own owning root, another piece's result root, is left out, and the
 * pieces each chain passes through on the way to its owning root are
 * included beside it. A linked document whose `result` chain cycles or runs
 * too deep names no source: it is no evidence of a piece the owner's inputs
 * come from.
 */
async function inputSourcesOf(
  runtime: Runtime,
  owner: OwningRootAddress,
  signal: AbortSignal | undefined,
  internalOnly = false,
): Promise<NormalizedFullLink[]> {
  const tx = runtime.edit();
  tx.tx.immediate = true;
  try {
    const argumentLink = getMetaLink(
      runtime.getCellFromLink({ ...owner, path: [] }, undefined, tx),
      "argument",
    );
    if (argumentLink === undefined) return [];
    const argument = runtime.getCellFromLink(argumentLink, undefined, tx);
    await argument.sync();
    signal?.throwIfAborted();
    const ownerKey = rootKey(owner);
    const followed = new Set([ownerKey, rootKey(argumentLink)]);
    const documents: { link: NormalizedFullLink; document: string }[] = [];
    for (const link of linksIn(argument.getRaw(), argument)) {
      if (link.space !== owner.space) continue;
      const document = rootKey(link);
      if (followed.has(document)) continue;
      followed.add(document);
      documents.push({ link, document });
    }
    // Each hop of a chain is a load, so the chains are followed at once, and
    // their ends are taken in the order the argument names the documents.
    const chains = await eachAtOnce(documents, async ({ link, document }) => {
      const chain: OwningRootAddress[] = [];
      const root = await followResultCellChain(
        runtime,
        runtime.getCellFromLink({ ...link, path: [] }, undefined, tx),
        tx,
        [],
        chain,
        signal,
      );
      return { document, chain, root };
    });
    const sources = new Map<string, NormalizedFullLink>();
    for (const { document, chain, root } of chains) {
      if (root === undefined) continue;
      const source = root.getAsNormalizedFullLink();
      const key = rootKey(source);
      if (internalOnly && key === document) continue;
      if (!internalOnly) {
        if (key !== ownerKey) sources.set(key, { ...source, path: [] });
        continue;
      }
      // Each piece the chain passes through on its way to its owning root is
      // a candidate too: a piece a list builtin builds carries a `result`
      // backlink to the piece that built it.
      for (const visited of chain.slice(1)) {
        const visitedKey = rootKey(visited);
        if (visitedKey === ownerKey) continue;
        const cell = runtime.getCellFromLink(
          { ...visited, path: [] },
          undefined,
          tx,
        );
        if (asPatternIdentityRef(cell.getMetaRaw("patternIdentity"))) {
          sources.set(visitedKey, { ...visited, path: [] });
        }
      }
    }
    return [...sources.values()];
  } finally {
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
  }
}

/**
 * Helper for `startInputSources()`, which returns the piece that encloses the
 * piece at `owner`, as a list of that one piece, or an empty list where no
 * piece does. With `opened`, a root carrying a `result` backlink names it
 * outright ({@link builderOf}); any other `owner` is the end of its `result`
 * chain, so it carries none. Otherwise the enclosing piece is the one
 * recording `owner` as the output of a nested node of its own graph
 * ({@link enclosesAsNested}), among the pieces whose argument or internal
 * documents `owner`'s argument links into (`inputSourcesOf()`), each asked at
 * once; a link to another piece's result root names no candidate, so the
 * producers a piece is wired to are not asked.
 */
async function enclosingPieceOf(
  runtime: Runtime,
  owner: OwningRootAddress,
  signal: AbortSignal | undefined,
  opened: boolean,
): Promise<NormalizedFullLink[]> {
  if (opened) {
    const builder = await builderOf(runtime, owner, signal);
    if (builder !== undefined) return [builder];
  }
  // TODO(danfuzz): Find the piece whose handler made `owner` as well, once a
  // child a handler made records its maker where this can read it; until then
  // such a child starts without its maker, and its handlers read inputs
  // nothing in the runtime derives. `space-server-enclosing-start.test.ts`
  // pins it.
  const candidates = await inputSourcesOf(runtime, owner, signal, true);
  const encloses = await eachAtOnce(candidates, async (candidate) => {
    const tx = runtime.edit();
    tx.tx.immediate = true;
    try {
      return await enclosesAsNested(runtime, candidate, owner, tx, signal);
    } finally {
      runtime.prepareTxForCommit(tx);
      await tx.commit().settled;
    }
  });
  const found = candidates.find((_, index) => encloses[index]);
  return found === undefined ? [] : [found];
}

/**
 * Helper for `enclosingPieceOf()`, which returns the piece that built the
 * piece at `owner`, where `owner`'s root carries a `result` backlink, as each
 * instance a list builtin builds for an element carries one to the piece
 * whose graph holds the builtin: the first piece the backlink chain reaches.
 * `undefined` where the root carries no backlink, or its chain cycles, runs
 * too deep or reaches no piece.
 */
async function builderOf(
  runtime: Runtime,
  owner: OwningRootAddress,
  signal: AbortSignal | undefined,
): Promise<NormalizedFullLink | undefined> {
  const tx = runtime.edit();
  tx.tx.immediate = true;
  try {
    const chain: OwningRootAddress[] = [];
    const end = await followResultCellChain(
      runtime,
      runtime.getCellFromLink({ ...owner, path: [] }, undefined, tx),
      tx,
      [],
      chain,
      signal,
    );
    if (end === undefined) return undefined;
    // The chain starts at `owner`, and each document on it has been loaded.
    const builder = chain.slice(1).find((visited) =>
      asPatternIdentityRef(
        runtime.getCellFromLink({ ...visited, path: [] }, undefined, tx)
          .getMetaRaw("patternIdentity"),
      )
    );
    return builder === undefined ? undefined : { ...builder, path: [] };
  } finally {
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
  }
}

/**
 * Helper for `enclosingPieceOf()`, which indicates whether the piece at
 * `candidate` records the piece at `owner` as the output of a nested node of
 * its own graph: one of its `internal` documents holds, as its whole value, a
 * link to `owner`'s root. A match compares documents by `rootKey()`, so the
 * scope counts too.
 */
async function enclosesAsNested(
  runtime: Runtime,
  candidate: NormalizedFullLink,
  owner: OwningRootAddress,
  tx: IExtendedStorageTransaction,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const root = runtime.getCellFromLink(candidate, undefined, tx);
  await root.sync();
  signal?.throwIfAborted();
  const internal = root.getMetaRaw("internal");
  if (!Array.isArray(internal)) return false;
  const ownerKey = rootKey(owner);
  const namesOwner = (link: NormalizedFullLink | undefined) =>
    link !== undefined && link.path.length === 0 && rootKey(link) === ownerKey;
  const links = internal.flatMap((entry) => {
    const link = isKeyableObjectOrArray(entry)
      ? parseLink((entry as { link?: unknown }).link, root)
      : undefined;
    return link === undefined || link.space !== owner.space ? [] : [link];
  });
  // A piece's internal documents include whatever its graph derives, which
  // can be large, so they load at once rather than one after another.
  const held = await eachAtOnce(links, async (link) => {
    const document = runtime.getCellFromLink(
      { ...link, path: [] },
      undefined,
      tx,
    );
    await document.sync();
    signal?.throwIfAborted();
    return parseLink(document.getRaw(), document);
  });
  return held.some(namesOwner);
}

/**
 * Every link `value` holds, at any depth. A link is taken whole rather than
 * walked into, since what it names is another document.
 */
function linksIn(value: unknown, base: Cell<any>): NormalizedFullLink[] {
  const link = parseLink(value, base);
  if (link !== undefined) return [link];
  if (!isKeyableObjectOrArray(value)) return [];
  return Object.values(value).flatMap((member) => linksIn(member, base));
}

/**
 * The key a document is known by while starting input sources: its space,
 * id and scope, since a `result` backlink can cross into the same id in
 * another scope, which is another document.
 */
function rootKey(address: OwningRootAddress): string {
  return addressKey({ ...address, path: [] });
}

/** A pattern update a piece refused, as `refusedUpdateOf()` reports it. */
export type RefusedUpdate = {
  /** The pattern the piece's origin offered. */
  offered: { identity: string; symbol: string };

  /** Why the piece refused it, when its record says. */
  reason?: PieceReconciliationReason;
};

/**
 * The pattern update a piece's origin last offered and the piece refused, as
 * its reconciliation record (`piece-reconciliation.ts`) names it, while the
 * piece runs some other program; `undefined` when the record says no such
 * thing. `piece` is the instance the start walk synced, so the reads load
 * nothing, and each runs in a read transaction of its own, so neither joins
 * a caller's transaction.
 */
function refusedUpdateOf(piece: Cell<any>): RefusedUpdate | undefined {
  const record = getPieceReconciliation(piece);
  if (record?.outcome !== "refused" || record.offered === undefined) {
    return undefined;
  }
  const running = asPatternIdentityRef(
    piece.getMetaRaw("patternIdentity", { meta: ignoreReadForScheduling }),
  );
  if (
    running?.identity === record.offered.identity &&
    running.symbol === record.offered.symbol
  ) {
    return undefined;
  }
  return {
    offered: record.offered,
    ...(record.reason !== undefined && { reason: record.reason }),
  };
}

/**
 * The address of the result document a chain resolved to — the one whose
 * `patternIdentity` decides the verdict.
 *
 * The scope and space travel with the id because a `result` backlink may
 * cross either, so the document is not always addressable from the scope the
 * traversal started in. A caller that reads that pattern pointer anywhere
 * else — against the store the replica syncs from, say — addresses it from
 * here.
 */
export type OwningRootAddress = Pick<
  NormalizedFullLink,
  "space" | "id" | "scope"
>;

/**
 * A classified `ensurePieceRunning` outcome (server-execution v2 stage
 * P2-F): the serving loop's demand cycle needs to tell a doc that is
 * LOADED but carries no pattern meta (the OW19 terminal class —
 * terminal-on-loaded-doc-without-pattern-meta, re-armed by a commit
 * touching an observed doc) from the other not-startable shapes, and
 * needs the resolved OWNING root so the per-(action × instance) run
 * supply can map a demanded argument/derived doc to its piece's actions.
 */
export type EnsurePieceVerdict = {
  /** The owning piece is (now) running. */
  started: boolean;

  /** Why a `started: false` verdict could not start the piece. Where a piece
   * the owning piece's inputs come from held it back (`heldBy`), each reason
   * is that piece's, and names what that piece's own chain, meta, pattern or
   * caller did. */
  reason?:

    /** Result-metadata cycle, or traversal depth exceeded. */
    | "chain-cycle"
    /** The chain's owning doc, named before it was read, carries no
     * `patternIdentity` meta at the scope the chain was walked in. A
     * scoped instance can read meta-less while the space instance holds
     * the pointer. The serving caller tries the requested scope, then
     * falls back to space scope; confirmation repeats that order. */
    | "no-pattern-meta"
    /** Meta present but `loadPatternByIdentity` found nothing. */
    | "pattern-unloadable"
    /** The caller's `admitStart` declined to start the owning piece. */
    | "start-declined"
    /** The caller's `originFollowed` has not yet followed the origin of the
     * owning piece, or of a piece its inputs come from
     * (`startInputSources()`); the caller starts the piece once it has. */
    | "origin-pending";

  /** Whether the started piece has a pattern graph installed AT THE
   * MOMENT THIS IS CALLED. `started` reports what the start walk did,
   * and the instantiation commit that walk fires settles after it
   * returns: a refused commit retires the graph while the registration
   * stands. A caller acting on `started` later asks this instead of
   * assuming. Present whenever a start ran. */
  graphIsInstalled?: () => boolean;

  /**
   * The pattern update the started piece last refused while it runs another
   * program, read from its reconciliation record AT THE MOMENT THIS IS CALLED
   * (`refusedUpdateOf()`), or `undefined` when it refused none. It says why
   * the piece can lack what the offered program has. Present whenever a start
   * ran.
   */
  refusedUpdate?: () => RefusedUpdate | undefined;

  /** The owning result doc (the chain terminus) where the chain
   * resolved — present for `started`, `no-pattern-meta`,
   * `pattern-unloadable`, `start-declined`, and `origin-pending`, and for any
   * reason a piece named in `heldBy` gave. */
  root?: OwningRootAddress;

  /** The content identity of the pattern a `pattern-unloadable` verdict
   * could not load. */
  patternIdentity?: string;

  /** The root of the piece whose own verdict this is, where a piece the
   * owning piece's inputs come from held the owning piece back
   * (`startInputSources()`): `reason` and `patternIdentity` are that piece's. */
  heldBy?: OwningRootAddress;

  /** Every doc id the traversal read (the demanded root plus chain
   * links): the demand cycle's commit-triggered re-arm watches these. */
  observedDocIds: string[];

  /** Every doc the traversal read, as `observedDocIds` names them but with
   * the space and scope that tell same-ID docs apart. */
  observedDocs: OwningRootAddress[];
};

/** Options of {@link ensurePieceRunningVerdict}. */
export type EnsurePieceOptions = {
  /**
   * Rethrow instead of collapsing every exception into a verdict. The
   * serving loop's demand cycle must distinguish a deferral from an actual
   * load or start failure; the default stays best-effort for the
   * event-recovery caller.
   */
  propagateErrors?: boolean;

  /** Aborting it stops the traversal at its next asynchronous boundary. */
  signal?: AbortSignal;

  /**
   * Called with the owning piece root's address once the chain from
   * `cellLink` has resolved to it, before the piece is started. A caller that
   * supplies a started piece's runs by what was demanded records the mapping
   * here, so a run the start releases at once already finds it.
   */
  onOwningRoot?: (root: OwningRootAddress) => void;

  /**
   * Asked, after `onOwningRoot`, whether to start the owning piece at all.
   * `false` ends the walk with the `start-declined` verdict, the root and
   * the documents read so far. A caller that knows a start of this piece
   * would fail the way its last one did declines it here, rather than start
   * it again to learn the same.
   */
  admitStart?: (root: OwningRootAddress) => boolean;

  /**
   * Asked, after `admitStart` and only for a piece that records an origin,
   * whether that origin has been followed, where a client's open of the
   * piece follows it: the origin resolved and its current source adopted,
   * so the pattern loaded next is the one the piece should now run. `false` ends the walk with the
   * `origin-pending` verdict and the root; the caller is following the origin
   * and asks for the start again once it has. Asked only for a piece that is
   * not running; a running piece was followed when it started, and the
   * runtime's watcher swaps its pattern from there. Asked for the pieces
   * the owning piece's inputs come from too, where `startInputSources` starts
   * them, with the same consequence. A serving runtime asks this before its
   * first start of a piece in a tenure, since nothing else opens the pieces
   * it serves, and follows the origin between waves, where the adopting write
   * can commit (serving-loop.md §3e).
   */
  originFollowed?: (root: OwningRootAddress) => boolean;

  /**
   * Start the pieces the owning piece's inputs come from before the owning
   * piece itself (`startInputSources()`), and leave the owning piece to one
   * of them when its graph sets it up as a child. An event's auto-load asks
   * for this wherever the runtime's run of the handler is the one that
   * counts: a stream a nested pattern defines belongs to the nested
   * instance, whose inputs the instance enclosing it derives, and a nested
   * instance started on its own runs its handlers against inputs nothing in
   * the runtime derives.
   */
  startInputSources?: boolean;

  /**
   * With `startInputSources`, start only the pieces that ENCLOSE the owning
   * piece, the instances whose graphs set it up as a nested node, and theirs in
   * turn, not every piece whose output its argument links to. An instance a
   * list builtin (`map`, `filter`, `flatMap`) builds for an element carries a
   * `result` backlink on its root to the piece whose graph holds the builtin.
   * An open of such an instance (`startWithInputSources()`) takes the first
   * piece that backlink chain reaches as the enclosing one; a walk from a
   * link starts at the end of the link's `result` chain, past the instance. A
   * nested node's root stores no pointer to its enclosing
   * instance; what the runtime stores is the other direction. Setup records
   * each nested node's output among the enclosing instance's `internal`
   * documents, as a document whose whole value is a link to the nested
   * instance's root. So for a root without a backlink, the walk looks for the
   * piece that records the owning piece that way among the pieces whose
   * argument or internal documents the owning piece's argument links into,
   * counting each piece a `result` backlink chain passes through on the way to
   * its owning root, and starts that one piece; the walk then does the same
   * for it. A link to a piece's result root names no candidate, so the
   * producers a piece is wired to are not asked. A child a handler made is held
   * behind a value-link slot, never named that way, so its creator is left to
   * the event path, as is a piece wired to another's output, and the owner of
   * any other document the argument links into. Found this way: a named nested
   * node, an `ifElse` branch, a pattern returning a nested instance's result
   * whole, nested instances fed by a sibling under one parent, the instance a
   * list builtin builds for an element, an instance nested in one, which finds
   * the element's instance as a backlink chain passes through it, and the
   * suggestion surface a free-form wish builds where the wish's `context`
   * links into the wishing piece, since the wish node's output records the
   * surface as a nested node's output is recorded. Not found: a nested
   * instance whose argument links into its enclosing instance only at that
   * instance's result root, or not at all. A pattern that itself stores a link
   * straight to a piece's root as the whole value of a document it owns reads
   * as enclosing that piece. Where no enclosing piece is found, the owning
   * piece starts alone, and silently: a piece nothing encloses and one whose
   * enclosing piece is not found look the same to the walk.
   */
  enclosingSourcesOnly?: boolean;

  /**
   * With `startInputSources`, a piece the owning piece's inputs come from that
   * does not start holds the owning piece back: the walk returns that piece's
   * verdict as the owning piece's, naming it in `heldBy`, and an error starting
   * it is thrown as `propagateErrors` throws the owning piece's own, wrapped in
   * an error naming that piece unless it is an abort or a
   * `PieceStateMovedError`, rather than leaving the owning piece to start
   * without it. A caller that retries,
   * parks and reports an owning piece that cannot start asks for this, so that
   * a source's failure is retried, parked and reported the same way. A linked
   * document that is no piece's is passed over either way.
   */
  sourcesRequired?: boolean;

  /**
   * With `startInputSources`, called with the root of each piece the walk
   * finds a piece's inputs come from, and that piece's root as `owner`: the
   * owning piece's own sources, then theirs in turn. Called before the source
   * is asked about, whether or not it runs already. A piece found running
   * ends the walk there, so the pieces beyond it are not reported, and a walk
   * runs only for an owning piece that is not running.
   */
  onSourceRoot?: (root: OwningRootAddress, owner: OwningRootAddress) => void;

  /**
   * The walk delivers an event, so each piece it starts, the pieces its
   * inputs come from included, is started as one
   * (`RunnerStartOptions.forEvent`).
   */
  forEvent?: boolean;
};

/**
 * Classified variant of {@link ensurePieceRunning} — same traversal and
 * start, richer outcome. {@link EnsurePieceOptions} says what a caller may
 * ask of it. An aborted `signal` stops the traversal at its next
 * asynchronous boundary and prevents a later piece start.
 */
export function ensurePieceRunningVerdict(
  runtime: Runtime,
  cellLink: NormalizedFullLink,
  options?: EnsurePieceOptions,
): Promise<EnsurePieceVerdict> {
  return ensureVerdict(runtime, cellLink, options, new Set());
}

/**
 * {@link ensurePieceRunningVerdict} for a piece reached while starting input
 * sources: `visited` holds the owning roots already asked about on the way,
 * by `rootKey()`, which `startInputSources()` skips, so pieces linked to each
 * other's outputs end the walk rather than loop. Each source the walk from
 * this piece could not start, at any depth, is added to `unstarted`
 * (`startInputSources()`).
 */
async function ensureVerdict(
  runtime: Runtime,
  cellLink: NormalizedFullLink,
  options: EnsurePieceOptions | undefined,
  visited: Set<string>,
  unstarted?: { source: NormalizedFullLink; verdict: EnsurePieceVerdict }[],
): Promise<EnsurePieceVerdict> {
  const observedDocIds: string[] = [];
  const observedDocs: OwningRootAddress[] = [];
  const signal = options?.signal;
  try {
    signal?.throwIfAborted();
    const tx = runtime.edit();
    tx.tx.immediate = true;

    try {
      // Get the cell at the event link location
      const rootCell: Cell<any> = runtime.getCellFromLink(
        // We'll find the piece information at the root of what could be the
        // owning result cell already, hence remove the path:
        { ...cellLink, path: [] },
        undefined,
        tx,
      );

      // If this is an internal/argument/derived cell, find the result cell that
      // owns the chain.
      const resultCell = await followResultCellChain(
        runtime,
        rootCell,
        tx,
        observedDocIds,
        observedDocs,
        signal,
      );
      signal?.throwIfAborted();
      if (resultCell === undefined) {
        return {
          started: false,
          reason: "chain-cycle",
          observedDocIds,
          observedDocs,
        };
      }
      const { space, id: rootId, scope } = resultCell
        .getAsNormalizedFullLink();
      const root: OwningRootAddress = { space, id: rootId, scope };

      // If rootCell is a result cell, it will carry a `{ identity, symbol }`
      // pattern pointer.
      const identityRef = asPatternIdentityRef(
        resultCell.getMetaRaw("patternIdentity"),
      );
      if (!identityRef) {
        logger.debug("ensure-piece", () => [
          `No pattern identity found in result metadata`,
        ]);
        return {
          started: false,
          reason: "no-pattern-meta",
          root,
          observedDocIds,
          observedDocs,
        };
      }

      // Commit the read transaction before starting the piece
      runtime.prepareTxForCommit(tx);
      await tx.commit().settled;
      signal?.throwIfAborted();

      // The owning root is known before the piece runs: a caller keying
      // per-instance run supply on it records the mapping here, so the
      // first run the start releases already finds it.
      options?.onOwningRoot?.(root);

      if (options?.admitStart?.(root) === false) {
        return {
          started: false,
          reason: "start-declined",
          root,
          observedDocIds,
          observedDocs,
        };
      }

      // A piece that records no origin follows nothing, so its start owes
      // the caller no follow.
      if (
        options?.originFollowed !== undefined &&
        !runtime.runner.isRunning(resultCell) &&
        typeof resultCell.getMetaRaw("patternSource") === "string" &&
        !options.originFollowed(root)
      ) {
        return {
          started: false,
          reason: "origin-pending",
          root,
          observedDocIds,
          observedDocs,
        };
      }

      // Load the pattern by its content identity.
      const pattern = await runtime.patternManager.loadPatternByIdentity(
        identityRef.identity,
        identityRef.symbol,
        cellLink.space,
      );
      signal?.throwIfAborted();

      if (!pattern) {
        logger.debug("ensure-piece", () => [
          `Failed to load pattern: ${identityRef.identity}#${identityRef.symbol}`,
        ]);
        return {
          started: false,
          reason: "pattern-unloadable",
          patternIdentity: identityRef.identity,
          root,
          observedDocIds,
          observedDocs,
        };
      }

      logger.debug("ensure-piece", () => [
        `Starting piece with pattern ${identityRef.identity} for result cell ${resultCell.getAsNormalizedFullLink().id}`,
      ]);

      if (
        options?.startInputSources === true &&
        !runtime.runner.isRunning(resultCell)
      ) {
        visited.add(rootKey(root));
        const pending = await startInputSources(
          runtime,
          root,
          options,
          visited,
          unstarted,
        );
        signal?.throwIfAborted();
        // A source still owed its follow holds this piece back with it, as
        // any source that did not start does under `sourcesRequired`; the
        // caller asks again once the follow has run, or as it retries this
        // piece for the same reason, and the re-arm watches what the source's
        // chain read as well as this one's.
        if (pending !== undefined) {
          return {
            started: false,
            ...(pending.reason !== undefined && { reason: pending.reason }),
            ...(pending.patternIdentity !== undefined &&
              { patternIdentity: pending.patternIdentity }),
            ...(pending.heldBy !== undefined && { heldBy: pending.heldBy }),
            root,
            observedDocIds: [...observedDocIds, ...pending.observedDocIds],
            observedDocs: [...observedDocs, ...pending.observedDocs],
          };
        }
        // A source whose graph sets this piece up as its child has started
        // it there, which is how it runs when a client opens the source.
        // Starting it again here would give it a lifetime of its own.
        if (runtime.runner.isRunning(resultCell)) {
          return {
            started: true,
            graphIsInstalled: () =>
              runtime.runner.pieceGraphIsInstalled(resultCell),
            refusedUpdate: () => refusedUpdateOf(resultCell),
            root,
            observedDocIds,
            observedDocs,
          };
        }
      }

      // Start the existing piece - this registers event handlers without
      // re-running setup and potentially allocating different metadata cells.
      await runtime.start(resultCell, { forEvent: options?.forEvent });

      logger.debug("ensure-piece", () => [
        `Piece started successfully`,
      ]);

      return {
        started: true,
        graphIsInstalled: () =>
          runtime.runner.pieceGraphIsInstalled(resultCell),
        refusedUpdate: () => refusedUpdateOf(resultCell),
        root,
        observedDocIds,
        observedDocs,
      };
    } catch (error) {
      if (signal?.aborted) {
        tx.abort(signal.reason);
        throw error;
      }
      // Make sure to commit/rollback the transaction on error
      try {
        runtime.prepareTxForCommit(tx);
        await tx.commit().settled;
      } catch {
        // Ignore commit errors on cleanup
      }
      throw error;
    }
  } catch (error) {
    if (options?.propagateErrors === true) throw error;
    logger.error("ensure-piece", "Error ensuring piece is running:", error);
    return { started: false, observedDocIds, observedDocs };
  }
}

/**
 * Indicates whether `runtime`'s run of a handler is the one that counts: a
 * serving runtime's, or any runtime's with server execution off. A client
 * under server execution runs a handler only as its speculative echo, which
 * the served run replaces, and leaves the pieces upstream of a piece it
 * starts, and the documents they read, to the server.
 */
export function handlerRunCounts(runtime: Runtime): boolean {
  return runtime.experimental.serverExecution !== true ||
    runtime.servingPosture;
}

/** Options of {@link startWithInputSources}. */
export type StartWithInputSourcesOptions = {
  /**
   * Follow the origin of each enclosing piece before starting it, as an open
   * that reconciles the opened piece follows that piece's
   * (`SourceReconciler.reconcile()`), so that neither runs source its origin
   * has replaced. A follow that fails leaves the enclosing piece to start on
   * what it has, as it leaves an opened piece.
   */
  followOrigins?: boolean;

  /**
   * Start the piece with `Runtime.startWithCommit()`, which also waits for
   * the commit of the setup writes of the graph the start instantiates.
   */
  awaitSetupCommit?: boolean;
};

/**
 * Starts `piece`, a piece a caller names on its own, as a client's open does,
 * and starts the pieces that enclose it before `piece` is instantiated, where
 * `runtime`'s run of its handlers is the one that counts
 * ({@link handlerRunCounts}): the instance whose graph sets `piece` up as a
 * nested one, and that instance's own enclosing instance, and so on
 * (`EnsurePieceOptions.enclosingSourcesOnly`). A nested instance started on its
 * own runs its handlers against inputs nothing in the runtime derives, and once
 * it runs, no later event starts what encloses it. A piece whose output
 * `piece`'s argument links to is not started here; an event's auto-load of a
 * piece that is not running starts it. `piece` is started whether or not an
 * enclosing piece's graph set it up as its child, so the opened piece has a
 * lifetime of its own: an enclosing piece that stops or re-instantiates leaves
 * it running, as it leaves a piece opened before what encloses it. Each
 * enclosing piece this starts is started in its own right too, and runs until
 * it is stopped itself or the runtime ends, outliving the opened piece, as a
 * piece an event's auto-load starts does.
 *
 * `piece`'s start begins at once, and loads what it needs while the search
 * for the enclosing pieces runs; it instantiates `piece` once the search is
 * done (`RunnerStartOptions.instantiateAfter`). This returns once both are
 * done.
 *
 * Starting what encloses `piece` is best effort. An enclosing piece that
 * cannot start, one whose origin's follow cannot be settled, and an argument
 * whose links cannot be read each leave `piece` to start without it, so an
 * open fails only where the piece's own start does; each is logged as a
 * warning naming the opened piece. Where `runtime`'s runs echo the served
 * ones, or `piece` runs already, this only starts `piece`.
 *
 * @returns What `Runtime.start()` returns, or `Runtime.startWithCommit()` with
 *   `awaitSetupCommit`.
 */
export async function startWithInputSources(
  runtime: Runtime,
  piece: Cell<any>,
  options: StartWithInputSourcesOptions = {},
): Promise<boolean> {
  const start = (startOptions?: RunnerStartOptions) =>
    options.awaitSetupCommit === true
      ? runtime.startWithCommit(piece, startOptions)
      : runtime.start(piece, startOptions);
  if (!handlerRunCounts(runtime) || runtime.runner.isRunning(piece)) {
    return await start();
  }
  const { space, id, scope } = piece.getAsNormalizedFullLink();
  const enclosing = startEnclosingFollowingOrigins(
    runtime,
    { space, id, scope },
    options,
  ).catch((error) => {
    openLogger.warn("input-sources", () => [
      `Opened ${id} without the pieces that enclose it, whose links ` +
      `could not be read; its handlers read what those derived last:`,
      error,
    ]);
  });
  try {
    return await start({ instantiateAfter: enclosing });
  } finally {
    await enclosing;
  }
}

/**
 * Helper for {@link startWithInputSources}, which starts the pieces that
 * enclose the piece at `root`. With `followOrigins`, the walk asks whether
 * each enclosing piece's origin has been followed, at any depth; every piece
 * it was told no for is followed, and the walk is made again, until a walk
 * names no piece not followed yet.
 */
async function startEnclosingFollowingOrigins(
  runtime: Runtime,
  root: OwningRootAddress,
  { followOrigins = false }: StartWithInputSourcesOptions,
): Promise<void> {
  const followed = new Map<string, OwningRootAddress>();
  let owed: OwningRootAddress[] = [];
  const originFollowed = followOrigins
    ? (source: OwningRootAddress) => {
      if (followed.has(rootKey(source))) return true;
      owed.push(source);
      return false;
    }
    : undefined;
  while (true) {
    owed = [];
    const unstarted: {
      source: NormalizedFullLink;
      verdict: EnsurePieceVerdict;
    }[] = [];
    const pending = await startInputSources(
      runtime,
      root,
      {
        startInputSources: true,
        enclosingSourcesOnly: true,
        ...(originFollowed !== undefined && { originFollowed }),
      },
      new Set([rootKey(root)]),
      unstarted,
      true,
    );
    for (const { source, verdict } of unstarted) {
      openLogger.warn("input-sources", () => [
        `Opened ${root.id} without ${source.id}, a piece that encloses it, ` +
        `which could not start (${verdict.reason ?? "failed"}); its ` +
        `handlers read what ${source.id} derived last.`,
      ]);
    }
    if (pending === undefined) return;
    const toFollow = owed.filter((source) => !followed.has(rootKey(source)));
    if (toFollow.length === 0) {
      openLogger.warn("input-sources", () => [
        `Opened ${root.id} without ${pending.root?.id ?? "a piece"} that ` +
        `encloses it, whose origin's follow could not be settled; its ` +
        `handlers read what that piece derived last.`,
      ]);
      return;
    }
    for (const source of toFollow) {
      followed.set(rootKey(source), source);
      // The reconciler reads the piece's pattern pointer and origin off the
      // loaded document, as the serving loop's follow does.
      const cell = runtime.getCellFromLink({ ...source, path: [] });
      await cell.sync();
      await runtime.sourceReconciler.reconcile(cell);
    }
  }
}

/**
 * Ensures the piece responsible for a given storage location is running.
 *
 * Note: We don't track which pieces we've already started because starting an
 * already-running piece is a no-op: this calls `runtime.start()`, which returns
 * as soon as it finds the piece already registered, without running setup. It
 * therefore neither re-materializes metadata nor re-validates the stored
 * argument — a piece whose `patternSetupIdentity` names another version is not
 * repaired through this route, only through one that reaches setup. This keeps
 * the code simple and stateless.
 *
 * This function follows result metadata from argument or derived internal cells
 * back to the root result cell, then starts the piece if it's not already
 * running.
 *
 * The traversal logic:
 * 1. Start with the cell at the cellLink location
 * 2. Follow result metadata until it reaches the owning result cell
 * 3. Read the owning result cell's pattern metadata
 * 4. Start the existing owning result cell
 *
 * @param runtime - The runtime instance
 * @param cellLink - The location that received an event or should be current
 * @param options - `propagateErrors` RETHROWS instead of collapsing every
 *   exception into `false` (review thread r3739139521): the serving loop's
 *   demand cycle must distinguish a creation-race DEFERRAL (`false` — retry
 *   next cycle) from an actual load/start FAILURE (throw — counted
 *   `structureLoadFailures`); with the collapse, its failure arm was
 *   unreachable and real errors retried silently every input-driven cycle.
 *   Default stays best-effort for the event-recovery caller.
 * @returns Promise<boolean> - true if a piece was started, false otherwise
 */
export async function ensurePieceRunning(
  runtime: Runtime,
  cellLink: NormalizedFullLink,
  options?: { propagateErrors?: boolean },
): Promise<boolean> {
  return (await ensurePieceRunningVerdict(runtime, cellLink, options)).started;
}
