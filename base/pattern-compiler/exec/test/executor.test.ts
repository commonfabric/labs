import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";

// The executor of `execution-and-storage.md` (ES) on the artifacts of the
// fixtures of the comparison: `compare/fixtures/<name>.emit.json` is the
// output of `pattern-compiler emit` for `<name>.tsx`.

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../../compare/fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === "default") ??
    patterns[patterns.length - 1];
};

type ViewNode = {
  name: string;
  props: Record<string, unknown>;
  children: unknown[];
};

describe("an instance", () => {
  it("computes each kept output from the slots its cone reads", async () => {
    const instance = new Instance(await artifactOf("small"), {
      secret: "s3cret",
      note: "n",
      flag: false,
      items: [{ title: "a", done: false }, { title: "b", done: true }],
    });

    expect(instance.result()).toEqual({
      shout: "S3CRET",
      echo: "S3CRET?",
      greeting: "hi n",
      chosen: "n",
      direct: "n",
      both: "s3cretn",
      count: 2,
      titles: ["a", "b"],
      loud: ["a!", "b!"],
      note: "n",
      secret: "s3cret",
    });
    // The value code reads no slot its cone does not list, and no output
    // over no edge.
    expect(instance.counts.slotsNotListed).toBe(0);
    expect(instance.counts.readsWithoutSlot).toBe(0);
    expect(instance.counts.outputsWithoutEdge).toBe(0);
  });

  it("stores the argument, the result, and one document per state cell", async () => {
    const instance = new Instance(await artifactOf("handler"), {
      secret: "s3cret",
      note: "n",
    });

    expect(instance.documents()).toEqual({
      "argument": 1,
      "result": 1,
      "state cell": 2,
    });
    expect(instance.stateCells()).toEqual([
      { name: "last", keys: [], value: "" },
      { name: "log", keys: [], value: [] },
    ]);
  });

  it("reads the default of a slot's schema where nothing is stored", async () => {
    const instance = new Instance(await artifactOf("defaulted"), {
      profile: { name: "ada" },
    });

    expect((instance.result() as { whole: unknown }).whole).toEqual({
      name: "ada",
      nick: "anon",
    });
  });
});

describe("an event", () => {
  it("runs the handler's body and evaluates again what read a written cell", async () => {
    const instance = new Instance(await artifactOf("handler"), {
      secret: "s3cret",
      note: "n",
    });
    const before = instance.counts.evaluations;

    const outcome = instance.send(0, { text: "hello", extra: "x" });

    expect(outcome).toEqual({ binding: 0, committed: true });
    expect(instance.result()).toEqual({
      last: "hellos3cret",
      log: [{ text: "hello" }],
      note: "n",
      record: { $stream: true },
    });
    // Each write is one a write edge of the handler's body names.
    expect(instance.counts.writesCovered).toBe(2);
    expect(instance.counts.writesNotCovered).toBe(0);
    // The result passes the two cells on by reference, so no cone read
    // what the handler wrote, and nothing is evaluated again.
    expect(instance.counts.evaluations).toBe(before);
  });

  it("evaluates again the cones that read what the handler wrote, and no other", async () => {
    const instance = new Instance(await artifactOf("outer-stream"), {
      items: ["a", "b"],
      shown: true,
    });
    const before = instance.counts.evaluations;

    instance.send(0, { by: 2 });

    expect((instance.result() as { count: number }).count).toBe(2);
    // The tree holds the stream and not the count.
    expect(instance.counts.evaluations).toBe(before);
  });

  it("commits nothing of a handler that throws", async () => {
    const instance = new Instance(await artifactOf("handler-throws"), {
      label: "l",
    });

    const outcome = instance.send(0, {});

    expect(outcome.committed).toBe(false);
    expect(outcome.error).toBe("nothing recorded yet");
    expect((instance.result() as { last?: string }).last).toBeUndefined();
  });

  it("reaches the handler a handler sends to", async () => {
    const instance = new Instance(await artifactOf("stream-target"), {
      start: 1,
    });

    // Binding 1 is the inline handler, which sends to the stream of
    // binding 0.
    instance.send(1, {});

    expect((instance.result() as { count: number }).count).toBe(2);
  });
});

describe("an element construct", () => {
  it("keys two equal plain values by their value and their count", async () => {
    const instance = new Instance(await artifactOf("equal-values"), {
      tags: ["a", "a"],
    });

    // A state cell per occurrence (PL §1.3, "A state cell is per
    // occurrence").
    expect(instance.stateCells().map(({ keys }) => keys)).toEqual([
      ['value:"a"#0'],
      ['value:"a"#1'],
    ]);

    // The event names the second occurrence, and its cell alone is set.
    instance.send(0, {}, [1]);

    expect(instance.stateCells().map(({ value }) => value)).toEqual([
      false,
      true,
    ]);
    const tree = (instance.result() as { $UI: ViewNode }).$UI;
    expect((tree.children as ViewNode[]).map((row) => row.children)).toEqual([
      ["a", false],
      ["a", true],
    ]);
  });

  it("keeps an element's state with its value when the element moves", async () => {
    const instance = new Instance(await artifactOf("equal-values"), {
      tags: ["a", "b"],
    });
    instance.send(0, {}, [1]);

    instance.writeArgument(["tags"], ["b", "a"]);

    const tree = (instance.result() as { $UI: ViewNode }).$UI;
    expect((tree.children as ViewNode[]).map((row) => row.children)).toEqual([
      ["b", true],
      ["a", false],
    ]);
    expect(instance.documents()["state cell"]).toBe(2);
  });

  it("evaluates again, after a move, the cones that read the index", async () => {
    const instance = new Instance(await artifactOf("index-nodes"), {
      items: [{ title: "a" }, { title: "b" }, { title: "c" }],
    });
    expect((instance.result() as { numbered: number[] }).numbered).toEqual([
      1,
      2,
      3,
    ]);
    const before = instance.counts.evaluations;

    // The last element stays at its position.
    instance.writeArgument(["items"], [
      { title: "b" },
      { title: "a" },
      { title: "c" },
    ]);

    expect((instance.result() as { numbered: number[] }).numbered).toEqual([
      1,
      2,
      3,
    ]);
    const tree = (instance.result() as { $UI: ViewNode }).$UI;
    expect(
      (tree.children as ViewNode[]).map((row) =>
        (row.children[0] as ViewNode).children
      ),
    ).toEqual([["b"], ["a"], ["c"]]);
    // Evaluated again: the two assemblies, the tree and the result, and
    // for each of the two moved keys the function that reads the index
    // and the function that reads the element at its new position. No
    // function of the key that did not move is.
    expect(instance.counts.evaluations - before).toBe(8);
  });

  it("gives a handler bound in the body the index its element has at the event", async () => {
    const instance = new Instance(await artifactOf("index-nodes"), {
      items: [{ title: "a" }, { title: "b" }],
    });

    instance.send(0, {}, [1]);

    expect((instance.result() as { chosen: number }).chosen).toBe(1);
  });
});
