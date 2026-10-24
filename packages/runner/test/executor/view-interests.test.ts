import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { SessionViewInterest } from "@commonfabric/memory/v2";
import { ViewInterestCache } from "../../src/executor/view-interests.ts";

const space = "did:key:z6MkViewInterestsSpace";

const interest = (
  sessionId: string,
  principal: string | undefined,
  selectionGeneration?: number,
): SessionViewInterest => ({
  handle: {
    sessionId,
    sessionEpoch: `${sessionId}-session`,
    viewEpoch: `${sessionId}-view`,
    viewId: "view",
    revision: 1,
  },
  principal,
  attached: true,
  view: { id: "view", revision: 1 } as SessionViewInterest["view"],
  ...(selectionGeneration === undefined ? {} : { selectionGeneration }),
});

/** A reader that returns `list` and counts how often it was asked. */
const reader = (list: () => SessionViewInterest[]) => {
  const state = { reads: 0 };
  return {
    state,
    read: () => {
      state.reads += 1;
      return Promise.resolve(list());
    },
  };
};

describe("view-interests", () => {
  it("reads the list once and returns what it holds to later publishes", async () => {
    const cache = new ViewInterestCache();
    const r = reader(() => [interest("a", "did:key:alice")]);

    const first = await cache.interestsFor(space, undefined, r.read);
    const second = await cache.interestsFor(space, undefined, r.read);

    expect(first).toEqual([interest("a", "did:key:alice")]);
    expect(second).toEqual(first);
    expect(r.state.reads).toBe(1);
  });

  it("reads the list again after a change is noted, and only then", async () => {
    const cache = new ViewInterestCache();
    let list = [interest("a", undefined)];
    const r = reader(() => list);
    await cache.interestsFor(space, undefined, r.read);

    list = [interest("a", undefined), interest("b", undefined)];
    expect(await cache.interestsFor(space, undefined, r.read)).toHaveLength(1);
    cache.noteChanged(space);
    expect(await cache.interestsFor(space, undefined, r.read)).toHaveLength(2);
    expect(await cache.interestsFor(space, undefined, r.read)).toHaveLength(2);
    expect(r.state.reads).toBe(2);
  });

  it("keeps a change noted for another space out of this one", async () => {
    const cache = new ViewInterestCache();
    const r = reader(() => []);
    await cache.interestsFor(space, undefined, r.read);

    cache.noteChanged("did:key:z6MkAnotherSpace");
    await cache.interestsFor(space, undefined, r.read);

    expect(r.state.reads).toBe(1);
  });

  it("leaves out the excluded principal's interests without reading again", async () => {
    const cache = new ViewInterestCache();
    const r = reader(() => [
      interest("a", "did:key:alice"),
      interest("b", "did:key:bob"),
    ]);
    await cache.interestsFor(space, undefined, r.read);

    const bobOnly = await cache.interestsFor(space, "did:key:alice", r.read);

    expect(bobOnly.map((entry) => entry.handle.sessionId)).toEqual(["b"]);
    expect(r.state.reads).toBe(1);
  });

  it("carries an accepted selection's generation on the held interest", async () => {
    const cache = new ViewInterestCache();
    const r = reader(
      () => [interest("a", undefined, 3), interest("b", undefined)],
    );
    const [a] = await cache.interestsFor(space, undefined, r.read);

    cache.noteSelection(space, a.handle, 4);
    const held = await cache.interestsFor(space, undefined, r.read);

    expect(held[0].selectionGeneration).toBe(4);
    expect(held[1].selectionGeneration).toBeUndefined();
    expect(r.state.reads).toBe(1);
  });

  it("reads again on the next publish after a read that failed", async () => {
    const cache = new ViewInterestCache();
    let list = [interest("a", undefined)];
    const r = reader(() => list);
    await cache.interestsFor(space, undefined, r.read);

    list = [interest("a", undefined), interest("b", undefined)];
    cache.noteChanged(space);
    const failing = () => Promise.reject(new Error("port closed"));
    await expect(cache.interestsFor(space, undefined, failing)).rejects
      .toThrow("port closed");

    expect(await cache.interestsFor(space, undefined, r.read)).toHaveLength(2);
    expect(r.state.reads).toBe(2);
  });

  it("reads again after a change noted while a read was in flight", async () => {
    const cache = new ViewInterestCache();
    const pending = Promise.withResolvers<SessionViewInterest[]>();
    const reading = cache.interestsFor(space, undefined, () => pending.promise);
    cache.noteChanged(space);
    pending.resolve([interest("a", undefined)]);
    await reading;

    const r = reader(
      () => [interest("a", undefined), interest("b", undefined)],
    );
    expect(await cache.interestsFor(space, undefined, r.read)).toHaveLength(2);
    expect(r.state.reads).toBe(1);
  });

  it("holds the list of the read that started last when two reads settle out of order", async () => {
    const cache = new ViewInterestCache();
    const older = Promise.withResolvers<SessionViewInterest[]>();
    const first = cache.interestsFor(space, undefined, () => older.promise);
    cache.noteChanged(space);
    const second = cache.interestsFor(
      space,
      undefined,
      () =>
        Promise.resolve([interest("a", undefined), interest("b", undefined)]),
    );
    expect(await second).toHaveLength(2);
    older.resolve([interest("a", undefined)]);
    expect(await first).toHaveLength(1);

    const r = reader(() => []);
    expect(await cache.interestsFor(space, undefined, r.read)).toHaveLength(2);
    expect(r.state.reads).toBe(0);
  });

  it("holds no list for a space once it is forgotten, and reads it again", async () => {
    const cache = new ViewInterestCache();
    const r = reader(() => [interest("a", undefined)]);
    await cache.interestsFor(space, undefined, r.read);
    expect(cache.size).toBe(1);

    cache.forget(space);

    expect(cache.size).toBe(0);
    expect(await cache.interestsFor(space, undefined, r.read)).toHaveLength(1);
    expect(r.state.reads).toBe(2);
  });

  it("holds nothing from a read in flight when its space is forgotten", async () => {
    const cache = new ViewInterestCache();
    const pending = Promise.withResolvers<SessionViewInterest[]>();
    const reading = cache.interestsFor(space, undefined, () => pending.promise);

    cache.forget(space);
    pending.resolve([interest("a", undefined)]);
    expect(await reading).toHaveLength(1);

    expect(cache.size).toBe(0);
  });

  it("keeps nothing for a change noted in a space it has not read", () => {
    const cache = new ViewInterestCache();

    cache.noteChanged(space);

    expect(cache.size).toBe(0);
  });

  it("keeps nothing for a space forgotten while a read of it fails", async () => {
    const cache = new ViewInterestCache();
    const pending = Promise.withResolvers<SessionViewInterest[]>();
    const reading = cache.interestsFor(space, undefined, () => pending.promise);

    cache.forget(space);
    pending.reject(new Error("port closed"));
    await expect(reading).rejects.toThrow("port closed");

    expect(cache.size).toBe(0);
  });

  it("holds the list of a read that starts after its space is forgotten, over one in flight before", async () => {
    const cache = new ViewInterestCache();
    const older = Promise.withResolvers<SessionViewInterest[]>();
    const first = cache.interestsFor(space, undefined, () => older.promise);
    cache.forget(space);
    await cache.interestsFor(
      space,
      undefined,
      () =>
        Promise.resolve([interest("a", undefined), interest("b", undefined)]),
    );

    older.resolve([interest("a", undefined)]);
    await first;

    const r = reader(() => []);
    expect(await cache.interestsFor(space, undefined, r.read)).toHaveLength(2);
    expect(r.state.reads).toBe(0);
  });

  it("ignores a selection for a handle the held list does not carry", async () => {
    const cache = new ViewInterestCache();
    const r = reader(() => [interest("a", undefined)]);
    const [a] = await cache.interestsFor(space, undefined, r.read);

    cache.noteSelection(space, { ...a.handle, viewEpoch: "other" }, 9);

    expect((await cache.interestsFor(space, undefined, r.read))[0])
      .toEqual(interest("a", undefined));
  });
});
