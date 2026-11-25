/**
 * Says where everything on the runners page's board goes, in an area of a
 * given size with its origin at the top left: every job's circle, every
 * runner's slot, every box and pool, every queue's heap, and every line of
 * text. The circles are as big as lets everything fit, up to a size that
 * reads easily.
 *
 * Everything here runs in the browser, handed to it by name by
 * runners-page.ts, so each declaration uses only the others, those of
 * runner-board.ts, and its own nested helpers.
 */

import {
  type Board,
  type Box,
  boxOffline,
  boxRunning,
  type Pool,
  type Slot,
} from "./runner-board.ts";

/** A rectangle, with its origin at its top left. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** How a line of text on the board looks. */
export type TextStyle = "heading" | "detail" | "count" | "slot" | "warning";

/** A line of text on the board, cut short at the end to fit `rect`. */
export interface LayoutText {
  readonly text: string;
  readonly rect: Rect;
  readonly style: TextStyle;
}

/** A pool's queue: the pool, where its jobs heap up, and which they are. */
export interface HeapArea {
  readonly pool: string;
  readonly rect: Rect;
  /** The jobs queued, the oldest first. */
  readonly jobs: readonly number[];
}

/** Where everything on the board goes. */
export interface BoardLayout {
  /** How big the circles are across. */
  size: number;
  /** Where each job's circle is, by the job's ID, apart from those queued. */
  tokens: Map<number, Rect>;
  slots: { slot: Slot; rect: Rect }[];
  boxes: Rect[];
  /** Each pool's rounded box, with its ID. */
  pools: { id: string; rect: Rect }[];
  heaps: HeapArea[];
  texts: LayoutText[];
  /** How many pools there was no room for. */
  hidden: number;
}

/** Returns the width, in pixels, that `text` takes in `style`. */
export type MeasureText = (text: string, style: TextStyle) => number;

/** The sizes the circles may be, the biggest first. */
export const CIRCLE_SIZES = [16, 14, 12, 10, 8, 6];

/** The space between the board's edges and its pools. */
export const BOARD_INSET = 18;

/** Returns `count` and `noun`, made plural unless `count` is one. */
export function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Returns how busy `box` is, in a few characters. */
export function boxCount(box: Box): string {
  const running = boxRunning(box);
  const slots = box.slots;
  if (slots === null || (box.capacity === null && slots.every((slot) => slot.place))) {
    return `${running}`;
  }
  const offline = boxOffline(box);
  return offline > 0 ? `${running}/${slots.length}, ${offline} offline` : `${running}/${slots.length}`;
}

/**
 * Lays out `board` in an area `width` by `height`, with circles no bigger
 * than `largest`. Each pool is a band across the board: its heading at the
 * top, its queue's heap on the left, as tall as the pool, and its boxes on
 * the right. The circles are the biggest of `CIRCLE_SIZES` that let every
 * pool fit, or, when even the smallest do not, as many pools as fit are laid
 * out, and the rest are counted at the bottom.
 */
export function layoutBoard(
  board: Board,
  width: number,
  height: number,
  largest: number,
  measure: MeasureText,
): BoardLayout {
  const INSET = BOARD_INSET;
  const POOL_PADDING = 8;
  const BOX_PADDING = 6;
  const BOX_HEADING = 14;
  const POOL_HEADING = 16;
  const SPACING = 8;
  const PLACES_ACROSS = 8;
  // The space between places for circles `size` across, and between a slot's
  // outline and its circle, so that a place is half as big again as its
  // circle at every size.
  const gapOf = (size: number) => size / 4;
  const rimOf = (size: number) => size / 8;
  const measured = (text: string, style: TextStyle) => Math.ceil(measure(text, style));
  const rect = (x: number, y: number, w: number, h: number): Rect => ({
    x,
    y,
    width: w,
    height: h,
  });

  const fresh = (): BoardLayout => ({
    size: CIRCLE_SIZES[0],
    tokens: new Map(),
    slots: [],
    boxes: [],
    pools: [],
    heaps: [],
    texts: [],
    hidden: 0,
  });
  const base = fresh();
  let top = 14;
  let running = 0;
  let queued = 0;
  let slots = 0;
  let idle = 0;
  let offline = 0;
  for (const pool of board.pools) {
    queued += pool.queue.length;
    for (const box of pool.boxes) {
      running += boxRunning(box);
      offline += boxOffline(box);
      for (const slot of box.slots ?? []) {
        if (slot.place) continue;
        slots++;
        if (slot.online && slot.job === null) idle++;
      }
    }
  }
  let summary = `${running} running · ${queued} queued`;
  if (slots > 0) summary += ` · ${idle} of ${counted(slots, "machine runner")} idle`;
  base.texts.push({ text: summary, rect: rect(INSET, top, width - 2 * INSET, 16), style: "heading" });
  if (offline > 0) {
    base.texts.push({
      text: `${offline} offline`,
      rect: rect(INSET + measured(summary, "heading") + 8, top + 2, 120, 14),
      style: "warning",
    });
  }
  top += 22;
  for (const problem of board.problems) {
    base.texts.push({ text: problem, rect: rect(INSET, top, width - 2 * INSET, 14), style: "warning" });
    top += 16;
  }
  const bottom = height - 12;
  if (board.pools.length === 0) {
    base.texts.push({
      text: "Nothing is queued or running, and no runners are known.",
      rect: rect(INSET, top, width - 2 * INSET, 14),
      style: "detail",
    });
  }

  // Places the pools one under another from `top`, and returns where the
  // last ends.
  const place = (layout: BoardLayout, pools: readonly Pool[]): number => {
    const size = layout.size;
    const poolWidth = width - 2 * INSET;
    const laneX = INSET + POOL_PADDING;
    const laneWidth = Math.floor((poolWidth - 2 * POOL_PADDING) * 0.24);
    const boxX = laneX + laneWidth + POOL_PADDING;
    const boxRight = INSET + poolWidth - POOL_PADDING;
    const gap = gapOf(size);
    const rim = rimOf(size);
    const cell = size + gap;
    const slotCell = size + 2 * rim + gap;
    let y = top;
    for (const pool of pools) {
      // The heading: the pool's name, what its runners are, and how busy
      // they are.
      const headingY = y + POOL_PADDING;
      const capacity = pool.boxes.length === 1 ? pool.boxes[0].capacity : null;
      const poolRunning = pool.boxes.reduce((sum, box) => sum + boxRunning(box), 0);
      const busy = `${pool.queue.length} queued · ` +
        (capacity === null ? `${poolRunning} running` : `${poolRunning} of ${capacity} running`);
      const busyWidth = measured(busy, "count");
      const titleWidth = Math.max(
        0,
        Math.min(measured(pool.title, "heading") + 2, boxRight - busyWidth - 8 - laneX),
      );
      layout.texts.push({ text: pool.title, rect: rect(laneX, headingY, titleWidth, 16), style: "heading" });
      layout.texts.push({
        text: busy,
        rect: rect(boxRight - busyWidth - 2, headingY + 2, busyWidth + 2, 14),
        style: "count",
      });
      const detailX = laneX + titleWidth + 6;
      layout.texts.push({
        text: pool.detail,
        rect: rect(detailX, headingY + 2, Math.max(0, boxRight - busyWidth - 8 - detailX), 14),
        style: "detail",
      });

      // The boxes: a machine's as wide as its slots, along a line, onto as
      // many lines as they need; boxes of places that share a pool in as
      // many columns as fit, each taking the next column in turn, one under
      // another, so that one growing moves only those under it.
      const boxesTop = headingY + POOL_HEADING + 4;
      const areaWidth = boxRight - boxX;
      const inner = BOX_PADDING * 2;
      const columnar = pool.boxes.length > 1 &&
        pool.boxes.every((box) => (box.slots?.every((slot) => slot.place) ?? true) && box.capacity === null);
      let widest = 0;
      for (const box of pool.boxes) {
        if (box.title === "") continue;
        widest = Math.max(widest, measured(box.title, "detail") + measured(boxCount(box), "count") + 16 + inner);
      }
      // As many columns as fit at the biggest circles, whatever size they
      // are, so that smaller circles fit more to a line rather than more
      // columns.
      const biggest = CIRCLE_SIZES[0];
      const columns = columnar
        ? Math.max(
          1,
          Math.floor(
            (areaWidth + SPACING) /
              (Math.max(
                PLACES_ACROSS * (biggest + 2 * rimOf(biggest) + gapOf(biggest)) - gapOf(biggest) + inner,
                widest,
              ) + SPACING),
          ),
        )
        : 1;
      const columnWidth = Math.floor((areaWidth - (columns - 1) * SPACING) / columns);
      const columnBottoms = new Array<number>(columns).fill(boxesTop);
      let x = boxX;
      let lineY = boxesTop;
      let lineHeight = 0;
      let firstContent: number | undefined;
      pool.boxes.forEach((box, index) => {
        const heading = box.title === "" ? 0 : BOX_HEADING;
        const count = boxCount(box);
        const headingWidth = box.title === "" ? 0 : measured(box.title, "detail") + measured(count, "count") + 16;
        let boxWidth: number;
        let items: number;
        let itemCell: number;
        if (box.slots !== null) {
          itemCell = slotCell;
          items = box.slots.length + box.jobs.length;
          // A box of places is as wide as its pool or its column, and grows
          // only by lines, so that nothing beside it moves.
          const places = box.slots.every((slot) => slot.place) && box.capacity === null;
          boxWidth = columnar
            ? columnWidth
            : places
            ? areaWidth
            : Math.min(areaWidth, Math.max(items * slotCell - gap + inner, headingWidth + inner));
        } else {
          itemCell = cell;
          items = box.jobs.length;
          boxWidth = columnar ? columnWidth : areaWidth;
        }
        const perLine = Math.max(1, Math.floor((boxWidth - inner + gap) / itemCell));
        const lines = Math.max(1, Math.ceil(items / perLine));
        const boxHeight = heading + inner + lines * itemCell - gap;
        let frame: Rect;
        if (columnar) {
          const column = index % columns;
          frame = rect(boxX + column * (columnWidth + SPACING), columnBottoms[column], boxWidth, boxHeight);
          columnBottoms[column] = frame.y + frame.height + SPACING;
        } else {
          if (x > boxX && x + boxWidth > boxRight) {
            x = boxX;
            lineY += lineHeight + SPACING;
            lineHeight = 0;
          }
          frame = rect(x, lineY, boxWidth, boxHeight);
          x += boxWidth + SPACING;
          lineHeight = Math.max(lineHeight, boxHeight);
        }
        layout.boxes.push(frame);
        if (box.title !== "") {
          const countWidth = measured(count, "count");
          layout.texts.push({
            text: box.title,
            rect: rect(frame.x + BOX_PADDING, frame.y + 3, Math.max(0, frame.width - inner - countWidth - 4), 12),
            style: "detail",
          });
          layout.texts.push({
            text: count,
            rect: rect(frame.x + frame.width - BOX_PADDING - countWidth - 2, frame.y + 3, countWidth + 2, 12),
            style: boxOffline(box) > 0 ? "warning" : "count",
          });
        }
        const contentX = frame.x + BOX_PADDING;
        const contentY = frame.y + heading + BOX_PADDING;
        firstContent ??= contentY;
        const origin = (i: number) => ({
          x: contentX + (i % perLine) * itemCell,
          y: contentY + Math.floor(i / perLine) * itemCell,
        });
        if (box.slots !== null) {
          const slotSize = size + 2 * rim;
          box.slots.forEach((slot, i) => {
            const at = origin(i);
            layout.slots.push({ slot, rect: rect(at.x, at.y, slotSize, slotSize) });
            if (slot.job) layout.tokens.set(slot.job.id, rect(at.x + rim, at.y + rim, size, size));
          });
          box.jobs.forEach((job, i) => {
            const at = origin(box.slots!.length + i);
            layout.tokens.set(job.id, rect(at.x + rim, at.y + rim, size, size));
          });
        } else {
          box.jobs.forEach((job, i) => {
            const at = origin(i);
            layout.tokens.set(job.id, rect(at.x, at.y, size, size));
          });
          if (box.jobs.length === 0) {
            layout.texts.push({
              text: box.idle > 0 ? `${box.idle} idle` : "none running",
              rect: rect(contentX, contentY + (size - 12) / 2, Math.max(0, frame.width - inner), 12),
              style: "detail",
            });
          }
        }
      });
      const boxesBottom = columnar
        ? columnBottoms.reduce((a, b) => Math.max(a, b), boxesTop) - SPACING
        : lineY + lineHeight;

      // The queue: a heap of its jobs, as tall as the runners it feeds and
      // the pool's heading above them, up to the top of the pool, so that
      // however long it grows, nothing below it moves.
      const laneBottom = Math.max(boxesBottom, (firstContent ?? boxesTop) + size);
      layout.heaps.push({
        pool: pool.id,
        rect: rect(laneX, y, laneWidth, laneBottom - y),
        jobs: pool.queue.map((token) => token.id),
      });
      const poolBottom = laneBottom + POOL_PADDING;
      layout.pools.push({ id: pool.id, rect: rect(INSET, y, poolWidth, poolBottom - y) });
      y = poolBottom + SPACING;
    }
    return y - SPACING;
  };

  const trial = (size: number, pools: readonly Pool[]) => {
    const layout = fresh();
    layout.size = size;
    layout.texts = [...base.texts];
    return { layout, end: place(layout, pools) };
  };
  for (const size of CIRCLE_SIZES) {
    if (size > largest) continue;
    const { layout, end } = trial(size, board.pools);
    if (end <= bottom) return layout;
  }
  // Pools are placed one under another, each where the ones above it end,
  // so as many as fit are those that end in the room above the line that
  // counts the rest.
  const smallest = CIRCLE_SIZES[CIRCLE_SIZES.length - 1];
  const room = bottom - 18;
  const every = trial(smallest, board.pools).layout;
  let shown = 0;
  while (shown < every.pools.length && every.pools[shown].rect.y + every.pools[shown].rect.height <= room) shown++;
  const { layout } = trial(smallest, board.pools.slice(0, shown));
  const more = board.pools.length - shown;
  if (more > 0) {
    layout.hidden = more;
    layout.texts.push({
      text: `${counted(more, "more pool")} not shown`,
      rect: rect(INSET, room + 4, width - 2 * INSET, 14),
      style: "warning",
    });
  }
  return layout;
}
