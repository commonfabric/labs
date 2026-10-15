import { FabricEpochNsec } from "@commonfabric/data-model/fabric-primitives";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { selectWindow } from "./window.ts";

describe("window", () => {
  const messages = Array.from({ length: 9 }, (_, index) => ({
    sentAt: new FabricEpochNsec(BigInt(index + 1)),
    body: `Message ${index + 1}`,
  }));

  it("pages backward with an exclusive cursor", () => {
    const newest = selectWindow(messages, { before: "end" }, 3, 100)!;
    expect(newest.messages).toEqual(messages.slice(6));
    expect(newest.hasOlder).toBe(true);
    expect(newest.hasNewer).toBe(false);
    const older = selectWindow(
      messages,
      { before: newest.messages[0].sentAt },
      3,
      100,
    )!;
    expect(older.messages).toEqual(messages.slice(3, 6));
    expect(older.hasOlder).toBe(true);
    expect(older.hasNewer).toBe(true);
  });

  it("pages forward without repeating the cursor message", () => {
    const oldest = selectWindow(messages, { after: "start" }, 3, 100)!;
    expect(oldest.messages).toEqual(messages.slice(0, 3));
    expect(oldest.hasOlder).toBe(false);
    expect(oldest.hasNewer).toBe(true);
    expect(
      selectWindow(messages, { after: oldest.messages[2].sentAt }, 3, 100)
        ?.messages,
    ).toEqual(messages.slice(3, 6));
  });

  it("fills a centered window from the other side near either edge", () => {
    expect(
      selectWindow(messages, { around: messages[0].sentAt }, 5, 100)?.messages,
    ).toEqual(messages.slice(0, 5));
    expect(
      selectWindow(messages, { around: messages[8].sentAt }, 5, 100)?.messages,
    ).toEqual(messages.slice(4));
    expect(
      selectWindow(messages, { around: messages[4].sentAt }, 5, 100)?.messages,
    ).toEqual(messages.slice(2, 7));
  });

  it("caps a window and refuses an absent center or invalid count", () => {
    expect(selectWindow(messages, { before: "end" }, 100, 2)?.messages)
      .toEqual(messages.slice(7));
    expect(
      selectWindow(messages, { around: new FabricEpochNsec(99n) }, 5, 100),
    ).toBeUndefined();
    for (const count of [0, -1, 1.5, NaN, Infinity]) {
      expect(selectWindow(messages, { before: "end" }, count, 100))
        .toBeUndefined();
    }
  });

  it("reports an empty view without inventing older or newer messages", () => {
    expect(selectWindow([], { before: "end" }, 5, 100)).toEqual({
      messages: [],
      hasOlder: false,
      hasNewer: false,
    });
  });
});
