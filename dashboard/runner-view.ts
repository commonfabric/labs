/**
 * Draws the runners page's board in the browser, and keeps it current: the
 * pools, boxes, slots and words on one canvas, drawn again only when the
 * board changes, and the jobs' balls on two more, one for the balls of jobs
 * on the board and one over it for those leaving it, moved and drawn every
 * frame while any moves. `followRunners()` connects the page to the server's
 * socket and feeds what it hears to a `RunnersView`.
 *
 * Everything here runs in the browser, handed to it by name by
 * runners-page.ts, so each declaration uses only the others, those of the
 * other runner modules, and its own nested helpers.
 */

import {
  type Board,
  boardTokens,
  buildBoard,
  forgetBeyond,
  type LargerRunner,
  newSteadiness,
  remembersMore,
  type Runner,
  type PageMessage,
  type RunnersMessage,
  runTitle,
  RunPalette,
  type Slot,
  steadyBoard,
  type Token,
} from "./runner-board.ts";
import { BallRenderer } from "./runner-gl.ts";
import { JobTracker, type Outcome } from "./runner-jobs.ts";
import {
  BOARD_INSET,
  type BoardLayout,
  CIRCLE_SIZES,
  counted,
  layoutBoard,
  type Rect,
  type TextStyle,
} from "./runner-layout.ts";
import {
  FLIGHT_STEP,
  heapDiameter,
  HeapWorld,
  LEAVE,
  type Leaving,
  leaveStep,
  type Motion,
  startLeaving,
  steerStep,
} from "./runner-physics.ts";

/** The elements of the page a `RunnersView` draws in. */
export interface RunnersElements {
  /** The board, which holds `chrome` and takes the pointer. */
  readonly board: HTMLElement;
  readonly chrome: HTMLCanvasElement;
  /** The canvas, the size of the board, that the balls are drawn on. */
  readonly balls: HTMLCanvasElement;
  /** The canvas over `balls` that the balls leaving the board are drawn on. */
  readonly effects: HTMLCanvasElement;
  readonly legend: HTMLElement;
  readonly tooltip: HTMLElement;
  /** The badge that says, as on the dashboard's other live pages, whether the page hears the server. */
  readonly badge: HTMLElement;
}

/**
 * How wide the board is laid out, in pixels; the page shows it at whatever
 * size fits, with everything on it scaled to match.
 */
export const BOARD_WIDTH = 780;

/** The colors of how a job ended, and of an offline runner. */
export const OUTCOME_COLORS = {
  passed: "#2fc79e",
  failed: "#e2504a",
  neither: "#7c828c",
};

/** A job's ball while its job is on the board. */
interface Ball {
  token: Token;
  /** Where it is, on the board, and how it moves, when not in a heap. */
  motion: Motion;
  /** The pool whose heap holds it, if any. */
  heap: string | null;
  /** Where it is going, and whether it is still getting there. */
  target: { x: number; y: number };
  steering: boolean;
  supported: boolean;
  /** Its size across, and the size it is becoming, from when, in seconds. */
  size: number;
  sizeFrom: number;
  sizeTo: number;
  sizeAt: number;
  /** When it came onto the board, to grow into sight, or `null`. */
  arrivedAt: number | null;
}

/** A ball on its way off the board. */
interface Gone {
  motion: Motion;
  leaving: Leaving;
  color: string;
  run: string;
  /** Where its job ended, for the ring a failure leaves. */
  ringX: number;
  ringY: number;
}

/** A queue's heap: where it is on the board, and its balls. */
interface Heap {
  rect: Rect;
  world: HeapWorld;
  /** The size planned for its balls when it was last sized. */
  planned: number;
}

/**
 * The board on the page: it lays out each board it is shown, moves every
 * ball that has somewhere to go from where it is, and names what the pointer
 * points at.
 */
export class RunnersView {
  #elements: RunnersElements;
  #layout: BoardLayout | undefined;
  #steadiness = newSteadiness();
  #largest = CIRCLE_SIZES[0];
  #palette = new RunPalette();
  #balls = new Map<number, Ball>();
  #gone: Gone[] = [];
  #heaps = new Map<string, Heap>();
  #clock = 0;
  #frame = 0;
  #pointer: { x: number; y: number } | null = null;
  #still: () => boolean;
  #renderer: BallRenderer;
  #effectsDrawn = false;
  #carry = 0;

  /**
   * Constructs an instance that draws in `elements`, opens a job's page with
   * `openPage` when its ball is clicked, and changes the board without moving
   * anything while `still` says to: by default, while the page is hidden,
   * when it draws no frames, or its reader asks for less motion.
   */
  constructor(
    elements: RunnersElements,
    openPage: (url: string) => void = (url) => open(url, "_blank", "noopener"),
    still: () => boolean = () => document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches,
  ) {
    this.#elements = elements;
    this.#still = still;
    this.#renderer = new BallRenderer(elements.balls);
    elements.board.addEventListener("pointermove", (event) => {
      this.#pointer = this.#local(event);
      this.#name();
    });
    elements.board.addEventListener("pointerleave", () => {
      this.#pointer = null;
      this.#name();
    });
    elements.board.addEventListener("click", (event) => {
      const token = this.#tokenAt(this.#local(event));
      if (token?.url.startsWith("https://github.com/")) openPage(token.url);
    });
    elements.balls.addEventListener("webglcontextrestored", () => this.#request());
    // A change of how many device pixels make a pixel, as when the page is
    // zoomed or moved to another screen, draws everything again.
    const watchScale = () => {
      matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener("change", () => {
        this.#drawChrome();
        this.#request();
        watchScale();
      }, { once: true });
    };
    watchScale();
  }

  /**
   * Draws the board again at the size the page now shows it, as when the
   * window changes size, without moving anything on it.
   */
  rescale(): void {
    this.#drawChrome();
    this.#name();
    this.#request();
  }

  /** How many balls of jobs on the board there are, and of jobs leaving it. */
  get counts(): { readonly shown: number; readonly leaving: number } {
    return { shown: this.#balls.size, leaving: this.#gone.length };
  }

  /**
   * Shows `board`, each job whose end `outcome` says leaving showing how it
   * ended, and every other that has gone simply going. Shown `afresh`, as
   * when the page opens, the board starts again: nothing
   * leaves, pools are set out in order, and queues drop into their heaps from
   * just above. Shown to `regrow`, the board lets its balls grow again, and
   * forgets the pools and boxes it was keeping empty, as it otherwise does
   * only once keeping them would make the balls smaller. While the system
   * asks for less motion, the board changes without moving anything.
   */
  show(board: Board, outcome: (id: number) => Outcome | undefined, afresh: boolean, regrow = false): void {
    const still = this.#still();
    const animate = !afresh && !still;
    if (!animate) this.#gone = [];
    if (afresh) {
      this.#steadiness = newSteadiness();
      this.#largest = CIRCLE_SIZES[0];
      this.#heaps.clear();
      this.#balls.clear();
    } else if (regrow) {
      this.#largest = CIRCLE_SIZES[0];
      forgetBeyond(this.#steadiness, board);
    }
    const now = this.#now();
    const { width, height } = this.#size();
    let steadied = steadyBoard(board, this.#steadiness);
    const present = new Set(boardTokens(board).map((token) => token.id));
    const ending = [...this.#balls.values()].filter((ball) =>
      !present.has(ball.token.id) && outcome(ball.token.id) !== undefined
    ).map((ball) => ({ id: ball.token.runId, jobs: 0 }));
    const leaving = this.#gone.map((gone) => ({ id: gone.run, jobs: 0 }));
    this.#palette.update([...steadied.runs, ...ending, ...leaving]);
    const measure = this.#measure();
    let layout = layoutBoard(steadied, width, height, this.#largest, measure);
    // Pools and boxes kept empty give way once they would make the circles
    // smaller or leave a pool off the board.
    if ((layout.size < this.#largest || layout.hidden > 0) && remembersMore(this.#steadiness, board)) {
      forgetBeyond(this.#steadiness, board);
      steadied = steadyBoard(board, this.#steadiness);
      layout = layoutBoard(steadied, width, height, this.#largest, measure);
    }
    this.#largest = layout.size;
    this.#layout = layout;
    this.#elements.board.setAttribute("aria-label", layout.texts[0]?.text ?? "");

    // The queues: each ball poured into its heap, or taken out of it.
    const queuedIn = new Map<number, string>();
    for (const area of layout.heaps) for (const id of area.jobs) queuedIn.set(id, area.pool);
    const freed = new Map<number, Motion>();
    const unseen = new Set<number>();
    const emptied = new Set<string>();
    for (const [pool, heap] of this.#heaps) {
      const area = layout.heaps.find((candidate) => candidate.pool === pool);
      for (let i = heap.world.count - 1; i >= 0; i--) {
        const id = heap.world.idAt(i);
        if (queuedIn.get(id) === pool) continue;
        const state = heap.world.remove(id)!;
        emptied.add(pool);
        if (state.x < 0) unseen.add(id);
        // One still on its way in, out of sight, comes out of the heap's top
        // left corner, where it would have come into sight.
        freed.set(id, {
          x: heap.rect.x + Math.max(0, state.x),
          y: heap.rect.y + (state.x < 0 ? 0 : Math.max(0, state.y)),
          vx: state.vx,
          vy: state.vy,
          t: 0,
        });
      }
      if (area === undefined || area.jobs.length === 0) this.#heaps.delete(pool);
    }
    for (const area of layout.heaps) {
      if (area.jobs.length === 0) continue;
      const planned = heapDiameter(area.jobs.length, area.rect.width, area.rect.height, layout.size);
      let heap = this.#heaps.get(area.pool);
      if (heap === undefined) {
        heap = { rect: area.rect, world: new HeapWorld(area.rect.width, area.rect.height, planned), planned };
        this.#heaps.set(area.pool, heap);
      }
      heap.rect = area.rect;
      heap.world.resize(area.rect.width, area.rect.height);
      const world = heap.world;
      const fresh = area.jobs.filter((id) => !world.has(id));
      // A heap's balls are as much smaller than planned as the heap last had
      // to make them to fit, so that they do not grow only to shrink again.
      const fitted = Math.floor(planned * world.targetDiameter / heap.planned * 2) / 2;
      world.setDiameter(Math.min(planned, Math.max(1, fitted)), animate);
      heap.planned = planned;
      // Those just queued are set out in rows, a pile as wide as the heap, the
      // oldest at the bottom, nearest the heap. Shown afresh, the pile is just
      // above the heap, and drops into it. Otherwise it is centered far off to
      // the left, two heaps' widths, and high up, two heaps' widths and three
      // heights above the heap's floor, or higher if it must be to be clear of
      // the slope that leads into the heap, or of any balls still on their way
      // in beneath it; so that it falls, out of sight, onto the slope, and the
      // balls roll down it into the heap one after another.
      const w = area.rect.width;
      const h = area.rect.height;
      const across = Math.max(1, Math.floor(w / (planned * 1.1)));
      const pileWidth = across * planned * 1.1;
      const pileHeight = Math.ceil(fresh.length / across) * planned * 1.2;
      const right = animate ? -2 * w + pileWidth / 2 : pileWidth;
      let beneath = 0;
      for (let i = 0; i < heap.world.count; i++) {
        const x = heap.world.xAt(i);
        if (x < right + planned && x > right - pileWidth - planned) {
          beneath = Math.min(beneath, heap.world.yAt(i));
        }
      }
      const bottom = animate
        ? Math.min(-2 * w - 2 * h + pileHeight / 2, right - pileWidth - planned, beneath - 2 * planned)
        : -planned / 2;
      fresh.forEach((id, k) => {
        const row = Math.floor(k / across);
        world.add(
          id,
          right - planned / 2 - (k % across) * planned * 1.1 - (row % 2 === 0 ? 0 : planned * 0.55),
          bottom - planned / 2 - row * planned * 1.2,
        );
      });
      // While the system asks for less motion, each heap is shown at rest.
      if (still) heap.world.settle();
    }

    // Every job on the board, where it is now, going where it goes.
    const next = new Map<number, Ball>();
    for (const token of boardTokens(steadied)) {
      const ball = this.#balls.get(token.id);
      const pool = queuedIn.get(token.id);
      if (pool !== undefined) {
        const size = this.#heaps.get(pool)!.world.diameter;
        next.set(token.id, {
          token,
          motion: ball?.motion ?? { x: 0, y: 0, vx: 0, vy: 0, t: 0 },
          heap: pool,
          target: { x: 0, y: 0 },
          steering: false,
          supported: false,
          size,
          sizeFrom: size,
          sizeTo: size,
          sizeAt: -Infinity,
          arrivedAt: null,
        });
        continue;
      }
      const rect = layout.tokens.get(token.id);
      if (rect === undefined) continue;
      const target = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const from = freed.get(token.id) ?? ball?.motion;
      if (from === undefined || !animate) {
        next.set(token.id, {
          token,
          motion: { x: target.x, y: target.y, vx: 0, vy: 0, t: 0 },
          heap: null,
          target,
          steering: false,
          supported: true,
          size: rect.width,
          sizeFrom: rect.width,
          sizeTo: rect.width,
          sizeAt: -Infinity,
          arrivedAt: animate ? now : null,
        });
        continue;
      }
      // A ball changes size only when its place does.
      const resized = ball === undefined || ball.heap !== null || ball.sizeTo !== rect.width;
      const size = ball ? this.#sizeOf(ball, now) : rect.width;
      const steering = (ball?.steering ?? false) || from.x !== target.x || from.y !== target.y;
      const restarting = steering && (ball === undefined || ball.target.x !== target.x ||
        ball.target.y !== target.y || freed.has(token.id));
      next.set(token.id, {
        token,
        motion: restarting ? { ...from, t: 0 } : from,
        heap: null,
        target,
        steering,
        supported: restarting ? Math.hypot(from.vx, from.vy) < 5 : ball?.supported ?? true,
        size,
        sizeFrom: resized ? size : ball.sizeFrom,
        sizeTo: rect.width,
        sizeAt: resized ? now : ball.sizeAt,
        arrivedAt: ball?.arrivedAt ?? null,
      });
    }
    // A job whose end was delivered leaves showing how it ended; one gone for
    // another reason simply goes, as does one still out of sight above its
    // heap.
    const { width: boardWidth, height: boardHeight } = this.#size();
    for (const [id, ball] of this.#balls) {
      if (next.has(id)) continue;
      const ended = outcome(id);
      const from = freed.get(id) ?? (ball.heap === null ? ball.motion : undefined);
      if (!animate || ended === undefined || from === undefined || unseen.has(id)) continue;
      const motion = { ...from, t: 0 };
      const size = this.#sizeOf(ball, now);
      this.#gone.push({
        motion,
        leaving: startLeaving(
          motion,
          size,
          ended,
          boardWidth,
          boardHeight,
          BOARD_INSET,
          Math.max(BOARD_INSET, boardWidth - BOARD_INSET),
        ),
        color: this.#palette.color(ball.token.runId),
        run: ball.token.runId,
        ringX: motion.x,
        ringY: motion.y,
      });
    }
    this.#balls = next;
    this.#drawChrome();
    this.#describeRuns(steadied);
    this.#name();
    this.#request();
  }

  /**
   * Helper for the methods that move and draw the balls, which returns the
   * time, in seconds, as the frames are drawn.
   */
  #now(): number {
    return performance.now() / 1000;
  }

  /**
   * Helper for the methods that lay out and draw the board, which returns
   * how big it is laid out: `BOARD_WIDTH` across, and as tall as the board
   * is for that width, whatever size the page shows it at.
   */
  #size(): { width: number; height: number } {
    const board = this.#elements.board;
    if (board.clientWidth === 0) return { width: BOARD_WIDTH, height: BOARD_WIDTH * 10 / 13 };
    return { width: BOARD_WIDTH, height: board.clientHeight * BOARD_WIDTH / board.clientWidth };
  }

  /**
   * Helper for the methods that draw the board and find what is under the
   * pointer, which returns how many pixels of the page a pixel of the board
   * as laid out takes.
   */
  #scale(): number {
    const width = this.#elements.board.clientWidth;
    return width === 0 ? 1 : width / BOARD_WIDTH;
  }

  /** Helper for `show()`, which returns what measures text on the board. */
  #measure(): (text: string, style: TextStyle) => number {
    const context = this.#elements.chrome.getContext("2d")!;
    return (text, style) => {
      context.font = RunnersView.#font(style);
      return context.measureText(text).width;
    };
  }

  /** Helper for the drawing methods, which returns the size `ball` is now. */
  #sizeOf(ball: Ball, now: number): number {
    if (ball.heap !== null) return this.#heaps.get(ball.heap)?.world.diameter ?? ball.size;
    const part = Math.min(1, (now - ball.sizeAt) / 0.7);
    const eased = part < 0.5 ? 2 * part * part : 1 - 2 * (1 - part) * (1 - part);
    return ball.sizeFrom + (ball.sizeTo - ball.sizeFrom) * eased;
  }

  /** Helper for the methods that change what is drawn, which asks for a frame. */
  #request(): void {
    if (this.#frame !== 0) return;
    this.#frame = requestAnimationFrame(() => this.#tick());
  }

  /**
   * Helper for `#request()`, which moves everything that moves by the time
   * since the last frame, at most a fifteenth of a second, draws the balls,
   * and asks for another frame while anything moves.
   */
  #tick(): void {
    this.#frame = 0;
    const now = this.#now();
    const elapsed = this.#clock === 0 ? 0 : Math.min(1 / 15, now - this.#clock);
    this.#clock = now;
    let moving = false;
    for (const heap of this.#heaps.values()) {
      if (heap.world.advance(elapsed)) moving = true;
    }
    const steps = Math.floor((elapsed + this.#carry) / FLIGHT_STEP);
    this.#carry = elapsed + this.#carry - steps * FLIGHT_STEP;
    for (const ball of this.#balls.values()) {
      if (ball.steering) {
        for (let i = 0; i < steps && ball.steering; i++) {
          ball.steering = !steerStep(ball.motion, ball.target, ball.supported);
        }
        if (ball.steering) moving = true;
      }
      if (now - ball.sizeAt < 0.7 || (ball.arrivedAt !== null && now - ball.arrivedAt < 0.7)) {
        moving = true;
      }
    }
    this.#gone = this.#gone.filter((gone) => {
      for (let i = 0; i < steps; i++) {
        if (leaveStep(gone.motion, gone.leaving)) return false;
      }
      return true;
    });
    if (this.#gone.length > 0) moving = true;
    this.#drawBalls(now);
    if (moving) this.#request();
    else this.#clock = 0;
  }

  /**
   * Helper for `#tick()`, which draws every ball: those in heaps clipped to
   * their pools' rounded boxes, out of sight until half past their heaps'
   * left sides, and the rest over everything; and, above them, those leaving,
   * outlined in the color of how their jobs ended, with a mark to match.
   */
  #drawBalls(now: number): void {
    const scale = devicePixelRatio * this.#scale();
    const renderer = this.#renderer;
    const poolRects = new Map(this.#layout?.pools.map((pool) => [pool.id, pool.rect]) ?? []);
    for (const [pool, heap] of this.#heaps) {
      const rect = poolRects.get(pool);
      const clip = rect === undefined
        ? null
        : { x: rect.x, y: rect.y, width: rect.width, height: rect.height, radius: 10 };
      const r = heap.world.diameter / 2;
      const x0 = heap.rect.x;
      const y0 = heap.rect.y;
      for (let i = 0; i < heap.world.count; i++) {
        const x = heap.world.xAt(i);
        if (x < 0) continue;
        const ball = this.#balls.get(heap.world.idAt(i));
        if (ball === undefined) continue;
        renderer.add(x0 + x, y0 + heap.world.yAt(i), r, this.#palette.color(ball.token.runId), clip);
      }
    }
    for (const ball of this.#balls.values()) {
      if (ball.heap !== null) continue;
      let r = this.#sizeOf(ball, now) / 2;
      if (ball.arrivedAt !== null) {
        const part = Math.min(1, (now - ball.arrivedAt) / 0.7);
        r *= 0.1 + 0.9 * (1 - (1 - part) * (1 - part));
      }
      renderer.add(ball.motion.x, ball.motion.y, r, this.#palette.color(ball.token.runId), null);
    }
    const { width, height } = this.#size();
    renderer.draw(width, height, scale);
    if (this.#gone.length === 0 && !this.#effectsDrawn) return;
    const canvas = this.#elements.effects;
    if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) {
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
    }
    const context = canvas.getContext("2d")!;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    this.#effectsDrawn = this.#gone.length > 0;
    for (const gone of this.#gone) {
      const { leaving, motion } = gone;
      const t = motion.t;
      const swelled = LEAVE * 0.15;
      let grow = t < swelled
        ? 1 + 0.3 * t / swelled
        : t < leaving.pause
        ? 1.3 - 0.3 * (t - swelled) / (leaving.pause - swelled)
        : 1;
      let alpha = 1;
      if (leaving.outcome === "neither" && t >= leaving.pause) {
        const part = Math.min(1, (t - leaving.pause) / 1.5);
        grow = 1 + 1.4 * part;
        alpha = 1 - part;
      }
      const size = leaving.diameter * grow;
      const color = OUTCOME_COLORS[leaving.outcome];
      context.globalAlpha = alpha;
      context.beginPath();
      context.arc(motion.x, motion.y, size / 2, 0, 2 * Math.PI);
      context.fillStyle = gone.color;
      context.fill();
      context.lineWidth = Math.max(1.5, size * 0.16);
      context.strokeStyle = color;
      context.stroke();
      context.fillStyle = "#ffffff";
      context.font = `900 ${size * 0.62}px -apple-system,Segoe UI,Roboto,sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      const mark = leaving.outcome === "passed" ? "✓" : leaving.outcome === "failed" ? "✕" : "–";
      context.fillText(mark, motion.x, motion.y);
      context.globalAlpha = 1;
      if (leaving.outcome === "failed" && t >= leaving.pause && t < LEAVE + leaving.pause) {
        // The ring a failure leaves where its job ended spreads and fades.
        const part = 1 - (1 - (t - leaving.pause) / LEAVE) ** 2;
        context.globalAlpha = 1 - part;
        context.beginPath();
        context.arc(gone.ringX, gone.ringY, leaving.diameter / 2 * (1 + 2.5 * part), 0, 2 * Math.PI);
        context.lineWidth = 1.5;
        context.strokeStyle = color;
        context.stroke();
        context.globalAlpha = 1;
      }
    }
  }

  /**
   * Helper for `show()`, which draws afresh everything but the balls: the
   * pools, boxes and slots, and the words, in the page's colors.
   */
  #drawChrome(): void {
    const layout = this.#layout;
    if (layout === undefined) return;
    const canvas = this.#elements.chrome;
    const { width, height } = this.#size();
    const scale = devicePixelRatio * this.#scale();
    if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) {
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
    }
    const context = canvas.getContext("2d")!;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const style = getComputedStyle(document.documentElement);
    const color = (name: string) => style.getPropertyValue(`--${name}`).trim();
    const text = color("text");
    const tint = (alpha: number) => {
      context.globalAlpha = alpha;
      context.fillStyle = text;
    };
    for (const pool of layout.pools) {
      tint(0.035);
      context.beginPath();
      context.roundRect(pool.rect.x, pool.rect.y, pool.rect.width, pool.rect.height, 10);
      context.fill();
    }
    for (const box of layout.boxes) {
      tint(0.05);
      context.beginPath();
      context.roundRect(box.x, box.y, box.width, box.height, 7);
      context.fill();
      context.globalAlpha = 1;
      context.strokeStyle = color("divider");
      context.lineWidth = 0.5;
      context.stroke();
    }
    context.globalAlpha = 1;
    // A place is outlined only while empty, to show the hole.
    for (const { slot, rect } of layout.slots) {
      if (slot.place && slot.job !== null) continue;
      context.beginPath();
      context.arc(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2 - 0.5, 0, 2 * Math.PI);
      context.lineWidth = 1;
      context.strokeStyle = slot.online ? color("text-faint") : OUTCOME_COLORS.failed;
      context.stroke();
      if (!slot.online) {
        context.beginPath();
        context.moveTo(rect.x + 4, rect.y + 4);
        context.lineTo(rect.x + rect.width - 4, rect.y + rect.height - 4);
        context.stroke();
      } else if (slot.job === null && layout.size >= 12) {
        context.font = RunnersView.#font("slot");
        const fits = context.measureText(slot.label).width <= layout.size;
        context.fillStyle = color("text-faint");
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(fits ? slot.label : slot.label.slice(0, 1), rect.x + rect.width / 2, rect.y + rect.height / 2);
      }
    }
    context.textAlign = "left";
    context.textBaseline = "top";
    for (const item of layout.texts) {
      context.font = RunnersView.#font(item.style);
      context.fillStyle = item.style === "heading"
        ? text
        : item.style === "warning"
        ? OUTCOME_COLORS.failed
        : color("text-muted");
      let line = item.text;
      if (context.measureText(line).width > item.rect.width) {
        // The longest start of the text that fits with an ellipsis after it.
        let fits = 0;
        let over = line.length;
        while (over - fits > 1) {
          const middle = (fits + over) >> 1;
          if (context.measureText(`${line.slice(0, middle)}…`).width <= item.rect.width) fits = middle;
          else over = middle;
        }
        line = fits > 0 ? `${line.slice(0, fits)}…` : "";
      }
      context.fillText(line, item.rect.x, item.rect.y + 1);
    }
  }

  /**
   * Helper for `show()`, which lists each run on the board in its color, in
   * alphabetical order, with how many of its jobs show.
   */
  #describeRuns(board: Board): void {
    const first = new Map<string, Token>();
    for (const token of boardTokens(board)) if (!first.has(token.runId)) first.set(token.runId, token);
    const entries = board.runs.flatMap((run) => {
      const token = first.get(run.id);
      // A run's page is its job's, without the job.
      const url = token?.url.replace(/\/job\/\d+$/, "");
      return token ? [{ id: run.id, title: runTitle(token), jobs: run.jobs, url }] : [];
    }).sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { numeric: true }) || (a.id < b.id ? -1 : 1)
    );
    const legend = this.#elements.legend;
    legend.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.setAttribute("role", "listitem");
      empty.textContent = "No jobs on the board.";
      legend.append(empty);
    }
    for (const entry of entries) {
      const line = document.createElement("div");
      line.className = "run";
      line.setAttribute("role", "listitem");
      const dot = document.createElement("span");
      dot.className = "swatch";
      dot.style.background = this.#palette.color(entry.id);
      // Each line links to its run on GitHub, so that a keyboard reaches every
      // run on the board.
      let title: HTMLElement;
      if (entry.url?.startsWith("https://github.com/")) {
        const link = document.createElement("a");
        link.href = entry.url;
        link.target = "_blank";
        link.rel = "noopener";
        title = link;
      } else {
        title = document.createElement("span");
      }
      title.className = "title";
      title.textContent = entry.title;
      title.title = entry.title;
      const jobs = document.createElement("span");
      jobs.className = "jobs";
      jobs.textContent = counted(entry.jobs, "job");
      line.append(dot, title, jobs);
      legend.append(line);
    }
  }

  /** Helper for the pointer listeners, which returns where `event` is on the board. */
  #local(event: MouseEvent): { x: number; y: number } {
    const { left, top } = this.#origin();
    const scale = this.#scale();
    return { x: (event.clientX - left) / scale, y: (event.clientY - top) / scale };
  }

  /**
   * Helper for the methods that place things in the window, which returns
   * where the board's inside, within its border, is in the window.
   */
  #origin(): { left: number; top: number } {
    const board = this.#elements.board;
    const rect = board.getBoundingClientRect();
    return { left: rect.left + board.clientLeft, top: rect.top + board.clientTop };
  }

  /** Helper for the pointer listeners, which returns the job whose ball is at `point`. */
  #tokenAt(point: { x: number; y: number }): Token | undefined {
    const now = this.#now();
    for (const heap of this.#heaps.values()) {
      const r = heap.world.diameter / 2 + 1;
      for (let i = 0; i < heap.world.count; i++) {
        const x = heap.world.xAt(i);
        // A ball above its pool's box, which clips it, is out of sight.
        if (x < 0 || heap.world.yAt(i) < 0) continue;
        if (Math.hypot(heap.rect.x + x - point.x, heap.rect.y + heap.world.yAt(i) - point.y) <= r) {
          return this.#balls.get(heap.world.idAt(i))?.token;
        }
      }
    }
    for (const ball of this.#balls.values()) {
      if (ball.heap !== null) continue;
      const r = this.#sizeOf(ball, now) / 2 + 1;
      if (Math.hypot(ball.motion.x - point.x, ball.motion.y - point.y) <= r) return ball.token;
    }
    return undefined;
  }

  /**
   * Helper for the methods that change what is under the pointer, which
   * names it, in a bubble beside the pointer: a job, a runner's slot, or a
   * free place.
   */
  #name(): void {
    const tooltip = this.#elements.tooltip;
    const point = this.#pointer;
    const words = point === null ? undefined : this.#words(point);
    if (point === null || words === undefined) {
      tooltip.hidden = true;
      this.#elements.board.style.cursor = "";
      return;
    }
    tooltip.textContent = words;
    tooltip.hidden = false;
    // The tooltip is placed in the page's pixels, beside the pointer.
    const board = this.#elements.board;
    const scale = this.#scale();
    const x = point.x * scale;
    const y = point.y * scale;
    const box = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.min(x + 12, board.clientWidth - box.width - 4)}px`;
    tooltip.style.top = `${y + 16 + box.height > board.clientHeight ? y - box.height - 8 : y + 16}px`;
    this.#elements.board.style.cursor = this.#tokenAt(point) ? "pointer" : "";
  }

  /** Helper for `#name()`, which returns what is at `point`, in words. */
  #words(point: { x: number; y: number }): string | undefined {
    const token = this.#tokenAt(point);
    if (token) return RunnersView.describe(token, Date.now());
    const slot = this.#layout?.slots.find(({ rect }) =>
      point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y &&
      point.y <= rect.y + rect.height
    )?.slot;
    return slot === undefined ? undefined : `${slot.name}: ${RunnersView.#doing(slot)}`;
  }

  /**
   * Returns what a job's ball says when pointed at: its run, which job it
   * is, and how long it has been running, and where, or how long it has
   * waited, and for what labels.
   */
  static describe(token: Token, now: number): string {
    const how = token.running ? `Running on ${token.runner ?? "a runner"}` : "Queued";
    const since = token.since === null ? "" : ` for ${RunnersView.duration(now - token.since)}`;
    const lines = [runTitle(token), token.job, how + since];
    if (!token.running) {
      lines.push(token.labels.length ? `for a runner labeled ${token.labels.join(", ")}` : "for any runner");
    }
    return lines.join("\n");
  }

  /** Returns a length of time in its largest unit: 40s, 4m, 2h, 3d. */
  static duration(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    return seconds < 60
      ? `${seconds}s`
      : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : seconds < 86400
      ? `${Math.floor(seconds / 3600)}h`
      : `${Math.floor(seconds / 86400)}d`;
  }

  /** Helper for `#words()`, which returns what a slot's runner is doing. */
  static #doing(slot: Slot): string {
    if (!slot.online) return "offline";
    if (slot.job !== null) return "running a job";
    return slot.place ? "free" : "idle";
  }

  /** Helper for the drawing methods, which returns the font of `style`. */
  static #font(style: TextStyle): string {
    const family = "-apple-system,Segoe UI,Roboto,sans-serif";
    switch (style) {
      case "heading":
        return `600 12px ${family}`;
      case "count":
        return `500 10px ui-monospace,Menlo,monospace`;
      case "slot":
        return `500 7px ${family}`;
      default:
        return `10px ${family}`;
    }
  }
}

/** The end of the server's socket that the runners page reads. */
export interface PageSocket {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  send(data: string): void;
  close(): void;
}

/**
 * Opens a WebSocket to `url`, and resolves with it once it is open, so that
 * it can be sent to at once, or rejects if it closes first.
 */
export function openedSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("close", () => reject(new Error(`the socket at ${url} closed before it opened`)), {
      once: true,
    });
  });
}

/**
 * How often the runners page looks at its socket, and how long a socket may
 * carry nothing, the server's tick being fifteen seconds, before the page
 * takes it for dead.
 */
export const SOCKET_CHECK_MS = 15_000;

/**
 * Connects the runners page to the server's socket at `url`, each socket
 * opened by `openSocket`, which resolves once the socket is open, and shows the board in `elements` as what it hears
 * changes it, starting afresh with the first snapshot. A page served by
 * another version of the server than `version` reloads. While no socket is
 * open, the badge says OFFLINE and the board shows no jobs, as nothing says
 * which are queued or running.
 * A socket that closes after carrying something is opened again at once.
 * Every `SOCKET_CHECK_MS`, as the main dashboard page checks its stream, the
 * page opens a socket if it has none, and gives up on one that has carried
 * nothing for three times that, as one left open after the computer slept or
 * the network moved does, or that has not finished opening in that time.
 * `every` runs those checks, and `now` tells the time in milliseconds.
 * Throws for a message it does not understand.
 */
export function followRunners(
  url: string,
  version: string,
  elements: RunnersElements,
  openSocket: (url: string) => PageSocket | Promise<PageSocket> = openedSocket,
  every: (check: () => void) => void = (check) => setInterval(check, SOCKET_CHECK_MS),
  now: () => number = Date.now,
): RunnersView {
  const view = new RunnersView(elements);
  const tracker = new JobTracker();
  let runners: readonly Runner[] = [];
  let larger: readonly LargerRunner[] = [];
  let problems: readonly string[] = [];
  let shown = false;
  let snapshotShown = false;
  let pending = 0;
  // The socket open or opening, and when it last carried anything or started
  // opening; each attempt to open one is numbered, so that one given up on
  // that opens later is closed.
  let socket: PageSocket | "opening" | null = null;
  let heardAt = 0;
  let attempts = 0;
  // What a delivery changes is shown with the next frame, so that many
  // deliveries arriving together are laid out once.
  const showSoon = () => {
    if (pending !== 0) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      show(false);
    });
  };
  const show = (afresh: boolean, regrow = false) => {
    cancelAnimationFrame(pending);
    pending = 0;
    const board = buildBoard(
      tracker.jobs.values(),
      runners,
      larger,
      (runId) => tracker.pullRequest(runId),
      problems,
    );
    view.show(board, (id) => tracker.outcome(id), afresh, regrow);
    shown = true;
  };
  // The badge says LIVE while the page hears the server, as the page that
  // arrived over a working connection does at first, and OFFLINE otherwise.
  const live = (hearing: boolean) => {
    elements.badge.textContent = hearing ? "● LIVE" : "● OFFLINE";
    elements.badge.classList.toggle("offline", !hearing);
  };
  const lost = (heard: boolean) => {
    socket = null;
    tracker.replace([]);
    problems = [];
    live(false);
    show(false);
    if (heard) void connect();
  };
  const hear = (message: RunnersMessage) => {
    if (message.type === "snapshot") {
      if (message.version !== version) {
        location.reload();
        return;
      }
      tracker.restore(message.tracker);
      runners = message.runners;
      larger = message.larger;
      problems = message.problems;
      show(!snapshotShown, true);
      snapshotShown = true;
    } else if (message.type === "news") {
      if (tracker.take(message.news)) showSoon();
    } else if (message.type === "runners") {
      runners = message.runners;
      larger = message.larger;
      problems = message.problems;
      showSoon();
    } else if (message.type !== "ping") {
      throw new Error("the dashboard sent a message the runners page does not understand");
    }
  };
  // The server reads GitHub only for a page someone can see.
  const tellVisible = (to: PageSocket) => {
    const message: PageMessage = { type: "visible", visible: !document.hidden };
    to.send(JSON.stringify(message));
  };
  document.addEventListener("visibilitychange", () => {
    if (socket !== null && socket !== "opening") tellVisible(socket);
  });
  const connect = async () => {
    const attempt = ++attempts;
    socket = "opening";
    heardAt = now();
    let opened: PageSocket;
    try {
      opened = await openSocket(url);
    } catch {
      if (attempt === attempts) lost(false);
      return;
    }
    if (attempt !== attempts) {
      opened.close();
      return;
    }
    socket = opened;
    heardAt = now();
    tellVisible(opened);
    let heard = false;
    opened.addEventListener("message", (event) => {
      if (socket !== opened) return;
      heard = true;
      heardAt = now();
      live(true);
      hear(JSON.parse(String(event.data)));
    });
    opened.addEventListener("close", () => {
      if (socket === opened) lost(heard);
    });
  };
  every(() => {
    if (socket === null) {
      void connect();
    } else if (now() - heardAt > 3 * SOCKET_CHECK_MS) {
      const dead = socket;
      attempts++;
      lost(false);
      if (dead !== "opening") dead.close();
      void connect();
    }
  });
  new ResizeObserver(() => view.rescale()).observe(elements.board);
  addEventListener("dashboardthemechange", () => {
    if (shown) showSoon();
  });
  show(true);
  void connect();
  return view;
}
