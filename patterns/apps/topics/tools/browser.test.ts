import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stripAnsi } from "@commonfabric/cli/view/ansi";
import { palette as C, ui } from "@commonfabric/cli/view/theme";
import type { CfcConfClause } from "@commonfabric/runner/cfc";

import {
  Browser,
  type Opening,
  type Saved,
  type WriteOutcome,
  type WriteRequest,
} from "./browser.ts";
import type { PartLabels } from "./labels.ts";
import type { Topic, TopicComment } from "./mirror.ts";
import { columns, mix } from "./text.ts";

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const HOUR = 3_600_000;
const LINKS = "https://fabric.example/space/top/";
const ME = "did:key:z6MkMe";
const USER = "https://commonfabric.org/cfc/atom/User";

/** A Topic with every field defaulted except those given. */
function topic(fields: Partial<Topic> & { number: string }): Topic {
  return {
    address: `of:fid1:entry-${fields.number}`,
    piece: `of:fid1:piece-${fields.number}`,
    title: `Topic ${fields.number}`,
    body: "",
    createdAt: NOW - 48 * HOUR,
    // As active as it says, as a display recomputes it.
    updatedAt: fields.lastActivityAt ?? NOW - 48 * HOUR,
    createdBy: "Sol (agent)",
    lastActivityAt: NOW - 48 * HOUR,
    comments: [],
    links: [],
    mentions: [],
    ...fields,
  };
}

/** A comment by `author` saying `body`, sent `at`. */
function comment(author: string, body: string, at: number): TopicComment {
  return { author, body, sentAt: at, removed: false };
}

/** The board the tests browse. */
function board(): Topic[] {
  return [
    topic({
      number: "1",
      title: "Flaky fryer test",
      body: "The fryer test fails; see [the log](https://ci.example/run/7) " +
        "and top/2.",
      createdBy: "Sol (agent)",
      lastActivityAt: NOW - 2 * HOUR,
      comments: [
        comment("Ada (person)", "Reproduced with cold oil.", NOW - 2 * HOUR),
      ],
      links: [{
        kind: "pr",
        url: "https://example.com/pull/1",
        label: "Fix",
        addedBy: "Sol (agent)",
        addedAt: NOW - 3 * HOUR,
        removed: false,
      }],
      mentions: ["of:fid1:entry-2"],
    }),
    topic({
      number: "2",
      title: "Donut glaze cracks",
      body: "Glaze cracks under the fryer.",
      createdBy: "Egory L7 (agent)",
      lastActivityAt: NOW - 5 * HOUR,
    }),
    topic({
      number: "3",
      title: "[RESOLVED] Old oven",
      createdBy: "Egory E1 (agent)",
      lastActivityAt: NOW - 1 * HOUR,
    }),
  ];
}

/** A host that records what the browser asks of it. */
class FakeHost {
  readonly writes: {
    request: WriteRequest;
    agentName: string;
    invocation: string;
  }[] = [];
  readonly opened: string[] = [];
  readonly copied: string[] = [];
  saves = 0;
  outcomes: (WriteOutcome | Error)[] = [];

  /** Set to hold writes until it settles. */
  held: Promise<void> | undefined;

  async write(
    request: WriteRequest,
    agentName: string,
    invocation: string,
  ): Promise<WriteOutcome> {
    this.writes.push({ request, agentName, invocation });
    await this.held;
    const outcome = this.outcomes.shift() ??
      { result: "written" as const, report: "Done." };
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }

  open(url: string) {
    this.opened.push(url);
    return Promise.resolve();
  }

  copy(text: string) {
    this.copied.push(text);
    return Promise.resolve();
  }

  persisted() {
    return Promise.resolve();
  }

  save() {
    this.saves++;
  }
}

describe("browser", () => {
  let host: FakeHost;
  let saved: Saved;
  let browser: Browser;
  let redraws: number;
  let redrawn: PromiseWithResolvers<void>;

  /** Counts a redraw the browser asks for, and lets a test waiting for one go on. */
  function redraw(): void {
    redraws++;
    redrawn.resolve();
    redrawn = Promise.withResolvers<void>();
  }
  let columnsWide: number;
  let rowsTall: number;

  beforeEach(() => {
    host = new FakeHost();
    saved = {
      since: NOW - 24 * HOUR,
      seen: {},
      drafts: {},
      pending: {},
      dropped: {},
      agentName: "Tester (person)",
      hideSettled: true,
    };
    redraws = 0;
    redrawn = Promise.withResolvers<void>();
    columnsWide = 140;
    rowsTall = 40;
    browser = make();
  });

  /** Opens Topic `number`. */
  function numbered(number: string): Opening {
    return {
      name: `top/${number}`,
      find: (topics) => topics.find((topic) => topic.number === number),
    };
  }

  /** A browser over `topics`, the test board unless given, opening `open`. */
  function make(open?: Opening, topics = board()): Browser {
    const made = new Browser({
      board: { space: "space", topicLinks: LINKS, viewer: ME },
      host,
      saved,
      redraw,
      now: () => NOW,
      open,
    });
    made.update(topics, NOW, true, 42);
    return made;
  }

  /** The screen as text. */
  function screen(): string[] {
    return browser.frame(columnsWide, rowsTall, NOW).map((row) =>
      stripAnsi(row)
    );
  }

  /** Types `text`, as bytes a terminal sends, returning whether it quit. */
  function type(text: string): boolean {
    return browser.input(new TextEncoder().encode(text));
  }

  /** Where `text` first shows on screen, as a zero-based cell. */
  function find(text: string): { x: number; y: number } {
    const rows = screen();
    const y = rows.findIndex((row) => row.includes(text));
    if (y < 0) throw new Error(`The screen does not show ${text}.`);
    return { x: columns(rows[y].slice(0, rows[y].indexOf(text))), y };
  }

  /** Clicks the first cell showing `text`. */
  function click(text: string): void {
    const { x, y } = find(text);
    type(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
  }

  /** Waits for the browser to draw again of its own accord, as a write that lands makes it. */
  async function settle(): Promise<void> {
    await redrawn.promise;
  }

  /** Presses the button down at the zero-based cell `x`, `y`. */
  function press({ x, y }: { x: number; y: number }): void {
    type(`\x1b[<0;${x + 1};${y + 1}M`);
  }

  /** Moves the pointer, the button held, to the zero-based cell `x`, `y`. */
  function dragTo({ x, y }: { x: number; y: number }): void {
    type(`\x1b[<32;${x + 1};${y + 1}M`);
  }

  /** Lets the button up at the zero-based cell `x`, `y`. */
  function release({ x, y }: { x: number; y: number }): void {
    type(`\x1b[<0;${x + 1};${y + 1}m`);
  }

  /** The background a selected row of the list is drawn on, while it has the keys. */
  const SELECTED = `48;2;${mix(C.editorBg, C.blue, 0.35).join(";")}`;

  /** The text of the row of the list drawn selected. */
  function selectedRow(): string {
    return stripAnsi(
      browser.frame(columnsWide, rowsTall, NOW).find((row) =>
        row.includes(SELECTED)
      ) ?? "",
    );
  }

  /** Forty Topics, `Many 10` most recently active down to `Many 49`. */
  function many(): Topic[] {
    return Array.from(
      { length: 40 },
      (_, index) =>
        topic({
          number: String(index + 10),
          title: `Many ${index + 10}`,
          lastActivityAt: NOW - index * HOUR,
        }),
    );
  }

  /** The board with the body of top/1 long enough to scroll. */
  function long(): Topic[] {
    const topics = board();
    topics[0] = { ...topics[0], body: Array(60).fill("line").join("\n\n") };
    return topics;
  }

  describe("the list", () => {
    it("marks what a search matched by whole characters", () => {
      const accented = board();
      accented[1] = { ...accented[1], title: "Cafe\u0301 glaze" };
      browser.update(accented, NOW, true, 42);
      type("e");

      expect(browser.frame(columnsWide, rowsTall, NOW).join("")).toContain(
        "e\u0301",
      );
    });

    it("lists open Topics most recently active first, settled ones hidden until asked for", () => {
      const shown = screen().join("\n");

      expect(shown.indexOf("Flaky fryer test")).toBeLessThan(
        shown.indexOf("Donut glaze cracks"),
      );
      expect(shown).not.toContain("Old oven");
      expect(shown).toContain("2/3 +1");

      type("\x14"); // Control-T
      const all = screen().join("\n");

      expect(all.indexOf("Old oven")).toBeLessThan(
        all.indexOf("Flaky fryer test"),
      );
      expect(saved.hideSettled).toBe(false);
    });

    it("narrows the list as a search is typed, by words, by author, and by number", () => {
      type("glaze");
      expect(screen().join("\n")).not.toContain("Flaky fryer test");
      expect(screen().join("\n")).toContain("Donut glaze cracks");

      type("\x1b"); // Escape clears the search.
      type('by:"Ada (person)"');
      expect(screen().join("\n")).toContain("Flaky fryer test");
      expect(screen().join("\n")).not.toContain("Donut glaze cracks");

      type("\x1b");
      type("#3");
      const pinned = screen().join("\n");
      expect(pinned).toContain("Old oven");
    });

    it("scrolls under the wheel without snapping back to the selection, and follows the selection when it moves", () => {
      rowsTall = 16;
      browser.update(many(), NOW, true, 42);
      const { x, y } = find("Many 10");
      type(`\x1b[<65;${x + 1};${y + 1}M`);
      type(`\x1b[<65;${x + 1};${y + 1}M`);

      expect(screen().join("\n")).not.toContain("Many 10 ");
      expect(screen().join("\n")).not.toContain("Many 10 ");

      type("\x1b[B"); // down moves the selection, which is brought back

      expect(screen().join("\n")).toContain("Many 11");
    });

    it("marks a Topic with activity the person has not seen, until it is read", () => {
      const row = () =>
        screen().find((line) => line.includes("Flaky fryer test")) ?? "";
      expect(row()).toContain("●");

      type("\r");

      expect(row()).not.toContain("●");
      expect(saved.seen["1"]).toBe(NOW - 2 * HOUR);
    });

    it("orders the list by number, then by comments, then by activity again, with Control-O", () => {
      const said = (count: number) =>
        Array.from(
          { length: count },
          (_, index) => comment("Ada (person)", `Said ${index}.`, NOW - HOUR),
        );
      browser.update(
        [
          topic({ number: "5", lastActivityAt: NOW - HOUR, comments: said(1) }),
          topic({
            number: "6",
            lastActivityAt: NOW - 2 * HOUR,
            comments: said(2),
          }),
          topic({ number: "7", lastActivityAt: NOW - 3 * HOUR }),
        ],
        NOW,
        true,
        42,
      );
      const order = () =>
        screen().flatMap((row) => row.match(/Topic (\d)/)?.[1] ?? []);
      expect(order()).toEqual(["5", "6", "7"]);

      type("\x0f"); // Control-O
      expect(order()).toEqual(["7", "6", "5"]);
      expect(screen().join("\n")).toContain("↕ number");

      type("\x0f");
      expect(order()).toEqual(["6", "5", "7"]);
      expect(screen().join("\n")).toContain("↕ comments");

      type("\x0f");
      expect(order()).toEqual(["5", "6", "7"]);
      expect(screen().join("\n")).toContain("↕ activity");
    });

    it("pages the selection through the list, which follows it down and back up", () => {
      rowsTall = 16; // nine rows of the list, a page of eight
      browser = make(undefined, many());
      screen();

      type("\x1b[6~\x1b[6~"); // PageDown twice
      expect(selectedRow()).toContain("Many 26");
      expect(screen().join("\n")).not.toContain("Many 17");

      type("\x1b[5~"); // PageUp
      expect(selectedRow()).toContain("Many 18");
      type("\x1b[5~");
      expect(selectedRow()).toContain("Many 10");
    });

    it("moves to a search's end with End, and opens nothing with Enter while nothing is listed", () => {
      type("fryer\x1b[H\x1b[F"); // to the search's start, then its end
      type("X");
      expect(screen().join("\n")).toContain("Find fryerX");

      type("\r");
      const shown = screen().join("\n");
      expect(shown).toContain("No Topic matches.");
      expect(shown).toContain("Pick a Topic from the list to read it here.");
    });

    it("marks a match lying inside another match once", () => {
      type("fryer fry");

      expect(screen().join("\n")).toContain("1 Flaky fryer test");
    });

    it("drags the list's scroll bar's thumb", () => {
      rowsTall = 16;
      browser.update(many(), NOW, true, 42);
      const thumb = find("█");
      press(thumb);
      dragTo({ x: thumb.x, y: rowsTall - 3 });
      release({ x: thumb.x, y: rowsTall - 3 });

      const shown = screen().join("\n");
      expect(shown).not.toContain("Many 10");
      expect(shown).toContain("Many 49");
    });
  });

  describe("the reader", () => {
    it("shows a Topic whole: its title, who filed it, its body, links, references, and thread", () => {
      type("\r");
      const shown = screen().join("\n");

      expect(shown).toContain("top/1 Flaky fryer test");
      expect(shown).toContain("filed by Sol (agent) ◇");
      expect(shown).toContain("The fryer test fails; see the log and top/2.");
      expect(shown).toContain("Links (1)");
      expect(shown).toContain("⇄ Fix https://example.com/pull/1");
      expect(shown).toContain("References (1 out)");
      expect(shown).toContain("→ top/2  Donut glaze cracks");
      expect(shown).toContain("1. Ada (person) ◇");
      expect(shown).toContain("Reproduced with cold oil.");
      // The badge keeps its padding on both sides, in its own colors.
      expect(browser.frame(columnsWide, rowsTall, NOW).join("")).toMatch(
        new RegExp(`48;2;${C.blue.join(";")}[^m]*m\u00a0NEW\u00a0`),
      );
    });

    it("links what the Topic links to, and opens a cited Topic here, going back after", () => {
      type("\r");
      const painted = browser.frame(columnsWide, rowsTall, NOW).join("");

      expect(painted).toContain("\x1b]8;;https://ci.example/run/7\x07");
      expect(painted).toContain(`\x1b]8;;${LINKS}2\x07`);

      click("the log");
      expect(host.opened).toEqual(["https://ci.example/run/7"]);

      click("→ top/2");
      expect(screen().join("\n")).toContain("top/2 Donut glaze cracks");

      type("\x1b[1;3D"); // Alt-Left
      expect(screen().join("\n")).toContain("top/1 Flaky fryer test");
      type("\x1b[1;3C"); // Alt-Right
      expect(screen().join("\n")).toContain("top/2 Donut glaze cracks");
    });

    it("lists each Topic referred to once, marked by which way, offering to take back only a mention", () => {
      browser.update(
        [
          topic({
            number: "1",
            title: "Hub",
            body: "See top/2, top/3, and top/4.",
            mentions: ["of:fid1:entry-2", "of:fid1:piece-5"],
          }),
          topic({
            number: "2",
            title: "Both, mentioned",
            body: "Back to top/1.",
          }),
          topic({ number: "3", title: "Both, cited", body: "Also top/1." }),
          topic({ number: "4", title: "Out, cited" }),
          topic({ number: "5", title: "Out, mentioned" }),
          topic({ number: "6", title: "In, cited", body: "After top/1." }),
          topic({
            number: "7",
            title: "In, mentioned",
            mentions: ["of:fid1:entry-1"],
          }),
        ],
        NOW,
        true,
        42,
      );
      type("\r");
      const shown = screen().join("\n");

      expect(shown).toContain("References (2 out, 2 in, 2 two-way)");
      const rows = [...shown.matchAll(/[→←↔] top\/\d+[^║│\n]*/g)]
        .map(([row]) => row.trim().replace(/ {2,}/g, "  "));
      expect(rows).toEqual([
        "↔ top/2  Both, mentioned  ✕",
        "→ top/5  Out, mentioned  ✕",
        "↔ top/3  Both, cited",
        "→ top/4  Out, cited",
        "← top/6  In, cited",
        "← top/7  In, mentioned",
      ]);
    });

    it("steps through the reader's links with Tab, and follows one with Enter", () => {
      screen();
      type("\r");
      // The Topic's own number, who filed it, then its buttons.
      type("\t\t\t\r");

      expect(screen().join("\n")).toContain("Comment on top/1");
    });

    it("marks a Topic read only while the reader shows it", () => {
      type("\r");
      screen();
      const read = saved.seen["1"];
      type("\x1b[17~\x1b[15~"); // F6 to the list, F5 to zoom it
      const later = board();
      later[0] = {
        ...later[0],
        comments: [...later[0].comments, comment("Bo", "New.", NOW)],
      };
      browser.update(later, NOW, true, 42);
      screen();

      expect(saved.seen["1"]).toBe(read);

      type("\x1b[15~");
      screen();

      expect(saved.seen["1"]).toBe(NOW);
    });

    it("keeps the reader's focus on the link it was on when a live change moves it", () => {
      screen();
      type("\r");
      type("\t".repeat(11)); // past the buttons, to the link to the log
      const moved = board();
      moved[0] = {
        ...moved[0],
        body: "See [elsewhere](https://evil.example/) first. " +
          moved[0].body,
      };
      browser.update(moved, NOW, true, 42);
      screen();
      type("\r");

      expect(host.opened).toEqual(["https://ci.example/run/7"]);
    });

    it("moves the list's selection with the button held on its rows, and opens the row it is released on", () => {
      const flaky = find("Flaky fryer test");
      const donut = find("Donut glaze cracks");
      type(`\x1b[<0;${flaky.x + 1};${flaky.y + 1}M`);
      type(`\x1b[<32;${donut.x + 1};${donut.y + 1}M`);
      const held = browser.frame(columnsWide, rowsTall, NOW);

      expect(held[donut.y]).toContain(SELECTED);
      expect(held[flaky.y]).not.toContain(SELECTED);
      expect(screen().join("\n")).not.toContain("top/2 Donut glaze cracks");

      type(`\x1b[<0;${donut.x + 1};${donut.y + 1}m`);

      expect(screen().join("\n")).toContain("top/2 Donut glaze cracks");
      // The keys stay with the list, from the row it opened.
      type("\x1b[A");
      expect(browser.frame(columnsWide, rowsTall, NOW)[flaky.y]).toContain(
        SELECTED,
      );
    });

    it("goes to the top and bottom of the list, the reader, and a dialog with Home and End", () => {
      const flaky = find("Flaky fryer test");
      const donut = find("Donut glaze cracks");
      type("\x1b[F"); // End
      expect(browser.frame(columnsWide, rowsTall, NOW)[donut.y]).toContain(
        SELECTED,
      );
      type("\x1b[H"); // Home
      expect(browser.frame(columnsWide, rowsTall, NOW)[flaky.y]).toContain(
        SELECTED,
      );

      rowsTall = 16;
      browser.update(long(), NOW, true, 42);
      type("\r\x1b[F");
      expect(screen().join("\n")).not.toContain("top/1 Flaky");
      type("\x1b[H");
      expect(screen().join("\n")).toContain("top/1 Flaky");

      type("\x1bOP\x1b[F"); // F1, then End
      expect(screen().join("\n")).not.toContain("Finding Topics");
      type("\x1b[H");
      expect(screen().join("\n")).toContain("Finding Topics");
    });

    it("opens on release the row the list's selection shows, however the rows moved, and nothing under a menu", () => {
      const donut = find("Donut glaze cracks");
      type(`\x1b[<0;${donut.x + 1};${donut.y + 1}M`);
      // A newer Topic comes in above, moving the rows down under the pointer.
      const newer = board();
      newer.push({
        ...newer[0],
        number: "4",
        address: "of:fid1:entry-4",
        title: "Newest thing",
        lastActivityAt: NOW,
      });
      browser.update(newer, NOW, true, 42);
      screen();
      type(`\x1b[<0;${donut.x + 1};${donut.y + 1}m`);

      expect(screen().join("\n")).toContain("top/2 Donut glaze cracks");

      const flaky = find("Flaky fryer test");
      type(`\x1b[<0;${flaky.x + 1};${flaky.y + 1}M`);
      type("\x1b[21~"); // F10 opens a menu while it is held
      type(`\x1b[<0;${flaky.x + 1};${flaky.y + 1}m`);

      expect(screen().join("\n")).toContain("top/2 Donut glaze cracks");
    });

    it("moves in a search begun with Home and End, and to the list's ends with Control", () => {
      type("fryer\x1b[D\x1b[H"); // the cursor to the search's start
      type("X");
      expect(screen().join("\n")).toContain("Find Xfryer");
    });

    it("scrolls up from the bottom after End, in one read", () => {
      rowsTall = 16;
      browser.update(long(), NOW, true, 42);
      type("\r");
      screen();
      type("\x1b[F");
      const bottom = screen().join("\n");
      type("\x1b[H");
      screen();
      type("\x1b[F\x1b[A"); // End, then Up, together
      expect(screen().join("\n")).not.toBe(bottom);
    });

    describe("stepping", () => {
      /** The number of the Topic the reader shows. */
      function reading(): string | undefined {
        return screen().join("\n").match(/top\/(\d) (Flaky|Donut|\[RES)/)
          ?.[1];
      }

      it("steps each way with every key and menu item, keeping the keys where they were", () => {
        // The list holds top/1, then top/2.
        type("\r");
        expect(reading()).toBe("1");
        for (
          const [keys, then] of [
            ["]", "2"],
            ["[", "1"],
            ["\x1b[1;3B", "2"], // Alt-↓
            ["\x1b[1;3A", "1"], // Alt-↑
            ["\x1b[21~\x1b[C\x1b[C\x1b[Ct", "2"], // Go ▸ Next topic
            ["\x1b[21~\x1b[C\x1b[C\x1b[Cp", "1"], // Go ▸ Previous topic
          ]
        ) {
          type(keys);
          expect(reading()).toBe(then);
        }

        // From the reader, the reader keeps the keys: c comments.
        type("]c");
        expect(screen().join("\n")).toContain("Comment on top/2");
      });

      it("steps from the list's selection where it has moved off the Topic being read", () => {
        // With settled Topics shown, the list holds top/3, top/1, top/2.
        type("\x14"); // Control-T
        type("\x1b[H\r\x1b[17~"); // open top/3, then back to the list
        expect(reading()).toBe("3");
        type("\x1b[B\x1b[B"); // the selection on top/2
        type("\x1b[1;3A"); // Alt-↑

        expect(reading()).toBe("1");
        // The list keeps the keys, its frame drawn double.
        expect(screen()[1]).toMatch(/^╔═+ Topics/);
      });

      it("steps from the selection when the Topic being read is not listed, and says when nothing is", () => {
        type("\x07"); // Control-G goes to a Topic
        type("3\r"); // the settled one, which the list hides
        expect(reading()).toBe("3");

        type("\x1b[1;3B");
        expect(reading()).toBe("2");

        type("\x1b[17~zzzz"); // a search that lists nothing
        type("\x1b[1;3B");
        expect(screen().join("\n")).toContain("No Topic is listed.");
      });
    });

    it("opens a Topic named when the browser starts, and copies its reference", async () => {
      browser = make(numbered("2"));
      expect(screen().join("\n")).toContain("Glaze cracks under the fryer.");

      type("y");
      await Promise.resolve();

      expect(host.copied).toEqual(["top/2"]);
    });

    it("opens the Topic named when it starts only once", () => {
      browser = make(numbered("2"));
      type("\x1b[17~"); // F6, back to the list
      browser.update(board(), NOW, true, 42);

      expect(screen()[1]).toMatch(/^╔═+ Topics/);
    });

    it("waits for the board to be live before saying the Topic named when it starts is not on it", () => {
      const open = numbered("2");
      const cached = board().filter((topic) => topic.number !== "2");
      browser = new Browser({
        board: { space: "space", topicLinks: LINKS, viewer: ME },
        host,
        saved,
        redraw,
        now: () => NOW,
        open,
      });
      browser.update(cached, NOW, false, 42);
      expect(screen().join("\n")).not.toContain("The board has no Topic");

      browser.update(board(), NOW, true, 42);
      expect(screen().join("\n")).toContain("Glaze cracks under the fryer.");
    });

    it("says why the Topic named when it starts names none of the board's, opening none", () => {
      browser = make({
        name: "fragment",
        find: () => {
          throw new Error("It is part of the address of each of top/1, top/2.");
        },
      });
      const shown = screen().join("\n");

      expect(shown).toContain("It is part of the address of each of top/1");
      expect(shown).toContain("Pick a Topic from the list to read it here.");
    });

    it("says so when the Topic named when it starts is not on the board once live", () => {
      browser = make(numbered("99"));

      expect(screen().join("\n")).toContain("The board has no Topic top/99.");
    });

    it("draws again, as it stands, the Topic being read when the board changes it", () => {
      type("\r");
      const changed = board();
      changed[0] = {
        ...changed[0],
        comments: [
          ...changed[0].comments,
          comment("Bo (agent)", "Fixed upstream.", NOW),
        ],
        lastActivityAt: NOW,
      };
      browser.update(changed, NOW, true, 42);

      expect(screen().join("\n")).toContain("Fixed upstream.");
      expect(browser.nextFrame(NOW)).toBe(33);
      expect(browser.nextFrame(NOW + 60_000)).toBeUndefined();
    });

    it("scrolls with the arrows, J and K, the page keys, and Space", () => {
      rowsTall = 16;
      browser.update(long(), NOW, true, 42);
      type("\r");
      const title = () => screen().join("\n").includes("top/1 Flaky");
      expect(title()).toBe(true);

      for (const [down, up] of [["\x1b[B", "\x1b[A"], ["j", "k"]]) {
        type(down);
        expect(title()).toBe(false);
        type(up);
        expect(title()).toBe(true);
      }
      type("\x1b[6~"); // PageDown
      expect(screen().join("\n")).not.toContain("line\n");
      expect(title()).toBe(false);
      type("\x1b[5~"); // PageUp
      expect(title()).toBe(true);
      type(" ");
      expect(title()).toBe(false);
    });

    it("scrolls a row at a time with its scroll bar's arrows", () => {
      rowsTall = 16;
      browser.update(long(), NOW, true, 42);
      type("\r");
      click("▼");
      expect(screen().join("\n")).not.toContain("top/1 Flaky");

      click("▲");
      expect(screen().join("\n")).toContain("top/1 Flaky");
    });

    it("wraps its buttons onto more rows where they do not fit on one", () => {
      columnsWide = 60;
      type("\r");

      expect(find("Labels").y).toBeGreaterThan(find("Comment").y);
    });

    it("goes back with Backspace, and nowhere with no Topic read before", () => {
      type("\r");
      type("\x1b[1;3D"); // Alt-Left, with nothing to go back to
      expect(screen().join("\n")).toContain("top/1 Flaky fryer test");

      click("→ top/2");
      type("\x7f"); // Backspace
      expect(screen().join("\n")).toContain("top/1 Flaky fryer test");
    });

    it("steps back through the reader's links with Shift-Tab, scrolling each into view", () => {
      rowsTall = 16;
      browser.update(long(), NOW, true, 42);
      type("\r");
      screen();
      type("\x1b[Z"); // Shift-Tab, to the last link, the thread's author
      expect(screen().join("\n")).toContain("1. Ada (person)");
      expect(screen().join("\n")).not.toContain("top/1 Flaky");

      type("\t"); // around to the first, the Topic's own number
      expect(screen().join("\n")).toContain("top/1 Flaky");
      type("\t\t\x1b[Z\r"); // on to the Comment button, back to who filed it
      expect(screen().join("\n")).toContain('Find by:"Sol (agent)"');
    });

    it("lets go of the reader's focus with Esc, and then of the keys", () => {
      screen();
      type("\r");
      type("\r"); // with no link focused, nothing
      expect(screen().join("\n")).not.toMatch(/Find by:|Comment on/);

      type("\t\t"); // to who filed it
      type("\x1b");
      type("\t\t\r"); // from no link, on to who filed it again
      expect(screen().join("\n")).toContain('Find by:"Sol (agent)"');

      type("\t"); // back to the reader, its link still focused
      type("\x1b");
      type("\x1b");
      type("x"); // the list has the keys, and its search goes on
      expect(screen().join("\n")).toContain('Find by:"Sol (agent)"x');
    });

    it("steps through no links, and opens no editor, where no Topic is open", () => {
      type("\t\t"); // to the reader, then through what it shows
      expect(screen().join("\n")).toContain(
        "Pick a Topic from the list to read it here.",
      );

      type("c");
      expect(screen().join("\n")).not.toContain("Comment on");
      expect(screen().at(-1)).toContain("Open a Topic first.");
    });

    it("gives a window the keys with Alt and its number", () => {
      type("\r\x1b1g"); // Alt-1, then a search
      expect(screen().join("\n")).toContain("Find g");

      type("\x1b2c"); // Alt-2, then a comment
      expect(screen().join("\n")).toContain("Comment on top/1");
    });

    it("zooms the other window with F6 while one is zoomed, and the list with a search", () => {
      type("\r\x1b[15~"); // Enter, then F5 zooms the reader
      expect(screen().join("\n")).not.toContain("Find");

      type("\x1b[17~"); // F6
      expect(screen().join("\n")).toContain("Find");
      expect(screen().join("\n")).not.toContain("filed by");

      type("\x1b[17~/"); // back to the reader, then / searches
      expect(screen().join("\n")).toContain("Find");
      expect(screen().join("\n")).not.toContain("filed by");
    });

    it("opens the Topic being read in a web browser with O", () => {
      type("\ro");

      expect(host.opened).toEqual([`${LINKS}1`]);
    });

    it("says why a web browser could not be opened", async () => {
      host.open = () => Promise.reject(new Error("No web browser."));
      type("\ro");
      await settle();

      expect(screen().at(-1)).toContain("No web browser.");
    });

    it("says what each of the Topic menu's items needs when no Topic is open, doing nothing", () => {
      type("\x1btl"); // Topic ▸ Add link
      expect(screen().at(-1)).toContain("Open a Topic to link from.");
      type("\x1btm"); // Topic ▸ Mention a topic
      expect(screen().at(-1)).toContain("Open a Topic to mention from.");
      type("\x1bvc"); // View ▸ CFC labels
      expect(screen().at(-1)).toContain("Open a Topic to see its labels.");
      type("\x1bty"); // Topic ▸ Copy reference
      type("\x1bto"); // Topic ▸ Open in web browser

      expect(screen().join("\n")).not.toMatch(
        /Add a link|mentions…|CFC labels of/,
      );
      expect(host.copied).toEqual([]);
      expect(host.opened).toEqual([]);
    });

    it("opens here a Topic its body cites", () => {
      type("\r");
      click("top/2"); // in the body's text

      expect(screen().join("\n")).toContain("top/2 Donut glaze cracks");
      expect(host.opened).toEqual([]);
    });

    it("opens the next unread Topic with N, listed or not, until nothing is unread", () => {
      type("\r");
      screen();
      type("n");
      expect(screen().join("\n")).toContain("top/2 Donut glaze cracks");

      type("n"); // the settled one, which the list hides
      expect(screen().join("\n")).toContain("top/3 [RESOLVED] Old oven");

      type("n");
      expect(screen().at(-1)).toContain("Nothing is unread.");
      expect(screen().join("\n")).toContain("top/3 [RESOLVED] Old oven");
    });

    it("says so when stepping past either end of the list", () => {
      type("\r]]");
      expect(screen().at(-1)).toContain("This is the last Topic listed.");
      expect(screen().join("\n")).toContain("top/2 Donut glaze cracks");

      type("[[");
      expect(screen().at(-1)).toContain("This is the first Topic listed.");
      expect(screen().join("\n")).toContain("top/1 Flaky fryer test");
    });

    it("dates a comment, saying when it was edited, and says so of a time it does not know", () => {
      const dated = board();
      dated[0] = {
        ...dated[0],
        comments: [{
          ...comment("Ada (person)", "Undated.", 0),
          editedAt: NOW - 30 * 60_000,
        }],
      };
      dated[1] = { ...dated[1], updatedAt: 0, lastActivityAt: 0 };
      browser.update(dated, NOW, true, 42);
      type("#1\r");
      expect(screen().join("\n")).toContain(
        "1. Ada (person) ◇ · - · edited 30m ago",
      );

      type("\x1b[17~\x15#2\r"); // the list, a search for top/2, and Enter
      expect(screen().join("\n")).toContain("· active never");
    });

    it("shows a web link by its address when it has no label", () => {
      const linked = board();
      linked[0] = {
        ...linked[0],
        links: [{ ...linked[0].links[0], kind: "web", label: "" }],
      };
      browser.update(linked, NOW, true, 42);
      type("\r");

      expect(screen().join("\n")).toContain("↗ https://example.com/pull/1");
    });

    it("gives the keys to the reader when its text is clicked", () => {
      type("\r\x1b[17~"); // F6, back to the list
      click("Reproduced with cold oil.");
      type("c");

      expect(screen().join("\n")).toContain("Comment on top/1");
    });

    it("keeps where it may go forward when the Topic being read is opened again", () => {
      type("\r");
      click("→ top/2");
      type("\x1b[1;3D"); // Alt-Left, back to top/1
      type("\x1b[17~\r"); // F6, then Enter on top/1 in the list
      type("\x1b[1;3C"); // Alt-Right

      expect(screen().join("\n")).toContain("top/2 Donut glaze cracks");
    });

    it("opens nothing for a click on a reference to a Topic the board has since taken away", () => {
      type("\r");
      const cited = find("→ top/2");
      browser.update(board().slice(0, 1), NOW, true, 42);
      press(cited);
      release(cited);

      expect(screen().join("\n")).toContain("top/1 Flaky fryer test");
    });

    it("asks nothing for a click taking back a link or a mention of a Topic the board has since taken away", () => {
      type("\r");
      const link = find("✕");
      const mention = find("cracks  ✕");
      browser.update(board().slice(1), NOW, true, 42);
      for (const at of [link, { x: mention.x + 8, y: mention.y }]) {
        press(at);
        release(at);
      }

      expect(screen().join("\n")).not.toContain("Are you sure?");
    });

    it("goes back to no Topic the board has since taken away", () => {
      type("\r");
      click("→ top/2");
      browser.update(board().slice(1), NOW, true, 42);
      type("\x1b[1;3D"); // Alt-Left

      expect(screen().join("\n")).toContain("top/2 Donut glaze cracks");
    });

    it("lets go of a scroll bar's thumb whose window is no longer drawn", () => {
      rowsTall = 16;
      browser.update(long(), NOW, true, 42);
      type("\r");
      const thumb = find("█");
      press(thumb);
      type("\x1b[17~\x1b[15~"); // F6, then F5 zooms the list over the reader
      screen();
      dragTo({ x: thumb.x, y: rowsTall - 3 });
      release({ x: thumb.x, y: rowsTall - 3 });
      type("\x1b[15~");

      expect(screen().join("\n")).toContain("top/1 Flaky");
    });
  });

  describe("writing", () => {
    it("keeps a comment as a draft when its editor closes, and posts it when saved", async () => {
      type("\r\x1bOQ"); // Enter, then F2.
      type("Looks **cold**.");

      expect(screen().join("\n")).toContain("Comment on top/1");
      expect(screen().join("\n")).toContain("Looks cold."); // the preview

      type("\x1b");
      // Each keystroke changed the draft, and each change is stamped later
      // than the one before, though the clock stands still.
      const draft = saved.drafts["comment:1"];
      expect(draft).toEqual({
        fields: ["Looks **cold**."],
        base: "",
        invocation: expect.stringMatching(/^topics-/),
        at: NOW + "Looks **cold**.".length - 1,
      });
      expect(screen().join("\n")).toContain("✎");

      type("c");
      expect(screen().join("\n")).toContain("Resumed your draft.");

      type("\x13"); // Control-S
      await settle();

      expect(host.writes.map(({ request, agentName }) => [request, agentName]))
        .toEqual([[
          { verb: "comment", topic: "1", text: "Looks **cold**." },
          "Tester (person)",
        ]]);
      // Under the invocation of the version of the draft it saves.
      expect(host.writes[0].invocation).toBe(draft?.invocation);
      expect(saved.drafts).toEqual({});
      expect(saved.pending).toEqual({});
    });

    it("takes a draft out while its write is under way, so it is neither posted twice nor lost", async () => {
      const release = Promise.withResolvers<void>();
      host.held = release.promise;
      type("\rc");
      type("First.\x13");

      expect(saved.drafts).toEqual({});
      expect(Object.values(saved.pending).map((p) => p.draft?.fields))
        .toEqual([["First."]]);

      type("c");
      expect(screen().join("\n")).not.toContain("Comment on top/1");
      expect(screen().join("\n")).toContain("Still commenting on top/1.");

      release.resolve();
      await settle();

      expect(host.writes.length).toBe(1);
      expect(saved.pending).toEqual({});
    });

    it("draws again only when the spinner turns or a note goes, while a write is under way", () => {
      const release = Promise.withResolvers<void>();
      host.held = release.promise;
      type("\rm2\r");
      // The mention's note says it is being written.
      const at = NOW + 60_000;

      expect(browser.nextFrame(at)).toBe(150);
      expect(browser.nextFrame(at + 100)).toBe(50);

      release.resolve();
    });

    it("gives a draft back when its write certainly failed", async () => {
      host.outcomes = [{ result: "failed", message: "No such Topic." }];
      type("\rc");
      type("Kept.\x13");
      await settle();

      expect(saved.drafts["comment:1"]?.fields).toEqual(["Kept."]);
      expect(saved.pending).toEqual({});
      expect(screen().join("\n")).toContain("Your draft is kept.");
    });

    it("asks before replacing a body someone else changed after the edit began", async () => {
      type("\re");
      type(" More.");
      const changed = board();
      changed[0] = { ...changed[0], body: "Their new body." };
      browser.update(changed, NOW, true, 42);

      expect(screen().join("\n")).toContain(
        "changed on the board after you began",
      );

      type("\x13");
      expect(screen().join("\n")).toContain("Are you sure?");
      expect(host.writes).toEqual([]);

      click(" Replace theirs ");
      await settle();

      expect(host.writes[0].request).toEqual({
        verb: "body",
        topic: "1",
        text:
          "The fryer test fails; see [the log](https://ci.example/run/7) and top/2. More.",
      });
    });

    it("forgets a body draft left as it began, even after the board changed the body", () => {
      type("\re");
      const changed = board();
      changed[0] = { ...changed[0], body: "Their new body." };
      browser.update(changed, NOW, true, 42);
      type("\x1b");

      expect(saved.drafts).toEqual({});
    });

    it("asks for a name to sign with when it has none, and remembers it", async () => {
      delete saved.agentName;
      type("\rm2\r");

      expect(screen().join("\n")).toContain("Sign your writes");

      type("Ian (person)\r");
      await settle();

      expect(saved.agentName).toBe("Ian (person)");
      expect(host.writes[0].request).toEqual({
        verb: "mention",
        topic: "1",
        other: "2",
      });
    });

    it("keeps a write that may have landed, and settles it under the same invocation", async () => {
      host.outcomes = [{ result: "unsettled", message: "Lost the answer." }];
      type("\rl");
      type("https://example.com/x\r\r");
      await settle();

      expect(screen().join("\n")).toContain("An unfinished write");
      expect(screen().join("\n")).toContain("Lost the answer.");
      expect(Object.values(saved.pending).map((p) => p.failure)).toEqual([
        "Lost the answer.",
      ]);

      click(" Settle it ");
      await settle();

      expect(host.writes.map((w) => w.invocation)).toEqual([
        host.writes[0].invocation,
        host.writes[0].invocation,
      ]);
      expect(host.writes[1].request).toEqual({
        verb: "link",
        topic: "1",
        url: "https://example.com/x",
        label: "",
        kind: "web",
      });
      expect(saved.pending).toEqual({});
    });

    it("takes a host that throws as a write that may have landed", async () => {
      host.outcomes = [new Error("The host went away.")];
      type("\rm2\r");
      await settle();

      expect(Object.values(saved.pending).map((p) => p.failure)).toEqual([
        "The host went away.",
      ]);
    });

    it("offers, once live, to settle the writes the last run left unfinished", async () => {
      saved.pending["topics-left"] = {
        request: { verb: "comment", topic: "1", text: "Left over." },
        draft: { key: "comment:1", fields: ["Left over."], base: "" },
        agentName: "Tester (person)",
        attempts: 1,
        at: NOW - HOUR,
      };
      browser = new Browser({
        board: { space: "space", topicLinks: LINKS, viewer: ME },
        host,
        saved,
        redraw,
        now: () => NOW,
      });
      browser.update(board(), NOW, false, 42);
      expect(screen().join("\n")).not.toContain("An unfinished write");

      browser.update(board(), NOW, true, 42);
      expect(screen().join("\n")).toContain("An unfinished write");
      expect(screen().join("\n")).toContain("Left over.");
      // The draft is set apart from what the dialog says by a blank row.
      const draft = find("Left over.");
      const above = screen()[draft.y - 1];
      expect(above.slice(draft.x - 3, draft.x + 12).trim()).toBe("");

      click(" Settle it ");
      await settle();

      expect(host.writes.map((w) => w.invocation)).toEqual(["topics-left"]);
    });

    it("lets go of a draft another browser posted, as it saves", () => {
      saved.drafts["comment:1"] = { fields: ["Posted."], base: "", at: 5 };
      browser.reconcile({
        ...saved,
        drafts: {},
        dropped: { "comment:1": { at: 5, when: NOW } },
      });
      type("\rc");

      expect(screen().join("\n")).not.toContain("Resumed your draft.");
      expect(saved.drafts).toEqual({});
    });

    it("closes an editor whose draft another browser posted, so it is not posted twice", () => {
      type("\rc");
      type("Same words.");
      const theirs = structuredClone(saved);
      delete theirs.drafts["comment:1"];
      theirs.dropped["comment:1"] = {
        at: saved.drafts["comment:1"].at,
        when: NOW,
      };
      browser.reconcile(theirs);

      expect(screen().join("\n")).not.toContain("Comment on top/1");
      expect(screen().join("\n")).toContain("posted or thrown away");
      expect(saved.drafts).toEqual({});
    });

    it("takes into an open editor the newer draft another browser saved", () => {
      type("\rc");
      type("hello");
      const theirs = structuredClone(saved);
      theirs.drafts["comment:1"] = {
        fields: ["hello world"],
        base: "",
        at: saved.drafts["comment:1"].at + 1,
      };
      browser.reconcile(theirs);
      type("\x1b[D"); // a cursor move, which changes nothing

      expect(screen().join("\n")).toContain("hello world");
      expect(saved.drafts["comment:1"]?.fields).toEqual(["hello world"]);
    });

    it("takes in with another browser's draft what it began from", () => {
      type("\re");
      const theirs = structuredClone(saved);
      theirs.drafts["body:1"] = {
        fields: ["Their edit."],
        base: "An older body.",
        at: NOW + 5,
      };
      browser.reconcile(theirs);

      expect(screen().join("\n")).toContain("changed on the board after");
    });

    it("keeps no draft of an editor opened and left as it began", () => {
      type("\re");

      expect(saved.drafts).toEqual({});
      expect(type("\x1bx")).toBe(true);
      expect(saved.drafts).toEqual({});
    });

    it("saves nothing while a write of the same draft is pending", () => {
      type("\rc");
      type("Mine.");
      saved.pending["topics-elsewhere"] = {
        request: { verb: "comment", topic: "1", text: "Mine." },
        draft: { key: "comment:1", fields: ["Mine."], base: "" },
        agentName: "Tester (person)",
        attempts: 1,
        at: NOW,
      };
      type("\x13");

      expect(host.writes).toEqual([]);
      expect(screen().join("\n")).toContain("Already commenting on top/1.");
    });

    it("offers to settle, rather than to edit again, a write left pending", () => {
      saved.pending["topics-left"] = {
        request: { verb: "comment", topic: "1", text: "Left." },
        draft: { key: "comment:1", fields: ["Left."], base: "" },
        agentName: "Tester (person)",
        attempts: 1,
        at: NOW,
      };
      type("\rc");

      expect(screen().join("\n")).toContain("An unfinished write");
      expect(screen().join("\n")).not.toContain("Comment on top/1");
    });

    it("opens no editor of the body of a Topic the display withholds", () => {
      const withheld = board();
      withheld[0] = {
        ...withheld[0],
        labels: {
          label: {
            confidentiality: [{ type: USER, subject: "did:key:zSomeoneElse" }],
          },
          confidentiality: [["User(did:key:zSomeoneElse)"]],
          integrity: [],
          authors: [],
        },
      };
      browser.update(withheld, NOW, true, 42);
      type("\re");

      expect(screen().join("\n")).not.toContain("Edit the body");
      expect(screen().join("\n")).toContain("withheld from this display.");
    });

    it("saves no body over a Topic the display withholds since the edit began", () => {
      type("\re");
      type(" More.");
      const withheld = board();
      withheld[0] = {
        ...withheld[0],
        labels: {
          label: {
            confidentiality: [{ type: USER, subject: "did:key:zSomeoneElse" }],
          },
          confidentiality: [["User(did:key:zSomeoneElse)"]],
          integrity: [],
          authors: [],
        },
      };
      browser.update(withheld, NOW, true, 42);

      expect(screen().join("\n")).toContain("withheld from this display now");

      type("\x13");

      expect(host.writes).toEqual([]);
      expect(screen().join("\n")).not.toContain("Are you sure?");
    });

    it("asks everything again once a question is answered, posting nothing another browser posted meanwhile", () => {
      type("\re");
      type(" More.");
      const changed = board();
      changed[0] = { ...changed[0], body: "Their new body." };
      browser.update(changed, NOW, true, 42);
      type("\x13");
      expect(screen().join("\n")).toContain("Are you sure?");

      const theirs = structuredClone(saved);
      delete theirs.drafts["body:1"];
      theirs.dropped["body:1"] = { at: saved.drafts["body:1"].at, when: NOW };
      browser.reconcile(theirs);

      expect(screen().join("\n")).not.toContain("Are you sure?");
      expect(host.writes).toEqual([]);
    });

    it("saves nothing over a body withheld while the question was asked", () => {
      type("\re");
      type(" More.");
      const changed = board();
      changed[0] = { ...changed[0], body: "Their new body." };
      browser.update(changed, NOW, true, 42);
      type("\x13");
      changed[0] = {
        ...changed[0],
        labels: {
          label: {
            confidentiality: [{ type: USER, subject: "did:key:zSomeoneElse" }],
          },
          confidentiality: [["User(did:key:zSomeoneElse)"]],
          integrity: [],
          authors: [],
        },
      };
      browser.update(changed, NOW, true, 42);
      click(" Replace theirs ");

      expect(host.writes).toEqual([]);
      expect(screen().join("\n")).toContain("withheld from this display now");
    });

    it("forgets an unfinished write only once that is confirmed", () => {
      saved.pending["topics-left"] = {
        request: { verb: "mention", topic: "1", other: "2" },
        agentName: "Tester (person)",
        attempts: 1,
        failure: "Lost.",
        at: NOW - HOUR,
      };
      type("\x1bf");
      type("u");
      click(" Forget it ");
      expect(saved.pending["topics-left"]).toBeDefined();

      click(" Forget write ");
      expect(saved.pending).toEqual({});
      expect(saved.dropped["topics-left"]).toEqual({
        at: NOW - HOUR,
        when: NOW,
      });
    });

    it("takes back a link only once it is confirmed, offering it only on the newest link to an address", async () => {
      const doubled = board();
      doubled[0] = {
        ...doubled[0],
        links: [...doubled[0].links, {
          ...doubled[0].links[0],
          label: "Again",
        }],
      };
      browser.update(doubled, NOW, true, 42);
      type("\r");
      expect(screen().join("\n").match(/✕/g)?.length).toBe(2); // and a mention

      click("✕");
      expect(screen().join("\n")).toContain("Take back the link");

      type("\t\r"); // Take back
      await settle();

      expect(host.writes[0].request).toEqual({
        verb: "unlink",
        topic: "1",
        url: "https://example.com/pull/1",
      });
    });

    it("finishes the writes under way when it closes, and fails naming one that may not have finished", async () => {
      const release = Promise.withResolvers<void>();
      host.held = release.promise;
      host.outcomes = [{ result: "unsettled", message: "Lost." }];
      type("\rm2\r");
      const closing = browser.close(new Promise(() => {}));

      expect(screen().join("\n")).toContain("Finishing 1 write…");
      expect(redraws).toBeGreaterThan(0);

      release.resolve();
      await expect(closing).rejects.toThrow(
        "These writes may not have finished",
      );
      expect(screen().join("\n")).not.toContain("An unfinished write");
    });

    it("signs its writes with the name it is given", async () => {
      browser = new Browser({
        board: { space: "space", topicLinks: LINKS, viewer: ME },
        host,
        saved,
        redraw,
        now: () => NOW,
        agentName: "Given (agent)",
      });
      browser.update(board(), NOW, true, 42);
      expect(saved.agentName).toBe("Given (agent)");
      expect(screen().at(-1)).toContain("writing as Given (agent)");

      type("\rm2\r");
      await settle();

      expect(host.writes.map((w) => w.agentName)).toEqual(["Given (agent)"]);
    });

    it("files a new Topic only once it has a title and a body, typed where a field is clicked", async () => {
      type("\x0e"); // Control-N
      type("Cold oil");
      type("\x1bi"); // Alt-I files it
      expect(screen().at(-1)).toContain("A topic needs a title and a body.");
      expect(host.writes).toEqual([]);

      const label = find("Body (Markdown)");
      press({ x: label.x, y: label.y + 1 });
      release({ x: label.x, y: label.y + 1 });
      type("Fry hot.\rThen rest.");
      expect(saved.drafts["new"]?.fields).toEqual([
        "Cold oil",
        "Fry hot.\nThen rest.",
      ]);

      type("\x1bi");
      await settle();

      expect(host.writes.map((w) => w.request)).toEqual([
        { verb: "new", title: "Cold oil", body: "Fry hot.\nThen rest." },
      ]);
      expect(screen().join("\n")).not.toContain("File a new topic");
      expect(saved.drafts).toEqual({});
    });

    it("throws a draft away once that is confirmed, from the button Shift-Tab reaches", () => {
      type("\x0e");
      type("Half an idea");
      type("\x1b[Z\r"); // Shift-Tab, around to Discard, then Enter
      expect(screen().join("\n")).toContain("Throw this draft away?");
      expect(saved.drafts["new"]?.fields).toEqual(["Half an idea", ""]);

      type("t");

      expect(screen().join("\n")).not.toContain("File a new topic");
      expect(saved.drafts).toEqual({});
      expect(saved.dropped["new"]).toBeDefined();
    });

    it("forgets a draft taken back to what the editor began with when it closes", () => {
      type("\rc");
      type("x\x7f"); // a letter, then Backspace
      type("\x1b");

      expect(saved.drafts).toEqual({});
      expect(screen().at(-1)).not.toContain("Your draft is kept");
    });

    it("says what each form lacks, writing nothing", () => {
      type("\rc\x13"); // Control-S, with nothing written
      expect(screen().at(-1)).toContain("There is nothing to save.");
      type("\x1b");

      type("l\r\r"); // a link with no address
      expect(screen().at(-1)).toContain("A link needs an address.");
      type("\x1b");

      type("m99\r"); // a mention of no Topic on the board
      expect(screen().at(-1)).toContain(
        "Name a Topic on the board by its number.",
      );
      type("\x1b");

      delete saved.agentName;
      type("m2\r\r"); // a signature of no name
      expect(screen().at(-1)).toContain("Writes are signed with a name.");

      expect(host.writes).toEqual([]);
    });

    it("moves a form's focus to its next field or button from the status line", () => {
      type("\x07"); // Control-G
      const next = screen().at(-1)!.indexOf("Tab Next");
      press({ x: next, y: rowsTall - 1 });
      release({ x: next, y: rowsTall - 1 });
      type("g"); // with a button focused, its letter presses it

      expect(screen().at(-1)).toContain("The board has no such Topic.");
    });

    it("says when no write is unfinished", () => {
      type("\x1bfu"); // File ▸ Unfinished writes

      expect(screen().at(-1)).toContain("No write is unfinished.");
      expect(screen().join("\n")).not.toContain("An unfinished write");
    });

    it("takes back no link the board took back while it asked", () => {
      type("\r");
      click("✕");
      const unlinked = board();
      unlinked[0] = { ...unlinked[0], links: [] };
      browser.update(unlinked, NOW, true, 42);
      type("t");

      expect(screen().at(-1)).toContain(
        "That link can no longer be taken back from here.",
      );
      expect(host.writes).toEqual([]);
    });

    describe("a mention", () => {
      beforeEach(() => {
        browser.update(
          [
            topic({ number: "1", mentions: ["of:fid1:entry-2"] }),
            topic({ number: "2" }),
          ],
          NOW,
          true,
          42,
        );
        type("\r");
        click("✕");
      });

      it("is taken back once that is confirmed", async () => {
        type("r");
        await settle();

        expect(host.writes.map((w) => w.request)).toEqual([
          { verb: "unmention", topic: "1", other: "2" },
        ]);
      });

      it("is not taken back from a Topic the board took away while it asked", () => {
        browser.update([topic({ number: "2" })], NOW, true, 42);
        type("r");

        expect(screen().at(-1)).toContain("top/1 is no longer on the board.");
        expect(host.writes).toEqual([]);
      });
    });

    it("saves nothing of, and shows nothing of, a body the board took away while it was edited", () => {
      type("\re More.");
      browser.update(board().slice(1), NOW, true, 42);
      expect(screen().join("\n")).toContain(
        "⚠ top/1 is no longer on the board.",
      );

      type("\x1bt"); // Alt-T, Theirs
      expect(screen().join("\n")).not.toContain("What top/1 holds now");
      type("\x13"); // Control-S

      expect(screen().join("\n")).not.toContain("Are you sure?");
      expect(screen().at(-1)).toContain("top/1 is no longer on the board.");
      expect(host.writes).toEqual([]);
    });
  });

  describe("authors", () => {
    it("lists everyone who wrote, or their families, and lists what one wrote", () => {
      type("\t");
      type("a");
      const names = screen().join("\n");
      expect(names).toContain("Egory L7 (agent)");
      expect(names).toContain("Ada (person)");

      type("f");
      expect(screen().join("\n")).not.toContain("Egory L7");

      click("Egory");
      expect(screen().join("\n")).toContain("by:^Egory\\b");
      expect(screen().join("\n")).toContain("Donut glaze cracks");
      expect(screen().join("\n")).not.toContain("Flaky fryer test");
    });

    it("lists what someone wrote when their name is clicked", () => {
      type("\r");
      click("Ada (person)");

      expect(screen().join("\n")).toContain('by:"Ada (person)"');
    });

    it("moves its selection with the arrows, the page keys, Home, and End, keeping it in view, and lists what the one chosen wrote", () => {
      rowsTall = 16;
      browser.update(
        Array.from({ length: 20 }, (_, index) =>
          topic({
            number: String(index + 10),
            createdBy: `Writer ${index + 10} (agent)`,
            createdAt: NOW - index * HOUR,
            lastActivityAt: NOW - index * HOUR,
          })),
        NOW,
        true,
        42,
      );
      /** The author the dialog shows selected. */
      const picked = () =>
        browser.frame(columnsWide, rowsTall, NOW).join("").match(
          new RegExp(`48;2;${C.button.join(";")}[^m]*m(Writer \\d+)`),
        )?.[1];
      type("\x1bva"); // View ▸ Authors
      expect(picked()).toBe("Writer 10");

      type("\x1b[B");
      expect(picked()).toBe("Writer 11");
      type("\x1b[A");
      expect(picked()).toBe("Writer 10");

      type("\x1b[F"); // End
      expect(picked()).toBe("Writer 29");
      expect(screen().join("\n")).not.toContain("Writer 10");
      type("\x1b[H"); // Home
      expect(picked()).toBe("Writer 10");

      type("\x1b[6~"); // PageDown
      expect(screen().join("\n")).not.toContain("Writer 10");
      type("\x1b[5~"); // PageUp
      expect(picked()).toBe("Writer 10");

      type("x"); // which presses nothing
      expect(screen().join("\n")).toContain("Filed  Comments");

      type("\x1b[B\r");
      expect(screen().join("\n")).not.toContain("Filed  Comments");
      expect(screen().join("\n")).toContain('Find by:"Writer 11 (agent)"');
    });

    it("closes from the status line", () => {
      type("\x1bva");
      const close = screen().at(-1)!.indexOf("C Close");
      press({ x: close, y: rowsTall - 1 });
      release({ x: close, y: rowsTall - 1 });

      expect(screen().join("\n")).not.toContain("Filed  Comments");
    });
  });

  describe("CFC labels", () => {
    /** What CFC says, with the label a display fits made from it. */
    function labels(
      confidentiality: string[][],
      authors: string[] = [],
    ): PartLabels {
      return {
        label: {
          confidentiality: confidentiality.map((alternatives): CfcConfClause =>
            alternatives.length === 1
              ? { type: USER, subject: alternatives[0] }
              : {
                anyOf: alternatives.map((subject) => ({ type: USER, subject })),
              }
          ),
          integrity: authors.map((subject) => ({
            kind: "authored-by",
            subject,
          })),
        },
        confidentiality: confidentiality.map((alternatives) =>
          alternatives.map((subject) => `User(${subject})`)
        ),
        integrity: authors.map((subject) => `authored-by(${subject})`),
        authors,
      };
    }

    it("shows what the display admits to the viewer, marked, and names who integrity says wrote it, apart from the typed name", () => {
      const labeled = board();
      labeled[0] = {
        ...labeled[0],
        labels: labels([[ME]]),
        comments: [{
          ...labeled[0].comments[0],
          labels: labels([], ["did:key:z6MkAda"]),
        }],
      };
      browser.update(labeled, NOW, true, 42);
      const row = screen().find((line) => line.includes("Flaky fryer test")) ??
        "";
      expect(row).toContain("◈");

      type("\r");
      const shown = screen().join("\n");
      expect(shown).toContain(`Only for User(${ME})`);
      expect(shown).toContain("The fryer test fails");
      expect(shown).toContain("Ada (person) · ✓ written by did:key:z6MkAda");

      type("i");
      const dialog = screen().join("\n");
      expect(dialog).toContain("CFC labels of top/1");
      expect(dialog).toContain("Integrity: authored-by(did:key:z6MkAda).");
    });

    it("withholds what the display does not admit to the viewer, and what has labels it cannot read", () => {
      const labeled = board();
      labeled[0] = {
        ...labeled[0],
        comments: [{
          ...labeled[0].comments[0],
          labels: labels([["did:key:zSomeoneElse"]]),
        }, {
          ...labeled[0].comments[0],
          body: "Unreadable.",
          labels: { ...labels([]), unreadable: true },
        }],
      };
      labeled[1] = {
        ...labeled[1],
        labels: labels([["did:key:zSomeoneElse"]]),
      };
      browser.update(labeled, NOW, true, 42);
      const list = screen().join("\n");
      expect(list).not.toContain("Donut glaze cracks");
      expect(list).toContain("withheld from this display");

      type("#1\r");
      const shown = screen().join("\n");
      expect(shown).not.toContain("Reproduced with cold oil.");
      expect(shown).not.toContain("Unreadable.");
      expect(shown.match(/Withheld: its labels do not admit it/g)?.length)
        .toBe(1);
      expect(shown).toContain("⚠ Withheld: its labels cannot be read.");

      type("i");
      const dialog = screen().join("\n");
      expect(dialog).toContain("• Withheld: its labels cannot be read.");
      expect(dialog).toContain(
        "• Withheld: its labels do not admit it to this display.",
      );
    });

    it("finds nothing of a withheld Topic by its words, its author, or a reference to it", () => {
      const labeled = board();
      labeled[1] = {
        ...labeled[1],
        labels: labels([["did:key:zSomeoneElse"]]),
      };
      browser.update(labeled, NOW, true, 42);

      type("glaze");
      expect(screen().join("\n")).not.toContain("top/2");
      expect(screen().join("\n")).toContain("0/");

      type("\x15by:Egory L7");
      expect(screen().join("\n")).toContain("0/");

      type("\x15#1\r");
      expect(screen().join("\n")).not.toContain("Donut");
    });

    it("lists no author of what is withheld", () => {
      const labeled = board();
      labeled[1] = {
        ...labeled[1],
        labels: labels([["did:key:zSomeoneElse"]]),
      };
      browser.update(labeled, NOW, true, 42);
      type("\x1b[21~\x1b[C\x1b[C\r"); // View ▸ Authors…

      expect(screen().join("\n")).not.toContain("Egory L7");
    });

    it("offers to take back no link filed before one that is withheld", () => {
      const labeled = board();
      labeled[0] = {
        ...labeled[0],
        links: [...labeled[0].links, {
          ...labeled[0].links[0],
          labels: labels([["did:key:zSomeoneElse"]]),
        }],
      };
      browser.update(labeled, NOW, true, 42);
      type("\r");

      expect(screen().join("\n")).toContain("Withheld");
      // Only the mention offers to be taken back.
      expect(screen().join("\n").match(/✕/g)?.length).toBe(1);
    });
  });

  describe("the menus and the frame", () => {
    it("opens a menu with F10 and runs an item with the keyboard or a click", () => {
      type("\x1b[21~"); // F10
      expect(screen().join("\n")).toContain("New topic…");

      type("\x1b[C\x1b[C"); // to View
      expect(screen().join("\n")).toContain("Authors…");

      type("\r");
      expect(screen().join("\n")).toContain("Filed  Comments");
      type("\x1b");

      click("Help");
      click("Keys and search…");
      expect(screen().join("\n")).toContain("Finding Topics");
    });

    it("moves through a menu's items with Up and Down, past its separators, and between menus with Left and Right", () => {
      /** Whether the item whose label goes on with `rest` is highlighted. */
      const highlighted = (rest: string) =>
        new RegExp(`48;2;${C.button.join(";")}[^m]*m${rest}`).test(
          browser.frame(columnsWide, rowsTall, NOW).join(""),
        );
      type("\x1b[21~\x1b[D"); // F10, then Left, around to Help
      expect(screen().join("\n")).toContain("Keys and search…");
      type("\x1b[C"); // Right, around to File
      expect(highlighted("ew topic")).toBe(true);

      type("\x1b[B\x1b[B"); // Down twice
      expect(highlighted("nfinished writes")).toBe(true);
      type("\x1b[A"); // Up
      expect(highlighted("o to topic")).toBe(true);
      expect(highlighted("nfinished writes")).toBe(false);

      // Down twice more passes the separator, to Exit.
      type("\x1b[B\x1b[B");
      expect(type("\r")).toBe(true);
    });

    it("closes a menu when its title is clicked again, or something outside it is pressed", () => {
      click("File");
      expect(screen().join("\n")).toContain("New topic…");
      click("File");
      expect(screen().join("\n")).not.toContain("New topic…");

      type("\r\x1b[21~"); // Enter, then F10
      expect(screen().join("\n")).toContain("New topic…");
      press(find("Reproduced with cold oil."));
      expect(screen().join("\n")).not.toContain("New topic…");
    });

    it("scrolls a dialog of text with the arrows, the page keys, Space, the wheel, and its thumb, and does nothing for other keys", () => {
      type("\x1bOP"); // F1
      const top = () => screen().join("\n").includes("Finding Topics");
      expect(top()).toBe(true);

      for (const [down, up] of [["\x1b[B", "\x1b[A"], ["\x1b[6~", "\x1b[5~"]]) {
        type(down);
        expect(top()).toBe(false);
        type(up);
        expect(top()).toBe(true);
      }
      type(" ");
      expect(top()).toBe(false);
      type("\x1b[H");

      const help = find("Finding Topics");
      type(`\x1b[<65;${help.x + 1};${help.y + 1}M`); // the wheel, down
      expect(top()).toBe(false);
      type("\x1b[H");

      const thumb = find("█");
      press(thumb);
      dragTo({ x: thumb.x, y: rowsTall - 4 });
      release({ x: thumb.x, y: rowsTall - 4 });
      expect(top()).toBe(false);

      type("x");
      expect(screen().join("\n")).toContain("═ Keys and search ═");
    });

    it("takes no press outside a dialog but on the status line", () => {
      type("\x1bOP"); // F1
      click("File");

      expect(screen().join("\n")).not.toContain("New topic…");
      expect(screen().join("\n")).toContain("═ Keys and search ═");
    });

    it("says so, asking nothing, when there is nothing to mark read", () => {
      saved.since = NOW;
      type("\x1bvm"); // View ▸ Mark all read

      expect(screen().at(-1)).toContain("Nothing is unread.");
      expect(screen().join("\n")).not.toContain("Are you sure?");
    });

    it("pushes a button down while it is held, and presses it only when released over it", () => {
      type("\x1bOP"); // F1
      const close = find(" Close ");
      type(`\x1b[<0;${close.x + 1};${close.y + 1}M`);

      expect(find(" Close ").x).toBe(close.x + 1);

      // Moved off before the release, it does nothing.
      type(
        `\x1b[<32;${close.x + 1};${close.y - 2}M\x1b[<0;${close.x + 1};${
          close.y - 2
        }m`,
      );
      expect(screen().join("\n")).toContain("Finding Topics");
      expect(find(" Close ").x).toBe(close.x);

      type(
        `\x1b[<0;${close.x + 2};${close.y + 1}M\x1b[<0;${close.x + 2};${
          close.y + 1
        }m`,
      );
      expect(screen().join("\n")).not.toContain("Finding Topics");
    });

    it("presses a button from its first column, pushed or not", () => {
      type("\x1bOP"); // F1
      const close = find(" Close ");
      type(`\x1b[<0;${close.x + 1};${close.y + 1}M`);
      const pushed = browser.frame(columnsWide, rowsTall, NOW).join("");
      type(`\x1b[<0;${close.x + 1};${close.y + 1}m`);

      // Pushed, it keeps its colors rather than turning them about.
      expect(pushed).toMatch(
        new RegExp(`48;2;${C.button.join(";")}[^m]*mlose `),
      );
      expect(screen().join("\n")).not.toContain("Finding Topics");
    });

    it("does nothing for a release under a dialog that opened while the button was held", () => {
      const row = find("Donut glaze cracks");
      type(`\x1b[<0;${row.x + 1};${row.y + 1}M`);
      type("\x1bOP"); // F1
      screen();
      type(`\x1b[<0;${row.x + 1};${row.y + 1}m`);
      type("\x1b");

      expect(screen().join("\n")).not.toContain("top/2 Donut glaze cracks");
    });

    it("forgets a press whose release never came once the next press comes", () => {
      type("\x1bOP"); // F1
      const close = find(" Close ");
      type(`\x1b[<0;${close.x + 2};${close.y + 1}M`);
      screen();
      type(`\x1b[<0;${close.x - 10};${close.y - 3}M`);

      expect(find(" Close ").x).toBe(close.x);
    });

    it("places the cursor in a field as the button goes down", () => {
      type("abc");
      const at = find("abc");
      type(`\x1b[<0;${at.x + 1};${at.y + 1}M`);
      type("X");

      expect(screen().join("\n")).toContain("Xabc");
    });

    it("turns the colors about of a link while it is held", () => {
      type("\r");
      const link = find("the log");
      const before = browser.frame(columnsWide, rowsTall, NOW)[link.y];
      type(`\x1b[<0;${link.x + 1};${link.y + 1}M`);

      expect(browser.frame(columnsWide, rowsTall, NOW)[link.y]).not.toBe(
        before,
      );
    });

    it("follows a link only once the pointer is released over it", () => {
      type("\r");
      const link = find("the log");
      type(`\x1b[<0;${link.x + 1};${link.y + 1}M`);
      screen();

      expect(host.opened).toEqual([]);

      type(`\x1b[<0;${link.x + 1};${link.y + 1}m`);

      expect(host.opened).toEqual(["https://ci.example/run/7"]);
    });

    it("says in the status line what the process says while the screen is its own", () => {
      browser.said("[WARN] connection closed, reconnecting", true);

      expect(screen().at(-1)).toContain("connection closed, reconnecting");
    });

    it("says in the status line that saving, or taking in another browser's saves, failed", () => {
      browser.saveFailed(new Error("Disk full."));
      expect(screen().at(-1)).toContain(
        "Could not save drafts and what you have read: Disk full.",
      );

      browser.followFailed(new Error("Watch lost."));
      expect(screen().at(-1)).toContain(
        "Stopped taking in what other browsers save: Watch lost.",
      );
    });

    it("presses a dialog's button by its letter, alone where no field has the keys and with Alt anywhere", async () => {
      // A question has no field: its letters press its buttons.
      type("\x1b[21~\x1b[C\x1b[Cm"); // View ▸ Mark all read
      expect(screen().at(-1)).toContain("M Mark read  K Keep unread");
      expect(browser.frame(columnsWide, rowsTall, NOW).join("")).toMatch(
        new RegExp(
          `${ui.buttonKey.fg?.join(";")};48;2;${C.button.join(";")}m?M`,
        ),
      );
      type("m");
      expect(Object.keys(saved.seen).length).toBeGreaterThan(0);

      // In an editor a letter is typed, and Alt and the letter presses.
      type("\rc");
      type("p");
      expect(screen().join("\n")).toContain("Comment on top/1");
      type("\x1bp");
      await settle();
      expect(host.writes.map((w) => w.request)).toEqual([
        { verb: "comment", topic: "1", text: "p" },
      ]);
    });

    it("moves a focused button's focus along the row with Left and Right, stopping at its ends", () => {
      type("\x1bvm"); // View ▸ Mark all read, Keep unread focused
      type("\x1b[D\x1b[C\x1b[C"); // Left, then Right past the end
      type("\r");
      expect(screen().join("\n")).not.toContain("unread Topics as read?");
      expect(saved.seen).toEqual({});

      type("\x1bvm");
      type("\x1b[D\x1b[D"); // Left, past the start
      type("\r");
      expect(Object.keys(saved.seen).length).toBeGreaterThan(0);
    });

    it("leaves Left and Right to a focused field", () => {
      type("\x07"); // Control-G
      type("12\x1b[D3");
      expect(screen().join("\n")).toContain("132");

      type("\t\x1b[D7"); // to Go, which is first
      expect(screen().join("\n")).toContain("132");
      expect(screen().join("\n")).not.toContain("1372");

      type("\x1b[C\r"); // right to Cancel
      expect(screen().join("\n")).not.toContain("Go to topic");
      expect(screen().join("\n")).not.toContain("top/132");
    });

    it("leaves Alt and the letters an editor moves and deletes by to the editor", () => {
      type("\x0e"); // Control-N files a new Topic
      type("one two\x01"); // a title, the cursor at its start
      type("\x1bf"); // Alt-F, a word on
      type("\x1bd"); // Alt-D, deletes the next word

      expect(host.writes).toEqual([]);
      expect(screen().join("\n")).not.toContain("Are you sure?");
      expect(saved.drafts["new"]?.fields[0]).toBe("one");
    });

    it("lists a dialog's buttons in the status line, with Alt where a field has the keys", () => {
      type("\rc");
      expect(screen().at(-1)).toContain("Alt-P Post");
      type("\x1b");

      type("\x1bOP"); // F1
      expect(screen().at(-1)).toContain("C Close");
      type("C"); // either case
      expect(screen().join("\n")).not.toContain("Finding Topics");
    });

    it("sizes a dialog of text to what it says, up to the screen's height, never shrinking it while open", () => {
      /** The rows of the open dialog called `title`, frame and all. */
      const framed = (title: string) => {
        const shown = screen().map((row) => [...row]);
        const top = shown.findIndex((row) =>
          row.join("").includes(`═ ${title} ═`)
        );
        const x = shown[top].indexOf("╔");
        const bottom = shown.findIndex((row, y) => y > top && row[x] === "╚");
        return shown.slice(top, bottom + 1).map((row) => row.join(""));
      };

      type("\x1bha"); // Help ▸ About
      // What it says ends a blank row and its button above the frame.
      const about = framed("About");
      expect(about.findLastIndex((row) => row.includes("Topics: 3,")))
        .toBe(about.length - 5);
      type("\x1b");

      type("\x1bva"); // View ▸ Authors, of whom there are a few
      const authors = framed("Authors").length;
      expect(authors).toBeLessThan(rowsTall / 2);
      // Gathered into fewer families, it keeps its height, and its buttons.
      type("f");
      expect(screen().join("\n")).toContain("Names");
      expect(framed("Authors").length).toBe(authors);
      type("\x1b");

      type("\x1bOP"); // F1, which says more than fits
      expect(framed("Keys and search").length).toBe(rowsTall - 4);
    });

    describe("each dialog", () => {
      // A write left unfinished, for the dialogs that settle one.
      const unfinished = () => {
        saved.pending["topics-left"] = {
          request: { verb: "mention", topic: "1", other: "2" },
          agentName: "Tester (person)",
          attempts: 1,
          failure: "Lost.",
          at: NOW - HOUR,
        };
        type("\x1bfu"); // File ▸ Unfinished writes
      };
      // The body of top/1 being edited, as someone else changes it.
      const overtaken = () => {
        type("\re More.");
        const changed = board();
        changed[0] = { ...changed[0], body: "Their new body." };
        browser.update(changed, NOW, true, 42);
      };
      // Every dialog: how it is opened, what only it shows, whether it has
      // a field, and the letter of the button that leaves the board alone.
      const dialogs: {
        name: string;
        open: () => void;
        shows: string;
        fields: boolean;
        safe: string;
      }[] = [
        {
          name: "Mark all read",
          open: () => type("\x1bvm"),
          shows: "unread Topics as read?",
          fields: false,
          safe: "k",
        },
        {
          name: "New topic",
          open: () => type("\x0e"),
          shows: "File a new topic",
          fields: true,
          safe: "c",
        },
        {
          name: "Go to topic",
          open: () => type("\x07"),
          shows: "Go to topic",
          fields: true,
          safe: "c",
        },
        {
          name: "Comment",
          open: () => type("\r\x1bOQ"),
          shows: "Comment on top/1",
          fields: true,
          safe: "c",
        },
        {
          name: "Edit body",
          open: () => type("\r\x1bOS"),
          shows: "Edit the body of top/1",
          fields: true,
          safe: "c",
        },
        {
          name: "Rename",
          open: () => type("\rr"),
          shows: "Rename top/1",
          fields: true,
          safe: "c",
        },
        {
          name: "Add link",
          open: () => type("\rl"),
          shows: "Add a link to top/1",
          fields: true,
          safe: "c",
        },
        {
          name: "Mention",
          open: () => type("\rm"),
          shows: "top/1 mentions…",
          fields: true,
          safe: "c",
        },
        {
          name: "Sign",
          open: () => {
            delete saved.agentName;
            type("\rm2\r");
          },
          shows: "Sign your writes",
          fields: true,
          safe: "c",
        },
        {
          name: "Take back a link",
          open: () => {
            type("\r");
            click("✕"); // the link's, above the mention's
          },
          shows: "Take back the link",
          fields: false,
          safe: "k",
        },
        {
          name: "Remove a mention",
          open: () => {
            browser.update(
              [
                topic({ number: "1", mentions: ["of:fid1:entry-2"] }),
                topic({ number: "2" }),
              ],
              NOW,
              true,
              42,
            );
            type("\r");
            click("✕");
          },
          shows: "Remove top/1's mention of top/2?",
          fields: false,
          safe: "k",
        },
        {
          name: "Throw a draft away",
          open: () => type("\rcx\x1ba"),
          shows: "Throw this draft away?",
          fields: false,
          safe: "k",
        },
        {
          name: "Theirs",
          open: () => {
            overtaken();
            type("\x1bt");
          },
          shows: "What top/1 holds now",
          fields: false,
          safe: "c",
        },
        {
          name: "Replace theirs",
          open: () => {
            overtaken();
            type("\x13"); // Control-S
          },
          shows: "after you began. Replace their",
          fields: false,
          safe: "k",
        },
        {
          name: "Unfinished write",
          open: unfinished,
          shows: "An unfinished write",
          fields: false,
          safe: "l",
        },
        {
          name: "Forget a write",
          open: () => {
            unfinished();
            click(" Forget it ");
          },
          shows: "Forget this write?",
          fields: false,
          safe: "k",
        },
        {
          name: "Keys and search",
          open: () => type("\x1bOP"),
          shows: "Keys and search",
          fields: false,
          safe: "c",
        },
        {
          name: "About",
          open: () => type("\x1bha"),
          shows: "About",
          fields: false,
          safe: "c",
        },
        {
          name: "Authors",
          open: () => type("\x1bva"),
          shows: "Authors",
          fields: false,
          safe: "c",
        },
        {
          name: "CFC labels",
          open: () => type("\r\x1bvc"),
          shows: "CFC labels of top/1",
          fields: false,
          safe: "c",
        },
      ];

      /** The buttons the status line lists, as their keys and labels. */
      function buttons(): { alt: boolean; key: string; label: string }[] {
        return screen().at(-1)!.trim().split(/ {2,}/).flatMap((hint) => {
          const [, alt, key, label] = hint.match(/^(Alt-)?(\S+) (.+)$/)!;
          return key === "Tab"
            ? []
            : [{ alt: alt !== undefined, key: key.toLowerCase(), label }];
        });
      }

      /**
       * Opens `dialog` and closes it with `keys`, checking that nothing was
       * written; a write is pending from the moment it is asked for.
       */
      function closesWith(
        { open, shows }: (typeof dialogs)[number],
        keys: string,
      ): void {
        open();
        expect(screen().join("\n")).toContain(shows);
        const writes = host.writes.length;
        const seen = { ...saved.seen };
        const pending = structuredClone(saved.pending);

        type(keys);

        expect(screen().join("\n")).not.toContain(shows);
        expect(host.writes.length).toBe(writes);
        expect(saved.seen).toEqual(seen);
        expect(saved.pending).toEqual(pending);
      }

      for (const dialog of dialogs) {
        describe(dialog.name, () => {
          it("labels each button in at most three words holding its own letter", () => {
            dialog.open();
            const listed = buttons();
            const keys = listed.map(({ key }) => key);

            expect(listed.length).toBeGreaterThan(0);
            expect(new Set(keys).size).toBe(keys.length);
            for (const { alt, key, label } of listed) {
              expect(alt).toBe(dialog.fields);
              expect(label.toLowerCase()).toContain(key);
              expect(label.split(" ").length).toBeLessThanOrEqual(3);
            }
            expect(keys).toContain(dialog.safe);
            // An editor moves and deletes by these with Alt.
            if (dialog.fields) {
              expect(keys).not.toEqual(expect.arrayContaining(["b"]));
              expect(keys).not.toEqual(expect.arrayContaining(["d"]));
              expect(keys).not.toEqual(expect.arrayContaining(["f"]));
            }
          });

          it("closes, writing nothing, with its safe button's letter", () =>
            closesWith(
              dialog,
              `${dialog.fields ? "\x1b" : ""}${dialog.safe}`,
            ));

          it("closes, writing nothing, with Esc", () =>
            closesWith(dialog, "\x1b"));

          if (!dialog.fields) {
            it("closes, writing nothing, with Enter", () =>
              closesWith(dialog, "\r"));
          }
        });
      }
    });

    it("offers to show settled Topics while they are hidden, and to hide them while shown", () => {
      type("\x1b[21~\x1b[C\x1b[C"); // F10, then to View
      expect(screen().join("\n")).toContain("Show settled topics");

      type("h");
      type("\x1b[21~\x1b[C\x1b[C");
      expect(screen().join("\n")).toContain("Hide settled topics");
      expect(saved.hideSettled).toBe(false);
    });

    it("moves a menu's one highlight with the pointer held on it, and runs the item it is released on", () => {
      type("\x1b[21~"); // F10
      // The hotkey is drawn apart, so what follows it shows the highlight.
      const picked = new RegExp(`48;2;${C.button.join(";")}[^m]*mew topic`);
      expect(browser.frame(columnsWide, rowsTall, NOW).join("")).toMatch(
        picked,
      );

      const first = find("New topic");
      const goto = find("Go to topic");
      type(`\x1b[<0;${first.x + 1};${first.y + 1}M`);
      type(`\x1b[<32;${goto.x + 1};${goto.y + 1}M`);
      const held = browser.frame(columnsWide, rowsTall, NOW).join("");

      expect(held).not.toMatch(picked);
      expect(held).toMatch(
        new RegExp(`48;2;${C.button.join(";")}[^m]*mo to topic`),
      );

      type(`\x1b[<0;${goto.x + 1};${goto.y + 1}m`);

      expect(screen().join("\n")).toContain("═ Go to topic ═");
    });

    it("marks every Topic read once that is confirmed", () => {
      expect(screen().join("\n")).toMatch(/[│║]●/);
      type("\x1b[21~\x1b[C\x1b[C"); // F10, then to View
      click("Mark all read");
      expect(screen().join("\n")).toContain("unread Topics as read?");
      expect(Object.keys(saved.seen)).toEqual([]);

      // The question and the buttons are centered in a box as wide as they
      // need, the question set off from the title by a blank row.
      const margins = (text: string) => {
        const { y } = find(text);
        const row = screen()[y];
        const at = row.indexOf(text);
        const inside = row.slice(
          row.lastIndexOf("║", at) + 1,
          row.indexOf("║", at),
        );
        return {
          y,
          before: inside.length - inside.trimStart().length,
          after: inside.length - inside.trimEnd().length,
          blank: inside.trim() === "",
        };
      };
      const question = margins("unread Topics as read?");
      const buttons = margins(" Mark read ");
      for (const { before, after } of [question, buttons]) {
        expect(Math.abs(before - after)).toBeLessThanOrEqual(1);
      }
      expect(question.before).toBeLessThan(10);
      expect(screen()[question.y - 1]).toMatch(/║ +║/);

      click(" Mark read ");

      expect(Object.keys(saved.seen).sort()).toEqual(["1", "2", "3"]);
      // No row of the list is marked unread.
      expect(screen().join("\n")).not.toMatch(/[│║]●/);
    });

    it("shows the reader when a Topic is opened from the list zoomed", () => {
      type("\x1b[15~"); // F5 zooms the list
      expect(screen().join("\n")).not.toContain("filed by");

      type("\r");
      expect(screen().join("\n")).toContain("filed by Sol (agent)");
    });

    it("zooms a window, and asks for a bigger terminal when it is too small", () => {
      type("\r\x1b[15~"); // Enter, then F5
      expect(screen().join("\n")).not.toContain("Find");

      columnsWide = 50;
      expect(screen().join("\n")).toContain(
        "Make the terminal at least 60 by 15",
      );
    });

    it("quits from an open editor, keeping what was typed as a draft", () => {
      type("\rc");
      type("Half a thought");

      expect(type("\x11")).toBe(true); // Control-Q
      expect(saved.drafts["comment:1"]?.fields).toEqual(["Half a thought"]);
    });

    it("takes only a key that quits while it closes", async () => {
      const release = Promise.withResolvers<void>();
      host.held = release.promise;
      type("\rm2\r");
      const closing = browser.close(new Promise(() => {}));

      expect(type("c")).toBe(false);
      expect(screen().join("\n")).not.toContain("Comment on top/1");
      expect(type("\x1bx")).toBe(true);

      release.resolve();
      await closing;
    });

    it("takes what a Mac's Option key types for Alt, except in a field", () => {
      type("ƒ"); // Option-F
      expect(screen().join("\n")).toContain("New topic…");
      type("\x1b");

      type("\rc");
      type("≈"); // Option-X, typed into the comment
      expect(saved.drafts["comment:1"]?.fields).toEqual(["≈"]);
      type("\x1b");

      // A search begun in the list takes it as text.
      type("\x1b[17~"); // F6, back to the list
      type("x≈");
      expect(screen().join("\n")).toContain("x≈");
      type("\x15"); // Control-U clears the search

      expect(type("≈")).toBe(true);
    });

    it("quits on Alt-X, keeping what it remembers", async () => {
      const saves = host.saves;
      expect(type("\x1bx")).toBe(true);
      await browser.close(new Promise(() => {}));

      expect(host.saves).toBeGreaterThan(saves);
    });

    it("closes a dialog from the status line, and moves no focus for a click on its blank", () => {
      type("\x1bOP"); // F1
      const help = find("Finding Topics");
      type(
        `\x1b[<0;${help.x + 30};${help.y + 2}M\x1b[<0;${help.x + 30};${
          help.y + 2
        }m`,
      );
      // The status line's Close, not the dialog's.
      type(`\x1b[<0;4;${rowsTall}M\x1b[<0;4;${rowsTall}m`);

      expect(screen().join("\n")).not.toContain("Finding Topics");

      // Focus stayed on the list, so typing searches.
      type("glaze");
      expect(screen().join("\n")).toContain("1/");
    });

    it("moves through an editor's text under the wheel", () => {
      type("\rc");
      type("one\x1b[200~\ntwo\nthree\x1b[201~");
      const { x, y } = find("three");
      type(`\x1b[<64;${x + 1};${y + 1}M`);
      type("!");

      // A wheel step moves three rows, here to the end of the first.
      expect(saved.drafts["comment:1"]?.fields).toEqual(["one!\ntwo\nthree"]);
    });

    it("keeps a dialog's buttons on a short terminal, however much it says", async () => {
      rowsTall = 15;
      columnsWide = 60;
      // Lines that wrap, so that their rows outnumber them.
      const text = Array(40).fill("a long line of text ".repeat(6)).join("\n");
      saved.pending["topics-long"] = {
        request: { verb: "comment", topic: "1", text },
        draft: { key: "comment:1", fields: [text], base: "" },
        agentName: "Tester (person)",
        attempts: 1,
        failure: "Lost.",
        at: NOW,
      };
      type("\x1bf");
      type("u");

      expect(screen().join("\n")).toContain(" Settle it ");
      expect(screen().at(-1)).toContain("S Settle it");
      expect(screen().join("\n")).toContain("…");
      expect(screen().every((row) => columns(row) === 60)).toBe(true);

      click(" Settle it ");
      await settle();

      expect(host.writes.map((w) => w.invocation)).toEqual(["topics-long"]);
    });

    it("scrolls the window under the wheel, and drags a scroll bar's thumb", () => {
      rowsTall = 16;
      browser.update(long(), NOW, true, 42);
      type("\r");
      const top = screen().join("\n");
      const { x, y } = find("top/1 Flaky");
      type(`\x1b[<65;${x + 1};${y + 1}M`);

      expect(screen().join("\n")).not.toBe(top);
      expect(screen().join("\n")).not.toContain("top/1 Flaky");

      const thumb = find("█");
      type(`\x1b[<0;${thumb.x + 1};${thumb.y + 1}M`);
      type(`\x1b[<32;${thumb.x + 1};${rowsTall - 2}M`);
      type(`\x1b[<0;${thumb.x + 1};${rowsTall - 2}m`);

      expect(screen().join("\n")).toContain("Reproduced with cold oil.");
      expect(redraws).toBe(0);
    });
  });
});
