import { expect } from "@std/expect";
import type { Board, Box, Pool, Slot, Token } from "./runner-board.ts";
import {
  BOARD_INSET,
  type BoardLayout,
  boxCount,
  CIRCLE_SIZES,
  counted,
  layoutBoard,
  type LayoutText,
  type Rect,
} from "./runner-layout.ts";
import { describe, it } from "@commonfabric/test-support/test";

const measure = (text: string) => text.length * 6;

const token = (id: number): Token => ({
  id,
  job: `job ${id}`,
  repository: "labs",
  workflow: "CI",
  branch: "main",
  pullRequest: null,
  commit: "1a2b3c4",
  runId: "1",
  running: true,
  since: id,
  labels: [],
  runner: null,
  url: `https://example.com/${id}`,
  runUrl: "https://github.com/example/labs/actions/runs/1",
});

const slot = (
  id: string,
  job: Token | null = null,
  { online = true, place = false }: { online?: boolean; place?: boolean } = {},
): Slot => ({ id, name: id, label: id, online, job, place });

const box = (fields: Partial<Box> & { id: string }): Box => ({
  title: "",
  slots: null,
  jobs: [],
  idle: 0,
  capacity: null,
  ...fields,
});

const pool = (fields: Partial<Pool> & { id: string }): Pool => ({
  kind: 1,
  title: fields.id,
  detail: "",
  boxes: [],
  queue: [],
  ...fields,
});

const board = (pools: Pool[], problems: string[] = []): Board => ({ pools, runs: [], problems });

/** A pool of runners that come and go, running `running` jobs from `first`. */
const busyPool = (id: string, first: number, running: number): Pool =>
  pool({
    id,
    boxes: [box({ id, jobs: Array.from({ length: running }, (_, i) => token(first + i)) })],
  });

const bottomOf = (rect: Rect) => rect.y + rect.height;
const rightOf = (rect: Rect) => rect.x + rect.width;
const textsOf = (layout: BoardLayout, style?: LayoutText["style"]) =>
  layout.texts.filter((text) => style === undefined || text.style === style).map((text) => text.text);
/** Returns the line of text on `layout` that says `text`, which must be there. */
const textSaying = (layout: BoardLayout, text: string): LayoutText => {
  const found = layout.texts.find((entry) => entry.text === text);
  if (found === undefined) throw new Error(`No text says "${text}".`);
  return found;
};
/** Returns where job `id`'s circle is on `layout`, which must have one. */
const tokenOf = (layout: BoardLayout, id: number): Rect => {
  const found = layout.tokens.get(id);
  if (found === undefined) throw new Error(`Job ${id} has no circle.`);
  return found;
};
const lastPoolBottom = (layout: BoardLayout) => bottomOf(layout.pools[layout.pools.length - 1].rect);

describe("runner-layout", () => {
  describe("counted()", () => {
    it("returns the noun singular for one", () => {
      expect(counted(1, "pool")).toBe("1 pool");
    });

    it("returns the noun plural for zero and for more than one", () => {
      expect(counted(0, "pool")).toBe("0 pools");
      expect(counted(3, "machine runner")).toBe("3 machine runners");
    });
  });

  describe("boxCount()", () => {
    it("returns just the number running for a box of runners that come and go", () => {
      expect(boxCount(box({ id: "b", jobs: [token(1), token(2)] }))).toBe("2");
    });

    it("returns just the number running for a box of places without a capacity", () => {
      const places = [slot("a", token(1), { place: true }), slot("b", null, { place: true })];
      expect(boxCount(box({ id: "b", slots: places }))).toBe("1");
    });

    it("returns the number running out of the places for a box of places with a capacity", () => {
      const places = [slot("a", token(1), { place: true }), slot("b", null, { place: true })];
      expect(boxCount(box({ id: "b", slots: places, capacity: 2 }))).toBe("1/2");
    });

    it("returns the number running out of a machine's runners, counting jobs beside its slots", () => {
      const runners = [slot("a", token(1)), slot("b"), slot("c")];
      expect(boxCount(box({ id: "m", slots: runners, jobs: [token(2)] }))).toBe("2/3");
    });

    it("says how many of a machine's runners are offline, and only when some are", () => {
      const runners = [slot("a", token(1)), slot("b", null, { online: false }), slot("c", null, { online: false })];
      expect(boxCount(box({ id: "m", slots: runners }))).toBe("1/3, 2 offline");
      expect(boxCount(box({ id: "m", slots: [slot("a"), slot("b")] }))).toBe("0/2");
    });
  });

  describe("layoutBoard()", () => {
    describe("the summary", () => {
      it("says nothing is queued or running on an empty board", () => {
        const layout = layoutBoard(board([]), 800, 600, 16, measure);
        expect(textsOf(layout)).toEqual([
          "0 running · 0 queued",
          "Nothing is queued or running, and no runners are known.",
        ]);
        expect(layout.pools).toEqual([]);
        expect(layout.heaps).toEqual([]);
        expect(layout.hidden).toBe(0);
      });

      it("says nothing is queued or running on an empty board even with no room at all", () => {
        const layout = layoutBoard(board([]), 800, 0, 16, measure);
        expect(textsOf(layout)).toContain("Nothing is queued or running, and no runners are known.");
        expect(layout.hidden).toBe(0);
      });

      it("picks the smallest circles for an empty board with no room at all, and the biggest with room", () => {
        const smallest = CIRCLE_SIZES[CIRCLE_SIZES.length - 1];
        expect(layoutBoard(board([]), 800, 0, 16, measure).size).toBe(smallest);
        expect(layoutBoard(board([]), 800, 0, 4, measure).size).toBe(smallest);
        expect(layoutBoard(board([]), 800, 600, 16, measure).size).toBe(16);
        expect(layoutBoard(board([]), 800, 600, 11, measure).size).toBe(10);
      });

      it("does not say nothing is queued or running when there is a pool", () => {
        const layout = layoutBoard(board([busyPool("p", 1, 0)]), 800, 600, 16, measure);
        expect(textsOf(layout)).not.toContain("Nothing is queued or running, and no runners are known.");
      });

      it("counts the jobs running and queued across every pool, and the idle machine runners", () => {
        const machines = pool({
          id: "machines",
          kind: 0,
          boxes: [box({
            id: "m",
            title: "m",
            slots: [slot("a", token(1)), slot("b"), slot("c", null, { online: false })],
            jobs: [token(2)],
          })],
          queue: [token(3)],
        });
        const places = pool({
          id: "places",
          boxes: [box({ id: "p", slots: [slot("x", token(4), { place: true })] })],
          queue: [token(5), token(6)],
        });
        const layout = layoutBoard(board([machines, places, busyPool("c", 7, 2)]), 800, 600, 16, measure);
        expect(layout.texts[0]).toEqual({
          text: "5 running · 3 queued · 1 of 3 machine runners idle",
          rect: { x: BOARD_INSET, y: 14, width: 800 - 2 * BOARD_INSET, height: 16 },
          style: "heading",
        });
      });

      it("leaves out the idle machine runners when there are none", () => {
        const layout = layoutBoard(board([busyPool("p", 1, 2)]), 800, 600, 16, measure);
        expect(layout.texts[0].text).toBe("2 running · 0 queued");
      });

      it("warns of offline runners just after the summary, and only when there are some", () => {
        const offline = pool({
          id: "m",
          kind: 0,
          boxes: [box({ id: "m", title: "m", slots: [slot("a"), slot("b", null, { online: false })] })],
        });
        const layout = layoutBoard(board([offline]), 800, 600, 16, measure);
        const summary = layout.texts[0];
        expect(layout.texts[1]).toEqual({
          text: "1 offline",
          rect: { x: BOARD_INSET + measure(summary.text) + 8, y: 16, width: 120, height: 14 },
          style: "warning",
        });

        const online = pool({ id: "m", kind: 0, boxes: [box({ id: "m", title: "m", slots: [slot("a")] })] });
        expect(textsOf(layoutBoard(board([online]), 800, 600, 16, measure))).not.toContain("0 offline");
      });

      it("lists each problem as a warning line, in order, above the pools", () => {
        const plain = layoutBoard(board([busyPool("p", 1, 1)]), 800, 600, 16, measure);
        const troubled = layoutBoard(
          board([busyPool("p", 1, 1)], ["GitHub is down.", "The token expired."]),
          800,
          600,
          16,
          measure,
        );
        const warnings = troubled.texts.filter((text) => text.style === "warning");
        expect(warnings.map((text) => text.text)).toEqual(["GitHub is down.", "The token expired."]);
        expect(warnings[1].rect.y).toBeGreaterThan(warnings[0].rect.y);
        expect(troubled.pools[0].rect.y).toBeGreaterThanOrEqual(bottomOf(warnings[1].rect));
        expect(troubled.pools[0].rect.y).toBe(plain.pools[0].rect.y + 32);
        expect(textsOf(plain, "warning")).toEqual([]);
      });
    });

    describe("the circle size", () => {
      it("picks the biggest circles for a small board", () => {
        const layout = layoutBoard(board([busyPool("p", 1, 3)]), 800, 600, 16, measure);
        expect(layout.size).toBe(16);
        expect(layout.hidden).toBe(0);
        for (const rect of layout.tokens.values()) {
          expect(rect.width).toBe(16);
          expect(rect.height).toBe(16);
        }
      });

      it("picks no circles bigger than `largest`", () => {
        const layout = layoutBoard(board([busyPool("p", 1, 3)]), 800, 600, 11, measure);
        expect(layout.size).toBe(10);
        expect(layout.tokens.get(1)?.width).toBe(10);
      });

      it("picks smaller circles as pools are added, the biggest that let every pool fit", () => {
        const pools = Array.from({ length: 12 }, (_, i) => busyPool(`p${i}`, i * 100, 80));
        const sizes: number[] = [];
        for (let count = 1; count <= pools.length; count++) {
          const layout = layoutBoard(board(pools.slice(0, count)), 800, 700, 16, measure);
          if (layout.hidden > 0) break;
          sizes.push(layout.size);
          expect(layout.pools.length).toBe(count);
          expect(lastPoolBottom(layout)).toBeLessThanOrEqual(700 - 12);
          const bigger = CIRCLE_SIZES[CIRCLE_SIZES.indexOf(layout.size) - 1];
          if (bigger !== undefined) {
            const roomy = layoutBoard(board(pools.slice(0, count)), 800, 100_000, bigger, measure);
            expect(roomy.size).toBe(bigger);
            expect(lastPoolBottom(roomy)).toBeGreaterThan(700 - 12);
          }
        }
        expect(sizes[0]).toBe(16);
        expect(sizes[sizes.length - 1]).toBeLessThan(16);
        expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
      });
    });

    describe("the pools not shown", () => {
      it("lays out as many pools as fit with the smallest circles, and counts the rest", () => {
        const pools = Array.from({ length: 4 }, (_, i) => busyPool(`p${i}`, i * 100, 3));
        const roomy = layoutBoard(board(pools), 800, 100_000, 6, measure);
        const height = bottomOf(roomy.pools[2].rect) + 30;
        const layout = layoutBoard(board(pools), 800, height, 16, measure);
        expect(layout.size).toBe(6);
        expect(layout.hidden).toBe(1);
        expect(layout.pools.map((shown) => shown.id)).toEqual(["p0", "p1", "p2"]);
        expect(layout.heaps.map((heap) => heap.pool)).toEqual(["p0", "p1", "p2"]);
        expect(layout.tokens.has(300)).toBe(false);
        expect(layout.texts[layout.texts.length - 1]).toEqual({
          text: "1 more pool not shown",
          rect: { x: BOARD_INSET, y: height - 30 + 4, width: 800 - 2 * BOARD_INSET, height: 14 },
          style: "warning",
        });
      });

      it("keeps the pools shown clear of the line counting the rest", () => {
        const pools = Array.from({ length: 4 }, (_, i) => busyPool(`p${i}`, i * 100, 3));
        const roomy = layoutBoard(board(pools), 800, 100_000, 6, measure);
        const height = bottomOf(roomy.pools[2].rect) + 20;
        const layout = layoutBoard(board(pools), 800, height, 16, measure);
        expect(layout.pools.length).toBe(2);
        expect(layout.hidden).toBe(2);
        const line = layout.texts[layout.texts.length - 1];
        expect(line.text).toBe("2 more pools not shown");
        expect(line.rect.y).toBeGreaterThan(lastPoolBottom(layout));
        expect(bottomOf(line.rect)).toBeLessThanOrEqual(height);
      });

      it("shows every pool, and says none are hidden, when they fit", () => {
        const pools = Array.from({ length: 4 }, (_, i) => busyPool(`p${i}`, i * 100, 3));
        const layout = layoutBoard(board(pools), 800, 600, 16, measure);
        expect(layout.hidden).toBe(0);
        expect(layout.pools.length).toBe(4);
        expect(layout.texts.some((text) => text.text.endsWith("not shown"))).toBe(false);
      });

      it("counts every pool when not even one fits", () => {
        const pools = Array.from({ length: 3 }, (_, i) => busyPool(`p${i}`, i * 100, 3));
        const layout = layoutBoard(board(pools), 800, 80, 16, measure);
        expect(layout.hidden).toBe(3);
        expect(layout.pools).toEqual([]);
        expect(layout.tokens.size).toBe(0);
        expect(textsOf(layout, "warning")).toEqual(["3 more pools not shown"]);
      });

      it("lays out every pool that fits at the smallest circles when `largest` is smaller than every circle size", () => {
        const pools = [busyPool("a", 1, 3), busyPool("b", 10, 3)];
        const layout = layoutBoard(board(pools), 800, 600, 4, measure);
        expect(layout.size).toBe(CIRCLE_SIZES[CIRCLE_SIZES.length - 1]);
        expect(layout.hidden).toBe(0);
        expect(layout.pools.map((shown) => shown.id)).toEqual(["a", "b"]);
        expect(layout.texts.some((text) => text.text.endsWith("not shown"))).toBe(false);
      });

      it("hides the pools that do not fit when `largest` is smaller than every circle size", () => {
        const pools = [busyPool("a", 1, 3), busyPool("b", 10, 3)];
        const roomy = layoutBoard(board(pools), 800, 100_000, 6, measure);
        const layout = layoutBoard(board(pools), 800, bottomOf(roomy.pools[0].rect) + 30, 4, measure);
        expect(layout.hidden).toBe(1);
        expect(layout.pools.map((shown) => shown.id)).toEqual(["a"]);
        expect(textsOf(layout, "warning")).toEqual(["1 more pool not shown"]);
      });
    });

    describe("a pool", () => {
      it("puts a heap of its queue on its left, as tall as the pool, listing the jobs oldest first", () => {
        const queued = pool({
          id: "q",
          boxes: [box({ id: "q", jobs: [token(1)] })],
          queue: [token(30), token(10), token(20)],
        });
        const layout = layoutBoard(board([busyPool("first", 100, 1), queued]), 800, 600, 16, measure);
        const heap = layout.heaps[1];
        const frame = layout.pools[1].rect;
        expect(heap.pool).toBe("q");
        expect(heap.jobs).toEqual([30, 10, 20]);
        expect(heap.rect.y).toBe(frame.y);
        expect(bottomOf(heap.rect)).toBe(bottomOf(frame) - 8);
        expect(heap.rect.x).toBeGreaterThan(frame.x);
        expect(rightOf(heap.rect)).toBeLessThan(layout.boxes[1].x);
        expect(bottomOf(layout.boxes[1])).toBeLessThanOrEqual(bottomOf(heap.rect));
        expect(layout.heaps[0].jobs).toEqual([]);
        for (const id of [10, 20, 30]) expect(layout.tokens.has(id)).toBe(false);
      });

      it("puts each pool under the one before it, across the board's width", () => {
        const layout = layoutBoard(board([busyPool("a", 1, 1), busyPool("b", 10, 1)]), 800, 600, 16, measure);
        const [a, b] = layout.pools.map((shown) => shown.rect);
        expect(a.x).toBe(BOARD_INSET);
        expect(a.width).toBe(800 - 2 * BOARD_INSET);
        expect(b.y).toBe(bottomOf(a) + 8);
      });

      it("gives a pool without boxes a heap a circle tall below its heading", () => {
        const layout = layoutBoard(board([pool({ id: "bare", queue: [token(1)] })]), 800, 600, 16, measure);
        const frame = layout.pools[0].rect;
        expect(layout.boxes).toEqual([]);
        expect(layout.heaps[0].rect.height).toBe(8 + 16 + 4 + 16);
        expect(frame.height).toBe(8 + 16 + 4 + 16 + 8);
      });

      it("heads the pool with its title, its detail, and how busy it is", () => {
        const larger = pool({
          id: "big",
          kind: 2,
          title: "ubuntu-large",
          detail: "GitHub-hosted · 8 cores",
          boxes: [box({ id: "big", jobs: [token(1)], capacity: 4 })],
          queue: [token(2), token(3)],
        });
        const layout = layoutBoard(board([larger]), 800, 600, 16, measure);
        const heading = layout.texts.filter((text) => text.rect.y <= layout.pools[0].rect.y + 10);
        expect(heading.map((text) => [text.text, text.style])).toEqual([
          ["1 running · 2 queued", "heading"],
          ["ubuntu-large", "heading"],
          ["2 queued · 1 of 4 running", "count"],
          ["GitHub-hosted · 8 cores", "detail"],
        ]);
        const [, title, busy, detail] = heading;
        expect(title.rect.width).toBe(measure("ubuntu-large") + 2);
        expect(detail.rect.x).toBe(rightOf(title.rect) + 6);
        expect(rightOf(detail.rect)).toBeLessThan(busy.rect.x);
        expect(rightOf(busy.rect)).toBe(800 - BOARD_INSET - 8);
      });

      it("says how many run without a capacity when the pool has more than one box", () => {
        const hosted = pool({
          id: "hosted",
          kind: 3,
          boxes: [
            box({ id: "a", title: "ubuntu-latest", jobs: [token(1)], capacity: 4 }),
            box({ id: "b", title: "macos-latest", jobs: [token(2)] }),
          ],
        });
        expect(textsOf(layoutBoard(board([hosted]), 800, 600, 16, measure), "count")).toContain(
          "0 queued · 2 running",
        );
      });

      it("cuts a long title short of how busy the pool is", () => {
        const long = pool({ id: "long", title: "x".repeat(200), detail: "detail", boxes: [box({ id: "b" })] });
        const layout = layoutBoard(board([long]), 400, 600, 16, measure);
        const busy = textSaying(layout, "0 queued · 0 running");
        expect(rightOf(textSaying(layout, long.title).rect)).toBe(busy.rect.x + 2 - 8);
        expect(textSaying(layout, "detail").rect.width).toBe(0);
      });
    });

    describe("a box", () => {
      it("puts a running job's circle inside its runner's slot, and none in an empty slot", () => {
        const machine = pool({
          id: "m",
          kind: 0,
          boxes: [box({ id: "m", title: "mac-01", slots: [slot("a"), slot("b", token(7)), slot("c")] })],
        });
        const layout = layoutBoard(board([machine]), 800, 600, 16, measure);
        expect(layout.slots.map((entry) => entry.slot.id)).toEqual(["a", "b", "c"]);
        const slotRect = layout.slots[1].rect;
        expect(layout.tokens.get(7)).toEqual({
          x: slotRect.x + 2,
          y: slotRect.y + 2,
          width: 16,
          height: 16,
        });
        expect(slotRect.width).toBe(20);
        expect(layout.tokens.size).toBe(1);
        expect(layout.slots[1].rect.x).toBe(layout.slots[0].rect.x + 24);
        expect(layout.slots[0].rect.x).toBe(layout.boxes[0].x + 6);
        expect(layout.slots[0].rect.y).toBe(layout.boxes[0].y + 14 + 6);
      });

      it("puts the jobs beside a machine's slots after them, like slots of their own", () => {
        const machine = pool({
          id: "m",
          kind: 0,
          boxes: [box({ id: "m", title: "mac-01", slots: [slot("a", token(1))], jobs: [token(2)] })],
        });
        const layout = layoutBoard(board([machine]), 800, 600, 16, measure);
        const first = tokenOf(layout, 1);
        expect(layout.tokens.get(2)).toEqual({ x: first.x + 24, y: first.y, width: 16, height: 16 });
        expect(layout.boxes[0].width).toBe(Math.max(2 * 24 - 4, measure("mac-01") + measure("2/1") + 16) + 12);
      });

      it("titles a box with its name and how busy it is, warning when runners are offline", () => {
        const machines = pool({
          id: "m",
          kind: 0,
          boxes: [
            box({ id: "a", title: "mac-01", slots: [slot("a1", token(1)), slot("a2", null, { online: false })] }),
            box({ id: "b", title: "mac-02", slots: [slot("b1")] }),
          ],
        });
        const layout = layoutBoard(board([machines]), 800, 600, 16, measure);
        const boxTexts = layout.texts.filter((text) =>
          ["mac-01", "1/2, 1 offline", "mac-02", "0/1"].includes(text.text)
        );
        expect(boxTexts.map((text) => [text.text, text.style])).toEqual([
          ["mac-01", "detail"],
          ["1/2, 1 offline", "warning"],
          ["mac-02", "detail"],
          ["0/1", "count"],
        ]);
        expect(rightOf(boxTexts[1].rect)).toBe(rightOf(layout.boxes[0]) - 6);
      });

      it("puts machines along a line, onto the next when the line is full", () => {
        const machines = pool({
          id: "m",
          kind: 0,
          boxes: Array.from(
            { length: 3 },
            (_, i) =>
              box({ id: `m${i}`, title: `m${i}`, slots: Array.from({ length: 10 }, (_, j) => slot(`m${i}-${j}`)) }),
          ),
        });
        const layout = layoutBoard(board([machines]), 800, 600, 16, measure);
        const [a, b, c] = layout.boxes;
        expect(a.width).toBe(10 * 24 - 4 + 12);
        expect(b.x).toBe(rightOf(a) + 8);
        expect(b.y).toBe(a.y);
        expect(c.x).toBe(a.x);
        expect(c.y).toBe(bottomOf(a) + 8);
        expect(bottomOf(layout.heaps[0].rect)).toBe(bottomOf(c));
      });

      it("makes a machine with more runners than fit across as wide as the pool, over several lines", () => {
        const machine = pool({
          id: "m",
          kind: 0,
          boxes: [box({ id: "m", title: "m", slots: Array.from({ length: 30 }, (_, j) => slot(`s${j}`)) })],
        });
        const layout = layoutBoard(board([machine]), 800, 600, 16, measure);
        const frame = layout.boxes[0];
        expect(rightOf(frame)).toBe(800 - BOARD_INSET - 8);
        const rows = new Set(layout.slots.map((entry) => entry.rect.y));
        expect(rows.size).toBe(2);
        for (const entry of layout.slots) expect(rightOf(entry.rect)).toBeLessThanOrEqual(rightOf(frame) - 6);
      });

      it("makes a lone box of places as wide as its pool", () => {
        const places = pool({
          id: "p",
          boxes: [box({ id: "p", slots: [slot("x", token(1), { place: true }), slot("y", null, { place: true })] })],
        });
        const layout = layoutBoard(board([places]), 800, 600, 16, measure);
        expect(rightOf(layout.boxes[0])).toBe(800 - BOARD_INSET - 8);
        expect(layout.boxes[0].height).toBe(12 + 20);
      });

      it("puts boxes of places that share a pool in columns, each taking the next in turn", () => {
        const places = (id: string, count: number) =>
          box({
            id,
            title: id,
            slots: Array.from({ length: count }, (_, j) => slot(`${id}${j}`, null, { place: true })),
          });
        const shared = pool({ id: "p", kind: 3, boxes: [places("a", 2), places("b", 40), places("c", 2)] });
        const layout = layoutBoard(board([shared]), 800, 600, 16, measure);
        const [a, b, c] = layout.boxes;
        expect(a.width).toBe(b.width);
        expect(b.x).toBe(rightOf(a) + 8);
        expect(b.y).toBe(a.y);
        expect(c.x).toBe(a.x);
        expect(c.y).toBe(bottomOf(a) + 8);
        expect(b.height).toBeGreaterThan(a.height);
        expect(bottomOf(layout.heaps[0].rect)).toBe(bottomOf(b));
      });

      it("puts boxes of runners that come and go that share a pool in columns", () => {
        const hosted = pool({
          id: "hosted",
          kind: 3,
          boxes: ["ubuntu-latest", "macos-latest", "windows-latest"].map((title, i) =>
            box({ id: title, title, jobs: [token(i * 10)] })
          ),
        });
        const layout = layoutBoard(board([hosted]), 800, 600, 16, measure);
        const [a, b, c] = layout.boxes;
        expect(a.width).toBe(b.width);
        expect(a.width).toBeLessThan((800 - 2 * BOARD_INSET) / 2);
        expect(b.x).toBe(rightOf(a) + 8);
        expect(c.x).toBe(a.x);
        expect(c.y).toBe(bottomOf(a) + 8);
        expect(layout.tokens.get(20)).toEqual({ x: c.x + 6, y: c.y + 14 + 6, width: 16, height: 16 });
      });

      it("does not put a box of places with a capacity in columns", () => {
        const places = (id: string) =>
          box({ id, title: id, slots: [slot(`${id}0`, null, { place: true })], capacity: 1 });
        const layout = layoutBoard(
          board([pool({ id: "p", boxes: [places("a"), places("b")] })]),
          800,
          600,
          16,
          measure,
        );
        const [a, b] = layout.boxes;
        expect(b.y).toBe(a.y);
        expect(b.x).toBe(rightOf(a) + 8);
        expect(a.width).toBe(Math.max(20, measure("a") + measure("0/1") + 16) + 12);
      });

      it("puts the circles of runners that come and go along lines across the box", () => {
        const layout = layoutBoard(board([busyPool("p", 1, 40)]), 800, 600, 16, measure);
        const frame = layout.boxes[0];
        const first = tokenOf(layout, 1);
        expect(first).toEqual({ x: frame.x + 6, y: frame.y + 6, width: 16, height: 16 });
        expect(layout.tokens.get(2)?.x).toBe(first.x + 20);
        const rows = new Set([...layout.tokens.values()].map((rect) => rect.y));
        expect(rows.size).toBe(2);
        for (const rect of layout.tokens.values()) expect(rightOf(rect)).toBeLessThanOrEqual(rightOf(frame) - 6);
        expect(textsOf(layout, "detail")).not.toContain("none running");
      });

      it("says how many are idle in a box of runners that come and go with nothing running", () => {
        const idle = pool({ id: "p", boxes: [box({ id: "p", idle: 3 })] });
        const layout = layoutBoard(board([idle]), 800, 600, 16, measure);
        const text = textSaying(layout, "3 idle");
        expect(text.style).toBe("detail");
        expect(text.rect.x).toBe(layout.boxes[0].x + 6);
        expect(textsOf(layout)).not.toContain("none running");
      });

      it("says none are running in a box with nothing running and none idle", () => {
        const layout = layoutBoard(board([pool({ id: "p", boxes: [box({ id: "p" })] })]), 800, 600, 16, measure);
        expect(textsOf(layout, "detail")).toContain("none running");
        expect(textsOf(layout).some((text) => text.endsWith(" idle"))).toBe(false);
      });
    });
  });
});
