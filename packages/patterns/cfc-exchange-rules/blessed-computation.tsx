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

// The policy releases what one function of this module computed. When every
// write of a transaction comes from one verified function, the runtime mints
// `TransformedBy` onto what it writes, naming the function's module by content
// identity and the function by its export name; `THIS_POLICY.moduleIdentity`
// binds to the identity of the module defining these rules, so the rule keeps
// naming this module's `tallyBallot` however the module is edited. `symbol` is
// that export name, so the function must be exported, under that one name.
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

export const ballotRules = exchangeRules([releaseTally]);

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

const countVotes = (briefs: readonly Brief[] | undefined) => {
  let approve = 0;
  let reject = 0;
  for (const brief of briefs ?? []) {
    if (brief?.vote === "approve") approve++;
    else if (brief?.vote === "reject") reject++;
  }
  return { approve, reject };
};

/** The released computation: the counts, and nothing of any note. */
export const tallyBallot = lift((briefs: Brief[] | undefined): string => {
  const { approve, reject } = countVotes(briefs);
  return `${approve}-${reject}`;
});

/** Defined beside `tallyBallot` but not named by the rule, so not released. */
export const echoNotes = lift((briefs: Brief[] | undefined): string =>
  (briefs ?? []).map((brief) => brief?.note ?? "").join("|")
);

interface BlessedComputationInput {
  briefs: Writable<Default<PrivateBrief[], []>>;
  roomTally: Writable<Default<RoomText, "">>;
  roomEcho: Writable<Default<RoomText, "">>;
  roomNote: Writable<Default<RoomText, "">>;
}

export interface BlessedComputationOutput {
  [NAME]: string;
  [UI]: VNode;
  tally: string;
  roomTally: RoomText;
  roomEcho: RoomText;
  roomNote: RoomText;
  submit: Stream<Brief>;
  publishTally: Stream<void>;
  publishEcho: Stream<void>;
  publishFirstNote: Stream<void>;
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

const publishNote = handler<
  void,
  { briefs: PrivateBrief[]; to: Writable<RoomText> }
>((_, { briefs, to }) => {
  to.set(briefs[0]?.note ?? "");
});

const BlessedComputation = pattern<
  BlessedComputationInput,
  BlessedComputationOutput
>(({ briefs, roomTally, roomEcho, roomNote }) => {
  const tally = tallyBallot(briefs);
  const echoed = echoNotes(briefs);
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
    submit: submitBrief({ briefs }),
    publishTally: publishText({ from: tally, to: roomTally }),
    publishEcho: publishText({ from: echoed, to: roomEcho }),
    publishFirstNote: publishNote({ briefs, to: roomNote }),
  };
});

export default BlessedComputation;
