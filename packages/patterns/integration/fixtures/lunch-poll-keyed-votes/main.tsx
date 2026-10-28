import {
  Default,
  handler,
  NAME,
  pattern,
  type PerSpace,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import LunchPoll, {
  type AddOptionEvent,
  type CastVoteEvent,
  type ClearVoteEvent,
  type JoinEvent,
  type LunchProfile,
  type Option,
  type RemoveOptionEvent,
  type ResetVotesEvent,
  type ViewerOverride,
  type Vote,
  voteKeyFor,
} from "../../../lunch-poll/main.tsx";

/**
 * Headless identity harness and keyed-address probe for the lunch poll —
 * fixture for lunch-poll-keyed-votes.test.ts.
 *
 * Two jobs, neither of which changes what the poll does.
 *
 * IDENTITY. The poll's identity is a shared `#profile` cell. In a space holding
 * no profile that wish resolves to the surface offering to create one, so a
 * session there has nothing to join or vote with until somebody uses it.
 * `claim` supplies what a resolved wish would: a
 * shared-space profile per claimed name, handed to the poll through its
 * `overrideViewer` seam. One session claims "Alice", another claims "Bob", and
 * the poll sees two participants whose identities are two distinct documents —
 * the production shape. The profile must be a document of the shared space,
 * never a per-user scoped cell: a scoped cell is one ADDRESS read through the
 * reader's own partition, so every session would store the same identity in the
 * roster and the second joiner would dedup into the first.
 *
 * ADDRESS. `probeVote` reads the vote list at the address the poll's own key
 * derivation names, and publishes what it finds as `probedVote`. That read
 * consults one entity and never the list, so it finds a vote only if the poll
 * stored it as a keyed element. The fixture holds the `votes` cell and hands it
 * to the poll so both name one document, which is what gives the probe a
 * writable handle to address elements from.
 *
 * `probedVote` is one slot shared by every session, so a test probes one
 * address at a time and reads the answer before probing the next.
 */

export interface KeyedVoteProbeInput {
  /** One profile document per claimed name, keyed by that name. */
  profiles?: PerSpace<LunchProfile[] | Default<[]>>;

  /** The poll's vote list, held here so the probe can address its elements. */
  votes?: PerSpace<Vote[] | Default<[]>>;

  /**
   * Show the poll's own view in place of this probe's one-line one, so a
   * client that renders this piece derives what a browser showing the poll
   * derives. Off, the probe's clients do no view work, which is what a test
   * of the vote write alone wants.
   */
  renderPoll?: Default<boolean, false>;
}

export interface ClaimEvent {
  name: string;
}

/** Which vote to look up: whose (by claimed name) and for which option. */
export interface ProbeVoteEvent {
  voterName: string;
  optionId: string;
}

/** What the vote list holds at one keyed address, or `null` for nothing. */
export interface ProbedVote {
  optionId: string;
  voteType: string;
}

export interface KeyedVoteProbeOutput {
  [NAME]: string;
  [UI]: VNode;
  claim: Stream<ClaimEvent>;
  probeVote: Stream<ProbeVoteEvent>;
  joinAs: Stream<JoinEvent>;
  addOption: Stream<AddOptionEvent>;
  removeOption: Stream<RemoveOptionEvent>;
  castVote: Stream<CastVoteEvent>;
  clearMyVote: Stream<ClearVoteEvent>;
  resetVotes: Stream<ResetVotesEvent>;
  probedVote: ProbedVote | null;
  votes: readonly Vote[];
  options: readonly Option[];
  users: readonly { name: string }[];
  joinMessage: string;
  voteCount: number;
  optionCount: number;
  userCount: number;
  myName: string;
  isJoined: boolean;
  isAdmin: boolean;
}

const claim = handler<ClaimEvent, {
  profiles: Writable<LunchProfile[]>;
  overrideViewer: Stream<ViewerOverride>;
}>(({ name }, { profiles, overrideViewer }) => {
  const profile = profiles.elementById(name);
  profile.set({ name });
  profiles.addUnique(profile);
  overrideViewer.send({ profile, name });
});

const probeVote = handler<ProbeVoteEvent, {
  profiles: Writable<LunchProfile[]>;
  votes: Writable<Vote[]>;
  probedVote: Writable<ProbedVote | null>;
}>(({ voterName, optionId }, { profiles, votes, probedVote }) => {
  const key = voteKeyFor(profiles.elementById(voterName), optionId);
  const found = key === undefined
    ? undefined
    : votes.elementById(key).get() as Vote | undefined;
  probedVote.set(
    found === undefined
      ? null
      : { optionId: found.optionId, voteType: found.voteType },
  );
});

export default pattern<KeyedVoteProbeInput, KeyedVoteProbeOutput>(
  ({ profiles, votes, renderPoll }) => {
    const poll = LunchPoll({ votes });
    const probed = Writable.of<ProbedVote | null>(null);
    return {
      [NAME]: "Lunch poll keyed-vote probe",
      [UI]: renderPoll ? poll[UI] : <div>lunch poll keyed-vote probe</div>,
      claim: claim({ profiles, overrideViewer: poll.overrideViewer }),
      probeVote: probeVote({ profiles, votes, probedVote: probed }),
      joinAs: poll.joinAs,
      addOption: poll.addOption,
      removeOption: poll.removeOption,
      castVote: poll.castVote,
      clearMyVote: poll.clearMyVote,
      resetVotes: poll.resetVotes,
      probedVote: probed,
      votes: poll.votes,
      options: poll.options,
      users: poll.users,
      joinMessage: poll.joinMessage,
      voteCount: poll.voteCount,
      optionCount: poll.optionCount,
      userCount: poll.userCount,
      myName: poll.myName,
      isJoined: poll.isJoined,
      isAdmin: poll.isAdmin,
    };
  },
);
