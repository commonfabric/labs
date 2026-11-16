/** The trusted dialog's line-by-line reading of a reviewed snapshot. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { audienceId, audienceWords, snapshotLines } from "./snapshot-view.ts";

describe("snapshot view", () => {
  it("shows field names exactly as stored, never as prose", () => {
    expect(snapshotLines({ onlyYouWillSeeThis: "x" })).toEqual([
      { key: "onlyYouWillSeeThis", text: "x", empty: false },
    ]);
  });

  it("keeps every field, marking empty ones rather than dropping them", () => {
    expect(snapshotLines({
      dietary: "",
      needs: [],
      plusOne: { name: "(blank)", count: 0 },
      vegan: false,
      gone: null,
    })).toEqual([
      { key: "dietary", text: "blank", empty: true },
      { key: "needs", text: "none", empty: true },
      {
        key: "plusOne",
        text: "",
        empty: false,
        children: [
          // A string that reads "(blank)" is a value, not an empty mark.
          { key: "name", text: "(blank)", empty: false },
          { key: "count", text: "0", empty: false },
        ],
      },
      { key: "vegan", text: "false", empty: false },
      { key: "gone", text: "none", empty: true },
    ]);
  });

  it("marks values that hold only spaces, and empty objects", () => {
    expect(snapshotLines({ a: "   ", b: {} })).toEqual([
      { key: "a", text: "only spaces (3)", empty: true },
      { key: "b", text: "none", empty: true },
    ]);
  });

  it("gives each list entry its own line, so no two values read as one", () => {
    expect(snapshotLines({ needs: ["a, b", "c"] })).toEqual([{
      key: "needs",
      text: "",
      empty: false,
      children: [
        { key: "0", text: "a, b", empty: false },
        { key: "1", text: "c", empty: false },
      ],
    }]);
  });

  it("reads a value that is not an object as one line", () => {
    expect(snapshotLines("hello")).toEqual([
      { key: "", text: "hello", empty: false },
    ]);
    expect(snapshotLines(null)).toEqual([
      { key: "", text: "none", empty: true },
    ]);
  });

  it("names the audience kind and its verified id", () => {
    const user = {
      type: "https://commonfabric.org/cfc/atom/User",
      subject: "did:key:reader",
    };
    expect(audienceWords(user)).toBe("One verified person");
    expect(audienceId(user)).toBe("did:key:reader");
    expect(audienceWords({ type: "https://commonfabric.org/cfc/atom/Space" }))
      .toBe("Everyone in one verified space");
    expect(audienceWords({ type: "other" })).toBe("A verified audience");
    expect(audienceId({})).toBe("");
  });
});
