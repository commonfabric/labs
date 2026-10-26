import { isKeyableObjectOrArray } from "@commonfabric/data-model";
import { getLogger } from "@commonfabric/utils/logger";
import type { Cell } from "./cell.ts";
import {
  areNormalizedLinksSame,
  getMetaLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import { addressKey } from "./link-types.ts";
import { asPatternIdentityRef } from "./meta-seam.ts";
import type { Runtime } from "./runtime.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

const logger = getLogger("ensure-piece-running", {
  enabled: false,
  level: "debug",
});

const MAX_RESULT_LINK_DEPTH = 10;

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
 * outermost. A source that cannot start leaves `owner` to start on its own,
 * but an argument whose links cannot be read fails `owner`'s start, as a
 * chain of its own that cannot be read does: a handler started without its
 * sources reads what they derived last.
 */
async function startInputSources(
  runtime: Runtime,
  owner: OwningRootAddress,
  signal: AbortSignal | undefined,
  visited: Set<string>,
): Promise<void> {
  const sources = await inputSourcesOf(runtime, owner, signal);
  for (const source of sources) {
    const key = rootKey(source);
    if (visited.has(key)) continue;
    visited.add(key);
    if (runtime.runner.isRunning(runtime.getCellFromLink(source))) continue;
    // A source that cannot start leaves `owner` to start on its own.
    await ensureVerdict(
      runtime,
      source,
      { startInputSources: true, signal },
      visited,
    );
    signal?.throwIfAborted();
  }
}

/**
 * The owning roots, other than `owner`, of the documents in `owner`'s space
 * that `owner`'s stored argument links to, at any depth. Each argument and
 * derived document a setup writes carries a `result` backlink to the piece it
 * belongs to, which `followResultCellChain()` follows, once for each document
 * however many links name it.
 */
async function inputSourcesOf(
  runtime: Runtime,
  owner: OwningRootAddress,
  signal: AbortSignal | undefined,
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
    const sources = new Map<string, NormalizedFullLink>();
    for (const link of linksIn(argument.getRaw(), argument)) {
      if (link.space !== owner.space) continue;
      const document = rootKey(link);
      if (followed.has(document)) continue;
      followed.add(document);
      const root = await followResultCellChain(
        runtime,
        runtime.getCellFromLink({ ...link, path: [] }, undefined, tx),
        tx,
        [],
        [],
        signal,
      );
      signal?.throwIfAborted();
      if (root === undefined) continue;
      const source = root.getAsNormalizedFullLink();
      const key = rootKey(source);
      if (key !== ownerKey) sources.set(key, { ...source, path: [] });
    }
    return [...sources.values()];
  } finally {
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
  }
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

  /** Why a `started: false` verdict could not start the piece. */
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
    | "pattern-unloadable";

  /** Whether the started piece has a pattern graph installed AT THE
   * MOMENT THIS IS CALLED. `started` reports what the start walk did,
   * and the instantiation commit that walk fires settles after it
   * returns: a refused commit retires the graph while the registration
   * stands. A caller acting on `started` later asks this instead of
   * assuming. Present whenever a start ran. */
  graphIsInstalled?: () => boolean;

  /** The owning result doc (the chain terminus) where the chain
   * resolved — present for `started`, `no-pattern-meta`, and
   * `pattern-unloadable`. */
  root?: OwningRootAddress;

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
   * Called with the owning piece root's id once the chain from `cellLink`
   * has resolved to it, before the piece is started. A caller that supplies
   * a started piece's runs by what was demanded records the mapping here,
   * so a run the start releases at once already finds it.
   */
  onOwningRoot?: (rootId: string) => void;

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
 * other's outputs end the walk rather than loop.
 */
async function ensureVerdict(
  runtime: Runtime,
  cellLink: NormalizedFullLink,
  options: EnsurePieceOptions | undefined,
  visited: Set<string>,
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
          root,
          observedDocIds,
          observedDocs,
        };
      }

      logger.debug("ensure-piece", () => [
        `Starting piece with pattern ${identityRef.identity} for result cell ${resultCell.getAsNormalizedFullLink().id}`,
      ]);

      // The owning root is known before the piece runs: a caller keying
      // per-instance run supply on it records the mapping here, so the
      // first run the start releases already finds it.
      options?.onOwningRoot?.(rootId);

      if (
        options?.startInputSources === true &&
        !runtime.runner.isRunning(resultCell)
      ) {
        visited.add(rootKey(root));
        await startInputSources(runtime, root, signal, visited);
        signal?.throwIfAborted();
        // A source whose graph sets this piece up as its child has started
        // it there, which is how it runs when a client opens the source.
        // Starting it again here would give it a lifetime of its own.
        if (runtime.runner.isRunning(resultCell)) {
          return {
            started: true,
            graphIsInstalled: () =>
              runtime.runner.pieceGraphIsInstalled(resultCell),
            root,
            observedDocIds,
            observedDocs,
          };
        }
      }

      // Start the existing piece - this registers event handlers without
      // re-running setup and potentially allocating different metadata cells.
      await runtime.start(resultCell);

      logger.debug("ensure-piece", () => [
        `Piece started successfully`,
      ]);

      return {
        started: true,
        graphIsInstalled: () =>
          runtime.runner.pieceGraphIsInstalled(resultCell),
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
