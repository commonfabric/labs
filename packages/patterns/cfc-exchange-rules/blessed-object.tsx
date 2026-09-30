/**
 * A policy that releases an object one function of its own module computed.
 *
 * The companion of `blessed-computation.tsx`, whose blessed function returns a
 * string. Here the blessed function returns an object, so a reader of the
 * released value also reads the object node, whose membership stamps must name
 * the function as well as its fields do. Each brief carries
 * `PolicyOf<typeof countRules>`, and the room stores admit only public values,
 * so a write into one succeeds only when every clause it consumed is released.
 * When every write of a transaction comes from one verified function, the
 * runtime mints `TransformedBy` onto what it writes, the object node's stamps
 * included, naming the function's module by content identity and the function
 * by its export name; the rule matches that atom with
 * `THIS_POLICY.moduleIdentity`, so it keeps naming this module's `countBallot`
 * however the module is edited.
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

export const countRules = exchangeRules([releaseCounts]);

export interface Brief {
  vote: "approve" | "reject";
  note: string;
}

export type PrivateBrief = Confidential<
  Brief,
  readonly [PolicyOf<typeof countRules>]
>;

export interface Counts {
  approve: number;
  reject: number;
}

/** The counts, as a store anyone in the room may read. */
export type RoomCounts = MaxConfidentiality<Counts, readonly []>;

const countVotes = (briefs: readonly Brief[] | undefined): Counts => {
  let approve = 0;
  let reject = 0;
  for (const brief of briefs ?? []) {
    if (brief?.vote === "approve") approve++;
    else if (brief?.vote === "reject") reject++;
  }
  return { approve, reject };
};

/** The released computation: the counts, and nothing of any note. */
export const countBallot = lift((briefs: Brief[] | undefined): Counts =>
  countVotes(briefs)
);

/** The same counts from a function no rule names, so not released. */
export const countByHand = lift((briefs: Brief[] | undefined): Counts =>
  countVotes(briefs)
);

interface BlessedObjectInput {
  briefs: Writable<Default<PrivateBrief[], []>>;
  // The stores start at counts no ballot produces, so a refused publish is
  // told apart from one that wrote zeros.
  roomCounts: Writable<Default<RoomCounts, { approve: -1; reject: -1 }>>;
  roomHandCounts: Writable<Default<RoomCounts, { approve: -1; reject: -1 }>>;
}

export interface BlessedObjectOutput {
  [NAME]: string;
  [UI]: VNode;
  counts: Counts;
  roomCounts: RoomCounts;
  roomHandCounts: RoomCounts;
  submit: Stream<Brief>;
  publishCounts: Stream<void>;
  publishHandCounts: Stream<void>;
}

const submitBrief = handler<Brief, { briefs: Writable<PrivateBrief[]> }>(
  (brief, { briefs }) => {
    briefs.push(brief as PrivateBrief);
  },
);

const publishCounts = handler<void, { from: Counts; to: Writable<RoomCounts> }>(
  (_, { from, to }) => {
    to.set({ approve: from.approve, reject: from.reject });
  },
);

const BlessedObject = pattern<BlessedObjectInput, BlessedObjectOutput>(
  ({ briefs, roomCounts, roomHandCounts }) => {
    const counts = countBallot(briefs);
    const handCounts = countByHand(briefs);
    return {
      [NAME]: "Blessed CFC object computation",
      [UI]: (
        <cf-screen title="Blessed CFC object computation">
          <cf-vstack gap="2" style={{ padding: "1rem" }}>
            <cf-label>Released counts</cf-label>
            <div id="blessed-object-approve">{roomCounts.key("approve")}</div>
            <div id="blessed-object-reject">{roomCounts.key("reject")}</div>
          </cf-vstack>
        </cf-screen>
      ),
      counts,
      roomCounts,
      roomHandCounts,
      submit: submitBrief({ briefs }),
      publishCounts: publishCounts({ from: counts, to: roomCounts }),
      publishHandCounts: publishCounts({
        from: handCounts,
        to: roomHandCounts,
      }),
    };
  },
);

export default BlessedObject;
