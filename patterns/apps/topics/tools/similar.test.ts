import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Topic } from "./mirror.ts";
import { similarTopics } from "./similar.ts";

/** A Topic numbered `number`, with `comments` from one author. */
function topicOf(
  number: string,
  title: string,
  body: string,
  comments: string[] = [],
): Topic {
  return {
    number,
    address: `of:fid1:entry-${number}`,
    piece: `of:fid1:piece-${number}`,
    title,
    body,
    createdAt: 1000,
    createdBy: "Sol (agent)",
    lastActivityAt: 1000,
    comments: comments.map((body) => ({
      author: "Ada (person)",
      body,
      sentAt: 2000,
      removed: false,
    })),
    links: [],
    mentions: [],
  };
}

const BOARD = [
  topicOf(
    "1",
    "Flaky fryer test",
    "The fryer test fails when the oil is cold.",
    ["Reproduced with cold batter."],
  ),
  topicOf(
    "2",
    "Donut glaze ratios drift",
    "The glaze recipe doubles its sugar when a batch is scaled.",
  ),
  topicOf(
    "3",
    "The oven timer test fails on main",
    "The timer test fails when the clock moves backwards.",
  ),
  topicOf(
    "4",
    "Checkout page is slow",
    "The checkout page takes ten seconds to load on main.",
  ),
  topicOf(
    "5",
    "Sourdough starter dies over the weekend",
    "Nobody feeds the starter on Saturday.",
  ),
];

/** The numbers of the Topics on `board` like `text`, most similar first. */
function ranked(text: string, board: readonly Topic[] = BOARD): string[] {
  return similarTopics(board, text).map(({ topic }) => topic.number);
}

describe("similar", () => {
  it("ranks a Topic stating the same problem in other sentences above Topics about other problems", () => {
    const fryer = ranked(
      "Deep fryer test is intermittent: it fails if the oil hasn't heated up.",
    );
    const oven = ranked(
      "The oven's timer test breaks when the clock is set back.",
    );

    expect(fryer[0]).toBe("1");
    expect(oven[0]).toBe("3");
    expect(oven.indexOf("1")).toBeGreaterThan(0);
  });

  it("ranks a Topic sharing a word fewer Topics use above one sharing a word more use", () => {
    const board = [
      topicOf("1", "Oven one", "Flour spills."),
      topicOf("2", "Oven two", "Flour clumps."),
      topicOf("3", "Oven three", "Sugar spills."),
    ];

    expect(ranked("flour sugar", board)[0]).toBe("3");
    expect(ranked("flour", board)).toEqual(["1", "2"]);
  });

  it("ranks equally similar Topics most recently active first", () => {
    const older = topicOf("1", "Oven one", "Flour spills.");
    const newer = {
      ...topicOf("2", "Oven two", "Flour spills."),
      lastActivityAt: 3000,
    };

    const other = topicOf("3", "Oven three", "Sugar clumps.");

    expect(ranked("flour", [older, newer, other])).toEqual(["2", "1"]);
    expect(ranked("flour", [{ ...older, lastActivityAt: 5000 }, newer, other]))
      .toEqual(["1", "2"]);
  });

  it("compares words without case or Unicode compatibility differences", () => {
    const board = [
      topicOf("1", "Caf\u00e9 menu", "Prices are wrong."),
      topicOf("2", "Kitchen menu", "Prices need a \ufb01x."),
    ];

    expect(ranked("CAFE\u0301", board)).toEqual(["1"]);
    expect(ranked("\uff26\uff29\uff38", board)).toEqual(["2"]);
    expect(ranked("cafe", board)).toEqual([]);
  });

  it("lists no Topic for a text whose only words every Topic uses", () => {
    expect(ranked("the THE")).toEqual([]);
  });

  it("ranks a Topic with a word in its title above one with that word only in its body", () => {
    const board = [
      topicOf("1", "Saturday deliveries", "The van comes late."),
      topicOf("2", "Late van", "The deliveries come Saturday."),
      topicOf("3", "Weekday orders", "Orders are fine."),
    ];

    expect(ranked("saturday deliveries", board)).toEqual(["1", "2"]);
    expect(ranked("late van", board)).toEqual(["2", "1"]);
  });

  it("compares a Topic's title and body, and not its comments", () => {
    expect(ranked("cold")).toEqual(["1"]);
    expect(ranked("batter")).toEqual([]);
  });

  it("returns a similarity near 1 for a Topic's own title and body, and far less for any other", () => {
    const [own, other] = similarTopics(
      BOARD,
      "Flaky fryer test\nThe fryer test fails when the oil is cold.",
    );

    expect(own.topic.number).toBe("1");
    expect(own.similarity).toBeGreaterThan(0.95);
    expect(own.similarity).toBeLessThanOrEqual(1);
    expect(other.similarity).toBeGreaterThan(0);
    expect(other.similarity).toBeLessThan(0.5);
  });

  it("names the shared words that count most first, five at most", () => {
    const [{ shared }] = similarTopics(BOARD, "oil and fryer, the fryer");
    const [{ shared: many }] = similarTopics(
      BOARD,
      "flaky fryer test fails oil cold when is",
    );

    expect(shared).toEqual(["fryer", "oil"]);
    expect(many).toHaveLength(5);
    expect(many.slice(0, 2)).toEqual(["fryer", "flaky"]);
  });

  it("leaves out Topics whose titles match a pattern of `exclude`, and only those", () => {
    const hits = similarTopics(BOARD, "fryer test fails main", {
      exclude: [/^Flaky/, /^Nothing/],
    });

    expect(hits.map(({ topic }) => topic.number)).toEqual(["3", "4"]);
  });

  it("leaves out every Topic a global pattern of `exclude` matches", () => {
    const board = [
      topicOf("1", "Oil fryer", "Oil."),
      topicOf("2", "Oil glaze", "Oil."),
      topicOf("3", "Sugar", "Sugar."),
    ];

    expect(similarTopics(board, "oil", { exclude: [/oil/gi] })).toEqual([]);
  });
});
