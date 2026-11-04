import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  baselineKeyOf,
  unjustifiedDeletions,
} from "./check-baselines-append-only.ts";

const BASE = "patterns/baselines";

describe("baselineKeyOf", () => {
  it("recovers the pattern key a baseline belongs to", () => {
    expect(
      baselineKeyOf(`${BASE}/system/home/home.tsx/20260101T000000Z-a.json`),
    )
      .toBe("system/home/home.tsx");
    expect(baselineKeyOf(`${BASE}/top.tsx/20260101T000000Z-a.json`))
      .toBe("top.tsx");
  });

  it("ignores paths that are not baselines", () => {
    expect(baselineKeyOf("patterns/system/home/home.tsx")).toBeUndefined();
    expect(baselineKeyOf(`${BASE}/system/home/home.tsx/README.md`))
      .toBeUndefined();
    expect(baselineKeyOf("tasks/pattern-compat.ts")).toBeUndefined();
  });
});

describe("unjustifiedDeletions", () => {
  it("flags a baseline deleted while its pattern still exists", () => {
    // This is the laundering path the gate's safety argument depends on being
    // impossible: drop the baseline that proves the break, then --update.
    const offenders = unjustifiedDeletions(
      [`${BASE}/system/home/home.tsx/20260101T000000Z-a.json`],
      new Set(),
    );
    expect(offenders.length).toBe(1);
    expect(offenders[0].key).toBe("system/home/home.tsx");
  });

  it("allows baselines to go when the pattern is retired in the same change", () => {
    const offenders = unjustifiedDeletions(
      [
        `${BASE}/system/gone.tsx/20260101T000000Z-a.json`,
        "patterns/system/gone.tsx",
      ],
      new Set(["patterns/system/gone.tsx"]),
    );
    expect(offenders).toEqual([]);
  });

  it("recognizes a retired connector-owned pattern", () => {
    const offenders = unjustifiedDeletions(
      [
        `${BASE}/agent-sessions-debug/main.tsx/20260101T000000Z-a.json`,
      ],
      new Set(["connectors/agents/debug-view/main.tsx"]),
    );
    expect(offenders).toEqual([]);
  });

  it("does not let retiring one pattern justify deleting another's baselines", () => {
    const offenders = unjustifiedDeletions(
      [
        `${BASE}/system/gone.tsx/20260101T000000Z-a.json`,
        `${BASE}/system/home/home.tsx/20260101T000000Z-b.json`,
      ],
      new Set(["patterns/system/gone.tsx"]),
    );
    expect(offenders.length).toBe(1);
    expect(offenders[0].key).toBe("system/home/home.tsx");
  });

  it("ignores unrelated deletions", () => {
    expect(
      unjustifiedDeletions(["docs/README.md", "tasks/old.ts"], new Set()),
    ).toEqual([]);
  });
});
