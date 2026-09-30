import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  followUpdates,
  liveUpdateStream,
  type UpdateSource,
  type UpdateStream,
} from "../stream-client.ts";

const CONNECTING = 0, OPEN = 1, CLOSED = 2;
const SILENCE = 55_000;

interface FakeStream extends UpdateStream {
  readyState: number;
  closed: boolean;
}

interface Fixture {
  /** Every stream the page has opened, oldest first. */
  opened: FakeStream[];

  current(): FakeStream;
  heard(now: number): void;
  lost(): void;
  check(now: number): boolean;

  /** The browser losing the connection and retrying it on its own. */
  connectionDropped(): void;

  /** The connection being made, and the first event arriving on it. */
  connectionMade(now: number): void;
}

function fixture(): Fixture {
  const opened: FakeStream[] = [];
  const live = liveUpdateStream<FakeStream>(SILENCE, () => {
    const stream: FakeStream = {
      readyState: CONNECTING,
      closed: false,
      close() {
        this.closed = true;
        this.readyState = CLOSED;
      },
    };
    opened.push(stream);
    return stream;
  });
  const current = () => opened[opened.length - 1];
  return {
    opened,
    current,
    heard: (now) => live.heard(now),
    lost: () => live.lost(),
    check: (now) => live.check(now),
    connectionDropped() {
      current().readyState = CONNECTING;
      live.lost();
    },
    connectionMade(now) {
      current().readyState = OPEN;
      live.heard(now);
    },
  };
}

describe("stream-client", () => {
  describe("liveUpdateStream()", () => {
    it("opens no stream until the page first checks", () => {
      const page = fixture();
      expect(page.opened.length).toBe(0);
      expect(page.check(1_000)).toBe(true); // the server served this page
      expect(page.opened.length).toBe(1);
    });

    it("leaves a stream that keeps delivering alone", () => {
      const page = fixture();
      page.check(1_000);
      page.connectionMade(1_000);
      for (let now = 2_000; now < 10 * SILENCE; now += 1_000) {
        expect(page.check(now)).toBe(true);
        page.heard(now); // the server keeps arriving
      }
      expect(page.opened.length).toBe(1);
    });

    it("returns `false` on the tick after the connection drops", () => {
      const page = fixture();
      page.check(0);
      page.connectionMade(0);
      expect(page.check(1_000)).toBe(true);

      // Nothing answers the port, so the browser holds the stream at
      // `CONNECTING` and retries on its own, reporting each failure as it
      // happens. The answer follows that report, on the tick after it.
      page.connectionDropped();
      expect(page.check(2_000)).toBe(false);
      for (let now = 3_000; now < SILENCE; now += 1_000) {
        page.connectionDropped(); // each of the browser's own retries fails too
        expect(page.check(now)).toBe(false);
      }

      page.connectionMade(SILENCE); // the browser's own retry finds the server back
      expect(page.check(SILENCE)).toBe(true);
      expect(page.opened.length).toBe(1); // its stream was never replaced
    });

    it("replaces a stream the browser has given up on at once", () => {
      const page = fixture();
      page.check(1_000);
      page.connectionMade(1_000);

      // An error page answered the browser's own reconnect, which closes the
      // stream for good and is reported as it happens.
      const abandoned = page.current();
      abandoned.readyState = CLOSED;
      page.lost();

      expect(page.check(2_000)).toBe(false);
      expect(page.opened.length).toBe(2);
      expect(abandoned.closed).toBe(true);
      expect(page.current().readyState).toBe(CONNECTING);

      page.connectionMade(2_100);
      expect(page.check(3_000)).toBe(true); // without the interval elapsing
    });

    it("returns `false` for a stream it has just opened, with nothing reporting the loss", () => {
      const page = fixture();
      page.check(0);
      page.connectionMade(0);

      // Only the closed state is set here, standing for a caller that reports
      // nothing. The answer cannot rest on a report the module does not make
      // itself: the stream it is now being asked about is one it has heard
      // nothing on, whatever the stream it replaced had delivered.
      page.current().readyState = CLOSED;
      expect(page.check(1_000)).toBe(false);
      expect(page.opened.length).toBe(2);

      page.connectionMade(1_100);
      expect(page.check(2_000)).toBe(true);
    });

    it("returns `false` for every tick of an outage that refuses each stream", () => {
      const page = fixture();
      page.check(0);
      page.connectionMade(0);

      // The server is behind a proxy answering every reconnect with an error
      // page, so each stream closes without ever delivering.
      page.current().readyState = CLOSED;
      page.lost();
      page.check(1_000);
      page.current().readyState = CLOSED;
      page.lost();

      for (let now = 2_000; now < SILENCE; now += 1_000) {
        expect(page.check(now)).toBe(false);
        page.current().readyState = CLOSED;
        page.lost();
      }
    });

    it("opens one stream an interval while every stream is refused", () => {
      const page = fixture();
      page.check(0);
      page.connectionMade(0);
      page.current().readyState = CLOSED;
      page.lost();
      page.check(1_000); // the prompt replacement
      expect(page.opened.length).toBe(2);

      // Ticking every second must not open a stream every second.
      page.current().readyState = CLOSED;
      for (let now = 2_000; now < 1_000 + SILENCE; now += 1_000) {
        page.check(now);
        page.current().readyState = CLOSED;
      }
      expect(page.opened.length).toBe(2);

      page.check(1_000 + SILENCE);
      expect(page.opened.length).toBe(3);
    });

    it("replaces a stream that stays open with nothing arriving on it", () => {
      const page = fixture();
      page.check(0);
      const zombie = page.current();
      page.connectionMade(0);

      // The connection survives a sleeping machine or a network that moved
      // while nothing comes down it. The browser reports nothing wrong, so the
      // elapsed interval is the only thing left to go on.
      expect(page.check(SILENCE - 1)).toBe(true);
      expect(page.opened.length).toBe(1);

      expect(page.check(SILENCE)).toBe(false);
      expect(page.opened.length).toBe(2);
      expect(zombie.closed).toBe(true);

      page.connectionMade(SILENCE + 500);
      expect(page.check(SILENCE + 1_000)).toBe(true);
      expect(page.opened.length).toBe(2);
    });

    it("gives a stream that is still connecting the whole interval before replacing it", () => {
      const page = fixture();
      page.check(0);
      page.connectionMade(0);
      page.current().readyState = CLOSED;
      page.lost();
      page.check(0); // prompt replacement, now at `CONNECTING`
      expect(page.opened.length).toBe(2);

      // The browser is retrying this one on its own schedule. Replacing it
      // every tick would cancel that.
      page.check(SILENCE - 1);
      expect(page.opened.length).toBe(2);
      page.check(SILENCE);
      expect(page.opened.length).toBe(3);
    });

    it("returns `true` through a long lull in the data, which heartbeats carry", () => {
      const page = fixture();
      page.check(0);
      page.connectionMade(0);
      for (let now = 1_000; now < 10 * SILENCE; now += 1_000) {
        page.heard(now); // a heartbeat, with no tile having changed
        expect(page.check(now)).toBe(true);
      }
      expect(page.opened.length).toBe(1);
    });
  });

  describe("followUpdates()", () => {
    /** A stream the test delivers events on by name. */
    class FakeSource implements UpdateSource {
      readyState = CONNECTING;
      readonly listeners = new Map<string, (event: { data: string }) => void>();
      close(): void {
        this.readyState = CLOSED;
      }
      addEventListener(
        type: string,
        listener: (event: { data: string }) => void,
      ): void {
        this.listeners.set(type, listener);
      }
      deliver(type: string, data = ""): void {
        this.listeners.get(type)!({ data });
      }
    }

    function follow() {
      const sources: FakeSource[] = [];
      const received: string[] = [];
      let paints = 0;
      const updates = followUpdates(
        () => {
          const source = new FakeSource();
          sources.push(source);
          return source;
        },
        SILENCE,
        () => paints++,
        { page: (data) => received.push(data) },
      );
      return { sources, received, updates, paints: () => paints };
    }

    it("hands each named event's data to its handler and repaints", () => {
      const page = follow();
      page.updates.check(Date.now());
      const [source] = page.sources;
      source.readyState = OPEN;
      source.deliver("open");
      source.deliver("page", "<main>one</main>");
      source.deliver("ping", "1");
      expect(page.received).toEqual(["<main>one</main>"]);
      expect(page.paints()).toBe(3);
      expect(page.updates.check(Date.now())).toBe(true);
    });

    it("says the server cannot be heard as soon as the connection drops", () => {
      const page = follow();
      page.updates.check(Date.now());
      const [source] = page.sources;
      source.readyState = OPEN;
      source.deliver("open");
      source.deliver("error");
      expect(page.paints()).toBe(2);
      expect(page.updates.check(Date.now())).toBe(false);
      source.deliver("ping", "2");
      expect(page.updates.check(Date.now())).toBe(true);
      expect(page.received).toEqual([]);
    });
  });
});
