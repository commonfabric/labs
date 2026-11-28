import { expect } from "@std/expect";
import { maxOf, minOf } from "@commonfabric/collections/math";
import { describe, it } from "@commonfabric/test-support/test";
import {
  FLIGHT_STEP,
  GROWING,
  heapDiameter,
  HeapWorld,
  LEAVE,
  leaveStep,
  type Motion,
  startLeaving,
  steerStep,
} from "./runner-physics.ts";

const FRAME = 1 / 60;

/** Advances `world` a frame at a time until it rests, and returns how many frames that took, or `limit` if it never did. */
function runToRest(world: HeapWorld, limit = 2000): number {
  let frames = 0;
  while (frames < limit && world.advance(FRAME)) frames++;
  return frames;
}

/** Returns a heap `width` by `height` of `count` balls `diameter` across, poured in rows from above the box. */
function poured(width: number, height: number, diameter: number, count: number): HeapWorld {
  const world = new HeapWorld(width, height, diameter);
  const across = Math.max(1, Math.floor(width / (diameter * 1.2)));
  for (let i = 0; i < count; i++) {
    world.add(
      i,
      diameter + (i % across) * diameter * 1.2,
      -diameter - Math.floor(i / across) * diameter * 1.2,
    );
  }
  return world;
}

/** Returns where each ball of `world` is, by its ID. */
function positions(world: HeapWorld): Map<number, { x: number; y: number }> {
  const result = new Map<number, { x: number; y: number }>();
  for (let i = 0; i < world.count; i++) result.set(world.idAt(i), { x: world.xAt(i), y: world.yAt(i) });
  return result;
}

/** Returns a heap of six hundred balls a hundred by three hundred, forty rows deep, at rest. */
function deepHeap(): HeapWorld {
  const world = poured(100, 300, heapDiameter(600, 100, 300, 16), 600);
  runToRest(world);
  return world;
}

/** Returns the farthest any ball of `world` that was at `before` has moved since. */
function farthestMoved(world: HeapWorld, before: Map<number, { x: number; y: number }>): number {
  let farthest = 0;
  for (const [id, where] of positions(world)) {
    const was = before.get(id);
    if (was !== undefined) farthest = Math.max(farthest, Math.hypot(where.x - was.x, where.y - was.y));
  }
  return farthest;
}

/** Returns a source of numbers from zero up to one, the same for the same `seed`: Mulberry32's. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Returns the IDs of the balls of `world`, in a box `height` tall, that are
 * in the box but neither on its floor nor touching a ball below them.
 */
function hanging(world: HeapWorld, height: number): number[] {
  const d = world.diameter;
  const result: number[] = [];
  for (let i = 0; i < world.count; i++) {
    const x = world.xAt(i);
    const y = world.yAt(i);
    if (x < 0 || y >= height - d / 2 - 0.01) continue;
    let held = false;
    for (let j = 0; j < world.count && !held; j++) {
      held = world.yAt(j) > y && Math.hypot(world.xAt(j) - x, world.yAt(j) - y) <= d * 1.02;
    }
    if (!held) result.push(world.idAt(i));
  }
  return result;
}

/** Returns a heap of three balls ten across, at rest in a pyramid on the floor of a box 200 by 100. */
function pyramid(): HeapWorld {
  const world = new HeapWorld(200, 100, 10);
  world.add(1, 45, 95);
  world.add(2, 55, 95);
  world.add(3, 50, 95 - Math.sqrt(10 ** 2 - 5 ** 2));
  runToRest(world);
  return world;
}

/**
 * Returns the IDs of the balls of `world`, in a box `width` by `height`,
 * balanced near the top of a single other: off the floor, clear of the sides,
 * held up by one ball less than a fifth of a ball across from straight
 * beneath it, and touching no other beside or below it.
 */
function perched(world: HeapWorld, width: number, height: number): number[] {
  const d = world.diameter;
  const r = d / 2;
  const result: number[] = [];
  for (let i = 0; i < world.count; i++) {
    const x = world.xAt(i);
    const y = world.yAt(i);
    if (y >= height - r - 0.5 || x <= r + 0.5 || x >= width - r - 0.5) continue;
    const touching: number[] = [];
    for (let j = 0; j < world.count; j++) {
      if (j !== i && world.yAt(j) > y - r && Math.hypot(world.xAt(j) - x, world.yAt(j) - y) <= d * 1.02) {
        touching.push(j);
      }
    }
    if (touching.length !== 1) continue;
    const [under] = touching;
    if (world.yAt(under) - y > r && Math.abs(world.xAt(under) - x) < 0.2 * d) result.push(world.idAt(i));
  }
  return result;
}

/** Returns a heap of `count` balls ten across, at rest in a row along the floor of a box a hundred square. */
function row(count: number): HeapWorld {
  const world = new HeapWorld(100, 100, 10);
  for (let i = 0; i < count; i++) world.add(i, 5 + i * 10, 95);
  world.settle();
  return world;
}

/** Wakes `world` and runs it to rest again, and returns the farthest any ball moved. */
function stirred(world: HeapWorld): number {
  const before = positions(world);
  world.add(-1, 100_000, -100_000);
  world.remove(-1);
  runToRest(world);
  let farthest = 0;
  for (const [id, where] of positions(world)) {
    const was = before.get(id);
    farthest = Math.max(farthest, was === undefined ? Infinity : Math.hypot(where.x - was.x, where.y - was.y));
  }
  return farthest;
}

/** Returns how many frames `world` takes to start making its balls smaller, or `limit` if it never does. */
function framesToShrink(world: HeapWorld, limit = 2000): number {
  const size = world.targetDiameter;
  let frames = 0;
  while (frames < limit && world.advance(FRAME) && world.targetDiameter === size) frames++;
  return frames;
}

/** Returns the least distance between the centers of any two balls of `world`. */
function closest(world: HeapWorld): number {
  let least = Infinity;
  for (let i = 0; i < world.count; i++) {
    for (let j = i + 1; j < world.count; j++) {
      least = Math.min(least, Math.hypot(world.xAt(i) - world.xAt(j), world.yAt(i) - world.yAt(j)));
    }
  }
  return least;
}

/** Expects every ball of `world` to lie within a box `width` by `height`, give or take `slack`. */
function expectInside(world: HeapWorld, width: number, height: number, slack = 1e-9): void {
  const r = world.diameter / 2;
  for (let i = 0; i < world.count; i++) {
    expect(Number.isFinite(world.xAt(i)) && Number.isFinite(world.yAt(i))).toBe(true);
    expect(world.xAt(i)).toBeGreaterThanOrEqual(r - slack);
    expect(world.xAt(i)).toBeLessThanOrEqual(width - r + slack);
    expect(world.yAt(i)).toBeGreaterThanOrEqual(r - 0.5 - slack);
    expect(world.yAt(i)).toBeLessThanOrEqual(height - r + slack);
  }
}

const motion = (fields: Partial<Motion> = {}): Motion => ({ x: 0, y: 0, vx: 0, vy: 0, t: 0, ...fields });

/** Steps `m` towards `target` until it is done, and returns every place it was on the way. */
function steer(m: Motion, target: { x: number; y: number }, supported: boolean): { x: number; y: number }[] {
  const path = [{ x: m.x, y: m.y }];
  for (let step = 0; step < 4 / FLIGHT_STEP; step++) {
    const done = steerStep(m, target, supported);
    path.push({ x: m.x, y: m.y });
    if (done) break;
  }
  return path;
}

/** Steps `m` off the board as `leaving` says until it has gone, and returns every place it was on the way. */
function leave(m: Motion, leaving: ReturnType<typeof startLeaving>): Motion[] {
  const path: Motion[] = [];
  for (let step = 0; step < 30 / FLIGHT_STEP; step++) {
    const gone = leaveStep(m, leaving);
    path.push({ ...m });
    if (gone) break;
  }
  return path;
}

describe("runner-physics", () => {
  describe("heapDiameter()", () => {
    it("returns `largest` when that many balls fit loosely", () => {
      expect(heapDiameter(10, 200, 200, 16)).toBe(16);
      expect(heapDiameter(0, 10, 10, 16)).toBe(16);
    });

    it("returns smaller balls, in half pixels, the more there are, the biggest that fit loosely", () => {
      let last = Infinity;
      for (const count of [10, 50, 100, 200, 400]) {
        const d = heapDiameter(count, 100, 100, 16);
        expect(d).toBeLessThanOrEqual(last);
        expect(d * 2).toBe(Math.round(d * 2));
        const rows = (size: number) => Math.ceil(count / Math.max(1, Math.floor(100 / size)));
        expect(rows(d) * d * 1.15).toBeLessThanOrEqual(100);
        if (d < 16) expect(rows(d + 0.5) * (d + 0.5) * 1.15).toBeGreaterThan(100);
        last = d;
      }
      expect(last).toBeLessThan(16);
    });

    it("returns one pixel at least, however many there are", () => {
      expect(heapDiameter(100_000, 10, 10, 16)).toBe(1);
      expect(heapDiameter(1, 10, 10, 0)).toBe(1);
    });
  });

  describe("HeapWorld", () => {
    describe("constructor()", () => {
      it("makes an empty heap at rest with balls of the given size", () => {
        const world = new HeapWorld(100, 100, 10);
        expect(world.count).toBe(0);
        expect(world.resting).toBe(true);
        expect(world.diameter).toBe(10);
        expect(world.targetDiameter).toBe(10);
        expect(world.advance(FRAME)).toBe(false);
      });
    });

    it("leaves no ball hanging in the air after any of many seeded rounds of adding, removing, and resizing", () => {
      // Each seed pours two hundred balls six across into a box eighty by a
      // hundred and twenty, then, thirty-two times, takes a ball out, drops
      // one in, or now and then resizes the box, and lets the heap come to
      // rest. A sleeping ball whose support moves away must fall too.
      for (let seed = 1; seed <= 10; seed++) {
        const random = seeded(seed);
        const d = 6;
        let width = 80;
        let height = 120;
        const world = new HeapWorld(width, height, d);
        let next = 0;
        for (; next < 200; next++) world.add(next, d / 2 + random() * (width - d), -d - random() * 3 * height);
        runToRest(world);
        for (let round = 0; round < 32; round++) {
          const change = random();
          if (change < 0.7) {
            world.remove(world.idAt(Math.floor(random() * world.count)));
          } else if (change < 0.95) {
            world.add(next++, d / 2 + random() * (width - d), -d - random() * 20);
          } else {
            width = 70 + Math.floor(random() * 20);
            height = 110 + Math.floor(random() * 20);
            world.resize(width, height);
          }
          expect(runToRest(world)).toBeLessThan(10 / FRAME);
          expect({ seed, round, hanging: hanging(world, height) }).toEqual({ seed, round, hanging: [] });
          expectInside(world, width, height);
        }
      }
    });

    describe("instance members", () => {
      describe("add()", () => {
        it("moves none of the balls of a deep heap at rest, which rests again within a few frames", () => {
          // A heap this deep never stops moving on its own; the cutoff puts
          // it at rest. Adding a ball far from it, and taking it out again,
          // must not set it all moving once more.
          const world = deepHeap();
          const before = positions(world);
          world.add(-1, 100_000, -100_000);
          world.remove(-1);
          expect(runToRest(world)).toBeLessThan(15);
          expect(farthestMoved(world, before)).toBe(0);
        });

        it("hardly moves the balls of a deep heap at rest when a ball lands on it", () => {
          const world = deepHeap();
          const before = positions(world);
          world.add(-1, 50, -20);
          expect(runToRest(world)).toBeLessThan(60);
          expect(farthestMoved(world, before)).toBeLessThan(0.5);
          expect(closest(world)).toBeGreaterThan(world.diameter * 0.95);
        });

        it("leaves asleep the balls of a deep heap at rest that only rest on balls a landing ball wakes", () => {
          // The ball dropped on the heap wakes the few it lands on and
          // presses as it rolls down the heap into a groove; the balls
          // resting on those stay in contact with them, so stay asleep, and
          // so does everything farther from its path.
          const world = deepHeap();
          const d = world.diameter;
          const before = positions(world);
          world.add(-1, 50, -20);
          const path: { x: number; y: number }[] = [];
          for (let frames = 0; frames < 2000 && world.advance(FRAME); frames++) {
            const where = positions(world).get(-1);
            if (where === undefined) throw new Error("The heap lost the ball dropped on it.");
            path.push(where);
          }
          expect(world.resting).toBe(true);
          let moved = 0;
          for (const [id, where] of positions(world)) {
            const was = before.get(id);
            if (was === undefined || (where.x === was.x && where.y === was.y)) continue;
            moved++;
            expect(path.some((on) => Math.hypot(was.x - on.x, was.y - on.y) < 2.5 * d)).toBe(true);
          }
          expect(moved).toBeGreaterThan(0);
          expect(moved).toBeLessThanOrEqual(12);
        });

        it("leaves a pyramid at rest standing when a ball beside its base shoots away level with it", () => {
          // The ball added overlaps the base's right ball a little and leaves
          // at once; a ball beside another, not beneath it, holds nothing up,
          // so the pyramid, which stands only while it sleeps, sleeps on.
          const world = pyramid();
          const before = positions(world);
          world.add(4, 64, 95, 550, 0);
          runToRest(world);
          expect(farthestMoved(world, before)).toBeLessThan(0.1);
          expect(positions(world).get(3)?.y).toBeLessThan(90);
        });

        it("does not leave a ball that lands on a pyramid at rest balanced on top of a single other", () => {
          // Each of these throws ends with a ball slowly beginning to roll
          // off the top of another, slowly enough to look still.
          for (const [x, y] of [[42, 94], [70, 89]]) {
            const world = pyramid();
            world.add(4, x, y, -550, 0);
            runToRest(world);
            expect({ x, y, perched: perched(world, 200, 100) }).toEqual({ x, y, perched: [] });
            expectInside(world, 200, 100);
          }
        });

        it("lets balls on top of others come to rest at once when held by a neighbor or a side", () => {
          // Three balls on three, side by side between the walls, each held
          // in place by its neighbors or a wall; and a ball on another in a box
          // too narrow for it to roll off, which rolls against a side.
          const rows = new HeapWorld(30, 100, 10);
          for (let i = 0; i < 3; i++) rows.add(i, 5 + 10 * i, 95);
          for (let i = 0; i < 3; i++) rows.add(10 + i, 5 + 10 * i, 85);
          expect(runToRest(rows)).toBeLessThan(30);
          for (let i = 0; i < 3; i++) expect(positions(rows).get(10 + i)?.y).toBeCloseTo(85, 1);
          const narrow = new HeapWorld(15, 100, 10);
          narrow.add(1, 7.5, 95);
          narrow.add(2, 7.6, 80);
          expect(runToRest(narrow)).toBeLessThan(60);
          const top = positions(narrow).get(2);
          expect(top?.y).toBeLessThan(90);
          expect([5, 10]).toContain(Math.round((top?.x ?? NaN) * 100) / 100);
        });

        it("nests a ball dropped right above a ball of a row at rest in the groove beside it", () => {
          const world = row(10);
          world.add(99, 45, 50);
          runToRest(world);
          const where = positions(world).get(99);
          expect(where?.y).toBeCloseTo(95 - Math.sqrt(10 ** 2 - 5 ** 2), 1);
          expect([40, 50]).toContain(Math.round(where?.x ?? NaN));
          for (const [id, ball] of positions(world)) if (id !== 99) expect(ball.y).toBeCloseTo(95, 3);
        });

        it("holds the ball and wakes the heap", () => {
          const world = new HeapWorld(100, 100, 10);
          world.add(7, 50, 10);
          expect(world.count).toBe(1);
          expect(world.has(7)).toBe(true);
          expect(world.has(8)).toBe(false);
          expect(world.idAt(0)).toBe(7);
          expect(world.xAt(0)).toBe(50);
          expect(world.yAt(0)).toBe(10);
          expect(world.resting).toBe(false);
        });

        it("sets a ball added to a moving heap moving as fast as it says", () => {
          const moving = (vx: number) => {
            const world = new HeapWorld(1000, 1000, 10);
            world.add(1, 900, 100);
            world.add(2, 100, 100, vx, 0);
            for (let frame = 0; frame < 6; frame++) world.advance(FRAME);
            return positions(world).get(2)?.x ?? NaN;
          };
          expect(moving(300)).toBeGreaterThan(125);
          expect(moving(300)).toBeLessThanOrEqual(130);
          expect(moving(0)).toBe(100);
        });

        it("sets a ball added to a heap at rest moving as fast as it says, and leaves the balls at rest where they are", () => {
          const added = (vx: number) => {
            const world = new HeapWorld(1000, 1000, 10);
            world.add(1, 900, 995);
            runToRest(world);
            const resting = positions(world).get(1);
            world.add(2, 100, 100, vx, 0);
            expect(world.resting).toBe(false);
            for (let frame = 0; frame < 6; frame++) world.advance(FRAME);
            expect(positions(world).get(1)).toEqual(resting);
            return positions(world).get(2)?.x ?? NaN;
          };
          expect(added(300)).toBeGreaterThan(125);
          expect(added(300)).toBeLessThanOrEqual(130);
          expect(added(0)).toBe(100);
        });

        it("sets the first ball added to an empty heap moving as fast as it says", () => {
          const added = (vy: number) => {
            const world = new HeapWorld(1000, 1000, 10);
            world.add(1, 500, 100, 0, vy);
            for (let frame = 0; frame < 6; frame++) world.advance(FRAME);
            return world.yAt(0);
          };
          const fall = added(0) - 100;
          expect(fall).toBeGreaterThan(0);
          expect(added(300) - 100).toBeGreaterThan(fall + 20);
        });
      });

      describe("advance()", () => {
        it("brings poured balls to rest inside the box with none overlapping", () => {
          const world = poured(100, 100, 10, 40);
          expect(runToRest(world)).toBeLessThan(100);
          expect(world.resting).toBe(true);
          expect(world.count).toBe(40);
          expect(world.diameter).toBe(10);
          expectInside(world, 100, 100);
          expect(closest(world)).toBeGreaterThan(10 * 0.98);
        });

        it("brings a deep heap to rest without squeezing it out of the box", () => {
          const world = poured(80, 300, 8, 200);
          expect(runToRest(world)).toBeLessThan(5 / FRAME);
          expectInside(world, 80, 300);
          expect(closest(world)).toBeGreaterThan(8 * 0.95);
        });

        it("comes to rest only once the balls have stopped, so that waking the heap moves none much", () => {
          for (const world of [poured(100, 100, 10, 40), poured(80, 300, 8, 200)]) {
            runToRest(world);
            expect(stirred(world)).toBeLessThan(1);
          }
        });

        it("brings a heap of hundreds of small balls to rest in the box within five seconds", () => {
          const world = poured(100, 300, heapDiameter(600, 100, 300, 16), 600);
          expect(runToRest(world)).toBeLessThanOrEqual(5 / FRAME);
          expectInside(world, 100, 300);
        });

        it("brings a heap of thousands of balls to rest because they stop, before five seconds would put it at rest, with none overlapping", () => {
          for (const [width, height] of [[360, 240], [200, 200]]) {
            const diameter = heapDiameter(2000, width, height, 16);
            const world = poured(width, height, diameter, 2000);
            expect(runToRest(world)).toBeLessThan(4.5 / FRAME);
            expectInside(world, width, height);
            expect(closest(world)).toBeGreaterThan(diameter * 0.95);
          }
        });

        it("makes the balls smaller at once when the heap stops moving with balls stuck on the slope", () => {
          // Thirty balls twelve across overfill a box sixty by forty, and
          // those left on the slope have no room to roll into the box.
          const world = poured(60, 40, 12, 30);
          expect(framesToShrink(world)).toBeLessThan(2 / FRAME);
          expect(world.targetDiameter).toBe(11.5);
        });

        it("puts a heap at rest after ten seconds while a ball outside is still falling, half a second more while the balls grow", () => {
          for (const growing of [false, true]) {
            const world = new HeapWorld(100, 100, 10);
            for (let i = 0; i < 5; i++) world.add(i, 10 + i * 20, 95);
            // Far above the slope, the ball takes over a minute to reach it.
            world.add(99, -5000, -50_000);
            if (growing) world.setDiameter(9.5, true);
            expect(runToRest(world)).toBe((growing ? 10 + GROWING : 10) / FRAME);
            expect(world.targetDiameter).toBe(growing ? 9.5 : 10);
            const faller = positions(world).get(99);
            expect(faller?.x).toBe(-5000);
            expect(faller?.y).toBeLessThan(-40_000);
          }
        });

        it("brings balls poured far off down the slope into a box they overfill to rest within seconds", () => {
          // Eighty balls 8.5 across, poured in a pile two boxes' widths to the
          // left, as the runners page pours a queue, do not fit in a box 171
          // by 46 as they lie; the heap shrinks them as each attempt jams.
          const width = 171;
          const height = 46;
          const planned = heapDiameter(80, width, height, 16);
          expect(planned).toBe(8.5);
          const world = new HeapWorld(width, height, planned);
          const across = Math.floor(width / (planned * 1.1));
          const pileWidth = across * planned * 1.1;
          const pileHeight = Math.ceil(80 / across) * planned * 1.2;
          const right = -2 * width + pileWidth / 2;
          const bottom = Math.min(-2 * width - 2 * height + pileHeight / 2, right - pileWidth - planned);
          for (let k = 0; k < 80; k++) {
            const row = Math.floor(k / across);
            world.add(
              k,
              right - planned / 2 - (k % across) * planned * 1.1 - (row % 2 === 0 ? 0 : planned * 0.55),
              bottom - planned / 2 - row * planned * 1.2,
            );
          }
          expect(runToRest(world, 3000)).toBeLessThan(9 / FRAME);
          expect(world.diameter).toBe(7);
          expectInside(world, width, height);
          expect(closest(world)).toBeGreaterThan(7 * 0.95);
        });

        it("returns `false`, and moves nothing, once the heap is at rest", () => {
          const world = poured(100, 100, 10, 10);
          runToRest(world);
          const before = positions(world);
          expect(world.advance(FRAME)).toBe(false);
          expect(world.advance(1)).toBe(false);
          expect(positions(world)).toEqual(before);
        });

        it("returns `true` while balls are still falling", () => {
          const world = poured(100, 100, 10, 10);
          expect(world.advance(FRAME)).toBe(true);
          expect(world.resting).toBe(false);
        });

        it("moves nothing in less time than a step takes", () => {
          const world = new HeapWorld(100, 100, 10);
          world.add(1, 50, 10);
          world.advance(1 / 10_000);
          expect(world.yAt(0)).toBe(10);
          world.advance(FRAME);
          expect(world.yAt(0)).toBeGreaterThan(10);
        });

        it("rolls balls dropped far to the left down the slope into the box", () => {
          const world = new HeapWorld(100, 100, 10);
          for (let i = 0; i < 5; i++) world.add(i, -200 - i * 15, -250 - i * 15);
          expect(runToRest(world)).toBeLessThan(600);
          expectInside(world, 100, 100);
        });

        it("parts two balls dropped in one spot, whichever is added first", () => {
          for (const ids of [[1, 2], [2, 1]]) {
            const world = new HeapWorld(50, 50, 10);
            for (const id of ids) world.add(id, 25, 25);
            runToRest(world);
            expectInside(world, 50, 50);
            expect(closest(world)).toBeGreaterThan(9.9);
          }
        });

        it("rolls a ball dropped right on top of another off it", () => {
          const world = new HeapWorld(200, 100, 10);
          world.add(1, 60, 95);
          runToRest(world);
          world.add(2, 60, 50);
          runToRest(world);
          expect(world.yAt(0)).toBeCloseTo(95, 1);
          expect(world.yAt(1)).toBeCloseTo(95, 1);
          expect(closest(world)).toBeGreaterThan(9.9);
        });

        it("makes the balls smaller until none sticks out of the top of the box", () => {
          const world = poured(60, 40, 12, 30);
          expect(runToRest(world, 3000)).toBeLessThan(3000);
          expect(world.targetDiameter).toBeLessThan(12);
          expect(world.diameter).toBe(world.targetDiameter);
          expectInside(world, 60, 40);
          expect(closest(world)).toBeGreaterThan(world.diameter * 0.95);
        });

        it("keeps the balls their size when they all fit", () => {
          const world = poured(100, 100, 10, 20);
          runToRest(world);
          expect(world.targetDiameter).toBe(10);
        });

        it("comes to rest with balls a pixel across when even those stick out", () => {
          const world = poured(3, 3, 1, 30);
          expect(runToRest(world, 3000)).toBeLessThan(3000);
          expect(world.diameter).toBe(1);
        });
      });

      describe("settle()", () => {
        it("puts the balls at rest at once in rows from the floor up, in the order the heap holds them", () => {
          const world = poured(100, 100, 10, 25);
          world.advance(FRAME);
          world.settle();
          expect(world.resting).toBe(true);
          expect(world.advance(FRAME)).toBe(false);
          expect(world.count).toBe(25);
          expect(world.diameter).toBe(10);
          for (let i = 0; i < world.count; i++) {
            expect(world.xAt(i)).toBe(5 + (i % 10) * 10);
            expect(world.yAt(i)).toBe(95 - Math.floor(i / 10) * 10);
          }
          expectInside(world, 100, 100);
        });

        it("makes the balls smaller, half a pixel at a time, until the rows fit", () => {
          const world = poured(60, 40, 12, 30);
          world.settle();
          // Twelve across, five to a row, the six rows of thirty need 72
          // pixels; at 8.5, seven to a row, five rows need 42.5; at 8, the
          // same five rows need 40.
          expect(world.diameter).toBe(8);
          expect(world.targetDiameter).toBe(8);
          expectInside(world, 60, 40);
          expect(closest(world)).toBe(8);
        });

        it("leaves balls that already fit their size, and finishes growing them", () => {
          const world = poured(100, 100, 10, 5);
          world.setDiameter(12, true);
          world.settle();
          expect(world.diameter).toBe(12);
          world.add(99, 50, -20);
          world.advance(FRAME);
          expect(world.diameter).toBe(12);
        });

        it("wakes again when a ball is added, and settles the new ball onto the rows", () => {
          const world = poured(100, 100, 10, 10);
          world.settle();
          world.add(99, 50, 0);
          expect(world.resting).toBe(false);
          expect(runToRest(world)).toBeLessThan(600);
          expectInside(world, 100, 100);
          expect(positions(world).get(99)?.y).toBeCloseTo(95 - Math.sqrt(10 ** 2 - 5 ** 2), 1);
        });
      });

      describe("remove()", () => {
        it("returns `undefined`, and leaves the heap at rest, for a ball it does not hold", () => {
          const world = poured(100, 100, 10, 3);
          runToRest(world);
          expect(world.remove(99)).toBeUndefined();
          expect(world.resting).toBe(true);
          expect(world.count).toBe(3);
        });

        it("returns where a ball at rest was, not moving", () => {
          const world = poured(100, 100, 10, 3);
          runToRest(world);
          const where = positions(world).get(1);
          expect(world.remove(1)).toEqual({ x: where?.x, y: where?.y, vx: 0, vy: 0 });
          expect(world.has(1)).toBe(false);
          expect(world.count).toBe(2);
          expect([0, 1].map((i) => world.idAt(i)).sort()).toEqual([0, 2]);
        });

        it("returns how a falling ball was moving", () => {
          const world = new HeapWorld(100, 1000, 10);
          world.add(1, 50, 10);
          for (let frame = 0; frame < 10; frame++) world.advance(FRAME);
          const state = world.remove(1);
          expect(state?.vy).toBeGreaterThan(100);
          expect(Math.abs(state?.vx ?? Infinity)).toBeLessThan(1);
        });

        it("wakes the heap so that the balls above fall into the ball's place", () => {
          const world = new HeapWorld(15, 100, 10);
          for (let i = 0; i < 3; i++) world.add(i, 7.5, 90 - i * 20);
          runToRest(world);
          const before = positions(world);
          const bottom = [...before].reduce((a, b) => (a[1].y > b[1].y ? a : b))[0];
          world.remove(bottom);
          expect(world.resting).toBe(false);
          expect(runToRest(world)).toBeLessThan(600);
          for (const [id, where] of positions(world)) {
            expect(where.y).toBeGreaterThan((before.get(id)?.y ?? Infinity) + 5);
          }
          expectInside(world, 15, 100);
        });

        it("lets the balls above a ball taken from deep in a heap fill its place, and moves none well below more than a fraction of a pixel", () => {
          // A ball whose neighbors above lie in an even, hexagonal patch
          // leaves a hole they bridge, as a real heap of marbles can; this
          // one, low down on the right, does not.
          const world = deepHeap();
          const d = world.diameter;
          const before = positions(world);
          let deep = world.idAt(0);
          for (const [id, where] of before) {
            const best = before.get(deep);
            if (best && Math.hypot(where.x - 70, where.y - 250) < Math.hypot(best.x - 70, best.y - 250)) deep = id;
          }
          const taken = world.remove(deep);
          if (taken === undefined) throw new Error("The heap did not hold the ball.");
          expect(runToRest(world)).toBeLessThan(5 / FRAME);
          let nearest = Infinity;
          for (const where of positions(world).values()) {
            nearest = Math.min(nearest, Math.hypot(where.x - taken.x, where.y - taken.y));
          }
          expect(nearest).toBeLessThan(d / 4);
          let below = 0;
          for (const [id, where] of positions(world)) {
            const was = before.get(id);
            if (was === undefined || was.y <= taken.y + 3 * d) continue;
            below++;
            expect(Math.hypot(where.x - was.x, where.y - was.y)).toBeLessThan(0.25);
          }
          expect(below).toBeGreaterThan(40);
          expect(closest(world)).toBeGreaterThan(d * 0.95);
          expectInside(world, 100, 300);
        });

        it("leaves an emptied heap at rest", () => {
          const world = new HeapWorld(100, 100, 10);
          world.add(1, 50, 50);
          world.remove(1);
          expect(world.count).toBe(0);
          expect(world.resting).toBe(true);
        });
      });

      describe("resize()", () => {
        it("leaves the heap at rest when the box keeps its size", () => {
          const world = poured(100, 100, 10, 5);
          runToRest(world);
          world.resize(100, 100);
          expect(world.resting).toBe(true);
        });

        it("wakes every ball, so that balls at rest fall to a lower floor", () => {
          const world = row(5);
          world.resize(100, 150);
          runToRest(world);
          for (const where of positions(world).values()) expect(where.y).toBe(145);
        });

        it("wakes the heap and settles it into a narrower box", () => {
          const world = poured(100, 100, 10, 20);
          runToRest(world);
          world.resize(40, 100);
          expect(world.resting).toBe(false);
          expect(runToRest(world)).toBeLessThan(600);
          expectInside(world, 40, 100);
        });
      });

      describe("setDiameter()", () => {
        it("wakes every ball, so that balls at rest that grow into each other part", () => {
          // Ten across, side by side, made eleven, each pair overlaps by a
          // pixel, too little to wake two sleeping balls by itself.
          for (const gently of [false, true]) {
            const world = row(5);
            world.setDiameter(11, gently);
            runToRest(world);
            expect(closest(world)).toBeGreaterThan(11 * 0.99);
            expectInside(world, 100, 100);
          }
        });

        it("makes the balls the new size at once when not gentle", () => {
          const world = poured(100, 100, 10, 5);
          runToRest(world);
          world.setDiameter(6, false);
          expect(world.diameter).toBe(6);
          expect(world.targetDiameter).toBe(6);
          expect(world.resting).toBe(false);
          runToRest(world);
          expectInside(world, 100, 100);
        });

        it("grows the balls to the new size over `GROWING` seconds when gentle", () => {
          const world = poured(100, 100, 10, 5);
          runToRest(world);
          world.setDiameter(12, true);
          expect(world.diameter).toBe(10);
          expect(world.targetDiameter).toBe(12);
          world.advance(GROWING / 2);
          expect(world.diameter).toBeGreaterThan(10);
          expect(world.diameter).toBeLessThan(12);
          for (let t = 0; t < GROWING; t += FRAME) world.advance(FRAME);
          expect(world.diameter).toBe(12);
          runToRest(world);
          expectInside(world, 100, 100);
          expect(closest(world)).toBeGreaterThan(12 * 0.98);
        });

        it("leaves the heap at rest when the size does not change", () => {
          const world = poured(100, 100, 10, 5);
          runToRest(world);
          world.setDiameter(10, true);
          expect(world.resting).toBe(true);
          world.setDiameter(10, false);
          expect(world.resting).toBe(true);
        });

        it("does not restart growing towards the size the balls are already becoming", () => {
          const world = poured(100, 100, 10, 5);
          runToRest(world);
          world.setDiameter(12, true);
          world.advance(GROWING / 2);
          const growing = world.diameter;
          world.setDiameter(12, true);
          expect(world.diameter).toBe(growing);
          world.setDiameter(12, false);
          expect(world.diameter).toBe(12);
        });

        it("keeps growing from the size the balls are when a ball is added while they grow", () => {
          const world = poured(100, 100, 10, 5);
          runToRest(world);
          world.setDiameter(12, true);
          world.advance(GROWING / 2);
          const growing = world.diameter;
          world.add(99, 50, -20);
          world.advance(FRAME);
          expect(world.diameter).toBeGreaterThanOrEqual(growing);
          expect(world.diameter).toBeLessThan(growing + 0.2);
          for (let t = 0; t < GROWING + FRAME; t += FRAME) world.advance(FRAME);
          expect(world.diameter).toBe(12);
        });

        it("does not grow the balls back to an old size when the heap is woken after a change of size", () => {
          const world = poured(100, 100, 10, 10);
          runToRest(world);
          world.setDiameter(6, true);
          runToRest(world);
          expect(world.diameter).toBe(6);
          world.add(99, 50, -20);
          for (let frame = 0; frame < 10; frame++) {
            world.advance(FRAME);
            expect(world.diameter).toBe(6);
          }
        });
      });
    });
  });

  describe("steerStep()", () => {
    it("brings a ball at rest to its target, exactly, and says so, in about a second", () => {
      const m = motion();
      const path = steer(m, { x: 100, y: 50 }, true);
      expect(m).toMatchObject({ x: 100, y: 50, vx: 0, vy: 0 });
      expect(m.t).toBeGreaterThan(0.5);
      expect(m.t).toBeLessThan(1.5);
      for (const point of path) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(100 + 1e-9);
      }
    });

    it("returns `false` until the ball has come to rest at its target", () => {
      const m = motion();
      expect(steerStep(m, { x: 100, y: 50 }, true)).toBe(false);
      expect(m.x).toBeGreaterThan(0);
      expect(m.x).toBeLessThan(100);
      expect(m.t).toBe(FLIGHT_STEP);
    });

    it("keeps a falling ball that is not supported falling a moment before it turns", () => {
      const target = { x: 100, y: -100 };
      const unsupported = steer(motion({ vy: 300 }), target, false);
      const supported = steer(motion({ vy: 300 }), target, true);
      const lowest = (path: { y: number }[]) => maxOf(path.map((point) => point.y));
      expect(lowest(unsupported)).toBeGreaterThan(lowest(supported) + 5);
      expect(unsupported[unsupported.length - 1]).toEqual(target);
    });

    it("lets gravity pull down a ball at rest only when it is not supported", () => {
      const target = { x: 0, y: -100 };
      const unsupported = steer(motion(), target, false);
      const supported = steer(motion(), target, true);
      expect(maxOf(unsupported.map((point) => point.y))).toBeGreaterThan(1);
      expect(maxOf(supported.map((point) => point.y))).toBe(0);
    });

    it("puts the ball on its target after three seconds however far it has to go", () => {
      const m = motion();
      const target = { x: 1e15, y: 0 };
      const path = steer(m, target, true);
      expect(m.t).toBeGreaterThanOrEqual(3);
      expect(m.t).toBeLessThan(3 + 2 * FLIGHT_STEP);
      expect(path[path.length - 1]).toEqual(target);
    });
  });

  describe("startLeaving()", () => {
    it("restarts the ball's clock and says how it leaves", () => {
      const m = motion({ x: 200, y: 300, t: 5 });
      const leaving = startLeaving(m, 12, "neither", 800, 500, 0, 800);
      expect(m.t).toBe(0);
      expect(leaving).toEqual({
        outcome: "neither",
        diameter: 12,
        pause: LEAVE * 0.35,
        thrownX: 0,
        thrownY: 0,
        width: 800,
        floor: 500,
        lineLeft: 0,
        lineRight: 800,
        hit: false,
      });
    });

    it("throws a failed ball harder to the right than a passed one", () => {
      const passed = startLeaving(motion({ x: 200, y: 300 }), 12, "passed", 800, 500, 0, 800);
      const failed = startLeaving(motion({ x: 200, y: 300 }), 12, "failed", 800, 500, 0, 800);
      expect(passed.thrownX).toBeGreaterThan(0);
      expect(passed.thrownY).toBeLessThan(0);
      expect(failed.thrownX).toBeGreaterThan(passed.thrownX);
      expect(failed.thrownY).toBe(-420);
    });
  });

  describe("leaveStep()", () => {
    it("slows the ball to a stop where it is before it goes", () => {
      const m = motion({ x: 200, y: 300, vx: 100, vy: -50 });
      const leaving = startLeaving(m, 12, "passed", 800, 500, 0, 800);
      while (m.t + FLIGHT_STEP < leaving.pause) expect(leaveStep(m, leaving)).toBe(false);
      expect(Math.hypot(m.vx, m.vy)).toBeLessThan(2);
      expect(Math.hypot(m.x - 200, m.y - 300)).toBeLessThan(15);
    });

    it("throws a passed ball off the right of the board, a little lower than it was", () => {
      const m = motion({ x: 200, y: 300 });
      const path = leave(m, startLeaving(m, 12, "passed", 800, 500, 0, 800));
      expect(m.x).toBeGreaterThan(812);
      expect(m.y).toBeGreaterThan(300);
      expect(m.y).toBeLessThan(400);
      expect(minOf(path.map((point) => point.y))).toBeLessThan(300);
      expect(m.t).toBeLessThan(LEAVE * 0.35 + 1);
    });

    it("throws a failed ball against the right side, then slides it along the line and off its left end", () => {
      const m = motion({ x: 200, y: 300 });
      const leaving = startLeaving(m, 12, "failed", 800, 500, 100, 800);
      const path = leave(m, leaving);
      expect(leaving.hit).toBe(true);
      expect(maxOf(path.map((point) => point.x))).toBe(794);
      expect(path.some((point) => point.y === 494 && point.vy < 0)).toBe(true);
      const onLine = path.filter((point) => point.y === 494);
      expect(minOf(onLine.map((point) => point.x))).toBeGreaterThanOrEqual(100 - 1);
      expect(m.x).toBeLessThan(100);
      expect(m.x).toBeGreaterThan(-12 - 1);
      expect(m.y).toBeGreaterThan(500);
    });

    it("lets a failed ball that lands past the line's right end fall", () => {
      const m = motion({ x: 200, y: 300 });
      const leaving = startLeaving(m, 12, "failed", 800, 500, 100, 700);
      const path = leave(m, leaving);
      expect(leaving.hit).toBe(true);
      expect(path.some((point) => point.y === 494)).toBe(false);
      expect(path.find((point) => point.y > 494)?.x).toBeGreaterThan(700);
      expect(m.y).toBeGreaterThan(900);
    });

    it("slides a failed ball off the left of the board when the line reaches past it", () => {
      const m = motion({ x: 200, y: 300 });
      leave(m, startLeaving(m, 12, "failed", 800, 500, -100, 800));
      expect(m.x).toBeLessThan(-12);
      expect(m.y).toBe(494);
    });

    it("raises a ball that neither passed nor failed off the top, ever faster", () => {
      const m = motion({ x: 200, y: 300 });
      const leaving = startLeaving(m, 12, "neither", 800, 500, 0, 800);
      const path = leave(m, leaving);
      expect(m.y).toBeLessThan(-24);
      expect(Math.abs(m.x - 200)).toBeLessThan(1);
      const rising = path.filter((point) => point.t > leaving.pause + FLIGHT_STEP);
      for (let i = 1; i < rising.length; i++) expect(rising[i].vy).toBeLessThan(rising[i - 1].vy);
    });

    it("gives up on a ball that has not gone after four seconds and a fortieth of a second a pixel across", () => {
      const m = motion({ x: 200, y: 10_000 });
      const leaving = startLeaving(m, 12, "neither", 400, 20_000, 0, 400);
      leave(m, leaving);
      expect(m.y).toBeGreaterThan(0);
      expect(m.t).toBeGreaterThan(leaving.pause + 4 + 400 / 40);
      expect(m.t).toBeLessThan(leaving.pause + 4 + 400 / 40 + 2 * FLIGHT_STEP);
    });
  });
});
