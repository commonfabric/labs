import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { CSI, stripAnsi } from "@commonfabric/cli/view/ansi";

import {
  BOARD,
  type BoardServer,
  boardServer,
  INPUT_1,
  link,
  SPACE,
} from "./board-fixture.ts";
import type { MirrorData } from "./mirror.ts";
import { GLOW_MS } from "./screen.ts";
import {
  loadMirror,
  type OpenedSession,
  refreshMirror,
  saveMirror,
} from "./sync.ts";
import {
  type Clock,
  consoleTerminal,
  systemClock,
  type Terminal,
  watchBoard,
} from "./watch.ts";

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

const ENTER = "\x1b[?1049h";
const LEAVE = "\x1b[?1049l";

/** Where a write moves to the start of a row, capturing the row's number. */
const ROW = new RegExp(`${RegExp.escape(CSI)}(\\d+);1H`);

/** A terminal a test types into, signals, and reads the screen of. */
class FakeTerminal implements Terminal {
  /** Everything written, in order. */
  readonly writes: string[] = [];
  readonly raw: boolean[] = [];
  columns = 100;
  lines = 30;

  /** Set to make the terminal refuse to go into raw mode. */
  broken = false;

  /** Each row on screen, as text. */
  #screen: string[] = [];
  #signals = new Map<Deno.Signal, () => void>();
  #keys!: ReadableStreamDefaultController<Uint8Array>;
  #input = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.#keys = controller;
    },
  });
  #waiting: { shows: string; arrived: (screen: string) => void }[] = [];

  /** Set to make writing what gives the terminal back fail. */
  failsToLeave = false;

  write(text: string): void {
    if (this.failsToLeave && text.includes(LEAVE)) {
      throw new Error("The terminal is gone.");
    }
    this.writes.push(text);
    const parts = text.split(ROW);
    for (let at = 1; at < parts.length; at += 2) {
      this.#screen[Number(parts[at]) - 1] = stripAnsi(parts[at + 1]);
    }
    const shown = this.screen();
    this.#waiting = this.#waiting.filter(({ shows, arrived }) => {
      if (!shown.includes(shows)) return true;
      arrived(shown);
      return false;
    });
  }

  size() {
    return { columns: this.columns, rows: this.lines };
  }

  setRaw(raw: boolean): void {
    if (this.broken && raw) throw new Error("Not a terminal.");
    this.raw.push(raw);
  }

  input(): ReadableStream<Uint8Array> {
    return this.#input;
  }

  on(signal: Deno.Signal, act: () => void): () => void {
    this.#signals.set(signal, act);
    return () => this.#signals.delete(signal);
  }

  /** Sends the process `signal`. */
  signal(signal: Deno.Signal): void {
    this.#signals.get(signal)?.();
  }

  /** The signals something listens for. */
  get listening(): Deno.Signal[] {
    return [...this.#signals.keys()];
  }

  /** The screen once a write shows `shows` on it. */
  showing(shows: string): Promise<string> {
    const { promise, resolve } = Promise.withResolvers<string>();
    this.#waiting.push({ shows, arrived: resolve });
    return promise;
  }

  /** The screen as it stands. */
  screen(): string {
    return this.#screen.slice(0, this.lines).join("\n");
  }

  type(key: string): void {
    this.#keys.enqueue(new TextEncoder().encode(key));
  }

  close(): void {
    this.#keys.close();
  }
}

/** A clock that moves only when a test moves it. */
class FakeClock implements Clock {
  #now = NOW;
  #due: { at: number; act: () => void }[] = [];

  now(): number {
    return this.#now;
  }

  after(ms: number, act: () => void): () => void {
    const timer = { at: this.#now + ms, act };
    this.#due.push(timer);
    return () => this.#due = this.#due.filter((t) => t !== timer);
  }

  /** How many timers are set. */
  get pending(): number {
    return this.#due.length;
  }

  /** Moves the clock on by `ms`, running each timer that falls due. */
  advance(ms: number): void {
    this.#now += ms;
    for (;;) {
      const due = this.#due.find((timer) => timer.at <= this.#now);
      if (due === undefined) return;
      this.#due = this.#due.filter((timer) => timer !== due);
      due.act();
    }
  }
}

describe("watch", () => {
  describe("watchBoard()", () => {
    let board: BoardServer;
    let dir: string;
    let mirror: string;
    let terminal: FakeTerminal;
    let clock: FakeClock;

    beforeEach(async () => {
      board = await boardServer();
      dir = await Deno.makeTempDir();
      mirror = join(dir, "copy.json");
      terminal = new FakeTerminal();
      clock = new FakeClock();
    });

    afterEach(async () => {
      await board.close();
      await Deno.remove(dir, { recursive: true });
    });

    /** A session on the board, as the client opens one. */
    async function connect(): Promise<OpenedSession> {
      const { client, session } = await board.mount();
      return { space: SPACE, session, close: () => client.close() };
    }

    /** Watches the board, connecting through `opens`. */
    function watch(
      opens: () => Promise<OpenedSession> = connect,
    ): Promise<void> {
      return watchBoard(
        {
          apiUrl: "https://fabric.example",
          board: BOARD,
          space: "topics space",
          mirror,
        },
        { terminal, clock, connect: opens },
      );
    }

    /** A session on the board that resolves `closed` once it is closed. */
    async function closing(closed: PromiseWithResolvers<void>) {
      const opened = await connect();
      return {
        ...opened,
        async close() {
          await opened.close();
          closed.resolve();
        },
      };
    }

    /** Adds a comment saying `body` to Topic 1. */
    async function comment(body: string) {
      await board.write({
        "of:fid1:comment-2": {
          value: { author: { name: "Bo" }, body, sentAt: 9000 },
        },
        "of:fid1:input-1": {
          value: {
            ...INPUT_1,
            comments: [link("of:fid1:comment-1"), link("of:fid1:comment-2")],
          },
        },
      });
    }

    it("draws the board as it goes live, then a pushed comment typing itself in, and saves the copy", async () => {
      const connecting = terminal.showing("○ connecting");
      const live = terminal.showing("● LIVE");
      const watching = watch();
      const first = await connecting;
      const going = await live;

      expect(terminal.writes[0]).toContain(ENTER);
      expect(first).toContain("0 topics");
      expect(going).toContain("2 topics");
      expect(going).toContain("Donut glaze");
      expect(terminal.writes.join("")).toContain(
        "\x1b]8;;https://fabric.example/topics%20space/top/2\x07",
      );
      expect(going).toContain("Reproduced with cold oil.");
      expect(going).toContain("waiting for changes");

      // A change that names nothing the view shows is drawn, but is not
      // called a change.
      const quiet = terminal.showing("waiting for changes");
      await board.write({
        "of:fid1:input-1": { value: { ...INPUT_1, unread: true } },
      });
      await quiet;

      const arrived = terminal.showing("last change");
      await comment("Live.");
      const typing = await arrived;

      expect(typing).toContain("Bo");
      expect(typing).toContain("▌");
      expect(typing).not.toContain("Live.");
      expect(clock.pending).toBe(1);

      clock.advance(GLOW_MS);

      expect(terminal.screen()).toContain("Live.");
      expect(clock.pending).toBe(0);

      terminal.type("q");
      await watching;

      expect(terminal.writes.at(-1)).toContain(LEAVE);
      expect(terminal.raw).toEqual([true, false]);
      expect(terminal.listening).toEqual([]);
      expect(Object.keys((await loadMirror(mirror)).docs)).toContain(
        "of:fid1:comment-2",
      );
    });

    it("rewrites only the rows that changed, and every row once the terminal is resized", async () => {
      const live = terminal.showing("● LIVE");
      const watching = watch();
      await live;
      const arrived = terminal.showing("last change");
      await comment("Live.");
      await arrived;
      const before = terminal.writes.length;
      clock.advance(GLOW_MS);
      const changed = terminal.writes.slice(before).join("").split(ROW).length;

      expect(changed).toBeGreaterThan(1);
      expect((changed - 1) / 2).toBeLessThan(terminal.lines);

      terminal.columns = 70;
      terminal.lines = 15;
      terminal.signal("SIGWINCH");

      expect(terminal.writes.at(-1)!.split(ROW).length).toBe(1 + 2 * 15);
      expect(terminal.screen()).toContain("● LIVE");

      terminal.type("q");
      await watching;
    });

    it("draws the copy before connecting, and quits on Control-C while still connecting, closing the session that opens late", async () => {
      const data: MirrorData = { pieces: {}, docs: {} };
      const source = await board.open();
      await refreshMirror(data, BOARD, source);
      await source.close();
      await saveMirror(mirror, data);
      const opening = Promise.withResolvers<OpenedSession>();
      const closed = Promise.withResolvers<void>();
      const connecting = terminal.showing("○ connecting");
      const watching = watch(() => opening.promise);
      const first = await connecting;

      expect(first).toContain("2 topics");
      expect(first).toContain("Donut glaze");

      terminal.type("\x03");
      await watching;

      expect(terminal.writes.at(-1)).toContain(LEAVE);

      opening.resolve(await closing(closed));
      await closed.promise;
    });

    it("quits on `q` or Control-C typed without other keys, and not on Escape or an arrow key", async () => {
      const live = terminal.showing("● LIVE");
      const watching = watch();
      await live;
      terminal.type("\x1b");
      terminal.type("\x1b[A");
      terminal.type("aq");
      const arrived = terminal.showing("last change");
      await comment("Still here.");
      await arrived;
      terminal.type("qq\x03");
      await watching;

      expect(terminal.writes.at(-1)).toContain(LEAVE);
    });

    it("ends when the terminal's input closes, or the process is signaled to end, closing the session", async () => {
      for (
        const end of [
          "input",
          "SIGHUP",
          "SIGINT",
          "SIGQUIT",
          "SIGTERM",
        ] as const
      ) {
        terminal = new FakeTerminal();
        const closed = Promise.withResolvers<void>();
        const live = terminal.showing("● LIVE");
        const watching = watch(() => closing(closed));
        await live;
        if (end === "input") terminal.close();
        else terminal.signal(end);
        await watching;
        await closed.promise;

        expect(terminal.writes.at(-1)).toContain(LEAVE);
      }
    });

    it("throws when the session does not open, restoring the terminal", async () => {
      await expect(watch(() => Promise.reject(new Error("refused")))).rejects
        .toThrow("refused");

      expect(terminal.writes.at(-1)).toContain(LEAVE);
      expect(terminal.raw).toEqual([true, false]);
    });

    it("throws when a frame cannot be drawn, restoring the terminal", async () => {
      const size = terminal.size.bind(terminal);
      let reads = 0;
      terminal.size = () => {
        if (++reads > 1) throw new Error("The terminal is gone.");
        return size();
      };
      // The first frame is drawn; the one going live is not.
      await expect(watch()).rejects.toThrow("The terminal is gone.");
      expect(terminal.writes.at(-1)).toContain(LEAVE);
      expect(terminal.raw).toEqual([true, false]);
    });

    it("leaves raw mode and closes the session when giving the terminal back fails, and throws", async () => {
      terminal.failsToLeave = true;
      const closed = Promise.withResolvers<void>();
      const live = terminal.showing("● LIVE");
      const watching = watch(() => closing(closed));
      await live;
      terminal.type("q");

      await expect(watching).rejects.toThrow("The terminal is gone.");
      expect(terminal.raw).toEqual([true, false]);
      await closed.promise;
    });

    it("throws when the terminal cannot be taken over, having started nothing", async () => {
      terminal.broken = true;
      let connected = false;

      await expect(watch(() => {
        connected = true;
        return connect();
      })).rejects.toThrow("Not a terminal.");
      expect(terminal.writes).toEqual([]);
      expect(terminal.listening).toEqual([]);
      expect(connected).toBe(false);
    });

    it("throws when the copy cannot be saved, restoring the terminal", async () => {
      const opening = Promise.withResolvers<OpenedSession>();
      const connecting = terminal.showing("○ connecting");
      const watching = watch(() => opening.promise);
      await connecting;
      await Deno.chmod(dir, 0o500);
      try {
        opening.resolve(await connect());

        await expect(watching).rejects.toThrow(Deno.errors.PermissionDenied);
      } finally {
        await Deno.chmod(dir, 0o700);
      }
      expect(terminal.writes.at(-1)).toContain(LEAVE);
    });

    it("throws when the session ends without being asked to, restoring the terminal", async () => {
      const opened = await connect();
      const live = terminal.showing("● LIVE");
      const watching = watch(() => Promise.resolve(opened));
      await live;
      await opened.close();

      await expect(watching).rejects.toThrow("memory session closed");
      expect(terminal.writes.at(-1)).toContain(LEAVE);
    });
  });

  describe("consoleTerminal()", () => {
    it("writes all of a text however little each write takes, and hands on size, raw mode, input, and resizes", () => {
      const written: number[] = [];
      const raw: boolean[] = [];
      const listening = new Set<[Deno.Signal, () => void]>();
      const readable = new ReadableStream<Uint8Array<ArrayBuffer>>();
      const terminal = consoleTerminal({
        stdin: { setRaw: (mode) => void raw.push(mode), readable },
        stdout: {
          writeSync(bytes) {
            written.push(bytes[0]);
            return 1;
          },
        },
        consoleSize: () => ({ columns: 80, rows: 24 }),
        addSignalListener: (signal, handler) =>
          void listening.add([signal, handler]),
        removeSignalListener: (signal, handler) => {
          for (const entry of listening) {
            if (entry[0] === signal && entry[1] === handler) {
              listening.delete(entry);
            }
          }
        },
      });
      const resized = () => {};
      terminal.write("hé");
      terminal.setRaw(true);
      const undo = terminal.on("SIGWINCH", resized);

      expect(written).toEqual([0x68, 0xc3, 0xa9]);
      expect(terminal.size()).toEqual({ columns: 80, rows: 24 });
      expect(raw).toEqual([true]);
      expect(terminal.input()).toBe(readable);
      expect([...listening]).toEqual([["SIGWINCH", resized]]);

      undo();

      expect(listening.size).toBe(0);
    });
  });

  describe("systemClock", () => {
    it("reads the time, and acts after a delay unless cancelled first", async () => {
      const acted: string[] = [];
      const done = Promise.withResolvers<void>();
      const before = Date.now();
      systemClock.after(0, () => acted.push("cancelled"))();
      systemClock.after(0, () => {
        acted.push("kept");
        done.resolve();
      });
      await done.promise;

      expect(systemClock.now()).toBeGreaterThanOrEqual(before);
      expect(acted).toEqual(["kept"]);
    });
  });
});
