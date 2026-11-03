import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { CSI, stripAnsi } from "@commonfabric/cli/view/ansi";
import { urlToAppView } from "@commonfabric/navigation";
import { taggedHashStringOf } from "@commonfabric/data-model";

import {
  BOARD,
  BOARD_DOCS,
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
  type BoardView,
  type Clock,
  consoleTerminal,
  showBoard,
  systemClock,
  type Terminal,
  topicLinks,
  type ViewControl,
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

  /** Says `text` on the console as the process would, while it is held. */
  say?: (text: string, error: boolean) => void;

  /** Whether what was held has been said after all. */
  released = false;

  /** Whether the screen was given back before what was held was said. */
  givenBackFirst = false;

  hold(said: (text: string, error: boolean) => void): () => void {
    this.say = said;
    return () => {
      this.say = undefined;
      this.released = true;
      this.givenBackFirst = this.writes.join("").includes(LEAVE);
    };
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

    /** Watches the board as `viewer`, connecting through `opens`. */
    function watch(
      opens: () => Promise<OpenedSession> = connect,
      viewer?: string,
    ): Promise<void> {
      return watchBoard(
        {
          apiUrl: "https://fabric.example",
          board: BOARD,
          space: "topics space",
          mirror,
          viewer,
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

    it("withholds a comment its labels do not admit to the viewer", async () => {
      await board.write({
        "of:fid1:comment-1": {
          value: BOARD_DOCS["of:fid1:comment-1"].value,
          cfc: {
            version: 2,
            schemaHash: taggedHashStringOf(true),
            labelMap: {
              version: 1,
              entries: [{
                path: [],
                origin: "declared",
                label: {
                  confidentiality: [{
                    type: "https://commonfabric.org/cfc/atom/User",
                    subject: "did:key:zSomeoneElse",
                  }],
                },
              }],
            },
          },
        },
        [`cid:${taggedHashStringOf(true)}`]: { value: true },
      });
      const live = terminal.showing("● LIVE");
      const watching = watch(connect, "did:key:zViewer");
      const going = await live;
      terminal.type("q");
      await watching;

      expect(going).toContain("Donut glaze");
      expect(going).not.toContain("Reproduced with cold oil.");
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

  describe("topicLinks()", () => {
    const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
    const opened = (space: string, apiUrl = "https://fabric.example") =>
      urlToAppView(new URL(`${topicLinks({ apiUrl, space })}42`));

    it("links a Topic in a space named by its DID to that space and that Topic", () => {
      expect(topicLinks({ apiUrl: "https://fabric.example", space: DID }))
        .toBe(`https://fabric.example/${DID}/top/`);
      expect(opened(DID)).toEqual({
        spaceDid: DID,
        pieceSlug: "top",
        pieceMember: "42",
      });
    });

    it("links a Topic in a space with a plain name to that space and that Topic", () => {
      expect(opened("topics-dev", "https://fabric.example/")).toEqual({
        spaceName: "topics-dev",
        pieceSlug: "top",
        pieceMember: "42",
      });
    });

    it("keeps the path the deployment's address has", () => {
      expect(topicLinks({ apiUrl: "https://fabric.example/shell", space: DID }))
        .toBe(`https://fabric.example/shell/${DID}/top/`);
    });

    it("throws for a board that names no space", () => {
      expect(() => topicLinks({ apiUrl: "https://fabric.example", space: "" }))
        .toThrow("without a space");
    });
  });

  describe("showBoard()", () => {
    let board: BoardServer;
    let dir: string;
    let terminal: FakeTerminal;

    beforeEach(async () => {
      board = await boardServer();
      dir = await Deno.makeTempDir();
      terminal = new FakeTerminal();
    });

    afterEach(async () => {
      await board.close();
      await Deno.remove(dir, { recursive: true });
    });

    /** Shows the board in the view `make` makes. */
    function show(make: (control: ViewControl) => BoardView) {
      return showBoard(
        {
          apiUrl: "https://fabric.example",
          board: BOARD,
          space: "topics space",
          mirror: join(dir, "copy.json"),
        },
        {
          terminal,
          clock: new FakeClock(),
          connect: async () => {
            const { client, session } = await board.mount();
            return { space: SPACE, session, close: () => client.close() };
          },
        },
        make,
      );
    }

    it("lets a view finish while the screen is its own, draws nothing once it is given back, and sets the view's modes and unsets them", async () => {
      const updates: boolean[] = [];
      const wentLive = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      let control!: ViewControl;
      let shown = "waiting";
      const showing = show((given) => {
        control = given;
        return {
          modes: { take: "<take>", give: "<give>" },
          update(_topics, _now, live) {
            updates.push(live);
            if (live) wentLive.resolve();
          },
          input: (bytes) => bytes[0] === 0x71,
          frame: (_columns, rows) =>
            Array.from(
              { length: rows },
              (_, row) => `${CSI}${row + 1};1H${row === 0 ? shown : ""}`,
            ),
          nextFrame: () => undefined,
          async close() {
            shown = "finishing";
            control.redraw();
            await finished.promise;
          },
        };
      });
      await wentLive.promise;
      terminal.type("q");
      await terminal.showing("finishing");
      finished.resolve();
      await showing;
      shown = "after";
      control.redraw();
      const written = terminal.writes.join("");

      expect(updates).toEqual([false, true]);
      expect(written.indexOf("<take>")).toBeLessThan(
        written.indexOf("waiting"),
      );
      expect(written.indexOf("finishing")).toBeLessThan(written.indexOf(LEAVE));
      expect(written.indexOf("<give>")).toBeLessThan(written.indexOf(LEAVE));
      expect(written).not.toContain("after");
      expect(terminal.raw).toEqual([true, false]);
    });

    it("abandons what a finishing view waits for when asked to end again", async () => {
      const wentLive = Promise.withResolvers<void>();
      const closing = Promise.withResolvers<void>();
      let control!: ViewControl;
      let shown = "waiting";
      let abandoned = false;
      const showing = show((given) => {
        control = given;
        return {
          update(_topics, _now, live) {
            if (live) wentLive.resolve();
          },
          input: (bytes) => bytes[0] === 0x71,
          frame: (_columns, rows) =>
            Array.from(
              { length: rows },
              (_, row) => `${CSI}${row + 1};1H${row === 0 ? shown : ""}`,
            ),
          nextFrame: () => undefined,
          async close(abandon) {
            shown = "finishing";
            control.redraw();
            closing.resolve();
            await abandon;
            abandoned = true;
          },
        };
      });
      await wentLive.promise;
      terminal.type("q");
      await closing.promise;

      expect(abandoned).toBe(false);

      terminal.type("q");
      await showing;

      expect(abandoned).toBe(true);
      expect(terminal.writes.at(-1)).toContain(LEAVE);
    });

    it("tells the view what the process says while the screen is its own, and says it once the screen is given back", async () => {
      const wentLive = Promise.withResolvers<void>();
      const said: [string, boolean][] = [];
      let shown = "waiting";
      const showing = show(() => ({
        update(_topics, _now, live) {
          if (live) wentLive.resolve();
        },
        input: (bytes) => bytes[0] === 0x71,
        frame: (_columns, rows) =>
          Array.from(
            { length: rows },
            (_, row) => `${CSI}${row + 1};1H${row === 0 ? shown : ""}`,
          ),
        nextFrame: () => undefined,
        said(text, error) {
          said.push([text, error]);
          shown = text;
        },
      }));
      await wentLive.promise;
      terminal.say?.("Reconnecting.", true);
      await terminal.showing("Reconnecting.");
      terminal.type("q");
      await showing;

      expect(said).toEqual([["Reconnecting.", true]]);
      expect(terminal.released).toBe(true);
      expect(terminal.givenBackFirst).toBe(true);
    });

    it("restores the terminal when the input fails, and throws what failed", async () => {
      const failing = new ReadableStream<Uint8Array>({
        pull: (controller) => controller.error(new Error("Hung up.")),
      });
      terminal.input = () => failing;

      await expect(show(() => ({
        update: () => {},
        input: () => false,
        frame: () => [],
        nextFrame: () => undefined,
      }))).rejects.toThrow("Hung up.");
      expect(terminal.writes.at(-1)).toContain(LEAVE);
      expect(terminal.raw).toEqual([true, false]);
    });
  });

  describe("consoleTerminal()", () => {
    it("holds what is said on the console or standard error as one line, and says it once undone", () => {
      const printed: unknown[][] = [];
      const errors: number[] = [];
      const out = {
        ...console,
        warn: (...args: unknown[]) => void printed.push(args),
        log: (..._args: unknown[]) => {},
        assert: (..._args: unknown[]) => {},
      };
      const io = {
        ...Deno,
        stderr: { writeSync: (bytes: Uint8Array) => errors.push(bytes.length) },
      };
      const terminal = consoleTerminal(io, out);
      const said: [string, boolean][] = [];
      const undo = terminal.hold((text, error) => said.push([text, error]));
      out.warn("%c[WARN]%c %s closed\n", "color: red", "", "memory", {
        open: 1,
      });
      out.log("plain");
      out.assert(true, "fine");
      io.stderr.writeSync(new TextEncoder().encode("[WARN] direct\n"));

      expect(printed).toEqual([]);
      expect(errors).toEqual([]);
      expect(said).toEqual([
        ["[WARN] memory closed { open: 1 }", true],
        ["plain", false],
        ["[WARN] direct", true],
      ]);

      undo();

      expect(printed).toEqual([[
        "%c[WARN]%c %s closed\n",
        "color: red",
        "",
        "memory",
        { open: 1 },
      ]]);
      expect(errors).toEqual([14]);
    });

    it("says a count or a timer as it stood when asked, and clears nothing once undone", () => {
      const printed: [string, unknown[]][] = [];
      const record = (as: string) => (...args: unknown[]) =>
        void printed.push([as, args]);
      const out = {
        ...console,
        info: record("info"),
        warn: record("warn"),
        clear: record("clear"),
        count: record("count"),
        timeEnd: record("timeEnd"),
      };
      const terminal = consoleTerminal(Deno, out);
      const said: string[] = [];
      const undo = terminal.hold((text) => said.push(text));
      out.count("x");
      out.count("x");
      out.countReset("x");
      out.count("x");
      out.clear();
      out.time("t");
      out.timeEnd("t");
      out.timeEnd("t");
      // A value with nothing to make it a string is said as it is.
      out.info(Object.create(null));
      undo();

      expect(said.slice(0, 3)).toEqual(["x: 1", "x: 2", "x: 1"]);
      expect(said[3]).toMatch(/^t: \d+\.\d{3}ms$/);
      expect(said[4]).toBe("Timer 't' does not exist");
      expect(printed.map(([as, [line]]) => [as, line])).toEqual([
        ["info", "x: 1"],
        ["info", "x: 2"],
        ["info", "x: 1"],
        ["info", said[3]],
        ["warn", "Timer 't' does not exist"],
        ["info", Object.create(null)],
      ]);
    });

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
        stderr: { writeSync: (bytes) => bytes.length },
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
