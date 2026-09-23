/**
 * A policy that releases what named functions of its own module computed.
 *
 * Each brief carries `PolicyOf<typeof ballotRules>`, and the room stores admit
 * only public values, so a write into one succeeds only when every clause it
 * consumed is released. When every write of a transaction comes from one
 * verified function, the runtime mints `TransformedBy` onto what it writes,
 * naming the function's module by content identity and the function by its
 * export name, so a blessed function must be exported under that one name. Each
 * rule matches that atom with `THIS_POLICY.moduleIdentity`, which binds to the
 * identity of the module defining the rules, so the rules keep naming this
 * module's functions however the module is edited. An object output is released
 * the same way as a scalar one.
 */

import {
  type Confidential,
  Default,
  handler,
  lift,
  type MaxConfidentiality,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
} from "commonfabric/cfc";

export const releaseTally = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "https://commonfabric.org/cfc/atom/TransformedBy",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "tallyBallot",
      },
    }],
  },
  post: { dropClause: true },
});

export const releaseCounts = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "https://commonfabric.org/cfc/atom/TransformedBy",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "countBallot",
      },
    }],
  },
  post: { dropClause: true },
});

export const ballotRules = exchangeRules([releaseTally, releaseCounts]);

export interface Brief {
  vote: "approve" | "reject";
  note: string;
}

export type PrivateBrief = Confidential<
  Brief,
  readonly [PolicyOf<typeof ballotRules>]
>;

/** A store anyone in the room may read: it admits only public values. */
export type RoomText = MaxConfidentiality<string, readonly []>;

export interface Counts {
  approve: number;
  reject: number;
}

/** The counts, as a store anyone in the room may read. */
export type RoomCounts = MaxConfidentiality<Counts, readonly []>;

const countVotes = (briefs: readonly Brief[] | undefined) => {
  let approve = 0;
  let reject = 0;
  for (const brief of briefs ?? []) {
    if (brief?.vote === "approve") approve++;
    else if (brief?.vote === "reject") reject++;
  }
  return { approve, reject };
};

/** A released computation: the counts, and nothing of any note. */
export const tallyBallot = lift((briefs: Brief[] | undefined): string => {
  const { approve, reject } = countVotes(briefs);
  return `${approve}-${reject}`;
});

/** The released computation again, returning an object. */
export const countBallot = lift((briefs: Brief[] | undefined): Counts =>
  countVotes(briefs)
);

/** The same counts from a function no rule names, so not released. */
export const countByHand = lift((briefs: Brief[] | undefined): Counts =>
  countVotes(briefs)
);

/** Defined beside `tallyBallot` but named by no rule, so not released. */
export const echoNotes = lift((briefs: Brief[] | undefined): string =>
  (briefs ?? []).map((brief) => brief?.note ?? "").join("|")
);

interface BlessedComputationInput {
  briefs: Writable<Default<PrivateBrief[], []>>;
  roomTally: Writable<Default<RoomText, "">>;
  roomEcho: Writable<Default<RoomText, "">>;
  roomNote: Writable<Default<RoomText, "">>;
  roomCounts: Writable<Default<RoomCounts, { approve: 0; reject: 0 }>>;
  roomHandCounts: Writable<Default<RoomCounts, { approve: 0; reject: 0 }>>;
}

export interface BlessedComputationOutput {
  [NAME]: string;
  [UI]: VNode;
  tally: string;
  roomTally: RoomText;
  roomEcho: RoomText;
  roomNote: RoomText;
  roomCounts: RoomCounts;
  roomHandCounts: RoomCounts;
  submit: Stream<Brief>;
  publishTally: Stream<void>;
  publishEcho: Stream<void>;
  publishFirstNote: Stream<void>;
  publishCounts: Stream<void>;
  publishHandCounts: Stream<void>;
}

const submitBrief = handler<Brief, { briefs: Writable<PrivateBrief[]> }>(
  (brief, { briefs }) => {
    briefs.push(brief as PrivateBrief);
  },
);

const publishText = handler<void, { from: string; to: Writable<RoomText> }>(
  (_, { from, to }) => {
    to.set(from);
  },
);

const publishCounts = handler<void, { from: Counts; to: Writable<RoomCounts> }>(
  (_, { from, to }) => {
    to.set({ approve: from.approve, reject: from.reject });
  },
);

const publishNote = handler<
  void,
  { briefs: PrivateBrief[]; to: Writable<RoomText> }
>((_, { briefs, to }) => {
  to.set(briefs[0]?.note ?? "");
});

const BlessedComputation = pattern<
  BlessedComputationInput,
  BlessedComputationOutput
>(({ briefs, roomTally, roomEcho, roomNote, roomCounts, roomHandCounts }) => {
  const tally = tallyBallot(briefs);
  const echoed = echoNotes(briefs);
  const counts = countBallot(briefs);
  const handCounts = countByHand(briefs);
  return {
    [NAME]: "Blessed CFC computation",
    [UI]: (
      <cf-screen title="Blessed CFC computation">
        <cf-vstack gap="2" style={{ padding: "1rem" }}>
          <cf-label>Released tally</cf-label>
          <div id="blessed-computation-tally">{roomTally}</div>
        </cf-vstack>
      </cf-screen>
    ),
    tally,
    roomTally,
    roomEcho,
    roomNote,
    roomCounts,
    roomHandCounts,
    submit: submitBrief({ briefs }),
    publishTally: publishText({ from: tally, to: roomTally }),
    publishEcho: publishText({ from: echoed, to: roomEcho }),
    publishFirstNote: publishNote({ briefs, to: roomNote }),
    publishCounts: publishCounts({ from: counts, to: roomCounts }),
    publishHandCounts: publishCounts({ from: handCounts, to: roomHandCounts }),
  };
});

export default BlessedComputation;
