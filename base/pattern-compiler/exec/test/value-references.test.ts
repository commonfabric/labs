import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";
import { Ref } from "../store.ts";

/** The pattern of `compare/fixtures/value-references.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../compare/fixtures/value-references.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns[0];
};

/**
 * An instance over `size` topics, each a document of its own that mentions
 * the two topics before it.
 */
const started = async (size: number) => {
  const link = (index: number) => ({
    $link: { doc: `topic-${index}`, path: [] },
  });
  const documents = Array.from({ length: size }, (_, index) => ({
    id: `topic-${index}`,
    kind: "topic",
    value: {
      title: `t${index}`,
      mentions: [index - 2, index - 1].filter((at) => at >= 0).map(link),
    },
  }));
  return new Instance(
    await artifact(),
    { topics: documents.map((_, index) => link(index)) },
    { documents },
  );
};

describe("a `map` over plain values that a `lift` generated from scratch and that hold references", () => {
  it("gives the title of the topic that mentions, for each mention", async () => {
    const instance = await started(4);

    expect(instance.result()).toEqual({
      titles: ["t1", "t2", "t2", "t3", "t3"],
    });
  });

  it("forms no key again when a topic that every pair leads to changes its title", async () => {
    const instance = await started(8);
    instance.result();
    const before = instance.store.hashes;

    instance.store.write(new Ref("topic-0", ["title"]), "edited");
    instance.settle();

    expect(instance.result()).toEqual({
      titles: [1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7].map((at) => `t${at}`),
    });
    expect(instance.store.hashes).toBe(before);
  });

  it("loads 64 topics that mention each other, where a pair with every reference followed has more than a billion members", async () => {
    const instance = await started(64);

    expect((instance.result() as { titles: string[] }).titles.length).toBe(125);
  });
});
