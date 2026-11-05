import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { GuestSessions, type OfferedSession } from "../src/guest-sessions.ts";

/** A session that records whether it was disconnected, and how often. */
class FakeSession implements OfferedSession {
  disconnects = 0;

  constructor(readonly name: string) {}

  disconnect(): void {
    this.disconnects++;
  }
}

function names(sessions: readonly FakeSession[]): string[] {
  return sessions.map((session) => session.name);
}

describe("GuestSessions", () => {
  describe("offer()", () => {
    it("keeps a single offer", () => {
      const sessions = new GuestSessions<FakeSession>();
      const first = new FakeSession("first");
      sessions.offer(first);
      expect(names(sessions.offered)).toEqual(["first"]);
      expect(first.disconnects).toBe(0);
    });

    it("keeps both offers when a second arrives", () => {
      // The guest may be holding either one at this point: the first if it was
      // already there, the second if the first went to a document that is
      // gone. Neither is disconnected until something says which.
      const sessions = new GuestSessions<FakeSession>();
      const first = new FakeSession("first");
      const second = new FakeSession("second");
      sessions.offer(first);
      sessions.offer(second);
      expect(names(sessions.offered)).toEqual(["first", "second"]);
      expect(first.disconnects).toBe(0);
      expect(second.disconnects).toBe(0);
    });

    it("disconnects the offer that was newest when a third arrives", () => {
      const sessions = new GuestSessions<FakeSession>();
      const first = new FakeSession("first");
      const second = new FakeSession("second");
      const third = new FakeSession("third");
      sessions.offer(first);
      sessions.offer(second);
      sessions.offer(third);
      expect(names(sessions.offered)).toEqual(["first", "third"]);
      expect(second.disconnects).toBe(1);
      expect(first.disconnects).toBe(0);
      expect(third.disconnects).toBe(0);
    });

    it("holds two however many offers arrive", () => {
      // A guest renavigating its own frame reports a load each time, and each
      // report offers a session, so the bound is what keeps a guest from
      // accumulating them.
      const sessions = new GuestSessions<FakeSession>();
      const offered: FakeSession[] = [];
      for (let index = 0; index < 20; index++) {
        const session = new FakeSession(`session-${index}`);
        offered.push(session);
        sessions.offer(session);
      }
      expect(names(sessions.offered)).toEqual(["session-0", "session-19"]);
      expect(offered.filter((session) => session.disconnects === 0).length)
        .toBe(2);
    });
  });

  describe("retireBefore()", () => {
    it("returns `false` and keeps every offer for the oldest session", () => {
      // The oldest session speaking says nothing about the others: an offer
      // made after it may still be waiting for the document that takes it.
      const sessions = new GuestSessions<FakeSession>();
      const first = new FakeSession("first");
      const second = new FakeSession("second");
      sessions.offer(first);
      sessions.offer(second);
      expect(sessions.retireBefore(first)).toBe(false);
      expect(names(sessions.offered)).toEqual(["first", "second"]);
      expect(first.disconnects).toBe(0);
      expect(second.disconnects).toBe(0);
    });

    it("disconnects the offers made before the session that spoke", () => {
      const sessions = new GuestSessions<FakeSession>();
      const first = new FakeSession("first");
      const second = new FakeSession("second");
      sessions.offer(first);
      sessions.offer(second);
      expect(sessions.retireBefore(second)).toBe(true);
      expect(names(sessions.offered)).toEqual(["second"]);
      expect(first.disconnects).toBe(1);
      expect(second.disconnects).toBe(0);
    });

    it("returns `false` for a session it does not hold", () => {
      const sessions = new GuestSessions<FakeSession>();
      const held = new FakeSession("held");
      const stranger = new FakeSession("stranger");
      sessions.offer(held);
      expect(sessions.retireBefore(stranger)).toBe(false);
      expect(names(sessions.offered)).toEqual(["held"]);
      expect(held.disconnects).toBe(0);
      expect(stranger.disconnects).toBe(0);
    });

    it("leaves nothing to retire when called twice", () => {
      const sessions = new GuestSessions<FakeSession>();
      const first = new FakeSession("first");
      const second = new FakeSession("second");
      sessions.offer(first);
      sessions.offer(second);
      sessions.retireBefore(second);
      expect(sessions.retireBefore(second)).toBe(false);
      expect(first.disconnects).toBe(1);
    });
  });

  describe("closeAll()", () => {
    it("disconnects every offer and forgets them", () => {
      const sessions = new GuestSessions<FakeSession>();
      const first = new FakeSession("first");
      const second = new FakeSession("second");
      sessions.offer(first);
      sessions.offer(second);
      sessions.closeAll();
      expect(names(sessions.offered)).toEqual([]);
      expect(first.disconnects).toBe(1);
      expect(second.disconnects).toBe(1);
    });

    it("disconnects nothing a second time", () => {
      const sessions = new GuestSessions<FakeSession>();
      const only = new FakeSession("only");
      sessions.offer(only);
      sessions.closeAll();
      sessions.closeAll();
      expect(only.disconnects).toBe(1);
    });

    it("forgets the offers before disconnecting them", () => {
      // A disconnect can reach back here -- closing a port is what makes a
      // guest's session end, and the element closes sessions while tearing
      // down -- so what it finds has to be the emptied list rather than the
      // one being walked.
      const sessions = new GuestSessions<OfferedSession>();
      let seenDuringDisconnect: number | undefined;
      sessions.offer({
        disconnect: () => {
          seenDuringDisconnect = sessions.offered.length;
        },
      });
      sessions.closeAll();
      expect(seenDuringDisconnect).toBe(0);
    });
  });
});
