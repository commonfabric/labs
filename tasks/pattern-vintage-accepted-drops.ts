import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

/**
 * State a pattern stopped holding on purpose, and therefore no longer owes a
 * vintage.
 *
 * Tier 2 asks whether a real document written by an older version is still
 * readable by the version about to merge, and its default answer to "no" is
 * that the update lost data. That answer is right almost every time: a moved
 * `.for()` key strands state while the declared contract does not change by a
 * byte, which is exactly the failure the tier exists for.
 *
 * It is not right when the state was removed on purpose. The feature behind it
 * is gone, what it held is an accepted casualty, and no change to the pattern
 * makes the vintage readable again — the comparison is measuring the decision
 * itself. That is a Tier 1 conversation first: a removal reaches here only
 * after `tasks/pattern-compat-accepted-breaks.ts` has already accepted it as a
 * contract break, and the two lists are meant to be read together.
 *
 * An entry names PATHS, not fixtures and not bare field names, and that bound
 * is what keeps it from becoming an off switch. `crossrefs` forgives the root
 * key of that name and nothing else; `topics[].crossrefs` forgives it on each
 * element of the `topics` list. A same-named field anywhere else — on an
 * unrelated nested object, under a different root — is compared exactly as
 * before, so a removal that also strands a body, a thread, or a timestamp
 * still fails.
 *
 * Nothing off the path to an accepted drop is rebuilt, either: the comparison
 * has to see the state it was handed, and a subtree that lost nothing is
 * returned as itself rather than as a copy of itself.
 *
 * An entry is bounded in TIME as well, by `capturedThrough`. A removal happened
 * once, and only the vintages captured before it hold state that cannot roll
 * forward — so a vintage captured later is compared with no exemption at all.
 * That is what keeps a REPLACED path honest: `crossrefs` is still published,
 * carrying pivot rows now, and an entry that forgave it forever would hide a
 * later change that stranded those.
 *
 * The list can only shrink. A path that removes nothing from any vintage in its
 * own window fails the run, so an exemption cannot outlive the removal it was
 * granted for.
 */
export interface AcceptedStateDrop {
  /** Pattern key: the path relative to `packages/patterns`. */
  pattern: string;

  /**
   * Dotted paths into the pattern's result state that it no longer holds.
   * A segment ending in `[]` steps through every element of that list.
   */
  paths: readonly string[];

  /**
   * Capture stamp of the newest vintage this entry forgives, as
   * `VintageRef.stamp` spells one (ISO-8601 with `:` replaced, so it sorts as
   * a string).
   *
   * A removal happened once, at a point in time, and only the vintages
   * captured before it hold the state that cannot roll forward. Without this
   * bound an entry would also strip the path out of every vintage captured
   * LATER, which matters most where a path was replaced rather than retired:
   * `crossrefs` still exists on the board, carrying pivot rows, and an
   * unbounded entry would hide a future change that stranded those too. The
   * exemption covers the removal it was granted for and stops there.
   */
  capturedThrough: string;

  /** Why the removal was accepted. */
  reason: string;

  /**
   * Repo-relative path of the decision record under `docs/history/` — shared
   * with the matching Tier 1 entry where there is one. Existence is enforced
   * when either gate runs (`pattern-break-registry-guards.ts`).
   */
  record: string;
}

export const ACCEPTED_STATE_DROPS: readonly AcceptedStateDrop[] = [
  {
    pattern: "topics/main.tsx",
    paths: [
      // The unsigned caller retires. The per-topic display names it fed go
      // with it, and are listed once below among the narrowed demand rather
      // than twice — the two removals take the same paths.
      "myName",
      "setMyName",
      // --- the demand narrowing (docs/history/topics-demand-narrowing-break.md)
      // The board demanded the topic's whole published surface of every stored
      // topic, three verb streams among them. A holder's required demands are
      // write-once and a stream cannot carry a default, so a verb named there
      // priced every future verb as a break of the board. The demand is now the
      // eight members the board reads.
      //
      // These sit in this entry rather than their own because `acceptedDropsFor`
      // takes the FIRST entry matching a pattern and window: a second entry for
      // `topics/main.tsx` covering the same vintages would shadow this one
      // instead of adding to it, and the paths above would silently stop
      // applying. Two breaks on one pattern inside one window share an entry.
      //
      // A stored topic loses none of this. What it loses is the board's claim
      // on it: the fields and verbs stay on the topic, reachable at its own
      // address, and only the board's view of them narrows.
      "topics[].addComment",
      "topics[].addLink",
      "topics[].bodyUpdatedAt",
      "topics[].bodyUpdatedBy",
      "topics[].comments",
      "topics[].createdByName",
      "topics[].links",
      "topics[].setBody",
      // --- the mention-universe index follows
      // (docs/history/topics-mentionable-index-break.md)
      // `mentionable` is listed WHOLE: it was an alias of `topics` — a link,
      // no state of its own — and is now a derived document of two-string
      // rows, so nothing of the old value survives to be compared field by
      // field while the topics themselves survive at their own addresses.
      // Listing the root retires the per-element demand-narrowing paths that
      // used to sit here (`mentionable[].addComment` and kin): the strip
      // never descends past a dropped root, so an element path under it
      // could forgive nothing and would fail the liveness guard.
      "mentionable",
      // --- the reference-graph rebuild follows
      "crossrefs",
      "index[].refsOut",
      "index[].referencedBy",
      "index[].topic",
      "topics[].crossrefs",
      // The retired edge row's `mentionable[]` copy needs no path of its
      // own: the whole-`mentionable` drop above already strips the list it
      // sat on.
      // `crossrefs` is listed WHOLE, and that is the honest shape of what
      // happened: the old graph row carried an fid, a title, summary counts and
      // two edge sets, and the pivot row that replaced it carries a topic and
      // who mentions it. Nothing of the old row survives to be compared field
      // by field.
      // The old index rows carried the same two edge sets beside their
      // summaries. The summaries themselves are untouched.
      // An index row IS its topic now, so the title-only reference that used to
      // sit beside it goes; the row's own address is the topic's. The copied
      // `fid` field goes with it, and needs no entry here: no replayed vintage
      // holds a resolved one.
    ],
    // The newest topics vintage predating the rebuild AND the mention-universe
    // index — both replayed fixtures sit at or under it. Anything captured
    // from here on holds pivot rows and index rows, which owe the comparison
    // the same answer as anything else.
    capturedThrough: "2026-08-06T23-04-13.189Z",
    reason:
      "Topics' reference graph was rebuilt on cell identity — see the matching " +
      "entry in tasks/pattern-compat-accepted-breaks.ts. A topic publishes " +
      "`referencedBy` instead of deriving its own edge row, so the old row is " +
      "gone from every child the board lists. The index rows became the topics " +
      "themselves, which is what retires their copied address and reference. " +
      "Carried with it, same pattern and window, so one entry: the mention " +
      "universe became a derived index " +
      "(docs/history/topics-mentionable-index-break.md), which replaces the " +
      "`mentionable` alias wholesale.",
    record: "docs/history/topics-crossref-identity-break.md",
  },
  {
    pattern: "topics/topic.tsx",
    // The topic's own edge row, whole. A topic no longer derives one: inbound
    // references are read out of the board's pivot and published as
    // `referencedBy`, so nothing reads this path.
    paths: [
      "crossrefs",
      // The unsigned caller retires, and the display names it fed go with it:
      // a comment always carries a structured author now, so the mirror beside
      // it describes nothing. A stored topic keeps what it holds; what goes is
      // the pattern's claim to publish these.
      "createdByName",
      "comments[].authorName",
      // And the structured author a legacy topic used to get FROM that name.
      // `createdByOf` projected `createdByName` into `createdBy` when a topic
      // had no structured author; with the name retired, such a topic reads as
      // the inert sentinel instead.
      //
      // Accepted on evidence, not on principle: every one of the 113 topics on
      // the deployed board carries a structured `createdBy.name`, so no live
      // topic reaches the projection being removed. The replayed vintages
      // predate structured authorship and do, which is what surfaces here. A
      // census belongs in the migration's pre-flight rather than being taken
      // on trust from this comment.
      "createdBy",
    ],
    capturedThrough: "2026-08-06T23-04-13.189Z",
    reason:
      "Topics' reference graph was rebuilt on cell identity — see the matching " +
      "entry in tasks/pattern-compat-accepted-breaks.ts. The board's own " +
      "`crossrefs` came back as a pivot and strands nothing, so only a topic's " +
      "retired per-topic row is listed here. Carried with it: the unsigned " +
      "caller's retirement, whose display-name mirrors go too — one entry per " +
      "pattern, because a second would shadow this one rather than add to it.",
    record: "docs/history/topics-crossref-identity-break.md",
  },
  {
    // Lunch-poll identity moved from display names to profile cells — see
    // docs/history/lunch-poll-identity-break.md and the matching entries in
    // tasks/pattern-compat-accepted-breaks.ts. Name-keyed vintages hold no
    // profile cells, so under the new model their capture user derives as
    // not-joined (a "display ghost"): `adminName` is the removed surface
    // itself, and `myName`/`isJoined`/`isAdmin` are its derived shadows.
    // `todaysVotes`/`todayVoteCount` empty for a second reason the entry is
    // honest about: they are current-day views, and a pinned vintage replayed
    // weeks after capture holds no votes cast "today" — the stored `votes`
    // themselves survive unchanged.
    pattern: "lunch-poll/main.tsx",
    paths: [
      "adminName",
      "myName",
      "isJoined",
      "isAdmin",
      // The name-keyed identity field on each stored vote. The vote itself
      // survives (id, color, timestamp); its identity is the `voter` profile
      // cell on votes this pattern casts.
      "votes[].voterName",
      "todaysVotes",
      "todayVoteCount",
    ],
    capturedThrough: "2026-07-30T21-32-46.548Z",
    reason: "Lunch-poll identity moved from display names to profile cells. " +
      "A name-keyed vintage's capture user matches no profile, so the " +
      "name-derived membership surface — `adminName` and the joined-ness it " +
      "anchored — does not survive on purpose; the current-day vote views " +
      "additionally empty because the pinned vintage is replayed long after " +
      "its capture day, while the stored votes survive whole.",
    record: "docs/history/lunch-poll-identity-break.md",
  },
  {
    // The card half of the same decision: it published the viewer's name as
    // `me`, now removed, and derived joined-ness/host status from it.
    pattern: "lunch-poll/participant-identity-card.tsx",
    paths: ["me", "isJoined", "isAdmin"],
    capturedThrough: "2026-07-30T21-32-46.548Z",
    reason: "Lunch-poll identity moved from display names to profile cells. " +
      "The card's published viewer-name identity is removed, and a name-keyed " +
      "vintage's capture user derives as not-joined under profile comparison.",
    record: "docs/history/lunch-poll-identity-break.md",
  },
];

/** One `(pattern, path)` drop, for reporting which entries were needed. */
export const acceptedDropKey = (pattern: string, path: string): string =>
  `${pattern} ${path}`;

/**
 * Whether a registry key addresses the pattern a manifest names.
 *
 * A manifest entry names its pattern by repo-relative path
 * (`/packages/patterns/topics/topic.tsx`) or by the route the toolshed serves
 * it at, while a registry key is written relative to `packages/patterns`. So
 * a key is matched as a path SUFFIX rather than a bare one: `endsWith` alone
 * would also claim a `subtopics/main.tsx` that no entry mentions, and the
 * leading `/` is what makes the segment boundary part of the test.
 *
 * Exported because the guards that hold these registries to a floor have to
 * ask the same question this asks, and a floor that judged membership by its
 * own rule would let a spelling this accepts walk straight around it.
 */
export function patternKeyClaims(patternPath: string, key: string): boolean {
  return patternPath === key || patternPath.endsWith(`/${key}`);
}

/**
 * The paths accepted as dropped for one pattern, in one vintage.
 *
 * A manifest entry names its pattern by repo-relative path
 * (`/packages/patterns/topics/topic.tsx`), so the key is matched as a path
 * suffix rather than a bare one: `endsWith("topics/main.tsx")` alone would also
 * claim a `subtopics/main.tsx` that no entry mentions.
 *
 * `stamp` is the replayed vintage's capture stamp, and an entry answers only
 * for the vintages it was granted over. Stamps are ISO-8601 with `:` replaced,
 * which leaves them sortable as plain strings — so the window is a string
 * comparison and needs no date parsing.
 */
export function acceptedDropsFor(
  patternPath: string,
  stamp: string,
  drops: readonly AcceptedStateDrop[] = ACCEPTED_STATE_DROPS,
): { paths: ReadonlySet<string>; pattern: string } | undefined {
  const entry = drops.find((drop) =>
    patternKeyClaims(patternPath, drop.pattern) &&
    stamp <= drop.capturedThrough
  );
  return entry === undefined
    ? undefined
    : { paths: new Set(entry.paths), pattern: entry.pattern };
}

/**
 * Every prefix along the way to an accepted path, including the root `""`.
 *
 * This is what keeps the walk from touching state no entry named: a value whose
 * prefix is absent here cannot contain a drop, so it is returned as itself.
 * A `foo[]` segment contributes both `foo` — the key holding the list — and
 * `foo[]`, the level its elements sit at.
 */
function spineOf(paths: ReadonlySet<string>): ReadonlySet<string> {
  const spine = new Set<string>([""]);
  for (const path of paths) {
    let prefix = "";
    for (const segment of path.split(".")) {
      const key = segment.endsWith("[]") ? segment.slice(0, -2) : segment;
      prefix = prefix === "" ? key : `${prefix}.${key}`;
      spine.add(prefix);
      if (key !== segment) {
        prefix = `${prefix}[]`;
        spine.add(prefix);
      }
    }
  }
  return spine;
}

/** A value this walk may rebuild: a bare object literal, nothing else. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!isObjectNotArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * `state` with every accepted path removed, and which paths that took.
 *
 * `isReduction` guards the one shape that must never be opened: a reduction
 * stands for something the comparison cannot see through and is compared whole,
 * so the walk returns one untouched rather than descending into its innards.
 * Anything that is not a plain object is returned as-is for the same reason —
 * rebuilding a value whose shape this does not understand would change what the
 * comparison sees.
 *
 * A subtree that lost nothing comes back as ITSELF, not a copy. The state on
 * both sides of the comparison is already `comparableState` output, so a rebuilt
 * copy would compare identically — but "the comparison sees exactly what it was
 * handed" is a property worth holding rather than re-deriving each time someone
 * asks whether the strip is safe.
 *
 * The returned path set is what makes the list shrink. An entry whose paths are
 * nowhere in any vintage forgives nothing, and a gate cannot tell that from an
 * entry quietly doing nothing unless it counts.
 */
export function withoutAcceptedDrops(
  state: unknown,
  paths: ReadonlySet<string>,
  isReduction: (value: unknown) => boolean,
): { value: unknown; applied: Set<string> } {
  const applied = new Set<string>();
  if (paths.size === 0) return { value: state, applied };
  const spine = spineOf(paths);

  const strip = (value: unknown, prefix: string): unknown => {
    if (!spine.has(prefix)) return value;
    if (!isObjectOrArray(value)) return value;
    if (isReduction(value)) return value;
    if (Array.isArray(value)) {
      const elements = `${prefix}[]`;
      if (!spine.has(elements)) return value;
      let changed = false;
      const out = value.map((element) => {
        const stripped = strip(element, elements);
        if (stripped !== element) changed = true;
        return stripped;
      });
      return changed ? out : value;
    }
    if (!isPlainObject(value)) return value;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (paths.has(path)) {
        applied.add(path);
        changed = true;
        continue;
      }
      const stripped = strip(nested, path);
      if (stripped !== nested) changed = true;
      out[key] = stripped;
    }
    return changed ? out : value;
  };

  return { value: strip(state, ""), applied };
}
