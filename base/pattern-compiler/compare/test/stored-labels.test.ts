import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../exec/executor.ts";
import { generateInputs } from "../generate.ts";
import { scenarioAudience } from "../harness.ts";
import { instanceOptions, inStorage } from "../integrated.ts";
import { perturbedRuns } from "../perturbation.ts";
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
    const ran = async (fixture: string) => {
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
  // list and writes back the rest.
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
