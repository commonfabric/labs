import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../exec/executor.ts";
import { generateInputs } from "../generate.ts";
import { scenarioAudience } from "../harness.ts";
import { instanceOptions, inStorage } from "../integrated.ts";
import { perturbedRuns, sentEvents } from "../perturbation.ts";
import {
  checkSoundness,
  deepStoredAt,
  type LabelPlan,
  type Soundness,
  soundnessOf,
  soundnessOfScenario,
} from "../stored-labels.ts";
import type { Atom, Label } from "../template.ts";
import { fixtureScenarios } from "../values-fixtures.ts";

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === "default") ??
    patterns[patterns.length - 1];
};

/** The findings of a check, each as one line. */
const lines = (name: string, soundness: Soundness | undefined): string[] =>
  (soundness?.failures ?? []).map(({ kind, path, input }) =>
    `${name}: ${kind} ${path} depends on ${input}`
  );

describe("stored-labels", () => {
  // The lower bound of the stored labels that reads no write record: a
  // value that differs when one labeled input alone is changed stores the
  // clause of that input.
  describe("soundnessOfScenario()", () => {
    it("finds the clause of each labeled input in the stored label of every value of a fixture that depends on it", async () => {
      const found: string[] = [];
      let dependent = 0;
      for (const scenario of await fixtureScenarios()) {
        const name = `${scenario.fixture} (${scenario.scenario})`;
        const { soundness } = await soundnessOfScenario(
          name,
          scenario.artifact,
          scenario.artifacts,
          scenario.argument,
          scenario.events,
        );
        dependent += soundness?.dependent ?? 0;
        for (const line of lines(name, soundness)) found.push(line);
      }

      expect(found).toEqual([]);
      expect(dependent).toBeGreaterThan(300);
    });

    it("finds it with the events of each fixture sent three times, each time with other values", async () => {
      const found: string[] = [];
      let dependent = 0;
      for (const scenario of await fixtureScenarios()) {
        if (scenario.events.length === 0) continue;
        const name = `${scenario.fixture} (${scenario.scenario})`;
        const { soundness } = await soundnessOfScenario(
          name,
          scenario.artifact,
          scenario.artifacts,
          scenario.argument,
          scenario.events,
          true,
        );
        dependent += soundness?.dependent ?? 0;
        for (const line of lines(name, soundness)) found.push(line);
      }

      expect(found).toEqual([]);
      expect(dependent).toBeGreaterThan(100);
    });

    it("finds the user atom of the seeded profile in the stored label of every value of `wish-home` that depends on the profile", async () => {
      const { soundness, refused } = await soundnessOfScenario(
        "wish-home",
        await artifactOf("wish-home"),
        () => undefined,
        { note: "n" },
        [],
      );

      expect(refused).toEqual([]);
      expect(soundness?.skipped).toBeUndefined();
      expect(soundness?.sources).toEqual(["note", "the seeded profile"]);
      expect(lines("wish-home", soundness)).toEqual([]);
      // `greeting`, `about` and `profile` read the profile, and `note` the
      // input.
      expect(soundness?.dependent).toBeGreaterThanOrEqual(4);
    });
  });

  describe("soundnessOfScenario() on a fixture whose commits were refused", () => {
    /** The refusals and the findings of each scenario of a fixture. */
    const ran = async (fixture: string, repeated = false) => {
      const refusals: string[] = [];
      const found: string[] = [];
      let dependent = 0;
      for (const scenario of await fixtureScenarios(fixture)) {
        const name = `${scenario.fixture} (${scenario.scenario})`;
        const { soundness, refused } = await soundnessOfScenario(
          name,
          scenario.artifact,
          scenario.artifacts,
          scenario.argument,
          scenario.events,
          repeated,
        );
        for (const reason of refused) {
          refusals.push(reason.slice(reason.lastIndexOf(": ") + 2));
        }
        for (const line of lines(name, soundness)) found.push(line);
        dependent += soundness?.dependent ?? 0;
      }
      return { refusals, found, dependent };
    };

    // The index of an element, in an output and in the state of a handler
    // bound once per element, depends on the order of the collection's
    // source and is at no stored position.
    it("commits every transaction of `index-nodes`, and stores the clause of the array for a value that reads an index", async () => {
      const { refusals, found, dependent } = await ran("index-nodes");

      expect(refusals).toEqual([]);
      expect(found).toEqual([]);
      expect(dependent).toBeGreaterThan(0);
    });

    // A handler writes a member of a record that an input's array holds in
    // place, a second time: the document then stores an envelope that
    // spells the input as an array.
    it("commits every transaction of `value-identity` with its events sent three times, whose handlers write below a member of an array of an input", async () => {
      const { refusals, found } = await ran("value-identity", true);

      expect(refusals).toEqual([]);
      expect(found).toEqual([]);
    });

    // A handler that reads a list and then writes one of its records reads
    // its own target before the write.
    it("commits every transaction of `keyed`, whose handler writes a record it read through the list that holds it", async () => {
      const { refusals, found } = await ran("keyed");

      expect(refusals).toEqual([]);
      expect(found).toEqual([]);
    });
  });

  // `fixtures/remove-shift.tsx`: a word pushed from the event, the input
  // `note` pushed after it, and the removal of the first, which reads the
  // list to find it and removes it in place.
  describe("soundnessOfScenario() after a removal from a list of plain values in place", () => {
    it("finds the clause of the input in the stored label of the list that holds its value at another position", async () => {
      const { soundness, refused } = await soundnessOfScenario(
        "remove-shift",
        await artifactOf("remove-shift"),
        () => undefined,
        { note: "n" },
        [
          { binding: 1, event: { word: "x" } },
          { binding: 0, event: {} },
          { binding: 2, event: { word: "x" } },
        ],
      );

      expect(refused).toEqual([]);
      expect(lines("remove-shift", soundness)).toEqual([]);
      expect(soundness?.dependent).toBeGreaterThanOrEqual(1);
    });
  });

  // A list of plain values in place that handlers add to and remove from,
  // each scenario with an event after the one whose write the input `note`
  // decides: the later write reads nothing that carries the clause of
  // `note`, and the list still holds what the earlier one put there.
  describe("soundnessOfScenario() after several changes of the members of a list of plain values in place", () => {
    const check = async (
      fixture: string,
      argument: Record<string, unknown>,
      events: { binding: number; event: unknown }[],
    ) => {
      const { soundness, refused } = await soundnessOfScenario(
        fixture,
        await artifactOf(fixture),
        () => undefined,
        argument,
        events,
      );
      return {
        refused,
        found: lines(fixture, soundness),
        dependent: soundness?.dependent ?? 0,
      };
    };

    it("finds the clause of the input in the stored label of a list that a later push added to", async () => {
      const { refused, found, dependent } = await check(
        "remove-shift",
        { note: "n" },
        [
          { binding: 1, event: { word: "x" } },
          { binding: 0, event: {} },
          { binding: 1, event: { word: "y" } },
        ],
      );

      expect(refused).toEqual([]);
      expect(found).toEqual([]);
      expect(dependent).toBeGreaterThanOrEqual(1);
    });

    it("finds it after a removal moved the value of the input and a later push added to the list", async () => {
      const { refused, found, dependent } = await check(
        "remove-shift",
        { note: "n" },
        [
          { binding: 1, event: { word: "x" } },
          { binding: 0, event: {} },
          { binding: 1, event: { word: "y" } },
          { binding: 2, event: { word: "x" } },
          { binding: 1, event: { word: "z" } },
        ],
      );

      expect(refused).toEqual([]);
      expect(found).toEqual([]);
      expect(dependent).toBeGreaterThanOrEqual(1);
    });

    it("finds it in the stored label of the number of members, after a push the input decided and one it did not", async () => {
      const { refused, found, dependent } = await check(
        "count-after-change",
        { note: "n" },
        [
          { binding: 0, event: { word: "x" } },
          { binding: 1, event: {} },
          { binding: 0, event: { word: "y" } },
        ],
      );

      expect(refused).toEqual([]);
      expect(found).toEqual([]);
      expect(dependent).toBeGreaterThanOrEqual(1);
    });

    it("finds it in the stored label of the number of members, after a removal the input decided found no member", async () => {
      const { refused, found, dependent } = await check(
        "count-after-change",
        { note: "n" },
        [
          { binding: 0, event: { word: "n" } },
          { binding: 0, event: { word: "y" } },
          { binding: 2, event: {} },
          { binding: 2, event: {} },
          { binding: 0, event: { word: "z" } },
        ],
      );

      expect(refused).toEqual([]);
      expect(found).toEqual([]);
      expect(dependent).toBeGreaterThanOrEqual(1);
    });

    it("finds it in the stored label of the number of members, after a removal the input decided and a later push", async () => {
      const { refused, found, dependent } = await check(
        "count-after-change",
        { note: "n" },
        [
          { binding: 0, event: { word: "n" } },
          { binding: 0, event: { word: "x" } },
          { binding: 2, event: {} },
          { binding: 0, event: { word: "y" } },
        ],
      );

      expect(refused).toEqual([]);
      expect(found).toEqual([]);
      expect(dependent).toBeGreaterThanOrEqual(1);
    });
  });

  // `fixtures/handle-methods.tsx`: the other methods of a handle that change
  // what a list holds, each after a write the input `note` decides.
  describe("soundnessOfScenario() after the other methods of a handle changed a list of plain values in place", () => {
    const check = async (events: { binding: string; event: unknown }[]) => {
      const artifact = await artifactOf("handle-methods");
      const { soundness, refused } = await soundnessOfScenario(
        "handle-methods",
        artifact,
        () => undefined,
        { note: "n" },
        events.map(({ binding, event }) => ({
          binding: artifact.plan.bindings.findIndex(({ name }) =>
            name === binding
          ),
          event,
        })),
      );
      return {
        refused,
        found: lines("handle-methods", soundness),
        dependent: soundness?.dependent ?? 0,
      };
    };

    it("finds the clause of the input in the label of what a `map` gives over a list that `set` emptied", async () => {
      const { refused, found, dependent } = await check([
        { binding: "addOnce", event: { word: "x" } },
        { binding: "clearIfNoted", event: {} },
      ]);

      expect(refused).toEqual([]);
      expect(found).toEqual([]);
      expect(dependent).toBeGreaterThanOrEqual(1);
    });

    // The write gives the list the value it had, so no value changes, and
    // the result of the `map` is not computed again.
    it("finds it in the label of what a `map` gives over a list that `set` left empty under another label", async () => {
      const { refused, found, dependent } = await check([
        { binding: "clearIfNoted", event: {} },
      ]);

      expect(refused).toEqual([]);
      expect(found).toEqual([]);
      expect(dependent).toBeGreaterThanOrEqual(1);
    });

    it("finds it in the label of the number of members after a write at the position behind the last member", async () => {
      const { refused, found, dependent } = await check([
        { binding: "addOnce", event: { word: "x" } },
        { binding: "addOnce", event: { word: "y" } },
        { binding: "putIfNoted", event: { at: 2 } },
      ]);

      expect(refused).toEqual([]);
      expect(found).toEqual([]);
      expect(dependent).toBeGreaterThanOrEqual(1);
    });

    it("finds it in the label of the number of members after `addUnique` of a member the list holds added nothing", async () => {
      const { refused, found, dependent } = await check([
        { binding: "addOnce", event: { word: "x" } },
        { binding: "addOnce", event: { word: "y" } },
        { binding: "putIfNoted", event: { at: 0 } },
        { binding: "addOnce", event: { word: "noted" } },
      ]);

      expect(refused).toEqual([]);
      expect(found).toEqual([]);
      expect(dependent).toBeGreaterThanOrEqual(1);
    });

    it("finds it in the labels of a number and of a record written after a write the input decided", async () => {
      const { refused, found, dependent } = await check([
        { binding: "bumpIfNoted", event: {} },
        { binding: "bump", event: { by: 2 } },
        { binding: "markNote", event: {} },
        { binding: "mark", event: { key: "k" } },
      ]);

      expect(refused).toEqual([]);
      expect(found).toEqual([]);
      expect(dependent).toBeGreaterThanOrEqual(1);
    });
  });

  // `fixtures/count-of-records.tsx`: the number of members of an array of
  // references, after a push the input `note` decides and one it does not.
  describe("soundnessOfScenario() after several pushes onto an array of references", () => {
    it("finds the clause of the input in the stored label of the number of members", async () => {
      const { soundness, refused } = await soundnessOfScenario(
        "count-of-records",
        await artifactOf("count-of-records"),
        () => undefined,
        { note: "n" },
        [
          { binding: 0, event: { title: "x" } },
          { binding: 1, event: {} },
          { binding: 0, event: { title: "y" } },
        ],
      );

      expect(refused).toEqual([]);
      expect(lines("count-of-records", soundness)).toEqual([]);
      expect(soundness?.dependent).toBeGreaterThanOrEqual(1);
    });
  });

  // `fixtures/whole-after-push.tsx`: a text of everything a list holds,
  // whose records declare a clause on a member, after two appended records.
  describe("soundnessOfScenario() after pushes onto a list whose records declare a label", () => {
    it("commits every transaction and finds the clause of the list in the stored label of the text", async () => {
      const { soundness, refused } = await soundnessOfScenario(
        "whole-after-push",
        await artifactOf("whole-after-push"),
        () => undefined,
        { items: [{ note: "first", amount: 1 }] },
        [{ binding: 0, event: {} }, { binding: 0, event: {} }],
      );

      expect(refused).toEqual([]);
      expect(lines("whole-after-push", soundness)).toEqual([]);
      expect(soundness?.dependent).toBeGreaterThanOrEqual(1);
    });
  });

  // `fixtures/remove-reference.tsx`: two records pushed, each a document of
  // its own that holds the input `note`, and the removal of the first.
  describe("soundnessOfScenario() after a removal from an array of references", () => {
    it("finds the clause of the input in the stored label of the record the list keeps", async () => {
      const { soundness, refused } = await soundnessOfScenario(
        "remove-reference",
        await artifactOf("remove-reference"),
        () => undefined,
        { note: "n" },
        [
          { binding: 0, event: { title: "a" } },
          { binding: 0, event: { title: "b" } },
          { binding: 1, event: {} },
        ],
      );

      expect(refused).toEqual([]);
      expect(lines("remove-reference", soundness)).toEqual([]);
      expect(soundness?.dependent).toBeGreaterThanOrEqual(1);
    });
  });

  // `fixtures/unchanged-write.tsx`: `raise` writes the greater of the inputs
  // `level` and `floor`, which leaves `level` as it was in the scenario.
  describe("soundnessOfScenario() after a handler run that leaves the value it writes as it was", () => {
    it("finds the clause of the input the run read in the stored label of the value", async () => {
      const { soundness, refused } = await soundnessOfScenario(
        "unchanged-write",
        await artifactOf("unchanged-write"),
        () => undefined,
        { floor: 3, level: 3 },
        [{ binding: 0, event: {} }],
      );

      expect(refused).toEqual([]);
      expect(lines("unchanged-write", soundness)).toEqual([]);
      expect(soundness?.dependent).toBeGreaterThanOrEqual(1);
    });
  });

  // `fixtures/derived-members.tsx`: the results of `map`, `filter` and
  // `flatMap` as kept outputs, over an array of references, over a list of
  // plain values in place and over the result of another per-element
  // construct, with handlers that add to and remove from both lists where
  // the input `note` holds one text.
  describe("soundnessOfScenario() on the results of per-element constructs over lists that handlers change", () => {
    const check = async (events: { binding: string; event: unknown }[]) => {
      const artifact = await artifactOf("derived-members");
      const { soundness, refused } = await soundnessOfScenario(
        "derived-members",
        artifact,
        () => undefined,
        { note: "n", secret: "ssss" },
        events.map(({ binding, event }) => ({
          binding: artifact.plan.bindings.findIndex(({ name }) =>
            name === binding
          ),
          event,
        })),
      );
      return {
        refused,
        found: lines("derived-members", soundness),
        appended: (soundness?.appended ?? []).map((
          { path, input, afterOtherChange },
        ) =>
          `${path} ${input}${afterOtherChange ? " after another change" : ""}`
        ),
      };
    };

    it("commits every transaction, the result of a `flatMap` over an array of references included", async () => {
      const { refused } = await check([
        { binding: "addIfNoted", event: {} },
        { binding: "add", event: { title: "xx" } },
      ]);

      expect(refused).toEqual([]);
    });

    it("counts as no failure a member that an append put at another position than in the run with the input changed", async () => {
      const { found, appended } = await check([
        { binding: "addIfNoted", event: {} },
        { binding: "add", event: { title: "xx" } },
      ]);

      expect(found).toEqual([]);
      // The first members of `twice` and of `doubled`, the results of a
      // `flatMap`, are written as a change of the members other than an
      // addition at the end, which stores the label of the membership once
      // for every position. An addition at the end leaves it, so the
      // positions it writes read it too.
      expect(appended).toEqual([
        "titles/1 note",
        "open/1 note",
        "cards/1 note",
        "cards/1/name note",
        "shouted/1 note",
        "openTitles/1 note",
        "longShouted/1 note",
        "shoutedTwice/1 note",
        '{"body":0,"write":1} /1 note',
        '{"body":0,"write":0} /1 note',
      ]);
    });

    it("finds the clause of the input that decided a removal at each position of a result that holds a member the removal moved", async () => {
      const { refused, found, appended } = await check([
        { binding: "add", event: { title: "aa" } },
        { binding: "addSecret", event: {} },
        { binding: "dropFirstIfNoted", event: {} },
      ]);

      expect(refused).toEqual([]);
      expect(found).toEqual([]);
      expect(appended).toEqual([]);
    });

    it("finds the clause of the input that decided a removal at the position of a member that was appended after it", async () => {
      const { found, appended } = await check([
        { binding: "add", event: { title: "aa" } },
        { binding: "add", event: { title: "bb" } },
        { binding: "dropFirstIfNoted", event: {} },
        { binding: "add", event: { title: "cc" } },
      ]);

      expect(found).toEqual([]);
      expect(appended).toEqual([]);
    });
  });

  // `fixtures/push-under-condition.tsx`: one handler that adds a word where
  // the input `note` holds one text and then adds the word of its event.
  describe("soundnessOfScenario() after two additions of one handler, the first under a condition on an input", () => {
    it("finds the clause of the input in the stored labels of both positions and of the number of members, with no member counted as appended elsewhere", async () => {
      const { soundness, refused } = await soundnessOfScenario(
        "push-under-condition",
        await artifactOf("push-under-condition"),
        () => undefined,
        { note: "n" },
        [{ binding: 0, event: { word: "b" } }],
      );

      expect(refused).toEqual([]);
      expect(lines("push-under-condition", soundness)).toEqual([]);
      expect(soundness?.appended).toEqual([]);
      expect(soundness?.dependent).toBeGreaterThanOrEqual(3);
    });
  });

  // `fixtures/held-in-place.tsx`: values the result holds in place where
  // the plan's template is of a reference or of a collection's membership.
  describe("soundnessOfScenario() on values the result holds in place", () => {
    const argument = {
      stops: [
        { title: "a", position: { lat: 3, lng: 3 } },
        { title: "b", position: { lat: 5, lng: 5 } },
      ],
      area: { lat: 3, lng: 3 },
      selected: 0,
      center: null,
    };
    const check = async (events: { binding: number; event: unknown }[]) => {
      const { soundness, refused } = await soundnessOfScenario(
        "held-in-place",
        await artifactOf("held-in-place"),
        () => undefined,
        argument,
        events,
      );
      return { refused, found: lines("held-in-place", soundness) };
    };

    it("finds the clause of an input an element body reads in the label of the rows a view holds", async () => {
      expect(await check([])).toEqual({ refused: [], found: [] });
    });

    it("finds the clause of what a cell's links lead to in the label of the cell's value, given as a branch of a `select`", async () => {
      expect(await check([{ binding: 1, event: {} }])).toEqual({
        refused: [],
        found: [],
      });
    });

    it("finds the clause of what the links lead to after a write that changes them and leaves the value the output holds as it was", async () => {
      expect(
        await check([
          { binding: 1, event: {} },
          { binding: 0, event: { index: 0 } },
        ]),
      ).toEqual({ refused: [], found: [] });
    });
  });

  // `fixtures/member-edges.tsx`: changes of the members of a list of plain
  // values in place at its edges.
  describe("soundnessOfScenario() after changes at the edges of a list of plain values in place", () => {
    const check = async (events: { binding: string; event: unknown }[]) => {
      const artifact = await artifactOf("member-edges");
      const { soundness, refused } = await soundnessOfScenario(
        "member-edges",
        artifact,
        () => undefined,
        { note: "n", secret: "ssss" },
        events.map(({ binding, event }) => ({
          binding: artifact.plan.bindings.findIndex(({ name }) =>
            name === binding
          ),
          event,
        })),
      );
      return {
        refused,
        found: lines("member-edges", soundness),
        dependent: soundness?.dependent ?? 0,
      };
    };

    it("finds the clause of a member that a removal and an addition of one transaction left at the position another stood at", async () => {
      const { refused, found, dependent } = await check([
        { binding: "add", event: { word: "a" } },
        { binding: "addSecret", event: {} },
        { binding: "dropFirstAndAdd", event: { word: "w" } },
      ]);

      expect(refused).toEqual([]);
      expect(found).toEqual([]);
      expect(dependent).toBeGreaterThanOrEqual(1);
    });

    it("finds the clause of the input that decided a write of `undefined` at a position, at that position", async () => {
      for (const at of [0, 1]) {
        const { refused, found, dependent } = await check([
          { binding: "add", event: { word: "a" } },
          { binding: "add", event: { word: "b" } },
          { binding: "clearAtIfNoted", event: { at } },
        ]);

        expect(refused).toEqual([]);
        expect(found).toEqual([]);
        expect(dependent).toBeGreaterThanOrEqual(1);
      }
    });

    it("commits a write at a position beyond the last member", async () => {
      const { refused, found } = await check([
        { binding: "add", event: { word: "a" } },
        { binding: "putAt", event: { at: 3, word: "far" } },
      ]);

      expect(refused).toEqual([]);
      expect(found).toEqual([]);
    });
  });

  // `fixtures/state-declared.tsx`: a state cell whose type declares the
  // clause `alice`, with a constant as its first value, returned by
  // reference.
  describe("deepStoredAt() of an output that is a state cell whose type declares a label", () => {
    it("holds the clause the type declares, which the document of the cell stores", async () => {
      const artifact = await artifactOf("state-declared");
      const space = (await Identity.fromPassphrase("pattern-compiler-compare"))
        .did();
      let label: Label | undefined;
      await inStorage(
        artifact,
        { note: "n" },
        [],
        instanceOptions("state-declared", space, () => undefined),
        undefined,
        true,
        true,
        {
          end: (runtime, hooks, instance) => {
            const tx = runtime.edit();
            try {
              label = deepStoredAt(tx, {
                space,
                id: hooks.entityOf(instance.id),
                scope: "space",
                path: ["pinned"],
              }, []).label;
            } finally {
              tx.abort();
            }
          },
        },
      );

      expect(label?.confidentiality).toContainEqual("alice");
    });
  });

  // `fixtures/handle-methods.tsx`: `putIfNoted` writes `key(at).set()` where
  // the input `note` holds one text. The plan has an envelope for that
  // write and no write edge, so no template gives its label.
  describe("deepStoredAt() in the class `shape` after a write the plan has only an envelope for added a member", () => {
    it("holds the clause of the input the write depends on, for the list and for what a `map` gives over it", async () => {
      const artifact = await artifactOf("handle-methods");
      const space = (await Identity.fromPassphrase("pattern-compiler-compare"))
        .did();
      const options = instanceOptions("handle-methods", space, () => undefined);
      const binding = (name: string) =>
        artifact.plan.bindings.findIndex((each) => each.name === name);
      const sent = sentEvents(artifact, { note: "n" }, [
        { binding: binding("addOnce"), event: { word: "x" } },
        { binding: binding("putIfNoted"), event: { at: 1 } },
      ], options);
      const labels: Record<string, string> = {};
      const refused: string[] = [];
      await inStorage(
        artifact,
        { note: "n" },
        sent,
        options,
        undefined,
        true,
        true,
        {
          refused: (reasons) => {
            for (const reason of reasons) refused.push(reason);
          },
          end: (runtime, hooks, instance) => {
            const tx = runtime.edit();
            try {
              for (const name of ["words", "shouted"]) {
                labels[name] = JSON.stringify(
                  deepStoredAt(
                    tx,
                    {
                      space,
                      id: hooks.entityOf(instance.id),
                      scope: "space",
                      path: [name],
                    },
                    [],
                    "shape",
                  ).label.confidentiality,
                );
              }
            } finally {
              tx.abort();
            }
          },
        },
      );

      expect(refused).toEqual([]);
      expect(labels.words).toContain("input:note");
      expect(labels.shouted).toContain("input:note");
    });
  });

  // `fixtures/set-then-push.tsx`: `fill` writes the whole input list `words`
  // from the input `extra`, and `add` appends a word of its event.
  describe("soundnessOfScenario() after an append to a list whose members an earlier write of the whole list stored", () => {
    it("finds the clause of the input the whole write read in the stored label of each member that write stored", async () => {
      const { soundness, refused } = await soundnessOfScenario(
        "set-then-push",
        await artifactOf("set-then-push"),
        () => undefined,
        { extra: "e", words: ["w"] },
        [
          { binding: 1, event: { word: "x" } },
          { binding: 0, event: {} },
          { binding: 1, event: { word: "y" } },
        ],
      );

      expect(refused).toEqual([]);
      expect(lines("set-then-push", soundness)).toEqual([]);
      // The list, its two first members and its number of members.
      expect(soundness?.dependent).toBeGreaterThanOrEqual(4);
    });
  });

  // `fixtures/computed-row-state.tsx`: the handler `pick` of each row of a
  // `map` over an array that a computation returns appends the row's title.
  describe("soundnessOfScenario() after a handler wrote what its binding takes from an element of an array a computation returned", () => {
    it("finds the clause of each input the computation read in the stored label of what the handler wrote", async () => {
      const { soundness, refused } = await soundnessOfScenario(
        "computed-row-state",
        await artifactOf("computed-row-state"),
        () => undefined,
        { names: ["a", "b"], suffix: "!" },
        [{ binding: 0, event: {} }, { binding: 0, event: {} }],
      );

      expect(refused).toEqual([]);
      expect(lines("computed-row-state", soundness)).toEqual([]);
      expect(soundness?.sources).toEqual(["names", "suffix"]);
      expect(soundness?.dependent).toBeGreaterThanOrEqual(6);
    });
  });

  // `fixtures/computed-row-cone.tsx`: each element of `marked` is computed
  // from a row of an array that a computation returns and from a cell that
  // the handler `setMark` writes.
  describe("soundnessOfScenario() after an element computed from a row of an array a computation returned was computed again alone", () => {
    it("finds the clause of each input the computation read in the stored label of the element", async () => {
      const { soundness, refused } = await soundnessOfScenario(
        "computed-row-cone",
        await artifactOf("computed-row-cone"),
        () => undefined,
        { names: ["a", "b"], suffix: "!" },
        [{ binding: 0, event: { mark: "?" } }],
      );

      expect(refused).toEqual([]);
      expect(lines("computed-row-cone", soundness)).toEqual([]);
      expect(soundness?.dependent).toBeGreaterThanOrEqual(4);
    });
  });

  // `fixtures/literal-state.tsx`: the state of `put` holds `item`, an object
  // of two literals, which the handler reads whole. The plan has no state
  // entry for `item` itself, so the records of `put` bind no position for
  // its slot. The second `put` appends to a list that holds a member.
  describe("soundnessOfScenario() after an append by a handler whose records lack the binding of a slot", () => {
    it("commits the transaction, the records of the number of members and of the membership included", async () => {
      const { refused } = await soundnessOfScenario(
        "literal-state",
        await artifactOf("literal-state"),
        () => undefined,
        { note: "n" },
        [{ binding: 0, event: {} }, { binding: 0, event: {} }],
      );

      expect(refused).toEqual([]);
    });
  });

  // `fixtures/input-writes.tsx`: `add` pushes a record onto the input list
  // `items`.
  describe("inStorage()", () => {
    it("leaves the argument as it was given, so that a second run starts from the same values", async () => {
      const artifact = await artifactOf("input-writes");
      const argument = { label: "l", count: 1, items: [{ text: "a" }] };
      const space = (await Identity.fromPassphrase("pattern-compiler-compare"))
        .did();
      const options = instanceOptions("input-writes", space, () => undefined);
      const events = sentEvents(artifact, argument, [
        { binding: 0, event: {} },
      ], options);

      await inStorage(artifact, argument, events, options, undefined, true);

      expect(argument).toEqual({
        label: "l",
        count: 1,
        items: [{ text: "a" }],
      });
    });
  });

  describe("soundnessOf()", () => {
    // `fixtures/briefing.tsx` computes `climate` from `city`.
    const checked = async (clause: (name: string) => Atom[] | undefined) => {
      const artifact = await artifactOf("briefing");
      const plan = artifact.plan as unknown as LabelPlan;
      const argument = { secret: "s", city: "Paris" };
      const space = (await Identity.fromPassphrase("pattern-compiler-compare"))
        .did();
      const options = instanceOptions("briefing", space, () => undefined);
      const inputs = generateInputs(
        artifact.plan as Parameters<typeof generateInputs>[0],
        artifact.schemas as Parameters<typeof generateInputs>[1],
        await scenarioAudience(),
      );
      const runs = await perturbedRuns(artifact, argument, [], options, inputs);
      let own: Soundness | undefined;
      let other: Soundness | undefined;
      await inStorage(artifact, argument, [], options, undefined, true, true, {
        end: (runtime, hooks, instance) => {
          own = checkSoundness(
            runtime,
            hooks,
            instance,
            plan,
            runs,
            inputs,
            [],
          );
          const tx = runtime.edit();
          try {
            other = soundnessOf(
              tx,
              hooks,
              instance,
              plan,
              runs,
              new Map(
                Object.keys(inputs).flatMap((name) => {
                  const held = clause(name);
                  return held === undefined
                    ? []
                    : [[name, { root: held }] as const];
                }),
              ),
              new Map(),
              [],
            );
          } finally {
            tx.abort();
          }
        },
      });
      return { own, other };
    };

    it("counts each pair of a kept output and a labeled input, and those whose value differs", async () => {
      const { own } = await checked(() => undefined);

      expect(own?.checked).toBeGreaterThan(0);
      expect(own?.dependent).toBeGreaterThan(0);
      expect(own?.dependent).toBeLessThan(own!.checked);
      expect(own?.failures).toEqual([]);
    });

    it("reports a value that depends on an input whose clause its stored label does not hold, with the input and the label", async () => {
      const { other } = await checked((name) =>
        name === "city" ? ["a clause nothing stores"] : undefined
      );

      expect(
        other?.failures.map(({ kind, path, input, missing }) => ({
          kind,
          path,
          input,
          missing,
        })),
      ).toContainEqual({
        kind: "output",
        path: "climate",
        input: "city",
        missing: '"a clause nothing stores"',
      });
      expect(other?.failures.every(({ input }) => input === "city")).toBe(
        true,
      );
    });
  });
});
