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
  type LabelPlan,
  type Soundness,
  soundnessOf,
  soundnessOfScenario,
} from "../stored-labels.ts";
import type { Atom } from "../template.ts";
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
    it("finds the clause of each labeled input in the stored label of every value of a fixture that depends on it, but for six values", async () => {
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

      // The result of a `reduce`, and the value a spread child copies,
      // are stored in place under a template whose slot observes a
      // reference alone.
      expect(found).toEqual([
        "reduce (written): output doubled depends on amounts",
        "reduce (written): output doubled depends on bonus",
        "reduce (written): output total depends on items",
        "reduce (written): output weighted depends on amounts",
        "spread-stream (written): output $UI depends on tags",
        "spread-stream (written): output $UI/children/1 depends on tags",
      ]);
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
