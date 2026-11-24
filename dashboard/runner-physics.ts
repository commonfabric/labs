/**
 * Moves the balls of the runners page: the heap of each queue, under gravity,
 * and each ball that moves on its own, drawn to the runner that takes its
 * job, or thrown off the board when its job ends. The page advances every
 * motion by the time each frame takes, so that a ball always goes on from
 * where it is, moving as it moves, and none ever changes speed or direction
 * all at once.
 *
 * Positions are in pixels, with y growing down the page. Everything here runs
 * in the browser, handed to it by name by runners-page.ts, so each
 * declaration uses only the others and its own nested helpers.
 */

import type { Outcome } from "./runner-jobs.ts";

/** How hard gravity pulls, in pixels a second each second, down the board. */
export const GRAVITY = 1800;

/** How long a heap's balls take to grow or shrink to a new size, in seconds. */
export const GROWING = 0.5;

/**
 * Returns how big the balls are so that `count` of them fit in an area
 * `width` by `height`, heaped as loosely as poured balls heap, but no bigger
 * than `largest`: the biggest, in half pixels, for which rows of as many as
 * fit across, with room to spare, fit from bottom to top.
 */
export function heapDiameter(
  count: number,
  width: number,
  height: number,
  largest: number,
): number {
  let d = Math.max(1, largest);
  while (d > 1) {
    const across = Math.max(1, Math.floor(width / d));
    if (Math.ceil(count / across) * d * 1.15 <= height) break;
    d = Math.max(1, d - 0.5);
  }
  return d;
}

/**
 * A heap of balls under gravity in a box open at the top: the queue's space,
 * `width` by `height`, with its top left as the origin. Its right side and
 * its floor go on for ever; its left side is only as tall as the box; and
 * from its top left corner a slope at forty-five degrees leads up and away to
 * the left, down which balls dropped far off to the left roll into the box.
 *
 * Each step moves every ball by Verlet integration, then pushes apart those
 * that overlap, twice, finding them by a grid of squares a ball across, from
 * the floor up, the ball below giving way less than the one on top of it, so
 * that a deep heap bears its weight rather than squeezing its bottom out
 * sideways. Each step puts the balls in the order of the squares they are in,
 * so that neighbors are neighbors in memory too. The heap takes as many steps
 * a second as keep the fastest ball from moving much more than its own width
 * in one, and so from passing through another.
 *
 * A heap at rest sleeps: its balls are not moved, and a change wakes only the
 * balls it can move. A ball added is awake; a ball taken out wakes those that
 * may fall into its place, above it in a cone widening upward; and a sleeping
 * ball wakes when an awake ball under it moves away from it, or an awake
 * one presses into it by more than a quarter of its width, rests on it nearer
 * its top than a ball nested between two others does, or is squeezed level
 * beside it. Until then it bears what presses on it without giving way. So
 * a deep heap, which would otherwise go on settling for as long as it is
 * simulated, stays as it lies when a ball is added to it.
 *
 * Once no ball has moved a quarter of a pixel, or a twelfth of its width if
 * that is less, in each sixtieth of a second for a tenth of a second, and
 * none is balanced near the top of a single other, or once
 * it has moved for five seconds, with every ball in the box for at least one,
 * or at most once it has moved for ten, the heap is at rest, and stepping it
 * does nothing until something changes. A heap at rest with balls sticking out
 * of the top of the box, or that has stopped moving with balls stuck on the
 * slope, is made of balls half a pixel smaller, and smaller again, until they
 * all fit.
 */
export class HeapWorld {
  #width: number;
  #height: number;
  #ids: number[] = [];
  #members = new Set<number>();
  #x = new Float64Array(16);
  #y = new Float64Array(16);
  #px = new Float64Array(16);
  #py = new Float64Array(16);
  #squares = new Int32Array(16);
  #awake = new Uint8Array(16);
  #supports = new Uint8Array(16);
  #touches = new Uint8Array(16);
  #supportDx = new Float64Array(16);
  #from = 1;
  #to = 1;
  #d = 1;
  #time = 0;
  #carry = 0;
  #sampled = 0;
  #still = 0;
  #moved = 0;
  #insideSince = Infinity;
  #resting = true;
  #rows = 0;

  /** Constructs an instance for a box `width` by `height`, with balls `diameter` across. */
  constructor(width: number, height: number, diameter: number) {
    this.#width = width;
    this.#height = height;
    this.#from = this.#to = this.#d = diameter;
  }

  /** How many balls the heap holds. */
  get count(): number {
    return this.#ids.length;
  }

  /** How big the balls are across now. */
  get diameter(): number {
    return this.#d;
  }

  /** How big the balls are becoming across. */
  get targetDiameter(): number {
    return this.#to;
  }

  /** Whether the heap is at rest. */
  get resting(): boolean {
    return this.#resting;
  }

  /** Returns the ID of the `i`th ball. */
  idAt(i: number): number {
    return this.#ids[i];
  }

  /** Returns where the center of the `i`th ball is across. */
  xAt(i: number): number {
    return this.#x[i];
  }

  /** Returns where the center of the `i`th ball is down. */
  yAt(i: number): number {
    return this.#y[i];
  }

  /** Returns whether the heap holds ball `id`. */
  has(id: number): boolean {
    return this.#members.has(id);
  }

  /** Makes the box `width` by `height`, and wakes the heap. */
  resize(width: number, height: number): void {
    if (width === this.#width && height === this.#height) return;
    this.#width = width;
    this.#height = height;
    this.#awake.fill(1);
    this.#wake();
  }

  /**
   * Makes the balls `diameter` across, over `GROWING` seconds from the size
   * they are now, or at once when not `gently`, and wakes the heap.
   */
  setDiameter(diameter: number, gently: boolean): void {
    if (diameter === this.#to && (gently || diameter === this.#d)) return;
    this.#from = gently ? this.#d : diameter;
    this.#to = diameter;
    this.#d = this.#from;
    this.#awake.fill(1);
    this.#wake();
  }

  /**
   * Adds ball `id` with its center at `x`, `y`, moving `vx`, `vy` pixels a
   * second, and wakes the heap.
   */
  add(id: number, x: number, y: number, vx = 0, vy = 0): void {
    this.#wake();
    const i = this.#ids.length;
    if (i === this.#x.length) this.#grow();
    this.#ids.push(id);
    this.#members.add(id);
    this.#awake[i] = 1;
    this.#resting = false;
    const dt = this.#dt();
    this.#x[i] = x;
    this.#y[i] = y;
    this.#px[i] = x - vx * dt;
    this.#py[i] = y - vy * dt;
  }

  /**
   * Takes ball `id` out of the heap, waking it so that the balls above fall
   * into its place, and returns where it was and how it was moving, in
   * pixels a second, or `undefined` when the heap did not hold it.
   */
  remove(id: number): { x: number; y: number; vx: number; vy: number } | undefined {
    if (!this.#members.has(id)) return undefined;
    const i = this.#ids.indexOf(id);
    const dt = this.#dt();
    const state = {
      x: this.#x[i],
      y: this.#y[i],
      vx: this.#resting ? 0 : (this.#x[i] - this.#px[i]) / dt,
      vy: this.#resting ? 0 : (this.#y[i] - this.#py[i]) / dt,
    };
    const last = this.#ids.length - 1;
    this.#ids[i] = this.#ids[last];
    this.#x[i] = this.#x[last];
    this.#y[i] = this.#y[last];
    this.#px[i] = this.#px[last];
    this.#py[i] = this.#py[last];
    this.#awake[i] = this.#awake[last];
    this.#ids.pop();
    this.#members.delete(id);
    // The balls that may fall into its place wake: those above it, in a cone
    // widening upward at forty-five degrees from two balls across.
    const d = this.#d;
    for (let j = 0; j < this.#ids.length; j++) {
      const above = state.y - this.#y[j];
      if (above >= -d && Math.abs(this.#x[j] - state.x) < 2 * d + Math.max(0, above)) this.#awake[j] = 1;
    }
    this.#wake();
    return state;
  }

  /**
   * Puts the balls at rest at once, in rows from the floor up, as many to a
   * row as fit across, in the order the heap holds them, made smaller, half a
   * pixel at a time, until the rows fit in the box.
   */
  settle(): void {
    let d = this.#to;
    const rowsOf = (size: number) => Math.ceil(this.#ids.length / Math.max(1, Math.floor(this.#width / size)));
    while (d > 1 && rowsOf(d) * d > this.#height) d = Math.max(1, d - 0.5);
    const across = Math.max(1, Math.floor(this.#width / d));
    for (let i = 0; i < this.#ids.length; i++) {
      this.#x[i] = this.#px[i] = d / 2 + (i % across) * d;
      this.#y[i] = this.#py[i] = this.#height - d / 2 - Math.floor(i / across) * d;
    }
    this.#from = this.#to = this.#d = d;
    this.#resting = true;
    this.#awake.fill(0);
    this.#carry = 0;
  }

  /**
   * Moves the heap on by `seconds`, unless it is at rest, and returns
   * whether it is still moving.
   */
  advance(seconds: number): boolean {
    if (this.#resting) return false;
    this.#carry += seconds;
    for (;;) {
      const dt = this.#dt();
      if (this.#carry < dt) break;
      this.#carry -= dt;
      this.#step(dt);
      if (this.#time - this.#sampled >= 1 / 60) this.#sample();
      if (this.#resting) {
        this.#carry = 0;
        break;
      }
    }
    return !this.#resting;
  }

  /** Helper for the methods that change the heap, which sets it moving. */
  #wake(): void {
    if (this.#resting) {
      for (let i = 0; i < this.#ids.length; i++) {
        this.#px[i] = this.#x[i];
        this.#py[i] = this.#y[i];
      }
    }
    this.#resting = this.#ids.length === 0;
    this.#from = this.#d;
    this.#time = 0;
    this.#sampled = 0;
    this.#still = 0;
    this.#moved = 0;
    this.#insideSince = Infinity;
  }

  /** Helper for `add()`, which doubles the room for balls. */
  #grow(): void {
    const room = this.#x.length * 2;
    const grown = (old: Float64Array) => {
      const array = new Float64Array(room);
      array.set(old);
      return array;
    };
    this.#x = grown(this.#x);
    this.#y = grown(this.#y);
    this.#px = grown(this.#px);
    this.#py = grown(this.#py);
    this.#squares = new Int32Array(room);
    const awake = new Uint8Array(room);
    awake.set(this.#awake);
    this.#awake = awake;
    this.#supports = new Uint8Array(room);
    this.#touches = new Uint8Array(room);
    this.#supportDx = new Float64Array(room);
  }

  /**
   * Helper for the stepping methods, which returns how long a step takes:
   * as short as keeps the fastest ball, 550 pixels a second, from moving
   * much more than the width of the smallest ball, but at most a third of a
   * sixtieth of a second.
   */
  #dt(): number {
    const steps = Math.max(3, Math.ceil(550 / 60 / Math.min(this.#from, this.#to)));
    return 1 / (60 * steps);
  }

  /**
   * Helper for `advance()`, which notes how far the balls have moved each
   * sixtieth of a second, and puts the heap at rest once they are still, or
   * have moved for long enough, shrinking its balls when some stick out.
   */
  #sample(): void {
    this.#sampled = this.#time;
    let outside = 0;
    for (let i = 0; i < this.#ids.length; i++) {
      if (this.#x[i] < 0) outside++;
    }
    const grown = this.#time >= GROWING || this.#from === this.#to;
    const still = this.#moved < Math.min(0.25, this.#to / 12) && grown;
    this.#still = still ? this.#still + 1 : 0;
    this.#moved = 0;
    if (outside > 0) this.#insideSince = Infinity;
    else this.#insideSince = Math.min(this.#insideSince, this.#time);
    const waiting = this.#from === this.#to ? 0 : GROWING;
    // A ball balanced near the top of a single other, touching nothing else
    // beside or below it, nor the floor or a side, has not come to rest,
    // however slowly it has begun to roll off.
    // One balanced dead on top is nudged off it, away from its support, or
    // to one side by its ID, so that it does not stay balanced for ever.
    let perched = false;
    const r = this.#d / 2;
    for (let i = 0; i < this.#ids.length; i++) {
      if (
        this.#supports[i] !== 1 || this.#touches[i] !== 1 ||
        Math.abs(this.#supportDx[i]) >= 0.2 * this.#d || this.#y[i] >= this.#height - r - 0.5 ||
        this.#x[i] <= r + 0.5 || this.#x[i] >= this.#width - r - 0.5
      ) continue;
      perched = true;
      const away = this.#supportDx[i] > 0 || (this.#supportDx[i] === 0 && this.#ids[i] % 2 === 0) ? -1 : 1;
      this.#px[i] -= away * this.#d * 0.001;
    }
    const settled = (this.#still >= 6 && !perched) ||
      (this.#time >= 5 + waiting && this.#time - this.#insideSince >= 1);
    // Balls still outside a heap that has stopped moving are stuck on the
    // slope, with no room for them in the box at their size.
    const jammed = this.#still >= 6 && outside > 0;
    if (!(outside === 0 && settled) && !jammed && this.#time < 10 + waiting) return;
    let over = jammed;
    for (let i = 0; i < this.#ids.length; i++) {
      if (this.#x[i] >= 0 && this.#y[i] < this.#d / 2 - 0.5) over = true;
    }
    if (over && this.#d > 1) {
      this.setDiameter(Math.max(1, this.#to - 0.5), true);
      return;
    }
    this.#resting = true;
    this.#awake.fill(0);
  }

  /** Helper for `advance()`, which takes one step of `dt` seconds. */
  #step(dt: number): void {
    const count = this.#ids.length;
    const x = this.#x;
    const y = this.#y;
    const px = this.#px;
    const py = this.#py;
    this.#time += dt;
    this.#d = this.#from + (this.#to - this.#from) * Math.min(1, this.#time / GROWING);
    const gravity = GRAVITY * dt * dt;
    const awake = this.#awake;
    for (let i = 0; i < count; i++) {
      if (!awake[i]) continue;
      const vx = (x[i] - px[i]) * 0.995;
      const vy = (y[i] - py[i]) * 0.995;
      px[i] = x[i];
      py[i] = y[i];
      x[i] += vx;
      y[i] += vy + gravity;
    }
    this.#sort();
    for (let pass = 0; pass < 2; pass++) {
      this.#separate();
      for (let i = 0; i < count; i++) this.#confine(i);
    }
    // Pushing balls apart moves them, but must not fling them: a ball pushed
    // up by those under it rises only about six of its widths a second, and
    // none goes faster than a fast fall.
    const rise = 6 * this.#to * dt;
    const fastest = 550 * dt;
    let moved = 0;
    for (let i = 0; i < count; i++) {
      if (!this.#awake[i]) continue;
      let vx = x[i] - px[i];
      let vy = Math.max(y[i] - py[i], -rise);
      const v = Math.sqrt(vx * vx + vy * vy);
      if (v > fastest) {
        vx *= fastest / v;
        vy *= fastest / v;
      }
      px[i] = x[i] - vx;
      py[i] = y[i] - vy;
      moved = Math.max(moved, Math.abs(vx), Math.abs(vy));
    }
    // A step moves a ball a fraction of what it moves in a sixtieth of a
    // second, so the most it moved in any step, scaled up, stands for that.
    this.#moved = Math.max(this.#moved, moved * (1 / 60) / dt);
  }

  /**
   * Helper for `#step()`, which keeps ball `i` out of the box's sides and
   * floor, and the slope that leads into it, each of which takes up the
   * ball's speed into it as it stops it; the floor slows a ball rolling along
   * it, too.
   */
  #confine(i: number): void {
    const r = this.#d / 2;
    const x = this.#x;
    const y = this.#y;
    x[i] = Math.min(x[i], this.#width - r);
    if (y[i] > this.#height - r) {
      y[i] = this.#height - r;
      this.#py[i] = y[i];
      this.#px[i] = x[i] - (x[i] - this.#px[i]) * 0.95;
    }
    if (y[i] >= 0) {
      // Beside the box's left side: nothing is ever outside the box beside
      // it, below the slope.
      x[i] = Math.max(x[i], r);
    } else if (x[i] + y[i] <= 0) {
      // Beside the slope, the line y = x up and to the left of the box's top
      // left corner, which a ball must stay above.
      const clear = (x[i] - y[i]) / Math.SQRT2;
      if (clear < r) {
        x[i] += (r - clear) / Math.SQRT2;
        y[i] -= (r - clear) / Math.SQRT2;
      }
    } else {
      // Above the box's top left corner, which it rolls over.
      const reach = Math.sqrt(x[i] * x[i] + y[i] * y[i]);
      if (reach < r && reach > 0) {
        x[i] *= r / reach;
        y[i] *= r / reach;
      }
    }
  }

  /**
   * Helper for `#step()`, which puts the balls in order of the grid's
   * squares they are in, by column from the left, and in each column from
   * the floor up, by insertion, which, as the order changes little from one
   * step to the next, takes little more than a look at each.
   */
  #sort(): void {
    const count = this.#ids.length;
    const square = Math.max(this.#from, this.#to);
    const x = this.#x;
    const y = this.#y;
    const px = this.#px;
    const py = this.#py;
    const ids = this.#ids;
    const squares = this.#squares;
    let top = 0;
    let left = 0;
    for (let i = 0; i < count; i++) {
      top = Math.min(top, y[i]);
      left = Math.min(left, x[i]);
    }
    top = Math.floor(top / square) * square;
    left = Math.floor(left / square) * square;
    const rows = Math.floor((this.#height - top) / square) + 2;
    this.#rows = rows;
    for (let i = 0; i < count; i++) {
      const column = Math.max(0, Math.floor((x[i] - left) / square));
      const row = rows - 1 - Math.min(rows - 1, Math.max(0, Math.floor((y[i] - top) / square)));
      squares[i] = column * rows + row;
    }
    for (let i = 1; i < count; i++) {
      if (squares[i] >= squares[i - 1]) continue;
      const s = squares[i];
      const bx = x[i];
      const by = y[i];
      const bpx = px[i];
      const bpy = py[i];
      const id = ids[i];
      const wakeful = this.#awake[i];
      let j = i;
      while (j > 0 && squares[j - 1] > s) {
        squares[j] = squares[j - 1];
        x[j] = x[j - 1];
        y[j] = y[j - 1];
        px[j] = px[j - 1];
        py[j] = py[j - 1];
        ids[j] = ids[j - 1];
        this.#awake[j] = this.#awake[j - 1];
        j--;
      }
      squares[j] = s;
      x[j] = bx;
      y[j] = by;
      px[j] = bpx;
      py[j] = bpy;
      ids[j] = id;
      this.#awake[j] = wakeful;
    }
  }

  /**
   * Helper for `#step()`, which pushes apart every two balls that overlap,
   * by the overlap, the one below giving way less than the one above,
   * looking for each ball's neighbors in its own square and the eight around
   * it, from the floor up. As the balls are taken in order, where the balls
   * of the squares beside a ball's start and end, in each of the three
   * columns, only ever moves on, so each is found by moving on from where it
   * was for the ball before.
   */
  #separate(): void {
    const count = this.#ids.length;
    const d = this.#d;
    const width = this.#width;
    const rows = this.#rows;
    const x = this.#x;
    const y = this.#y;
    const ids = this.#ids;
    const squares = this.#squares;
    const awake = this.#awake;
    // How many balls hold up each, and how far across the last one is; and
    // how many touch each from beside or below.
    const supports = this.#supports;
    const supportDx = this.#supportDx;
    const touches = this.#touches;
    supports.fill(0, 0, count);
    touches.fill(0, 0, count);
    const starts = [0, 0, 0];
    const ends = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      const column = Math.floor(squares[i] / rows);
      const row = squares[i] % rows;
      const odd = ids[i] % 2 === 1;
      for (let side = 0; side < 3; side++) {
        const c = column + side - 1;
        if (c < 0) continue;
        const low = c * rows + Math.max(0, row - 1);
        const high = c * rows + Math.min(rows - 1, row + 1);
        let start = starts[side];
        while (start < count && squares[start] < low) start++;
        let end = Math.max(ends[side], start);
        while (end < count && squares[end] <= high) end++;
        starts[side] = start;
        ends[side] = end;
        for (let j = Math.max(i + 1, start); j < end; j++) {
          if (!awake[i] && !awake[j]) continue;
          let nx = x[j] - x[i];
          let ny = y[j] - y[i];
          let distance2 = nx * nx + ny * ny;
          // A sleeping ball that an awake one under it has moved away from,
          // leaving a gap of more than a fiftieth of a ball and less than a
          // whole one, which no step moves a ball past, wakes, so that it
          // falls rather than hang in the air.
          const beneath = y[i] > y[j] ? i : j;
          const above = beneath === i ? j : i;
          // A ball holds up another only from clearly below it: one nested
          // between two others has them seven eighths of a ball beneath.
          const under = y[beneath] - y[above] > d / 2;
          if (distance2 < d * d * 1.0404) {
            touches[above]++;
            if (under) {
              supports[above]++;
              supportDx[above] = x[beneath] - x[above];
            } else {
              touches[beneath]++;
            }
          }
          if (under && awake[i] !== awake[j] && distance2 > d * d * 1.0404 && distance2 < d * d * 4) {
            if (awake[beneath] && !awake[above]) {
              awake[above] = 1;
              this.#px[above] = x[above];
              this.#py[above] = y[above];
            }
          }
          if (distance2 >= d * d) continue;
          if (distance2 < 1e-8) {
            // Two balls in one spot part sideways.
            nx = odd ? -1e-3 : 1e-3;
            ny = 0;
            distance2 = 1e-6;
          }
          const distance = Math.sqrt(distance2);
          // One ball balanced right on top of another rolls off it, as a
          // real one would, away from the nearer side of the box.
          if (Math.abs(nx) < distance * 0.05) {
            const inward = x[i] + x[j] < width ? 1 : -1;
            nx += (ny > 0 ? -inward : inward) * 0.08 * distance;
          }
          // And of two side by side, squeezed together, one rides up over
          // the other, rather than both staying level for ever.
          if (Math.abs(ny) < distance * 0.05) ny -= 0.08 * distance;
          // The ball below gives way less than the one on top of it, as if
          // heavier, so that the weight of a deep heap does not squeeze the
          // bottom of it out sideways.
          const push = (d - distance) / distance;
          // A sleeping ball stays where it is, bearing what presses on it,
          // until a ball presses into it by more than a quarter of its width,
          // or rests on it nearer its top than a ball nested between two
          // others does, or is squeezed level beside it: balls that the
          // pushes above part only by moving both.
          const balanced = Math.abs(x[j] - x[i]) < distance * 0.45 || Math.abs(y[j] - y[i]) < distance * 0.05;
          if (d - distance > d / 4 || balanced) {
            for (const k of [i, j]) {
              if (awake[k]) continue;
              awake[k] = 1;
              this.#px[k] = x[k];
              this.#py[k] = y[k];
            }
          }
          const upper = !awake[i] ? 0 : !awake[j] ? 1 : 0.5 + 0.4 * ny / distance;
          x[i] -= nx * push * upper;
          y[i] -= ny * push * upper;
          x[j] += nx * push * (1 - upper);
          y[j] += ny * push * (1 - upper);
        }
      }
    }
  }
}

/** Where a ball moving on its own is, how it is moving, and for how long. */
export interface Motion {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** How long it has moved this way, in seconds. */
  t: number;
}

/** How long a step of a ball moving on its own takes, in seconds. */
export const FLIGHT_STEP = 1 / 480;

/**
 * Moves `motion` on by one `FLIGHT_STEP` as a ball drawn to `target`, as a
 * job's is to the runner that takes it, and returns whether it has come to
 * rest there. The pull of the place comes on over a quarter of a second,
 * while gravity goes on pulling down a ball that is falling, unless it is
 * `supported`, as one at rest in a heap or a slot is, until the pull holds it
 * up, so that a ball dropping into its queue as its job starts goes on
 * falling a moment, then curves round to the runner. Pulled as a damped
 * spring pulls, a ball at rest goes straight there, but one already rushing
 * towards the place may overshoot it a little, and come back. A ball at
 * rest is put exactly on its target.
 */
export function steerStep(
  motion: Motion,
  target: { readonly x: number; readonly y: number },
  supported: boolean,
): boolean {
  const dt = FLIGHT_STEP;
  const stiffness = 9;
  const weight = supported ? 0 : GRAVITY;
  motion.t += dt;
  const pull = Math.min(1, motion.t / 0.25);
  const towardX = stiffness * stiffness * (target.x - motion.x) - 2 * stiffness * motion.vx;
  const towardY = stiffness * stiffness * (target.y - motion.y) - 2 * stiffness * motion.vy;
  motion.vx += pull * towardX * dt;
  motion.vy += (weight + pull * (towardY - weight)) * dt;
  motion.x += motion.vx * dt;
  motion.y += motion.vy * dt;
  const done = (Math.hypot(motion.x - target.x, motion.y - target.y) < 0.25 &&
    Math.hypot(motion.vx, motion.vy) < 10) || motion.t >= 3;
  if (done) {
    motion.x = target.x;
    motion.y = target.y;
    motion.vx = 0;
    motion.vy = 0;
  }
  return done;
}

/** How a ball leaves the board, worked out as it starts to. */
export interface Leaving {
  readonly outcome: Outcome;
  readonly diameter: number;
  /** How long it slows to a stop where it is before it goes, in seconds. */
  readonly pause: number;
  /** How fast it is thrown, in pixels a second. */
  readonly thrownX: number;
  readonly thrownY: number;
  /** The board's width, its bottom, and the line along its bottom. */
  readonly width: number;
  readonly floor: number;
  readonly lineLeft: number;
  readonly lineRight: number;
  /** Whether it has hit the right side, which ends the throw. */
  hit: boolean;
}

/** How long a ball takes to leave once its job ends, in seconds. */
export const LEAVE = 1.3;

/**
 * Returns how a ball at `motion`, `diameter` across, leaves a board `width`
 * wide with its bottom at `floor` and a line along its bottom from
 * `lineLeft` to `lineRight`, once its job has ended `outcome`. For the first
 * part of a second, while it swells, it slows to a stop where it is, as if
 * held there; then it goes. One that passed is thrown up and to the right,
 * off the board, a little lower than it was. One that failed is thrown up
 * and to the right harder, hard enough to reach the right side while still
 * in the air. One that neither passed nor failed rises like a puff of smoke.
 */
export function startLeaving(
  motion: Motion,
  diameter: number,
  outcome: Outcome,
  width: number,
  floor: number,
  lineLeft: number,
  lineRight: number,
): Leaving {
  const r = diameter / 2;
  const wall = width - r;
  // Pushed steadily for a tenth of a second, a ball goes as far as it would
  // have going at its final speed from halfway through the push.
  const lag = 0.05;
  const away = width + diameter - motion.x;
  const flying = Math.min(0.9, Math.max(0.5, away / 900));
  let thrownX = 0;
  let thrownY = 0;
  if (outcome === "passed") {
    thrownX = away / (flying - lag);
    thrownY = (60 - GRAVITY * flying * flying / 2) / (flying - lag);
  } else if (outcome === "failed") {
    thrownX = Math.max(900, (wall - motion.x) / 0.45);
    thrownY = -420;
  }
  motion.t = 0;
  return {
    outcome,
    diameter,
    pause: LEAVE * 0.35,
    thrownX,
    thrownY,
    width,
    floor,
    lineLeft,
    lineRight,
    hit: false,
  };
}

/**
 * Moves `motion` on by one `FLIGHT_STEP` as a ball leaving the board as
 * `leaving` says, and returns whether it has gone. One that failed bounces
 * off the right side at a fifth of the speed it hit it at, falls to the line
 * along the bottom, bounces there, each bounce back up at half the speed it
 * came down at, and slides off to the left, as on a floor both bouncy and
 * slippery, until, past the line's left end, nothing holds it up, and it
 * falls. One that neither passed nor failed is lifted by buoyancy and held
 * back by the air, so that it rises ever faster to a steady speed.
 */
export function leaveStep(motion: Motion, leaving: Leaving): boolean {
  const dt = FLIGHT_STEP;
  const push = 0.1;
  const r = leaving.diameter / 2;
  motion.t += dt;
  const t = motion.t;
  let ax: number;
  let ay: number;
  if (t < leaving.pause) {
    // Drag, with the ball held up, slows it to a stop.
    ax = -12 * motion.vx;
    ay = -12 * motion.vy;
  } else if (leaving.outcome === "neither") {
    ax = -3 * motion.vx;
    ay = -700 - 3 * motion.vy;
  } else {
    const pushing = t < leaving.pause + push && !leaving.hit;
    ax = pushing ? leaving.thrownX / push : 0;
    ay = GRAVITY + (pushing ? leaving.thrownY / push : 0);
  }
  motion.vx += ax * dt;
  motion.vy += ay * dt;
  motion.x += motion.vx * dt;
  motion.y += motion.vy * dt;
  if (leaving.outcome === "failed") {
    const wall = leaving.width - r;
    if (motion.x >= wall && motion.vx > 0) {
      motion.x = wall;
      motion.vx *= -0.2;
      leaving.hit = true;
    }
    const ground = leaving.floor - r;
    if (
      motion.y >= ground && motion.x >= leaving.lineLeft &&
      motion.x <= leaving.lineRight && motion.y - motion.vy * dt <= ground
    ) {
      motion.y = ground;
      motion.vy = motion.vy > 90 ? -motion.vy * 0.5 : 0;
    }
  }
  const d = leaving.diameter;
  return t > leaving.pause &&
    (motion.x > leaving.width + d || motion.x < -d || motion.y < -d * 2 ||
      motion.y > leaving.floor + 400 || t > leaving.pause + 4 + leaving.width / 40);
}
