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

// The policy releases the tally only when everything the tally read was
// written by this module's `commit` step. The identity alone would release
// whatever `tallyBallot` computed, over any input a caller chose; the
// `inputWitness` names the code that must have written the tally's
// confidential inputs, so a vote list written by any other code is refused.
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
      inputWitness: {
        type: "https://commonfabric.org/cfc/atom/TransformedBy",
        identity: {
          kind: "verified",
          moduleIdentity: THIS_POLICY.moduleIdentity,
          symbol: "commit",
        },
      },
    }],
  },
  post: { dropClause: true },
});

export const ballotRules = exchangeRules([releaseTally]);

export interface Brief {
  vote: "approve" | "reject";
}

export type Sealed<T> = Confidential<
  T,
  readonly [PolicyOf<typeof ballotRules>]
>;

/** A store anyone in the room may read: it admits only public values. */
export type RoomText = MaxConfidentiality<string, readonly []>;

export interface Committed {
  votes: string[];
}

export const submit = handler<Brief, { briefs: Writable<Sealed<Brief>[]> }>(
  (brief, { briefs }) => {
    briefs.push({ vote: brief.vote } as Sealed<Brief>);
  },
);

/** The endorsed step whose output the tally must have read. */
export const commit = handler<
  void,
  { briefs: Sealed<Brief>[]; committed: Writable<Sealed<Committed>> }
>((_, { briefs, committed }) => {
  committed.set(
    { votes: (briefs ?? []).map((brief) => brief?.vote ?? "") } as Sealed<
      Committed
    >,
  );
});

/** Not the endorsed step: writes a vote list of its own choosing. */
export const forgeCommitted = handler<
  void,
  { briefs: Sealed<Brief>[]; committed: Writable<Sealed<Committed>> }
>((_, { briefs, committed }) => {
  committed.set(
    { votes: (briefs ?? []).map(() => "approve") } as Sealed<Committed>,
  );
});

/** Not the endorsed step: adds one vote beside the committed ones. */
export const appendVote = handler<
  void,
  { committed: Writable<Sealed<Committed>> }
>((_, { committed }) => {
  committed.key("votes").push("approve");
});

/** Not the endorsed step: copies the committed votes into a list of its own. */
export const relayVotes = lift((
  committed: Committed | undefined,
): Committed => ({
  votes: [...(committed?.votes ?? [])],
}));

/** The released computation: how many votes approve. */
export const tallyBallot = lift((committed: Committed | undefined): string =>
  String(
    (committed?.votes ?? []).filter((vote) => vote === "approve").length,
  )
);

interface WitnessedChainInput {
  briefs: Writable<Default<Sealed<Brief>[], []>>;
  committed: Writable<Default<Sealed<Committed>, { votes: [] }>>;
}

export interface WitnessedChainOutput {
  [NAME]: string;
  [UI]: VNode;
  tally: string;
  relayTally: string;
  submit: Stream<Brief>;
  commit: Stream<void>;
  forge: Stream<void>;
  append: Stream<void>;
}

const WitnessedChain = pattern<WitnessedChainInput, WitnessedChainOutput>(
  ({ briefs, committed }) => {
    const tally = tallyBallot(committed);
    const relayTally = tallyBallot(relayVotes(committed));
    return {
      [NAME]: "Witnessed CFC chain",
      [UI]: (
        <cf-screen title="Witnessed CFC chain">
          <cf-vstack gap="2" style={{ padding: "1rem" }}>
            <cf-label>Tally</cf-label>
            <div id="witnessed-chain-tally">{tally}</div>
          </cf-vstack>
        </cf-screen>
      ),
      tally,
      relayTally,
      submit: submit({ briefs }),
      commit: commit({ briefs, committed }),
      forge: forgeCommitted({ briefs, committed }),
      append: appendVote({ committed }),
    };
  },
);

export default WitnessedChain;
