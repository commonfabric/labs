/**
 * Contract breaks the repository has decided to ship.
 *
 * Tier 1's default answer to "this contract cannot be applied over a deployed
 * one" is to change the pattern, and that answer is right almost every time: a
 * new required field wants a `Default<>`, not an exemption. But it is not right
 * every time. A surface can be removed on purpose — the feature behind it is
 * gone, the pieces holding its state are accepted casualties — and then there
 * is no pattern change that satisfies the check, because the check is
 * measuring exactly the decision that was made.
 *
 * `--update` cannot express that: it records only when "not recorded" is the
 * sole finding, so an incompatible contract never reaches a baseline. Deleting
 * the offending baselines cannot express it either — that is the laundering
 * `check-baselines-append-only` exists to stop, and it destroys the evidence
 * that would catch a LATER break against the same contract. So the decision
 * gets written down here instead, where review sees it as a diff.
 *
 * An entry forgives specific `(pattern, baseline)` pairs, and within a pair
 * only the schema paths it names. Both bounds matter. The pair bound keeps the
 * exemption from becoming an off switch over time: the contract recorded once
 * the break ships is a new baseline that no entry names, so the very next
 * change to that pattern is gated again, against the shape the break left
 * behind. The path bound keeps it from becoming one within a single change: the
 * compatibility proof reports every issue it found against a baseline as ONE
 * finding, so forgiving by pair alone would suppress an unintended break that
 * happened to land beside the accepted one — and `--update` would then record
 * that broken contract as the new baseline.
 *
 * Paths are written exactly as the proof names them (`result.crossrefs`,
 * `argument.topics[]`). One limitation is worth knowing: the proof reports at
 * most one issue per role, so where an accepted path is the reported issue for
 * its role, a second problem in that same role can be hidden behind it. Keep
 * accepted paths as few as the removal actually needs.
 *
 * The list can only shrink. A listed pair that no longer produces a finding —
 * because the pattern grew the surface back, or the baseline is gone — fails
 * the run, so an exemption cannot outlive the break it was granted for.
 */
export interface AcceptedContractBreak {
  /** Pattern key: the path relative to `packages/patterns`. */
  pattern: string;

  /** Baseline labels (filename stems) this pattern may fail to apply over. */
  baselines: readonly string[];

  /**
   * Schema paths this break may blame, spelled as the compatibility proof
   * spells them. A finding blaming anything else stands.
   */
  paths: readonly string[];

  /** Why the break was accepted. */
  reason: string;

  /**
   * Repo-relative path of the decision record under `docs/history/` — the
   * deliberation behind this entry's declaration. Its existence is enforced
   * when either gate runs (`pattern-break-registry-guards.ts`).
   */
  record: string;

  /**
   * The ruling that lets this entry name a required pattern. Absent on every
   * other entry: the guard refuses a break on an auto-updating root unless
   * one is carried, because such a break strands every space's root the
   * moment it merges, and that is a decision a person makes by name.
   */
  requiredPatternOverride?: RequiredPatternOverride;
}

/** Who ruled that a required pattern takes an accepted break, and why. */
export interface RequiredPatternOverride {
  /** The person whose ruling this is. */
  rulingBy: string;

  /** The date of the ruling, `YYYY-MM-DD`. */
  on: string;

  /** The ruling, quoted or summarized. */
  reason: string;
}

export const ACCEPTED_CONTRACT_BREAKS: readonly AcceptedContractBreak[] = [
  {
    // The profile gained its owner-protected share inbox pointer (`inbox`,
    // optional, undefaulted). The picker consumes a stored profile, and the
    // proof compares the new property's `ifc` label against a baseline that
    // has no such property at all, so it reads a label change where a
    // stored profile without the field still validates. An unlabelled
    // pointer would pass the proof and let a stranger redirect the owner's
    // inbox; the label is the point.
    pattern: "system/profile-picker.tsx",
    baselines: [
      "20260729T022742Z-BVxqS5A3M24IcX6m",
      "20260818T220011Z-J-y30yE6xQ8axACi",
    ],
    paths: ["argument.defaultProfile"],
    reason:
      "the profile's new owner-protected inbox pointer reads as a changed label under a baseline that never had the property",
    record: "docs/history/profile-inbox-pointer-break.md",
  },
  {
    // A SECOND entry for the picker, and no baseline here appears above: the
    // pairs stay disjoint because the gate keys accepted pairs into a Map,
    // so a baseline named twice would take the later path set in place of
    // the earlier one.
    //
    // The share inbox pointer's `space` and `host` fields left, replaced by
    // a link to the inbox piece under `piece`. The recorded object requires
    // the two fields, so no candidate without them applies over it.
    pattern: "system/profile-picker.tsx",
    baselines: [
      "20260915T064957Z-Idjl03Ljo7Yyeecn",
      "20260918T000350Z-TY78mWqtLnHDoZtN",
    ],
    paths: ["argument.defaultProfile"],
    reason:
      "the share inbox pointer's `space` and `host` fields left, replaced by a link to the inbox piece under `piece`, which the recorded object requires them beside",
    record: "docs/history/profile-inbox-piece-break.md",
  },
  {
    // The same ruling seen from the profile itself: the proof names the
    // first of the two fields that left.
    pattern: "system/profile-home.tsx",
    baselines: [
      "20260915T064957Z-mE7S34E5xl20_PZs",
      "20260917T235321Z--A47I2nujs7eKua6",
    ],
    paths: ["result.inbox.host"],
    reason:
      "the share inbox pointer's `space` and `host` fields left, replaced by a link to the inbox piece under `piece`, which the recorded object requires them beside",
    record: "docs/history/profile-inbox-piece-break.md",
  },
  {
    // The same ruling seen from home, whose published `defaultProfile`
    // carries the profile's shape. Home is a required pattern, so this entry
    // carries the ruling that lets it name one: every space's root takes the
    // break the moment it merges, and nothing deployed beyond one install
    // holds a pointer of the old shape.
    pattern: "system/home.tsx",
    baselines: [
      "20260915T064957Z-k40oHeJO0hh31i1H",
      "20260917T220636Z-xdDxE87ojM-_6i1g",
      "20260918T000350Z-AhP3Iq9N0OLx48b1",
      "20260918T002421Z-RB590FUNua-vIXOh",
      "20260918T072634Z-NeP8mB1oe_0bWKFV",
    ],
    paths: ["result.defaultProfile"],
    reason:
      "the share inbox pointer's `space` and `host` fields left, replaced by a link to the inbox piece under `piece`, which the recorded object requires them beside",
    record: "docs/history/profile-inbox-piece-break.md",
    requiredPatternOverride: {
      rulingBy: "Berni",
      on: "2026-09-18",
      reason:
        "you can make that an allowed incompatible pattern update if you need to since other than Gideon no one will have that version of setInbox",
    },
  },
  {
    // Three cells' declared defaults take effect. Each is typed
    // `Stored | Default<Record<PropertyKey, never>>` and reaches the schema
    // generator through a scope alias, where default recovery from the
    // resolved union had taken the propertyless plain arm for a marker-less
    // brand, so no baseline carries the `default: {}` the declarations always
    // meant. A piece holding one of them unset reads `{}` where it read
    // `undefined`. The proof reports one issue per role, so it names only
    // `adminRegistry`; the other four paths are found by peeling.
    pattern: "cfc-group-chat-demo/main.tsx",
    baselines: [
      "20260729T022742Z-piF14M8QDh5pSPw1",
      "20260821T064855Z-7vNcdzNpQKWFJXVr",
      "20260831T222745Z-kIL5Ew24PVUYtyxy",
    ],
    paths: [
      "argument.adminRegistry",
      "result.adminRegistry",
      "argument.myProfile",
      "result.myProfile",
      "argument.rooms",
      "result.rooms",
    ],
    reason:
      "the declared `Default<{}>` of the admin registry, the profile, and the room list is honored where the recorded contracts carry no default",
    record: "docs/history/admin-registry-default-honored-break.md",
  },
  {
    // The Join verb's event opens: `Record<PropertyKey, never>` compiled to
    // a closed empty object the runner's closed-world gate now enforces, so
    // the rendered button's serialized DOM event was refused and the roster
    // could never be joined. `void` (the lobby's shape) is a different
    // recorded contract for the stream; nothing held state under the old one.
    pattern: "profile-roster-live-demo.tsx",
    baselines: ["20260729T022742Z-QNOFVBAs80X9XKZu"],
    paths: ["result.join"],
    reason:
      "the Join verb's closed empty event refused every rendered click; re-declared void",
    record: "docs/history/roster-join-event-opened.md",
  },
  {
    // The same break in the shared roster, same record.
    pattern: "shared-profile-roster/main.tsx",
    baselines: ["20260729T022742Z-MLeLOCqjpbIUoIib"],
    paths: ["result.join"],
    reason:
      "the Join verb's closed empty event refused every rendered click; re-declared void",
    record: "docs/history/roster-join-event-opened.md",
  },
  {
    // One entry per (pattern, BASELINE) pair, and that is a requirement
    // rather than tidiness: the gate keys accepted pairs into a Map, so a
    // second entry naming a baseline this one also names REPLACES its path
    // set rather than adding to it. Breaks that share baselines therefore
    // share an entry — and its single `record`, the other break named in
    // the reason — while a later break against baselines no earlier entry
    // names gets its own entry, with the pairs kept disjoint.
    //
    // Carried here: the reference graph rebuilt on cell identity, and the
    // board's demand narrowed to the eight members it reads — which narrows
    // the published projection with it, opens the link and author `kind`
    // domains a closed enum in provided data could never widen, and stops
    // `addLink` requiring the two fields its handler already defaulted.
    pattern: "topics/main.tsx",
    baselines: [
      "20260729T022742Z-31DT95VXuyOj8JeU",
      "20260803T191013Z-jUl4tnb6Dw8LBVJj",
      "20260804T003803Z-4eh5RiQl5phB1jpX",
      "20260806T230301Z-96vyQcPJ2htEfat9",
      "20260807T155936Z-wBGKcf6ruadhes3g",
      "20260807T190842Z-SD0Ii3eK0ZnJnIhs",
      "20260810T212206Z-cIIz70jbLbbPc-F3",
      "20260812T003521Z-Jy37T5qk4KSHkgQe",
      "20260814T233350Z-jHoJZsDa5eUdWU-B",
      "20260817T051200Z-NIE10ssgY89CXloq",
      "20260817T212730Z-3FUPLp4oeb7gwpch",
      "20260817T231646Z-3OsO1miQLNSxm34N",
      "20260818T002831Z-Lk1mtrXcWtEV2FAK",
      "20260818T020120Z-AfZn709Q7YVH7WlZ",
      "20260819T172917Z-ocrU646RD4YKITBc",
    ],
    paths: [
      "argument.topics[]",
      "result.mentionable[].mention",
      "result.crossrefs",
      "result.crossrefs[].fid",
      "result.crossrefs[].commentCount",
      "result.index[].fid",
      "argument.topics[].createdBy",
      "result.index[].createdBy",
      "result.mentionable[].addComment",
      // The unsigned caller retires: `agentName` is required on every verb, and the display-name mirrors that path filled go with it.
      "result.myName",
    ],
    reason:
      "Two accepted breaks on one pattern: the reference-graph rebuild on cell " +
      "identity (docs/history/topics-crossref-identity-break.md), and the " +
      "demand narrowing recorded below.",
    record: "docs/history/topics-demand-narrowing-break.md",
  },
  {
    // A SECOND entry for this pattern, deliberately: the one-entry rule the
    // neighbors state guards against two entries naming the SAME baseline —
    // the gate's Map keeps one path set and drops the other — and no
    // baseline here appears above. Keeping the pairs disjoint is what keeps
    // the bound tight: forgiving this path on the older baselines too would
    // let the proof's one-issue-per-role limit hide an unintended break
    // behind pairs this break never produced a finding against.
    pattern: "topics/main.tsx",
    baselines: [
      "20260826T221814Z-pt-HCeVbN-iyz9VX",
      "20260831T174843Z-iQFp3QQPN2zAkRuJ",
    ],
    paths: [
      // The published mention universe stopped carrying the topics' own
      // surface: a row is two strings and an unread `piece` reference,
      // because every field a row carries by value ships to every reader
      // of the universe.
      "result.mentionable[].body",
    ],
    reason:
      "The board's mention universe became a derived index of two-string " +
      "rows holding each topic as an unread reference, so the published " +
      "`mentionable` stopped carrying a topic's own surface. Wired to the " +
      "raw topics list it multiplied every topic's resume into every " +
      "sibling topic under document-granular delivery.",
    record: "docs/history/topics-mentionable-index-break.md",
  },
  {
    // One entry per (pattern, BASELINE) pair, and that is a requirement
    // rather than tidiness: the gate keys accepted pairs into a Map, so a
    // second entry naming a baseline this one also names REPLACES its path
    // set rather than adding to it. Breaks that share baselines therefore
    // share an entry — and its single `record`, the other break named in
    // the reason — while a later break against baselines no earlier entry
    // names gets its own entry, with the pairs kept disjoint.
    //
    // Carried here: the reference graph rebuilt on cell identity, and the
    // board's demand narrowed to the eight members it reads — which narrows
    // the published projection with it, opens the link and author `kind`
    // domains a closed enum in provided data could never widen, and stops
    // `addLink` requiring the two fields its handler already defaulted. And
    // the mention universe reaching a topic as a readable cell, the break
    // the entry below records for the baselines after these.
    pattern: "topics/topic.tsx",
    baselines: [
      "20260729T022742Z-6pmDbdEVBz84jJRa",
      "20260804T003803Z-I2QhJWkighYF1Fa1",
      "20260806T230301Z-JAM7epNCGeRRdbAJ",
      "20260807T155937Z-T6UB0k9yc-pCo6Fj",
      "20260807T190842Z-XNG2XTMFFTjcmnX0",
      "20260808T001558Z-H7ntBZnGU80t30LL",
      "20260810T212206Z-FQasUmU3p-SDapLo",
      "20260812T003521Z-XWPlA9Dl3OHXlHEH",
      "20260814T233350Z-ignmxWvAy2vygaDl",
      "20260817T212731Z-S2Y3ePoq7Zj_7fLa",
      "20260817T231646Z-bBfPByCuBScHp-Ou",
      "20260818T002831Z-ULPZkKYbQEmzLpDl",
      "20260818T020121Z-Y5Q-u4fiTKGUrP5Y",
      "20260819T172917Z-K_8fL8hZtM4xYV7V",
    ],
    paths: [
      "argument.boardCrossrefs",
      "argument.boardCrossrefs[].referencedBy",
      "argument.mentionable[]",
      "result.mention",
      "result.crossrefs",
      "argument.bodyUpdatedBy.kind",
      "result.addLink.kind",
      // The unsigned caller retires: a comment always carries a structured author now, so the mirror beside it goes.
      "argument.comments[]",
      "result.createdByName",
      // The mention universe's readable-cell narrowing, the break the entry
      // below records: these baselines carry it as well, and the argument
      // role reports it once the widened `kind` domains are accepted (a
      // closed enum widening to `string` is a type widening the proof
      // admits).
      "argument.mentionable",
    ],
    reason:
      "Three accepted breaks on one pattern: the reference-graph rebuild on " +
      "cell identity (docs/history/topics-crossref-identity-break.md), the " +
      "demand narrowing recorded below, and the mention universe's readable-" +
      "cell narrowing, which these baselines carry as well " +
      "(docs/history/topics-mentionable-readonly-break.md).",
    record: "docs/history/topics-demand-narrowing-break.md",
  },
  {
    // The parking coordinator's admin roster declared a `requiredIntegrity`
    // floor that nothing in the pattern could satisfy: no `addIntegrity` mint
    // on the roster path, and the roles' own mint does not reach the path the
    // floor sits on. Under `cfcWriteFloor: "enforce"` every write to the
    // roster is refused, so the floor had to gain the mint that satisfies it,
    // and the roster had to name the same atom the spot list is floored on —
    // a write may only consume reads that all carry one witness for its floor,
    // and checking a spot write reads the roster. The floor also gained a
    // `writeAuthorizedBy` binding, so the roster is written by one reviewed
    // handler rather than by any action that happens to hold the cell.
    pattern: "factory-outputs/parking-coordinator/main.tsx",
    baselines: [
      "20260729T022742Z-ZaBTuPX0s1ITifoj",
      "20260804T003803Z-xkP59lcpdOUTy_M1",
    ],
    // `ifc` is compared for exact equality, so any correction to an
    // unsatisfiable floor reads as a break. Both roles name the same one
    // path: the roster's own.
    paths: [
      "argument.adminRegistry.admins",
      "result.adminRegistry.admins",
    ],
    reason:
      "The admin roster's integrity floor was unsatisfiable, so no write to " +
      "it could be accepted once the write floor is enforced. Correcting the " +
      "declaration changes the `ifc` at that path, which no shape of the " +
      "pattern avoids. A piece holding a roster keeps its stored roles; what " +
      "it loses is the ability to be updated in place to the corrected " +
      "contract.",
    record: "docs/history/parking-admin-floor-contract-break.md",
  },
  {
    // Lot Watch's admin roster declared a `requiredIntegrity` floor nothing
    // could satisfy: no `addIntegrity` mint on the roster path, and a floor
    // atom that differed from the one its roles carry, so the roster read a
    // roster change has to make could never witness the floor either. Under
    // `cfcWriteFloor: "enforce"` every write to the roster is refused. The
    // declaration gained the mint, the single `lot-watch-admin` atom, and a
    // `writeAuthorizedBy` binding naming the one handler that may write it,
    // so the roster is no longer written by any action that holds the cell.
    pattern: "factory-outputs/lot-watch/main.tsx",
    baselines: [
      "20260729T022742Z-W-iDVp0QJ9fPJBsi",
      "20260804T003803Z-MtNQDxsoMJZjryZC",
    ],
    // `ifc` is compared for exact equality, so any correction to an
    // unsatisfiable floor reads as a break. The registry is not published in
    // the result, so only the argument role names the roster's own path.
    paths: ["argument.adminRegistry.admins"],
    reason:
      "The admin roster's integrity floor was unsatisfiable, so no write to " +
      "it could be accepted once the write floor is enforced. Correcting the " +
      "declaration changes the `ifc` at that path, which no shape of the " +
      "pattern avoids. A piece holding a roster keeps its stored roles; what " +
      "it loses is the ability to be updated in place to the corrected " +
      "contract.",
    record: "docs/history/lot-watch-admin-floor-contract-break.md",
  },
  {
    // The lunch poll's identity moved from display names to profile cells
    // (see docs/history/lunch-poll-identity-break.md). The proof reports two
    // paths here: the published name-keyed admin result went away, and the
    // visit array's legacy roster links were replaced by optional profile
    // links. Cell metadata is stable under default insertion, so the proof
    // identifies the incompatible link at `loggedBy`. The
    // vintage replay still preserves the stored visit rows.
    pattern: "lunch-poll/main.tsx",
    baselines: ["20260729T022742Z-5bjUubcOZ-gpvz7F"],
    paths: ["argument.visits[].loggedBy", "result.adminName"],
    reason: "Lunch-poll identity moved from display names to profile cells. " +
      "The published `adminName` result cannot survive the removal of " +
      "name-keyed identity; `argument.visits[].loggedBy` identifies the " +
      "legacy roster link that became an optional profile link. The vintage " +
      "replay preserves those rows, but the root argument contract cannot " +
      "be updated in place.",
    record: "docs/history/lunch-poll-identity-break.md",
  },
  {
    // Same decision, seen from the join card. The removed optional admin input
    // is compatible; the checker exemption is only for `me`, which published
    // the viewer's display name as identity. Joined-ness and host status are
    // now derived from profile-cell comparison.
    pattern: "lunch-poll/participant-identity-card.tsx",
    baselines: ["20260729T022742Z-KMaq_J9475tWtRxW"],
    paths: ["result.me"],
    reason: "Lunch-poll identity moved from display names to profile cells. " +
      "The card's published `me` result treated the viewer's display name as " +
      "identity, so it goes with the model it keyed.",
    record: "docs/history/lunch-poll-identity-break.md",
  },
  {
    pattern: "agent-sessions-debug/main.tsx",
    baselines: ["20260818T001423Z-_DSuxwZWgUTcB_2z"],
    // The proof reports `ownerDid` first. Holding it compatible in a separate
    // proof reports the command cell's change from an optional opaque input to
    // the required writable queue that the connector host supplies.
    paths: ["argument.ownerDid", "argument.commandsCell"],
    reason:
      "Before its first deployment, the connector-managed debug view changed " +
      "to require the host's configured owner DID and one authoritative, " +
      "writable command queue. The owner isolates discovery and commands in " +
      "a shared space, while the writable queue is the host's protected " +
      "command input. The earlier contract was not deployed, and neither " +
      "input has a safe compatibility default.",
    record: "docs/history/agent-connector-owner-identity-break.md",
  },
  {
    // A parking-admin role named a person by name. Review asked for the CFC
    // primitives instead — compare profiles by their cells, not by what those
    // cells are called — so a role names the viewer's `#profile` cell, and the
    // stored shape of a role changed with it.
    pattern: "factory-outputs/parking-coordinator/main.tsx",
    baselines: [
      "20260820T191154Z-Fah23u1z5LYk4qKk",
      "20260825T211621Z-wEoO6wvf7g-fhtJd",
    ],
    // The same change seen from the two roles a contract has: the subject is a
    // cell where it was an inline object, and the name inside it goes with it.
    paths: [
      "argument.adminRegistry.admins[].subject",
      "result.adminRegistry.admins[].subject.personName",
    ],
    reason:
      "A role's subject moved from a person's name to their profile cell, so " +
      "authority is compared by identity rather than by a string. A stored " +
      "role of the old shape names nobody the pattern can resolve, and the " +
      "piece holding it keeps running its own source; a space starting over " +
      "on the new contract recovers through the same open-roster bootstrap " +
      "that lets a fresh space have an admin at all.",
    record: "docs/history/parking-admin-profile-subject-break.md",
  },
  {
    // The exemplar's index rows became the members themselves. A row's own
    // address is the item's address, so nothing in a row carries a separate
    // reference to it; and a row reads the board's name for its item out of
    // the item's own `shortName`, so the demand carries that member too.
    pattern: "collection-naming/board.tsx",
    baselines: [
      "20260904T001531Z-WRSzkgeFJQmQt1ZM",
      "20260904T022635Z-OsLnrwxWR4PfC0gG",
    ],
    // The one ruling seen from the two roles a contract has: the published
    // row lost the reference the derived row document carried, and the demand
    // gained the defaulted `shortName` a row reads its name from.
    paths: [
      "argument.items[]",
      "result.index[].member",
    ],
    reason:
      "An index row IS the member, so the derived row document's `member` " +
      "reference is what the ruling removed, and no shape of the board both " +
      "keeps it and makes a row the member. The row demand's `shortName` " +
      "needs its `| undefined` arm, without which the pattern compiler " +
      "refuses the board where an item meets the row type, and that arm moves " +
      "the demand's defaults below a constraint the proof cannot prove stable " +
      "under default insertion. The exemplar had no instance beyond a " +
      "throwaway local demo, so no piece held the contract this replaces.",
    record: "docs/history/collection-naming-index-rows-break.md",
  },
  {
    // A second entry for this pattern, with baselines disjoint from the other
    // one's: the gate keys accepted pairs into a Map, so a baseline named
    // twice would take the later path set in place of the earlier one. The
    // older baselines report this same narrowing for the argument role and
    // name it in their own entry above, beside the breaks only they carry.
    pattern: "topics/topic.tsx",
    baselines: [
      "20260826T221814Z-RZiIzB74VkCoXYty",
      "20260831T181712Z-hoTDhhCHJzB2Umnc",
      "20260831T204059Z-2Fi9qBnr1mK4_p2J",
      "20260901T191235Z-4uo6zrdZRahgZ98O",
      "20260905T021503Z-Y-lXQUSup41JBSeM",
      "20260906T050633Z-d6Et9xqrHqjlhlzA",
    ],
    // One path, and only in the argument role: the element type is untouched,
    // so `asCell` at the mention universe's own node is the whole break.
    paths: ["argument.mentionable"],
    reason:
      "The board's mention universe reaches a topic as a readable cell rather " +
      "than a writable one, so the retained link's proof drops the write-back " +
      "leg that refused a topic its own bytes. `asCell` is compared for exact " +
      "equality, so narrowing a cell reads as a break however narrow the " +
      "narrowing is. The one shape that keeps the writable handle instead " +
      "declares the board's `piece` on the topic's projection, which is the " +
      "wide demand the narrow one was adopted to avoid. A deployed topic takes " +
      "this one update forced and is proven again on every update after it.",
    record: "docs/history/topics-mentionable-readonly-break.md",
  },
  {
    // A SECOND entry for this pattern, and no baseline here appears above:
    // the pairs stay disjoint so that the older ones, which predate
    // `shortName` entirely, keep the tight bound the entry above gave them.
    //
    // The exemplar's `shortName` takes the spelling Topics ships,
    // `shortName?: string`. One property in two roles here, because a row IS
    // the item: the board's demand of a stored item, and the row the board
    // publishes.
    pattern: "collection-naming/board.tsx",
    baselines: [
      "20260904T051612Z-5rtP1U2c-e31PtKt",
      "20260904T063417Z-pWfbKiYw-7bd7xpC",
      "20260905T003604Z-uX940wR7R4lVwuOt",
    ],
    // The one spelling seen from the two roles a contract has: an optional
    // property carries no default, so the demand's defaults move, and the
    // published row stops requiring the name. Stable cell metadata lets the
    // proof identify the incompatible type at `shortName`.
    paths: [
      "argument.items[].shortName",
      "result.index[].shortName",
    ],
    reason:
      "The exemplar exists to prove a contract before it is grafted onto " +
      "Topics, and on this property it proved a spelling Topics does not " +
      "ship. Aligning it makes the demand's defaults move and drops the " +
      "published row's requirement, neither of which any shape of the board " +
      "avoids while the property is optional. The exemplar has no " +
      "deployment, so no piece holds the contract this replaces.",
    record: "docs/history/collection-naming-shortname-spelling-break.md",
  },
  {
    // The member's side of the same alignment: an item publishes its name the
    // way a topic does, and demands it of a universe entry the same way.
    pattern: "collection-naming/item.tsx",
    baselines: [
      "20260904T001531Z-z0Gy14PpefRML1fx",
      "20260904T022635Z-GMG883UMGFeAnh-r",
    ],
    // These two baselines predate the item's mention universe, so the
    // published name is the whole of what they blame.
    paths: ["result.shortName"],
    reason:
      "An item publishes `shortName` as `shortName?: string`, the spelling " +
      "Topics ships, where it published a required property whose type " +
      "admitted `undefined`. The published property stops being required, " +
      "which no shape of the item avoids while it is optional. The exemplar " +
      "has no deployment, so no piece holds the contract this replaces.",
    record: "docs/history/collection-naming-shortname-spelling-break.md",
  },
  {
    // A second entry for the item, keeping its pairs disjoint from the two
    // above for the reason the board's pair of entries states.
    //
    // Carried here: the `shortName` alignment recorded in the entry above,
    // and the mention universe becoming a readable binding — the two
    // breaks land on the same baselines, which is what puts them in one
    // entry.
    pattern: "collection-naming/item.tsx",
    baselines: [
      "20260904T082808Z-1fwb7SfgxGYK3VR0",
      "20260905T003605Z-gslMTuThImQHhkVQ",
    ],
    // These two carry the mention universe, which is what makes them the
    // pairs both breaks blame. `asCell` is compared for exact equality, so
    // the readable binding is reported at the whole property rather than at
    // an element of it, and it is reported ahead of the defaults the
    // optional `shortName` moves.
    paths: [
      "argument.mentionable",
      "result.shortName",
    ],
    reason:
      "Two accepted breaks on one pattern. An item publishes `shortName` as " +
      "`shortName?: string`, the spelling Topics ships, and demands it of a " +
      "universe entry the same way " +
      "(docs/history/collection-naming-shortname-spelling-break.md). And " +
      "the universe binding became readable, recorded below. Neither has a " +
      "shape of the item that avoids the break, and the exemplar has no " +
      "deployment, so no piece holds the contract they replace.",
    record: "docs/history/collection-naming-mentionable-readonly-break.md",
  },
  {
    // Two entries, one per pattern, for one ruling: `LLMMessageSchema` stopped
    // admitting the `system` role, and that schema reaches the argument
    // contract of every pattern whose `messages` it types.
    pattern: "chatbot.tsx",
    baselines: [
      "20260729T022742Z-Wx_o-CaAUThcJygl",
      "20260818T183826Z-ibsxlvix5LQH7bfY",
    ],
    paths: [
      "argument.messages[].role",
    ],
    reason:
      "A system instruction travels in the request's `system` field. The " +
      "guard the toolshed route gates on refused a system-role message " +
      "already, and behind it the AI SDK refuses one inside `messages` " +
      "whatever its content, so the role named a message no piece could ever " +
      "send. An enum in a deployed contract cannot stop accepting a value " +
      "compatibly, and no shape of the schema both drops the role and applies " +
      "over a baseline declaring it. The narrowing strands nothing: the " +
      "runtime enforces an enum neither on read nor on write, so a stored " +
      "system-role message materializes under the new contract unchanged.",
    record: "docs/history/features/llm-message-role-narrowing-break.md",
  },
  {
    // The second pattern of the same ruling. Its baseline appears in no other
    // entry, so the pairs stay disjoint.
    pattern: "deep-research.tsx",
    baselines: [
      "20260729T022742Z-6PInVAlNOHThJNGH",
    ],
    paths: [
      "argument.messages[].role",
    ],
    reason:
      "The `system` role leaving `LLMMessageSchema`, recorded once for both " +
      "patterns it breaks.",
    record: "docs/history/features/llm-message-role-narrowing-break.md",
  },
  {
    // A pattern's result schema no longer carries the least upper bound of
    // its argument schema's `ifc.confidentiality` at its root. That clause was
    // a dependency measurement written into the component CFC §8.12.8 reserves
    // for declared store policy, and at a document root it covers every field,
    // `$UI` included — which is what denied the whole rendered sub-view of any
    // pattern holding a confidential argument. The author's own per-field
    // declarations are untouched.
    pattern: "budget-tracker/confidential.tsx",
    baselines: [
      "20260818T045519Z-gy2rtE24CYfgovy8",
    ],
    // `ifc` is compared for exact equality, so dropping the synthesized clause
    // reads as a break. It sat at the result root, which the proof names as
    // the whole role.
    paths: [
      "result",
    ],
    reason:
      "The builder synthesized a covering confidentiality clause at the " +
      "result schema's root from the argument schema's shape, measuring no " +
      "transaction. Stored, it labels every field of the result document, so " +
      "the display ceiling denies the pattern's entire view. No shape of the " +
      "pattern avoids the change: the clause came from the builder rather " +
      "than from the source. A deployed piece keeps its stored labels, which " +
      "are grow-only; what it loses is the ability to be updated in place " +
      "onto the narrowed contract.",
    record: "docs/history/pattern-result-ifc-contract-break.md",
  },
  {
    // The second pattern of the same ruling. Its baseline appears in no other
    // entry, so the pairs stay disjoint.
    pattern: "cfc-input-cell-demo/briefing.tsx",
    baselines: [
      "20260828T041445Z-xK1PX5XOqtJknIj6",
    ],
    paths: [
      "result",
    ],
    reason: "The synthesized result-root confidentiality clause leaving the " +
      "builder, recorded once for all three patterns it breaks. This one " +
      "exists to show that its two results carry different labels, which a " +
      "clause on the object containing them contradicted.",
    record: "docs/history/pattern-result-ifc-contract-break.md",
  },
  {
    // The third pattern of the same ruling.
    pattern: "cfc-input-cell-demo/seed.tsx",
    baselines: [
      "20260828T041445Z-77e4kMM67vF8OWFf",
    ],
    paths: [
      "result",
    ],
    reason: "The synthesized result-root confidentiality clause leaving the " +
      "builder, recorded once for all three patterns it breaks. This one " +
      "seeds one labeled cell beside one unlabeled cell, which a clause over " +
      "both defeated.",
    record: "docs/history/pattern-result-ifc-contract-break.md",
  },
  {
    // The Send verb's event opens, the same break the roster Join verbs took
    // above: `Record<PropertyKey, never>` compiled to a closed empty object,
    // which the runner's closed-world gate enforces, so the Send button's
    // serialized DOM event was refused and no message could be sent. `void`
    // is a different recorded contract for the stream; nothing held state
    // under the old one.
    pattern: "profile-group-chat/main.tsx",
    baselines: ["20260729T022742Z-VIR19UFKyKrauX_B"],
    paths: ["result.sendMessage"],
    reason:
      "the Send verb's closed empty event refused every rendered click; re-declared void",
    record: "docs/history/chat-send-event-opened.md",
  },
  {
    // The same break in the scoped chat, same record.
    pattern: "scoped-group-chat/main-plain-inputs.tsx",
    baselines: [
      "20260729T022742Z-Z-pkp9K1p6P_byR_",
      "20260909T184756Z-M530BSuyTtIuZ_9J",
    ],
    paths: ["result.sendMessage"],
    reason:
      "the Send verb's closed empty event refused every rendered click; re-declared void",
    record: "docs/history/chat-send-event-opened.md",
  },
  {
    // The same break in the scoped chat's writable-input variant, same record.
    pattern: "scoped-group-chat/main-with-writable-inputs.tsx",
    baselines: [
      "20260729T022742Z-_XyScfA2QEj14JnS",
      "20260909T184756Z-NMt89YDsQnt_urES",
    ],
    paths: ["result.sendMessage"],
    reason:
      "the Send verb's closed empty event refused every rendered click; re-declared void",
    record: "docs/history/chat-send-event-opened.md",
  },
  {
    // #7976 was reverted. Its printed-type-node reading narrowed this
    // result (`$UI` from `true` to the `JSXElement` shape) and recorded the
    // baseline below; the revert restores the contract recorded before it.
    pattern: "examples/fetch-program-test.tsx",
    baselines: ["20260923T184038Z-XJY1r8MIb3iWMhNG"],
    paths: ["result.$UI"],
    reason:
      "#7976 reverted: the result returns to the contract recorded before it",
    record: "docs/history/printed-type-node-revert-break.md",
  },
  {
    // The same revert, same record.
    pattern: "system/knowledge-graph.tsx",
    baselines: ["20260923T184039Z-rq8KAA-ICBTFDbI6"],
    paths: ["result.$UI"],
    reason:
      "#7976 reverted: the result returns to the contract recorded before it",
    record: "docs/history/printed-type-node-revert-break.md",
  },
];
