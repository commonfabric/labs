import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  assertNoReaderDrift,
  assertNoTriggerDrift,
  compareRowPaths,
  createTriggerReference,
  EntityTriggers,
  resetTriggerScanWork,
  triggerEquivalenceEnabled,
  triggerScanWork,
} from "../../src/scheduler/entity-triggers.ts";
import {
  arraysOverlap,
  comparePaths,
} from "../../src/reactive-dependencies.ts";
import type { Action } from "../../src/scheduler/types.ts";

type Path = readonly string[];

/** An action that does nothing, named so a failure says which one it was. */
function reader(name: string): Action {
  return ({ [name]: () => {} })[name]!;
}

/** A xorshift generator over `[0, 1)`, so a seed reproduces its run exactly. */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

/** `paths` in ascending order with each path once. */
function ascending(paths: readonly Path[]): Path[] {
  return [...paths].sort(comparePaths).filter((path, at, sorted) =>
    at === 0 || comparePaths(sorted[at - 1]!, path) !== 0
  );
}

/** How a seeded run of registrations and removals is shaped. */
interface DefinitionRun {
  /** The index under test, made fresh for each seed. */
  readonly create: () => EntityTriggers;

  /** How many actions the run registers and removes among. */
  readonly actions: number;

  /** Whether one list in eight repeats a path or comes out of order. */
  readonly malformed: boolean;
}

/**
 * Drives `run` through `steps` seeded registrations and removals and, after
 * each one, compares what the index returns for a set of writes against what
 * the overlap definition says of a plain model of every action's reads.
 *
 * The writes probed are the root, every registered path, its parent, a child
 * no read names, and four paths drawn at random. Throws naming the seed, the
 * step and the write at the first disagreement.
 */
function compareWithDefinition(
  seed: number,
  steps: number,
  run: DefinitionRun,
): void {
  const random = seeded(seed);
  const alphabet = ["value", "a", "b", "a/b", "", "10", "9"];
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)]!;
  const randomPath = (): Path =>
    Array.from({ length: Math.floor(random() * 4) }, () => pick(alphabet));
  const actions = Array.from(
    { length: run.actions },
    (_, index) => reader(`reader-${index}`),
  );
  const model = new Map<Action, Path[]>();
  const triggers = run.create();
  const where = (step: number, writePath: Path) =>
    `seed ${seed} step ${step} write ${JSON.stringify(writePath)}`;

  for (let step = 0; step < steps; step++) {
    const action = pick(actions);
    if (random() < 0.2) {
      model.delete(action);
      triggers.delete(action);
    } else {
      const drawn = Array.from(
        { length: 1 + Math.floor(random() * 6) },
        randomPath,
      );
      const next = ascending(drawn);
      let list = next;
      if (run.malformed && random() < 0.125) {
        list = random() < 0.5 ? [...drawn, drawn[0]!] : drawn.toReversed();
      }
      model.set(action, next);
      triggers.set(action, list);
    }

    expect(triggers.size, `seed ${seed} step ${step}: size`).toBe(model.size);
    const probes = new Map<string, Path>();
    const probe = (path: Path) => probes.set(JSON.stringify(path), path);
    for (const path of [[], randomPath(), randomPath()]) probe(path);
    for (const path of [randomPath(), randomPath()]) probe(path);
    for (const paths of model.values()) {
      for (const path of paths) {
        probe(path);
        probe(path.slice(0, -1));
        probe([...path, "absent"]);
      }
    }
    const keys = new Map<Path, string>();
    for (const paths of model.values()) {
      for (const path of paths) keys.set(path, JSON.stringify(path));
    }
    const keyOf = (path: Path) => keys.get(path) ?? JSON.stringify(path);
    for (const writePath of probes.values()) {
      // Compared as text first, since an expectation per probe would cost
      // more than the run itself; a difference is then handed to `expect()`
      // for its account of what differs.
      const expected: Record<string, string[]> = {};
      for (const [action, paths] of model) {
        const reached: string[] = [];
        for (const path of paths) {
          if (arraysOverlap(path, writePath)) reached.push(keys.get(path)!);
        }
        if (reached.length > 0) expected[action.name] = reached;
      }
      const answered: Record<string, string[]> = {};
      for (const [action, paths] of triggers.matching(writePath)) {
        answered[action.name] = paths.map(keyOf);
      }
      if (canonical(answered) !== canonical(expected)) {
        expect(answered, where(step, writePath)).toEqual(expected);
      }

      const visited: string[] = [];
      triggers.forEachMatching(writePath, (path, action) => {
        visited.push(`${action.name} ${keyOf(path)}`);
      });
      const pairs = Object.entries(expected).flatMap(([name, paths]) =>
        paths.map((path) => `${name} ${path}`)
      );
      visited.sort();
      pairs.sort();
      if (visited.join("\n") !== pairs.join("\n")) {
        expect(visited, where(step, writePath)).toEqual(pairs);
      }
    }
  }
}

/** `groups` as text that two equal groupings share whatever their key order. */
function canonical(groups: Record<string, string[]>): string {
  return JSON.stringify(
    Object.entries(groups).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  );
}

/** What `matching()` returned, as plain data an expectation can name. */
function matched(
  triggers: EntityTriggers,
  writePath: readonly string[],
): Record<string, string[][]> {
  const result: Record<string, string[][]> = {};
  for (const [action, paths] of triggers.matching(writePath)) {
    result[action.name] = paths.map((path) => [...path]);
  }
  return result;
}

describe("EntityTriggers", () => {
  describe("instance members", () => {
    describe("matching()", () => {
      it("returns a read at the written path", () => {
        const triggers = new EntityTriggers();
        triggers.set(reader("exact"), [["value", "a"]]);
        expect(matched(triggers, ["value", "a"])).toEqual({
          exact: [["value", "a"]],
        });
      });

      it("returns a read above the written path", () => {
        const triggers = new EntityTriggers();
        triggers.set(reader("whole"), [[]]);
        triggers.set(reader("above"), [["value"]]);
        expect(matched(triggers, ["value", "a", "b"])).toEqual({
          whole: [[]],
          above: [["value"]],
        });
      });

      it("returns a read below the written path", () => {
        const triggers = new EntityTriggers();
        triggers.set(reader("below"), [["value", "a", "b"]]);
        expect(matched(triggers, ["value", "a"])).toEqual({
          below: [["value", "a", "b"]],
        });
      });

      it("omits a read on a sibling of the written path", () => {
        const triggers = new EntityTriggers();
        triggers.set(reader("sibling"), [["value", "b"]]);
        triggers.set(reader("cousin"), [["other", "a"]]);
        expect(matched(triggers, ["value", "a"])).toEqual({});
      });

      it("returns every read for a write at the document root", () => {
        const triggers = new EntityTriggers();
        triggers.set(reader("first"), [["value", "a"]]);
        triggers.set(reader("second"), [["other"]]);
        expect(matched(triggers, [])).toEqual({
          first: [["value", "a"]],
          second: [["other"]],
        });
      });

      it("returns an action's matching paths in ascending path order", () => {
        // Registered out of order, so that the order of the answer has to
        // come from `set()` putting the list in order and from the row
        // holding it so, not from the list as handed over. Ascending order is
        // what `determineTriggeredActions()` reads its groups in.

        const triggers = new EntityTriggers();
        triggers.set(reader("several"), [
          ["value", "b", "y"],
          ["value", "a", "x"],
          ["value"],
          ["value", "b"],
        ]);
        expect(matched(triggers, ["value", "b"])).toEqual({
          several: [["value"], ["value", "b"], ["value", "b", "y"]],
        });
      });

      it("returns every action registered on one path", () => {
        const triggers = new EntityTriggers();
        triggers.set(reader("first"), [["value", "a"]]);
        triggers.set(reader("second"), [["value", "a"]]);
        expect(matched(triggers, ["value", "a"])).toEqual({
          first: [["value", "a"]],
          second: [["value", "a"]],
        });
      });

      it("agrees with the overlap predicate over a mixed registration", () => {
        // The index prunes what a write has to consider, and the predicate
        // decides. Drift between the two is a dropped trigger, so this walks
        // every registered path against every written path and compares.

        const paths = [
          [],
          ["value"],
          ["value", "a"],
          ["value", "a", "b"],
          ["value", "a", "c"],
          ["value", "ab"],
          ["value", "b"],
          ["other"],
        ];
        const triggers = new EntityTriggers();
        for (const path of paths) {
          triggers.set(reader(path.join("/")), [path]);
        }
        for (const writePath of paths) {
          const expected = paths
            .filter((path) => arraysOverlap(path, writePath))
            .map((path) => path.join("/"))
            .sort();
          expect(Object.keys(matched(triggers, writePath)).sort()).toEqual(
            expected,
          );
        }
      });

      it("visits a number of paths set by the written path, not by the readership", () => {
        const small = new EntityTriggers();
        const large = new EntityTriggers();
        for (let i = 0; i < 16; i++) {
          small.set(reader(`small-${i}`), [["value", `member-${i}`]]);
        }
        for (let i = 0; i < 1024; i++) {
          large.set(reader(`large-${i}`), [["value", `member-${i}`]]);
        }

        resetTriggerScanWork();
        small.matching(["value", "member-8"]);
        const smallVisits = triggerScanWork.pathsVisited;
        resetTriggerScanWork();
        large.matching(["value", "member-8"]);
        expect(triggerScanWork.pathsVisited).toBe(smallVisits);
      });
    });

    describe("set()", () => {
      it("checks a broad registration without comparing every pair of reads", () => {
        expect(triggerEquivalenceEnabled((name) => Deno.env.get(name))).toBe(
          true,
        );
        const count = 1024;
        let componentReads = 0;
        const paths = Array.from(
          { length: count },
          (_, index) =>
            new Proxy(["value", `member-${index}`], {
              get(target, property, receiver) {
                if (property === "0" || property === "1") componentReads++;
                return Reflect.get(target, property, receiver);
              },
            }),
        );
        const triggers = new EntityTriggers();
        triggers.set(reader("broad"), paths);

        // Count comparisons through the paths instead of elapsed time. A full
        // scan for each moved path reads over a million components here.
        expect(componentReads).toBeLessThan(count * 512);
        expect(matched(triggers, ["value", "member-8"])).toEqual({
          broad: [["value", "member-8"]],
        });
      });

      it("replaces what the action read before", () => {
        const triggers = new EntityTriggers();
        const action = reader("moved");
        triggers.set(action, [["value", "a"]]);
        triggers.set(action, [["value", "b"]]);
        expect(matched(triggers, ["value", "a"])).toEqual({});
        expect(matched(triggers, ["value", "b"])).toEqual({
          moved: [["value", "b"]],
        });
      });

      it("counts one action however many times it registers", () => {
        const triggers = new EntityTriggers();
        const action = reader("repeat");
        triggers.set(action, [["value", "a"]]);
        triggers.set(action, [["value", "a"]]);
        expect(triggers.size).toBe(1);
      });

      it("holds a path a list names twice once, and removes it once", () => {
        const triggers = new EntityTriggers();
        const action = reader("twice");
        triggers.set(action, [["value"], ["value"]]);
        expect(matched(triggers, ["value"])).toEqual({ twice: [["value"]] });

        triggers.set(action, [["other"]]);
        expect(matched(triggers, ["value"])).toEqual({});
        expect(matched(triggers, ["other"])).toEqual({ twice: [["other"]] });
      });

      it("hands an action each path once when its list repeats a path out of order", () => {
        const triggers = new EntityTriggers();
        triggers.set(reader("unordered"), [["b"], ["a"], ["b"]]);
        expect(matched(triggers, [])).toEqual({ unordered: [["a"], ["b"]] });

        const visited: string[] = [];
        triggers.forEachMatching([], (path, action) => {
          visited.push(`${action.name} ${JSON.stringify(path)}`);
        });
        expect(visited).toEqual(['unordered ["a"]', 'unordered ["b"]']);
      });

      it("treats an empty list as a removal", () => {
        const triggers = new EntityTriggers();
        const action = reader("emptied");
        triggers.set(action, [["value", "a"]]);
        triggers.set(action, []);
        expect(triggers.size).toBe(0);
        expect(matched(triggers, [])).toEqual({});
      });

      it("rejects a path component that is not a string while the check runs", () => {
        expect(triggerEquivalenceEnabled((name) => Deno.env.get(name))).toBe(
          true,
        );
        const triggers = new EntityTriggers();
        expect(() =>
          triggers.set(reader("numbered"), [
            ["value", 9 as unknown as string],
          ])
        ).toThrow('Read path `["value",9]` holds a component');
        expect(triggers.size).toBe(0);
      });

      it("finds every path of a first registration longer than one block", () => {
        const triggers = new EntityTriggers();
        const paths = Array.from(
          { length: 600 },
          (_, index) => ["value", `member-${String(index).padStart(4, "0")}`],
        );
        triggers.set(reader("long"), paths);
        expect(matched(triggers, [])).toEqual({ long: paths });
        expect(matched(triggers, ["value", "member-0300"])).toEqual({
          long: [["value", "member-0300"]],
        });

        triggers.set(reader("beside"), [["value", "member-0300"]]);
        expect(matched(triggers, ["value", "member-0300"])).toEqual({
          long: [["value", "member-0300"]],
          beside: [["value", "member-0300"]],
        });
        expect(Object.keys(matched(triggers, ["value", "member-0299"])))
          .toEqual(["long"]);
      });
    });

    describe("finding what an action read before", () => {
      it("finds an action's earlier reads without scanning the row once it holds many paths", () => {
        const triggers = new EntityTriggers();
        triggers.set(
          reader("many"),
          Array.from(
            { length: 1024 },
            (_, index) => ["value", `member-${String(index).padStart(4, "0")}`],
          ),
        );
        const small = Array.from({ length: 7 }, (_, k) => reader(`small-${k}`));
        for (const action of small) triggers.set(action, [["value", "count"]]);

        resetTriggerScanWork();
        for (let k = 0; k < 2000; k++) {
          triggers.set(
            small[k % 7]!,
            k % 2 === 0 ? [["value", "zcount"]] : [["value", "count"]],
          );
        }
        expect(triggerScanWork.rowScanEntries).toBe(0);
      });

      it("scans the row of a document few actions read", () => {
        const triggers = new EntityTriggers();
        const first = reader("first");
        triggers.set(first, [["value", "a"]]);
        triggers.set(reader("second"), [["value", "b"]]);
        triggers.set(reader("third"), [["value", "c"]]);

        resetTriggerScanWork();
        triggers.set(first, [["value", "d"]]);
        expect(triggerScanWork.rowScanEntries).toBeGreaterThan(0);
      });
    });

    describe("delete()", () => {
      it("removes every path the action read", () => {
        const triggers = new EntityTriggers();
        const action = reader("gone");
        triggers.set(action, [["value", "a"], ["value", "b"]]);
        triggers.delete(action);
        expect(triggers.size).toBe(0);
        expect(matched(triggers, ["value", "a"])).toEqual({});
        expect(matched(triggers, ["value", "b"])).toEqual({});
      });

      it("leaves a path another action still reads", () => {
        const triggers = new EntityTriggers();
        const gone = reader("gone");
        const stays = reader("stays");
        triggers.set(gone, [["value", "a"]]);
        triggers.set(stays, [["value", "a"]]);
        triggers.delete(gone);
        expect(matched(triggers, ["value", "a"])).toEqual({
          stays: [["value", "a"]],
        });
      });

      it("visits no more of the index than an empty one once every action is gone", () => {
        const triggers = new EntityTriggers();
        const empty = new EntityTriggers();
        for (let i = 0; i < 64; i++) {
          const action = reader(`member-${i}`);
          triggers.set(action, [["value", `member-${i}`]]);
          triggers.delete(action);
        }

        resetTriggerScanWork();
        empty.matching(["value", "member-8"]);
        const emptyVisits = triggerScanWork.pathsVisited;
        resetTriggerScanWork();
        triggers.matching(["value", "member-8"]);
        expect(triggerScanWork.pathsVisited).toBe(emptyVisits);
      });

      it("leaves another action's read when a list that named a path twice is removed", () => {
        const triggers = new EntityTriggers();
        const gone = reader("gone");
        const stays = reader("stays");
        triggers.set(stays, [["value"]]);
        triggers.set(gone, [["value"], ["value"]]);
        triggers.set(gone, [["other"]]);
        triggers.delete(gone);
        expect(matched(triggers, ["value"])).toEqual({ stays: [["value"]] });
        expect(triggers.size).toBe(1);
      });

      it("leaves `size` unchanged for an action it does not hold", () => {
        const triggers = new EntityTriggers();
        triggers.set(reader("present"), [["value", "a"]]);
        triggers.delete(reader("absent"));
        expect(triggers.size).toBe(1);
      });
    });

    describe("size", () => {
      it("returns the number of actions registered", () => {
        const triggers = new EntityTriggers();
        expect(triggers.size).toBe(0);
        triggers.set(reader("first"), [["value", "a"]]);
        triggers.set(reader("second"), [["value", "b"]]);
        expect(triggers.size).toBe(2);
      });
    });
  });

  describe("registering the same reads again", () => {
    it("leaves the index untouched when handed back the same list", () => {
      const triggers = new EntityTriggers();
      const action = reader("same-list");
      const paths = [["value", "count"]];
      triggers.set(action, paths);
      triggers.set(action, paths);

      expect(matched(triggers, ["value", "count"])).toEqual({
        "same-list": [["value", "count"]],
      });
    });
  });

  describe("against the overlap definition", () => {
    // A write reaches exactly the reads it overlaps, so every answer the
    // index gives is checked against `arraysOverlap()` over a plain record of
    // each action's reads, after every step of a seeded run.

    it("agrees with the definition at production limits, seeds 1 to 40", () => {
      for (let seed = 1; seed <= 40; seed++) {
        compareWithDefinition(seed, 60, {
          create: () => new EntityTriggers(),
          actions: 12,
          malformed: true,
        });
      }
    });

    it("agrees with the definition at limits a handful of reads crosses, seeds 1001 to 1040", () => {
      // Limits this small put a first registration of up to six paths past a
      // block, and reach splits, merges, the return to one inline row, readers
      // held in a set, and the per-action map being built and dropped.

      for (let seed = 1001; seed <= 1040; seed++) {
        compareWithDefinition(seed, 60, {
          create: () =>
            new EntityTriggers({
              readersInArray: 2,
              actionsWithoutMap: 2,
              rowWithoutMap: 3,
              block: 4,
            }),
          actions: 40,
          malformed: true,
        });
      }
    });

    it("agrees with the definition at limits that merge one block into the next, seeds 2001 to 2020", () => {
      // A block merges into its neighbor when compacting leaves it with
      // fewer than a quarter of `block` entries, which a block of four never
      // holds and a block of eight does.

      for (let seed = 2001; seed <= 2020; seed++) {
        compareWithDefinition(seed, 60, {
          create: () =>
            new EntityTriggers({
              readersInArray: 2,
              actionsWithoutMap: 2,
              rowWithoutMap: 3,
              block: 8,
            }),
          actions: 40,
          malformed: true,
        });
      }
    });
  });

  describe("compareRowPaths()", () => {
    it("orders a number component apart from a string", () => {
      // `comparePaths()` returns 1 both ways for a number against a string
      // that does not read as a number, and for `9` against `"9"`.

      const nine = [9] as unknown as Path;
      for (const other of [["9"], ["10"], ["value"]]) {
        const forward = compareRowPaths(nine, other);
        expect(forward).not.toBe(0);
        expect(Math.sign(compareRowPaths(other, nine))).toBe(
          -Math.sign(forward),
        );
      }
    });

    it("agrees with comparePaths on string paths", () => {
      const alphabet = ["value", "a", "b", "a/b", "", "10", "9"];
      const paths: Path[] = [[]];
      for (let length = 1; length <= 3; length++) {
        for (const path of paths.filter((path) => path.length === length - 1)) {
          for (const component of alphabet) paths.push([...path, component]);
        }
      }
      const disagreements = paths.flatMap((a) =>
        paths.filter((b) =>
          Math.sign(compareRowPaths(a, b)) !== Math.sign(comparePaths(a, b))
        ).map((b) => `${JSON.stringify(a)} ${JSON.stringify(b)}`)
      );
      expect(paths.length).toBe(400);
      expect(disagreements).toEqual([]);
    });
  });

  describe("createTriggerReference()", () => {
    it("agrees with a full overlap scan for prefixes, extensions, and absent paths", () => {
      const registered = [
        ["value", "b", "child"],
        ["a/b"],
        ["value"],
        ["value", "a"],
        ["value", "ab"],
        [],
        ["value", "b"],
        ["value", "b"],
        ["a", "b"],
        [""],
        ["\u{1f369}", "glaze"],
        ["\u{e000}"],
      ];
      const writes = [
        ...registered,
        ["value", "a", "absent"],
        ["value", "b", "absent"],
        ["value", "between"],
        ["absent"],
        ["z"],
        ["\u{1f369}"],
        ["\u{e000}", "absent"],
      ];
      const reference = createTriggerReference(registered);
      for (const writePath of writes) {
        const expected = new Set(
          registered.filter((path) => arraysOverlap(path, writePath))
            .map((path) => JSON.stringify(path)),
        );
        expect(
          new Set(
            [...reference(writePath)].map((path) => JSON.stringify(path)),
          ),
        ).toEqual(expected);
      }
    });

    it("returns no paths from an empty registration", () => {
      const reference = createTriggerReference([]);
      expect([...reference([])]).toEqual([]);
      expect([...reference(["value"])]).toEqual([]);
    });

    it("preserves drift detection for an incomplete or excessive index result", () => {
      const registered = [["value", "a"], ["value", "b"], ["other"]];
      const reference = createTriggerReference(registered);
      expect(() =>
        assertNoTriggerDrift([], reference(["value", "a"]), ["value", "a"])
      ).toThrow('Trigger index drift for write ["value","a"]: ["value","a"]');
      expect(() =>
        assertNoTriggerDrift(
          [["value", "a"], ["value", "b"]],
          reference(["value", "a"]),
          ["value", "a"],
        )
      ).toThrow('Trigger index drift for write ["value","a"]: ["value","b"]');
    });
  });

  describe("assertNoTriggerDrift()", () => {
    it("accepts an answer holding exactly the reads the write overlaps", () => {
      const registered = [["value", "a"], ["value", "b"], ["other"]];
      expect(() =>
        assertNoTriggerDrift([["value", "a"]], registered, ["value", "a"])
      ).not.toThrow();
    });

    it("names a read the answer left out", () => {
      const registered = [["value", "a"]];
      expect(() => assertNoTriggerDrift([], registered, ["value", "a"]))
        .toThrow('Trigger index drift for write ["value","a"]: ["value","a"]');
    });

    it("names a read the answer invented", () => {
      expect(() => assertNoTriggerDrift([["value", "a"]], [], ["value", "a"]))
        .toThrow('Trigger index drift for write ["value","a"]: ["value","a"]');
    });

    it("tells a component holding a separator from two components", () => {
      // `["a/b"]` and `["a", "b"]` are different reads, and a write to one
      // reaches neither the other nor anything below it.
      expect(() => assertNoTriggerDrift([["a/b"]], [["a", "b"]], ["a/b"]))
        .toThrow('Trigger index drift for write ["a/b"]: ["a/b"]');
    });
  });

  describe("assertNoReaderDrift()", () => {
    const first = reader("first");
    const second = reader("second");

    it("accepts an answer holding each read the write overlaps once", () => {
      const registered = [
        { action: first, path: ["value", "a"] },
        { action: second, path: ["value", "a"] },
        { action: first, path: ["other"] },
      ];
      expect(() =>
        assertNoReaderDrift(registered.slice(0, 2), registered, ["value"])
      ).not.toThrow();
    });

    it("names a read the answer left out", () => {
      expect(() =>
        assertNoReaderDrift([], [{ action: first, path: ["value"] }], [
          "value",
        ])
      ).toThrow(
        'Trigger reader drift for write ["value"]: missing first at ["value"]',
      );
    });

    it("names a read the answer invented", () => {
      expect(() =>
        assertNoReaderDrift([{ action: first, path: ["value"] }], [], [
          "value",
        ])
      ).toThrow(
        'Trigger reader drift for write ["value"]: extra first at ["value"]',
      );
    });

    it("names a read the answer handed over twice", () => {
      const read = { action: first, path: ["value"] };
      expect(() => assertNoReaderDrift([read, read], [read], ["value"]))
        .toThrow(
          'Trigger reader drift for write ["value"]: first at ["value"] 2 times',
        );
    });

    it("tells two actions reading one path apart", () => {
      expect(() =>
        assertNoReaderDrift(
          [{ action: second, path: ["value"] }],
          [{ action: first, path: ["value"] }],
          ["value"],
        )
      ).toThrow(
        'Trigger reader drift for write ["value"]: extra second at ["value"], missing first at ["value"]',
      );
    });
  });

  describe("triggerEquivalenceEnabled()", () => {
    it("runs the check under a test environment and nowhere else", () => {
      expect(triggerEquivalenceEnabled(() => "test")).toBe(true);
      expect(triggerEquivalenceEnabled(() => "production")).toBe(false);
      expect(triggerEquivalenceEnabled(() => undefined)).toBe(false);
    });

    it("stays off when the environment cannot be read", () => {
      expect(triggerEquivalenceEnabled(() => {
        throw new Deno.errors.NotCapable("requires env access");
      })).toBe(false);
    });
  });
});
