import { describeFailure } from "@commonfabric/js-values/describe-failure";
import {
  type PatternIndexClient,
  PatternIndexError,
  type PatternIndexEventType,
  type PatternIndexPublishRequest,
} from "@commonfabric/pattern-index/client";
import type { HarnessPatternIndexClientFactory } from "./factory.ts";
import { PATTERN_DISCOVERABILITY_REASONS } from "./publish-render-gate.ts";

/**
 * Everything one session sends to the pattern index: the patterns it authored,
 * and the events its runs report about the patterns they ran.
 *
 * Each write is sent behind the one sent before it, and no caller waits for
 * any of them. So the index sees this session's writes in the order they were
 * sent — a dependency before the entry naming it, a run's `instantiated`
 * before the terminal event that follows it — while what a session contributes
 * to a shared catalog costs the run that contributed it nothing. A publication
 * is held rather than sent when it is staged, for the reason below.
 *
 * `flush` is the session's one wait for all of it. The harness process ends
 * through `Deno.exit`, which does not let a pending request finish, so a write
 * nothing waits for is a write that can be cut off in flight; the prompt loop
 * reaches `flush` before the process gets there. Nothing bounds that wait: a
 * session whose index has stopped answering ends when its last request does.
 *
 * ## The problem holding a publication exists for
 *
 * A pattern-author that iterates runs the same capability three or four times
 * before it is happy. Each successful run published, and since the source
 * differs slightly between iterations each is a different content-addressed
 * identity, so none deduplicates against the others. About a third of the
 * index is that: near-duplicates produced by iteration rather than by use,
 * several of which occupy consecutive slots in one search and crowd
 * everything else out of it.
 *
 * ## What it does instead
 *
 * Every iteration is still RECORDED — nothing an authoring session produced
 * is lost, and `getPattern` and `cf:pattern:` answer for all of it. The
 * request decides whether the retained candidate is discoverable; ordinary
 * authored runs record it, while curated seeding requests discoverability.
 *
 * A staged request is held. Staging the same capability again publishes the
 * one being displaced immediately, as `discoverable: false`, and holds the
 * new one. What is still held when the session ends is published with the
 * discoverability the caller requested. So a session that authored a
 * capability four times leaves four records and at most one search result.
 *
 * A staged request naming a held entry among its `dependencies` publishes
 * that dependency first, with its requested discoverability, since it is not
 * being superseded — the index refuses a publication whose dependency it does
 * not hold, so a
 * session composing an atom it authored earlier needs that atom in the index
 * before the composite arrives. An entry published that way becomes the
 * `priorPatternId` of the next iteration staged under the same capability,
 * which is the one case where two entries from one session both reach the
 * index through the front door.
 *
 * ## Which version history an entry joins
 *
 * The index files every publication into a lineage, one pattern's history of
 * versions, and finds it from what the request names: a `slot` before a
 * `priorPatternId`, and a `remixedFrom` always starting a new one
 * (pattern-index `docs/visibility-contract.md`, "Lineages and versions"). An
 * agent run names the new piece it deployed to as the slot, so without more
 * every run's pattern would start a history of its own. Two things say more:
 *
 * - A later iteration of a capability this session already sent continues
 *   that entry's history: it names the entry as `priorPatternId` and drops
 *   its own slot and remix credit, which would otherwise outrank the
 *   predecessor and start another history. A request revised from something
 *   else than that entry was is not an iteration of it, whatever its words.
 * - A request staged with `revisedFrom` — the pattern a run's source was
 *   revised from, which the run knows only when the model named the piece it
 *   revised — continues the caller's own pattern the same way, and is
 *   credited as `remixedFrom` someone else's, starting a new history, which
 *   is what a revision of a pattern the caller did not write is. A pattern
 *   this session sent is known to be the caller's (one still held is sent
 *   first, so the index holds it). For any other the index is asked when the
 *   request is sent. A pattern it does not hold, or a deployment that does
 *   not say whose a pattern is, leaves the request as it was: the index is
 *   told nothing about a predecessor nobody could confirm.
 *
 * An entry staged with neither names nothing earlier, so a new pattern never
 * joins a history it is unrelated to.
 *
 * Dropping the slot has a cost, stated rather than discovered: the new piece's
 * key is then bound to no history, so a later publication naming that piece
 * as its slot would start another one. Nothing sends one today — every
 * `run_pattern` deploys a new piece, and an in-place `revise_piece` publishes
 * nothing. The index binding an unbound slot to the history a
 * `priorPatternId` finds, as it already does for a remix, would let this keep
 * the slot.
 *
 * ## What this costs, stated rather than discovered
 *
 * **A session that dies before its flush loses the latest iteration of each
 * capability it was still holding** — one entry per capability, not the
 * session's whole output, since every superseded iteration was already sent
 * when it was displaced. A publication that fails at the index is logged and
 * does not bear on the run.
 *
 * **Two different capabilities described in identical words collapse**, the
 * later one taking the retained slot and the earlier being recorded. The
 * key is the model's own description and hashtags, which is also what the
 * index ranks a search against — so two entries this key cannot tell apart
 * are two entries a search cannot tell apart either.
 */
export interface PatternIndexLedger {
  /**
   * Holds `request` as this session's offer for its capability, publishing
   * anything it displaces as non-discoverable. Never throws and never awaits:
   * a contribution to a shared catalog does not bear on the run that made it.
   */
  stage(
    request: PatternIndexPublishRequest,
    options?: PatternIndexStageOptions,
  ): void;

  /**
   * Sends `eventType` for `patternId`, behind everything written before it.
   * Never throws and never awaits: the run has said what it did with the
   * pattern and is done with the report.
   */
  record(patternId: string, eventType: PatternIndexEventType): void;

  /**
   * Publishes everything still held, ordered so that a held entry another
   * held entry names among its `dependencies` goes first. A request whose
   * turn never comes is still published, after everything that could be
   * ordered — nothing here produces a cycle, since a dependency is the
   * content-addressed identity of something that already compiled, but the
   * ordering does not assume it.
   *
   * Resolves once every write this session made has been answered, the
   * publications above among them.
   */
  flush(): Promise<void>;
}

export interface PatternIndexStageOptions {
  /**
   * The index pattern the request's source was revised from. Whether it
   * continues that pattern's history or is credited as a remix of it is
   * decided when the request is sent, by asking the index whose it is.
   */
  revisedFrom?: string;
}

/**
 * A request as held: what was staged, and what it was revised from. Whose
 * that is still has to be asked unless the request already names it as its
 * `priorPatternId`.
 */
interface StagedPublication {
  request: PatternIndexPublishRequest;
  revisedFrom?: string;
}

/**
 * `request` as the next version of `priorPatternId`, one of the caller's
 * own. Its slot and remix credit go: either one outranks a predecessor when
 * the index looks for the history to file it in, and both would start a new
 * one.
 */
const continuing = (
  request: PatternIndexPublishRequest,
  priorPatternId: string,
): PatternIndexPublishRequest => {
  const { slot: _slot, remixedFrom: _remixedFrom, ...rest } = request;
  return { ...rest, priorPatternId };
};

/**
 * `request` with what the index says about `revisedFrom` applied: continuing
 * it when the caller wrote it, crediting it when someone else did, and
 * unchanged when the index does not hold it or does not say whose it is.
 * A deployment that says answers with `author`, and with `mine: true` only to
 * the author: it leaves `mine` out rather than send `false`.
 * A read that fails is reported and leaves the request unchanged too, since
 * a guess at a predecessor's owner is the one thing this must not send.
 */
const withPredecessor = async (
  client: PatternIndexClient,
  request: PatternIndexPublishRequest,
  revisedFrom: string,
  onError: (message: string) => void,
): Promise<PatternIndexPublishRequest> => {
  let answer;
  try {
    answer = await client.getPattern({
      patternId: revisedFrom,
      includeSource: false,
    });
  } catch (error) {
    if (!(error instanceof PatternIndexError && error.status === 404)) {
      onError(
        `run_pattern could not ask the pattern index whose pattern "${revisedFrom}" is, so the pattern revised from it starts a version history of its own: ${
          describeFailure(error)
        }`,
      );
    }
    return request;
  }
  if (answer.mine === true) return continuing(request, revisedFrom);
  if (answer.author !== undefined) {
    return { ...request, remixedFrom: revisedFrom };
  }
  return request;
};

/**
 * What counts as one capability: the description and hashtags the model gave,
 * normalized for case and whitespace, with hashtags order-independent.
 */
export const patternCapabilityKey = (
  request: PatternIndexPublishRequest,
): string =>
  JSON.stringify([
    request.description.trim().toLowerCase().replace(/\s+/g, " "),
    [...request.hashtags]
      .map((hashtag) => hashtag.trim().toLowerCase())
      .sort(),
  ]);

export const createPatternIndexLedger = (
  getClient: HarnessPatternIndexClientFactory,
  options: { onError?: (message: string) => void } = {},
): PatternIndexLedger => {
  const onError = options.onError ??
    ((message: string) => console.error(message));
  const held = new Map<string, StagedPublication>();
  // Per capability, the entry last sent and what it was revised from; and
  // every entry this session sent, each of them the caller's own.
  const publishedByKey = new Map<
    string,
    { patternId: string; revisedFrom?: string }
  >();
  const sentIds = new Set<string>();
  // Every write is serialized behind one chain, so a write is sent once the
  // write before it has been answered, without any caller awaiting either.
  let chain: Promise<void> = Promise.resolve();

  const send = (
    key: string,
    { request, revisedFrom }: StagedPublication,
    supersede: boolean,
  ): void => {
    publishedByKey.set(key, {
      patternId: request.patternId,
      ...(revisedFrom !== undefined ? { revisedFrom } : {}),
    });
    sentIds.add(request.patternId);
    // A render-gate reason is more informative than displacement and stays on
    // a superseded entry. The generic automatic-recording reason is replaced:
    // supersession specifically explains why an earlier iteration is not the
    // retained candidate.
    const automaticReason =
      PATTERN_DISCOVERABILITY_REASONS["recorded-automatically"];
    const body = supersede
      ? {
        ...request,
        nonDiscoverable: request.nonDiscoverable?.reason === automaticReason
          ? { reason: PATTERN_DISCOVERABILITY_REASONS.superseded }
          : request.nonDiscoverable ??
            { reason: PATTERN_DISCOVERABILITY_REASONS.superseded },
      }
      : request;
    chain = chain.then(async () => {
      try {
        const client = await getClient();
        const response = await client.publishPattern(
          revisedFrom === undefined || body.priorPatternId !== undefined
            ? body
            : await withPredecessor(client, body, revisedFrom, onError),
        );
        if (response.created) {
          await client.recordEvent({
            patternId: response.patternId,
            eventType: "created",
          });
        }
      } catch (error) {
        onError(
          `run_pattern could not publish the pattern it ran to the pattern index: ${
            describeFailure(error)
          }`,
        );
      }
    });
  };

  return {
    record(patternId, eventType) {
      chain = chain.then(async () => {
        try {
          const client = await getClient();
          await client.recordEvent({ patternId, eventType });
        } catch (error) {
          onError(
            `run_pattern could not record the ${eventType} event for pattern index entry "${patternId}": ${
              describeFailure(error)
            }`,
          );
        }
      });
    },
    stage(request, options = {}) {
      const { revisedFrom } = options;
      const dependencies = new Set(request.dependencies ?? []);
      if (revisedFrom !== undefined) dependencies.add(revisedFrom);
      if (dependencies.size > 0) {
        for (const [key, pending] of [...held]) {
          if (dependencies.has(pending.request.patternId)) {
            held.delete(key);
            // Not superseded: something depends on it or revises it, so it
            // is a part of this session's output in its own right.
            send(key, pending, false);
          }
        }
      }
      const key = patternCapabilityKey(request);
      const displaced = held.get(key);
      if (displaced !== undefined) {
        held.delete(key);
        send(key, displaced, true);
      }
      // An earlier iteration this session sent is already in the history
      // this one belongs to — unless this one says it was revised from
      // something else.
      const prior = publishedByKey.get(key);
      const predecessor = prior !== undefined &&
          prior.patternId !== request.patternId &&
          (revisedFrom === undefined || revisedFrom === prior.revisedFrom)
        ? prior.patternId
        : revisedFrom !== undefined && sentIds.has(revisedFrom)
        ? revisedFrom
        : undefined;
      held.set(key, {
        request: predecessor === undefined
          ? request
          : continuing(request, predecessor),
        ...(revisedFrom !== undefined ? { revisedFrom } : {}),
      });
    },
    async flush() {
      // Dependency order, not staging order. Staging order happens to be
      // right whenever a dependency was authored before the entry composing
      // it — which a `cf:pattern:` import needing to resolve at compile time
      // forces — but the index rejects a publication whose dependency it does
      // not hold, so the ordering is made rather than relied upon.
      //
      // A pass rather than a loop-until-no-progress: `stage()` already sends
      // any held entry a later request names among its dependencies, so no
      // two held entries can name each other and the ordering has no residue
      // case to fall back on. Counting each entry's held dependencies and
      // sending in that order cannot leave anything unsent, which is a
      // property of the shape rather than a claim about the input.
      const pending = [...held];
      held.clear();
      const heldIds = new Set(
        pending.map(([, { request }]) => request.patternId),
      );
      const depth = ([, { request }]: [string, StagedPublication]) =>
        (request.dependencies ?? []).filter((id) => heldIds.has(id)).length;
      for (
        const [key, staged] of pending.sort((a, b) => depth(a) - depth(b))
      ) {
        send(key, staged, false);
      }
      await chain;
    },
  };
};
