import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";
import { Ref } from "../store.ts";

/** The pattern of `compare/fixtures/crossref.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL("../../compare/fixtures/crossref.emit.json", import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

const link = (doc: string) => ({ $link: { doc, path: [] } });

/**
 * An instance over `count` topics, each a document of its own that
 * mentions the two topics before it, and the document `spare`, a topic
 * that mentions the first topic and that the array does not hold.
 */
const started = async (count: number) => {
  const topics = Array.from({ length: count }, (_, index) => ({
    id: `topic-${index}`,
    kind: "topic",
    value: {
      title: `t${index}`,
      shortName: `${index + 1}`,
      mentions: [index - 1, index - 2].filter((at) => at >= 0).map((at) =>
        link(`topic-${at}`)
      ),
    },
  }));
  const instance = new Instance(
    await artifact(),
    { topics: topics.map(({ id }) => link(id)) },
    {
      documents: [...topics, {
        id: "spare",
        kind: "topic",
        value: {
          title: "spare",
          shortName: "spare",
          mentions: [link("topic-0")],
        },
      }],
    },
  );
  /** The titles of the topics that mention each topic, by its title. */
  const mentionedBy = (): Record<string, string[]> => {
    const { rows } = instance.result() as {
      rows: { topic: { title: string }; mentionedBy: { title: string }[] }[];
    };
    return Object.fromEntries(
      rows.map((row) => [
        row.topic.title,
        row.mentionedBy.map(({ title }) => title),
      ]),
    );
  };
  /**
   * The evaluations, those of them that are of an element body or a key
   * function, and the buckets changed that `change` causes.
   */
  const work = (change: () => void) => {
    const before = { ...instance.counts };
    change();
    instance.settle();
    return {
      evaluations: instance.counts.evaluations - before.evaluations,
      elementEvaluations: instance.counts.elementEvaluations -
        before.elementEvaluations,
      bucketsChanged: instance.counts.bucketsChanged - before.bucketsChanged,
    };
  };
  return { instance, mentionedBy, work };
};

describe("the inverse of a relation each member holds as a list of references: a `flatMap` into pairs, a `groupBy` of the pairs by a cell, and a `map` over the array of references that looks up each member", () => {
  it("gives each row the topics that mention its topic, in the order of the array", async () => {
    const { mentionedBy } = await started(4);

    expect(mentionedBy()).toEqual({
      t0: ["t1", "t2"],
      t1: ["t2", "t3"],
      t2: ["t3"],
      t3: [],
    });
  });

  it("files the rows under the name each carries, in the index the result keeps", async () => {
    const { instance } = await started(3);

    const { byName } = instance.result() as {
      byName: { buckets: Record<string, { name: string }[]> };
    };
    expect(Object.keys(byName.buckets).sort()).toEqual(["s:1", "s:2", "s:3"]);
    expect(byName.buckets["s:2"]).toMatchObject([{ name: "2" }]);
  });

  it("moves a topic between the rows of the topics it mentions when its list of mentions is written", async () => {
    const { instance, mentionedBy } = await started(4);

    instance.store.write(new Ref("topic-3", ["mentions"]), [link("topic-0")]);
    instance.settle();

    expect(mentionedBy()).toEqual({
      t0: ["t1", "t2", "t3"],
      t1: ["t2"],
      t2: [],
      t3: [],
    });
  });

  it("adds a row for a topic that is appended, and adds the topic to the row of each topic it mentions", async () => {
    const { instance, mentionedBy } = await started(3);

    instance.spliceArgument(["topics"], 3, 0, [link("spare")]);
    instance.settle();

    expect(mentionedBy()).toEqual({
      t0: ["t1", "t2", "spare"],
      t1: ["t2"],
      t2: [],
      spare: [],
    });
  });

  it("evaluates no element body and no key function and changes no bucket for a change of a title, which no key reads", async () => {
    const { instance, work } = await started(4);

    const done = work(() =>
      instance.store.write(new Ref("topic-2", ["title"]), "edited")
    );

    expect(done).toMatchObject({ elementEvaluations: 0, bucketsChanged: 0 });
  });

  it("evaluates as much for a change of one topic's mentions among 1,000 topics as among 10", async () => {
    const counts: unknown[] = [];
    for (const count of [10, 1_000]) {
      const { instance, work } = await started(count);
      counts.push(
        work(() =>
          instance.store.write(new Ref("topic-5", ["mentions"]), [
            link("topic-0"),
          ])
        ),
      );
    }

    expect(counts[1]).toEqual(counts[0]);
    // The rows of the topics the member left and of the one it entered,
    // and not a row for each topic.
    expect((counts[0] as { evaluations: number }).evaluations).toBeLessThan(
      40,
    );
  });

  it("forms the segment of the one topic whose mentions changed, among 1,000 topics as among 10, and moves the topic between the rows", async () => {
    for (const count of [10, 1_000]) {
      const { instance, mentionedBy } = await started(count);
      const before = instance.counts.segmentsFormed;

      instance.store.write(new Ref("topic-5", ["mentions"]), [
        link("topic-0"),
        link("topic-1"),
      ]);
      instance.settle();

      expect(instance.counts.segmentsFormed - before).toBe(1);
      // The result is read whole, every link followed, for the small
      // board alone: the topics of the large one mention each other in a
      // chain as long as the board.
      if (count > 10) continue;
      const rows = mentionedBy();
      expect(rows.t0).toEqual(["t1", "t2", "t5"]);
      expect(rows.t1).toEqual(["t2", "t3", "t5"]);
      expect(rows.t3).toEqual(["t4"]);
      expect(rows.t4).toEqual(["t6"]);
    }
  });

  it("splices the segments of two topics whose mentions change in one transaction, and of a topic whose mentions empty", async () => {
    const { instance, mentionedBy } = await started(6);

    instance.store.write(new Ref("topic-2", ["mentions"]), []);
    instance.store.write(new Ref("topic-4", ["mentions"]), [
      link("topic-0"),
      link("topic-1"),
      link("topic-5"),
    ]);
    instance.settle();

    expect(mentionedBy()).toEqual({
      t0: ["t1", "t4"],
      t1: ["t3", "t4"],
      t2: ["t3"],
      t3: ["t5"],
      t4: ["t5"],
      t5: ["t4"],
    });

    instance.store.write(new Ref("topic-2", ["mentions"]), [link("topic-5")]);
    instance.settle();

    expect(mentionedBy().t5).toEqual(["t2", "t4"]);
  });

  it("evaluates as much for a topic appended to 1,000 topics as to 10", async () => {
    const counts: unknown[] = [];
    for (const count of [10, 1_000]) {
      const { instance, work } = await started(count);
      counts.push(
        work(() =>
          instance.spliceArgument(["topics"], count, 0, [link("spare")])
        ),
      );
    }

    expect(counts[1]).toEqual(counts[0]);
  });
});

describe("a write to a document that an array of references refers to, at a path that no body of a collection over the array reads", () => {
  it("evaluates nothing: no assembly over the array is formed again or brought up to date", async () => {
    const { instance, work } = await started(40);

    const done = work(() =>
      instance.store.write(new Ref("topic-20", ["title"]), "edited")
    );

    expect(done).toEqual({
      evaluations: 0,
      elementEvaluations: 0,
      bucketsChanged: 0,
    });
  });

  it("forms the keys of the array once for writes to 40 of its members", async () => {
    const { instance } = await started(40);
    const before = instance.store.keyings;

    for (let index = 0; index < 40; index++) {
      instance.store.write(new Ref(`topic-${index}`, ["title"]), "edited");
      instance.settle();
    }

    expect(instance.store.keyings).toBe(before);
  });

  it("follows a member whose document is written whole", async () => {
    const { instance, mentionedBy } = await started(4);

    instance.store.write(new Ref("topic-3", []), {
      title: "t3",
      shortName: "4",
      mentions: [link("topic-0")],
    });
    instance.settle();

    expect(mentionedBy()).toEqual({
      t0: ["t1", "t2", "t3"],
      t1: ["t2"],
      t2: [],
      t3: [],
    });
  });
});
