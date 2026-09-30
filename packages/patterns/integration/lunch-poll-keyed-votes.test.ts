/**
 * Regression test: a lunch-poll vote is a KEYED, mergeable write.
 *
 * `castVote` addresses one vote by `(voter profile entity, option)` and manages
 * membership with `addUnique` / `removeByValue`. It never reads or rewrites the
 * whole vote list, so two people voting at the same time touch different
 * documents and their commits merge instead of conflicting and retrying.
 *
 * This is the property nothing else here could see. `main.test.tsx` drives one
 * runtime, so nothing in it is ever concurrent. `lunch-poll-vote.test.ts` drives
 * two browsers but asserts the OUTCOME — "2 love it" on both — and a whole-list
 * read-modify-write reaches that same outcome, by conflicting and retrying until
 * it converges. `packages/runner/test/array-push-mergeable.test.ts` covers
 * `elementById` / `addUnique` / `removeByValue` with hand-built cells, and the
 * machinery was never what broke. So a vote write can regress to
 * `votes.set([...])` with every one of them still green, while voting quietly
 * becomes a contention storm.
 *
 * What catches that is where the vote LIVES, not what the tally says. A keyed
 * write puts the vote at an address every session can compute; a whole-list
 * write puts it at an address minted from the writer's own commit, which no
 * other session can name. So the first test has one session read another
 * session's vote by key alone. Under a whole-list write the tally still reads
 * right and that read finds nothing.
 *
 * The second test is the same property in the units a person feels: three
 * voters recast every option at once, three rounds of it, and the burst
 * throws almost nothing away. Each voter's vote for an option is its own
 * document, so a burst of recasts holds no document two sessions both write,
 * and the color schedule advances every voter by one color a round, which
 * leaves each option holding one of every color throughout, so the tallies
 * the poll derives never change and never contend either.
 *
 * The schedule is what makes the count answer the question this file asks.
 * Casting the color already held clears the vote, and clearing one changes
 * the shared list's membership, which is what the sessions' concurrent
 * commits then get refused over. That cost is membership churn, and it is the
 * same whether the vote itself is keyed or not. A burst that repeats a color
 * pays it and measures something else. Each round therefore checks the vote
 * count has not moved, which is the schedule failing in the terms that say
 * why.
 *
 * The bound is one rolled-back write per vote, and it is a bound rather than
 * an equality because the count is not specific to the vote write: it is
 * every optimistic write this session had rolled back, whatever refused it.
 * The keyed burst measured 0 across twenty-two runs here and 7 once on a
 * loaded continuous-integration host under server execution, where a piece
 * whose instantiation loses a race contributes refusals of its own. A
 * whole-list write measured 67 and 68 (2026-09-02, this harness). So the
 * bound sits some five times above what a keyed burst costs and well below
 * what a whole-list one does, and neither margin rests on a single reading.
 *
 * The poll's identity is a shared `#profile` cell. The wish resolves in this
 * harness, and in a space holding no profile it resolves to the surface that
 * offers to create one — not to an identity a session can vote with. So the
 * sessions claim identities through the `lunch-poll-keyed-votes` fixture, and
 * everything under test is the poll's own handlers, driven through the poll's
 * own streams.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const ROOT_PATH = join(import.meta.dirname!, "..");
const PROGRAM_PATH = join(
  ROOT_PATH,
  "integration",
  "fixtures",
  "lunch-poll-keyed-votes",
  "main.tsx",
);

const NAMES = ["Alice", "Bob", "Carol"] as const;
const TITLES = ["Cheeseboard", "Gregoire", "Saul's", "Fava"] as const;
const COLORS = ["green", "yellow", "red"] as const;

/**
 * The color a voter casts for an option in a given round. Consecutive rounds
 * differ for every voter and option, so no cast ever repeats the color that
 * vote already holds and no cast is read as clearing it. Every option holds
 * one of each color in every round, so the poll's tallies never change.
 */
const colorFor = (voter: number, option: number, round: number): string =>
  COLORS[(voter + option + round) % COLORS.length];

/**
 * Optimistic writes these sessions had rolled back — each one applied locally,
 * refused by the server over a stale read, and undone. This is the cost a keyed
 * write is here to avoid, counted.
 */
async function reverts(
  sessions: readonly MultiRuntimeSession[],
): Promise<number> {
  const each = await Promise.all(sessions.map(async (session) => {
    const counts = await session.loggerCounts();
    return counts["storage.v2"]?.["commit-revert"]?.total ?? 0;
  }));
  return each.reduce((sum, n) => sum + n, 0);
}

/**
 * The refused commits of every session that wrote into `document`, one line
 * each, naming what refused them.
 *
 * `reverts` counts what a session threw away; this says which of those
 * commits touched a particular document. The two answer different questions,
 * and for the burst below the second is the one about the vote write.
 */
async function refusalsWriting(
  sessions: readonly MultiRuntimeSession[],
  document: string,
): Promise<string[]> {
  const lines = await Promise.all(
    sessions.map(async (session) =>
      (await session.rejections())
        .filter((rejection) => rejection.writes.includes(document))
        .map((rejection) => `  ${session.label}: ${rejection.message}`)
    ),
  );
  return lines.flat();
}

describe("lunch poll: a vote is a keyed, mergeable write", () => {
  let harness: MultiRuntimeHarness;
  let everyone: MultiRuntimeSession[];
  let host: MultiRuntimeSession;
  let options: string[];

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: NAMES.map((name) => ({ label: name.toLowerCase() })),
      // Records each refused commit, which is what `refusalsWriting` reads.
      recordRejections: true,
    });
    everyone = NAMES.map((name) => harness.session(name.toLowerCase()));
    host = everyone[0];

    // Each session claims its own profile and joins. The first to join hosts,
    // and only the host may add options.
    for (let i = 0; i < everyone.length; i++) {
      await everyone[i].send("claim", { name: NAMES[i] });
      await harness.settle();
      await everyone[i].send("joinAs", {});
      await harness.settle();
    }
    expect(await host.read(["userCount"])).toBe(NAMES.length);

    for (const title of TITLES) {
      await host.send("addOption", { title });
      await harness.settle();
    }
    options = (await host.read(["options"]) as { id: string }[])
      .map((option) => option.id);
    expect(options.length).toBe(TITLES.length);
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("stores a cast vote where another session reaches it by key", async () => {
    // The whole contract in one read. Alice votes; Bob computes the address of
    // Alice's vote from her profile and the option — no list involved — and
    // finds the vote there. A vote written as part of a whole-list value lives
    // at an address minted from Alice's own commit, which Bob cannot name, so
    // this read comes back empty while the tally still says one vote.
    const [alice, bob] = everyone;
    const option = options[0];

    await alice.send("castVote", { optionId: option, voteType: "green" });
    await harness.settle();
    expect(await alice.read(["voteCount"])).toBe(1);

    await bob.send("probeVote", { voterName: "Alice", optionId: option });
    await harness.settle();
    expect(
      await bob.read(["probedVote"]),
      "another session must reach the vote by its key alone; nothing here " +
        "means the vote was stored as part of a whole-list write",
    ).toEqual({ optionId: option, voteType: "green" });

    // Clearing drops the membership AND the entity, so the address goes empty
    // rather than keeping the removed vote's content for the next reader.
    await alice.send("clearMyVote", { optionId: option });
    await harness.settle();
    await bob.send("probeVote", { voterName: "Alice", optionId: option });
    await harness.settle();
    expect(await bob.read(["probedVote"])).toBe(null);
    expect(await alice.read(["voteCount"])).toBe(0);
  });

  it("shows one session's vote to another after it settles", async () => {
    // The narrowest statement of what a torn-down poll graph costs. Bob
    // votes; Alice's session must see the tally move. A session whose piece
    // lost its instantiation and was never re-instantiated keeps serving its
    // last durable value instead, so this read stays at zero while Bob's
    // write is sitting in the store. The burst test below catches the same
    // loss, but only as a side effect of counting rollbacks.
    const [, bob] = everyone;
    const option = options[1];

    await bob.send("castVote", { optionId: option, voteType: "green" });
    await harness.settle();
    expect(
      await host.read(["voteCount"]),
      "the host's graph must observe a vote another session cast",
    ).toBe(1);

    await bob.send("clearMyVote", { optionId: option });
    await harness.settle();
    expect(await host.read(["voteCount"])).toBe(0);
  });

  it("keeps a lunch-time burst from becoming a retry storm", async () => {
    // Everyone re-votes every option at once, repeatedly — the shape of a real
    // lunch decision, where a whole-list write makes each vote wait seconds.
    // Warm up first so no session is paying for a document it has never held; a
    // cold first write conflicts either way and is not what this measures. The
    // warm-up is round zero of the same schedule, so the first measured round
    // changes every color it touches.
    for (let voter = 0; voter < everyone.length; voter++) {
      for (let option = 0; option < options.length; option++) {
        await everyone[voter].send("castVote", {
          optionId: options[option],
          voteType: colorFor(voter, option, 0),
        });
        await harness.settle();
      }
    }
    const cast = everyone.length * options.length;
    expect(await host.read(["voteCount"])).toBe(cast);

    await harness.settle();
    const before = await reverts(everyone);
    await Promise.all(everyone.map((session) => session.clearRejections()));
    const votes = (await host.link(["votes"])).id;
    const rounds = 3;
    for (let round = 1; round <= rounds; round++) {
      await Promise.all(
        everyone.flatMap((session, voter) =>
          options.map((option, index) =>
            session.send(
              "castVote",
              { optionId: option, voteType: colorFor(voter, index, round) },
              undefined,
              { idle: false },
            )
          )
        ),
      );
      await harness.settle();
      // The count moving is the schedule having gone wrong, and it is worth
      // catching here rather than in the rollback total below. A cast in the
      // color a vote already holds reads as the voter clicking their own
      // color again, so `castVote` drops the vote — a membership write on the
      // one document every session shares, and the only write in this burst
      // another session's commit can go stale against. The rollback count
      // would then be measuring that, and how much of it each session sees is
      // a race.
      expect(
        await host.read(["voteCount"]),
        `round ${round} left the poll holding a different number of votes ` +
          "than it started with, so the burst is changing the shared list's " +
          "membership rather than recasting votes in place",
      ).toBe(cast);
    }
    const rolledBack = await reverts(everyone) - before;

    expect(
      rolledBack,
      `${rolledBack} rolled-back writes for ${cast * rounds} concurrent ` +
        "recasts; a recast writes one voter's own vote document and adds a " +
        "membership already present, so it shares no document with another " +
        "voter's recast and costs almost nothing. A count near this bound " +
        "means the vote write is contending on the whole list again",
    ).toBeLessThan(cast * rounds);

    // The count above is every optimistic write these sessions had rolled
    // back, whatever refused it, which is what makes it a bound. The refusals
    // themselves carry what each commit wrote, so this asks the narrower
    // question the count cannot: did any commit refused during the burst
    // write the list every voter shares? A recast writes one voter's own vote
    // document and leaves the list alone, so none of them did, and a refusal
    // from elsewhere on the host does not move this.
    const contended = await refusalsWriting(everyone, votes);
    expect(
      contended,
      "commits refused during a burst of recasts wrote the shared vote " +
        "list, so a recast is changing its membership after all:\n" +
        contended.join("\n"),
    ).toEqual([]);
  });
});
