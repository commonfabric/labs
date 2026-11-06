/** The trusted dialog's plain-language reading of a reviewed snapshot. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  audienceId,
  audienceWords,
  fieldLabel,
  snapshotLines,
} from "./snapshot-view.ts";

describe("snapshot view", () => {
  it("reads field names as words", () => {
    expect(fieldLabel("plusOne")).toBe("Plus one");
    expect(fieldLabel("plus_one")).toBe("Plus one");
    expect(fieldLabel("dietary")).toBe("Dietary");
    expect(fieldLabel("")).toBe("");
  });

  it("keeps every field, naming empty ones rather than dropping them", () => {
    expect(snapshotLines({
      dietary: "",
      needs: [],
      note: "Running late",
      plusOne: { name: "", count: 0 },
      vegan: false,
      gone: null,
    })).toEqual([
      { label: "Dietary", text: "(blank)" },
      { label: "Needs", text: "(none)" },
      { label: "Note", text: "Running late" },
      {
        label: "Plus one",
        text: "",
        children: [
          { label: "Name", text: "(blank)" },
          { label: "Count", text: "0" },
        ],
      },
      { label: "Vegan", text: "No" },
      { label: "Gone", text: "(none)" },
    ]);
  });

  it("joins plain lists and nests lists of objects", () => {
    expect(snapshotLines({ needs: ["nut-free", "vegan"] })).toEqual([
      { label: "Needs", text: "nut-free, vegan" },
    ]);
    expect(snapshotLines({ books: [{ title: "Solaris" }] })).toEqual([{
      label: "Books",
      text: "",
      children: [{
        label: "1",
        text: "",
        children: [{ label: "Title", text: "Solaris" }],
      }],
    }]);
  });

  it("reads a value that is not an object as one line", () => {
    expect(snapshotLines("hello")).toEqual([{ label: "Value", text: "hello" }]);
    expect(snapshotLines(null)).toEqual([{ label: "Value", text: "(none)" }]);
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
