import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { sortDisplayMessages } from "./logic.ts";

// Thread order must be deterministic for messages that land in the same
// millisecond — the tiebreaker chain (author → body → origin) is the contract
// that keeps two replicas rendering one thread in one order. The pattern tests
// exercise these branches only when the harness happens to send two messages
// inside a single millisecond, so this pins the semantics with fixed
// timestamps instead of a clock race.

type ThreadMessage = {
  authorName: string;
  body: string;
  origin: "sent" | "imported";
  timestamp: number;
};

const msg = (
  authorName: string,
  body: string,
  origin: ThreadMessage["origin"],
  timestamp: number,
): ThreadMessage => ({ authorName, body, origin, timestamp });

describe("sortDisplayMessages thread order", () => {
  it("orders by timestamp before anything else", () => {
    const later = msg("alice", "first alphabetically", "sent", 2_000);
    const earlier = msg("zed", "zzz", "sent", 1_000);
    expect(sortDisplayMessages([later, earlier])).toEqual([earlier, later]);
  });

  it("breaks same-millisecond ties by author name", () => {
    const bob = msg("bob", "hi", "sent", 1_000);
    const alice = msg("alice", "hi", "sent", 1_000);
    expect(sortDisplayMessages([bob, alice])).toEqual([alice, bob]);
  });

  it("breaks same-author same-millisecond ties by body", () => {
    const second = msg("alice", "beta", "sent", 1_000);
    const first = msg("alice", "alpha", "sent", 1_000);
    expect(sortDisplayMessages([second, first])).toEqual([first, second]);
  });

  it("breaks identical-content ties by origin", () => {
    const sent = msg("alice", "hi", "sent", 1_000);
    const imported = msg("alice", "hi", "imported", 1_000);
    expect(sortDisplayMessages([sent, imported])).toEqual([imported, sent]);
  });

  it("yields one thread order from any arrival order", () => {
    const a = msg("alice", "alpha", "sent", 1_000);
    const b = msg("bob", "beta", "imported", 1_000);
    const c = msg("bob", "gamma", "sent", 1_000);
    const d = msg("carol", "delta", "sent", 2_000);
    const sorted = sortDisplayMessages([a, b, c, d]);
    expect(sortDisplayMessages([d, c, b, a])).toEqual(sorted);
    expect(sortDisplayMessages([c, a, d, b])).toEqual(sorted);
  });

  it("does not mutate its input", () => {
    const input = [
      msg("bob", "hi", "sent", 2_000),
      msg("alice", "hi", "sent", 1_000),
    ];
    const before = [...input];
    sortDisplayMessages(input);
    expect(input).toEqual(before);
  });
});
