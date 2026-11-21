import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CommitSummary } from "@commonfabric/memory/v2";
import { historySteps } from "../src/history-steps.ts";

describe("historySteps()", () => {
  const commit = (
    seq: number,
    rest: Partial<CommitSummary> = {},
  ): CommitSummary => ({
    seq,
    branch: "",
    class: "authored",
    createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
    events: 0,
    writes: 1,
    ...rest,
  });

  const derived = (seq: number, derivedThrough: number): CommitSummary =>
    commit(seq, { class: "derived", derivedThrough, writes: 2 });

  it("returns one step per commit when no serving loop committed", () => {
    const steps = historySteps([commit(3), commit(2), commit(1)]);

    expect(steps.map(({ seq, startSeq, settled }) => [seq, startSeq, settled]))
      .toEqual([[3, 3, true], [2, 2, true], [1, 1, true]]);
  });

  it("returns a step that sent an event as not settled when a served space's loop has yet to commit", () => {
    const steps = historySteps([commit(2, { events: 1 }), commit(1)], {
      served: true,
    });

    expect(steps.map(({ seq, settled }) => [seq, settled]))
      .toEqual([[2, false], [1, true]]);
  });

  it("returns a step that sent no event as settled, however far the serving loop had computed", () => {
    const steps = historySteps([
      derived(4, 3),
      commit(3, { events: 1 }),
      commit(2),
      commit(1),
    ]);

    expect(steps.map(({ seq, settled }) => [seq, settled]))
      .toEqual([[4, true], [2, true], [1, true]]);
  });

  it("returns a step as not settled while an event of an earlier step is pending", () => {
    const steps = historySteps([
      derived(4, 2),
      commit(3),
      commit(2, { events: 1 }),
      derived(1, 0),
    ]);

    expect(steps.map(({ seq, settled }) => [seq, settled]))
      .toEqual([[4, true], [2, false]]);
  });

  it("returns the principal of the commit that began each step", () => {
    const steps = historySteps([
      derived(3, 2),
      commit(2, { events: 1, principal: "did:key:zAlice" }),
      commit(1),
    ]);

    expect(steps.map((step) => step.principal))
      .toEqual(["did:key:zAlice", undefined]);
  });

  it("ends a step at the last commit the serving loop made for it", () => {
    const steps = historySteps([
      derived(5, 3),
      derived(4, 3),
      commit(3, { events: 1 }),
      derived(2, 1),
      commit(1),
    ]);

    expect(steps).toEqual([
      {
        seq: 5,
        startSeq: 3,
        at: "2026-01-01T00:00:03Z",
        kind: "event",
        events: 1,
        writes: 5,
        settled: true,
      },
      {
        seq: 2,
        startSeq: 1,
        at: "2026-01-01T00:00:01Z",
        kind: "write",
        events: 0,
        writes: 3,
        settled: true,
      },
    ]);
  });

  it("reports a step the serving loop had not caught up with as unsettled", () => {
    const steps = historySteps([
      derived(4, 3),
      commit(3, { events: 1 }),
      commit(2, { events: 1 }),
      derived(1, 0),
    ]);

    expect(steps.map(({ seq, settled }) => [seq, settled]))
      .toEqual([[4, true], [2, false]]);
  });

  it("reports a restore with the seq it restored", () => {
    const steps = historySteps([
      commit(2, { class: "system", restored: { branch: "", seq: 1 } }),
      commit(1),
    ]);

    expect(steps[0]).toMatchObject({ kind: "restore", restoredSeq: 1 });
  });

  it("leaves out the commits of a step whose first commit is not listed", () => {
    expect(historySteps([commit(3), derived(2, 1)]).map((step) => step.seq))
      .toEqual([3]);
  });
});
