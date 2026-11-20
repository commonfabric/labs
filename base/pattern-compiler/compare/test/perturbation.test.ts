import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Artifact } from "../../exec/executor.ts";
import { generateInputs } from "../generate.ts";
import { instanceOptions } from "../integrated.ts";
import {
  concretePaths,
  perturbed,
  perturbedRuns,
  sentEvents,
  valueAt,
} from "../perturbation.ts";

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === "default") ??
    patterns[patterns.length - 1];
};

describe("perturbation", () => {
  describe("perturbed()", () => {
    it("changes a text, a number and a boolean to another value of the type", () => {
      expect(perturbed("a")).toBe("a~");
      expect(perturbed(3)).toBe(4);
      expect(perturbed(true)).toBe(false);
    });

    it("changes a member of an `enum` to the next member, and the last to the first", () => {
      const schema = { enum: ["low", "high"] };

      expect(perturbed("low", schema)).toBe("high");
      expect(perturbed("high", schema)).toBe("low");
    });

    it("leaves a `const` and an `enum` of one member as they are", () => {
      expect(perturbed("fixed", { const: "fixed" })).toBe("fixed");
      expect(perturbed("only", { enum: ["only"] })).toBe("only");
    });

    it("changes each member of an object under the schema of its property", () => {
      const schema = {
        type: "object",
        properties: { kind: { enum: ["a", "b"] }, title: { type: "string" } },
      };

      expect(perturbed({ kind: "a", title: "t", more: 1 }, schema)).toEqual({
        kind: "b",
        title: "t~",
        more: 2,
      });
    });

    it("changes each member of an array and adds one generated from the schema of its items", () => {
      const schema = { type: "array", items: { type: "string" } };

      expect(perturbed(["a", "b"], schema, schema, "tags")).toEqual([
        "a~",
        "b~",
        "tags-added-text",
      ]);
    });

    it("adds a changed copy of the last member to an array whose items have no schema", () => {
      expect(perturbed([1, 2])).toEqual([2, 3, 4]);
    });

    it("leaves an empty array whose items have no schema empty", () => {
      expect(perturbed([])).toEqual([]);
    });
  });

  describe("concretePaths()", () => {
    it("gives a path without `*` as it is, whether the value holds it or not", () => {
      expect(concretePaths(["a", "b"], {})).toEqual([["a", "b"]]);
    });

    it("replaces each `*` by each index of the array the value holds there", () => {
      const value = { rows: [{ tags: ["x", "y"] }, { tags: ["z"] }] };

      expect(concretePaths(["rows", "*", "tags", "*"], value)).toEqual([
        ["rows", "0", "tags", "0"],
        ["rows", "0", "tags", "1"],
        ["rows", "1", "tags", "0"],
      ]);
    });

    it("gives no path where the value holds nothing at a `*`", () => {
      expect(concretePaths(["rows", "*"], { rows: undefined })).toEqual([]);
    });
  });

  // `fixtures/briefing.tsx` computes `climate` from `city` and reads
  // `secret` in another output.
  describe("perturbedRuns()", () => {
    const runs = async () => {
      const artifact = await artifactOf("briefing");
      const argument = { secret: "s", city: "Paris" };
      const options = instanceOptions(
        "briefing",
        "did:key:unused",
        () => undefined,
      );
      return await perturbedRuns(
        artifact,
        argument,
        sentEvents(artifact, argument, [], options),
        options,
        generateInputs(
          artifact.plan as Parameters<typeof generateInputs>[0],
          artifact.schemas as Parameters<typeof generateInputs>[1],
        ),
      );
    };

    it("runs the scenario as given twice and once for each labeled input", async () => {
      const { runs: made, sources, skipped } = await runs();

      expect(skipped).toBeUndefined();
      expect(sources.map(({ name }) => name).sort()).toEqual([
        "city",
        "secret",
      ]);
      expect(made).toBe(4);
    });

    it("gives a value that reads an input another value in the run with that input changed, and the same value in the run with another input changed", async () => {
      const { baseline, sources } = await runs();
      const climate = (name: string) =>
        valueAt(
          sources.find((source) => source.name === name)?.instance?.result(),
          ["climate"],
        );

      expect(climate("city")).not.toEqual(
        valueAt(baseline?.result(), ["climate"]),
      );
      expect(climate("secret")).toEqual(
        valueAt(baseline?.result(), ["climate"]),
      );
    });
  });
});
