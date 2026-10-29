import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { followBoard } from "./live.ts";
import type { MirrorData, Topic } from "./mirror.ts";
import type { Refreshed } from "./sync.ts";
import {
  BOARD,
  BOARD_DOCS,
  type BoardServer,
  boardServer,
  INPUT_1,
  link,
  SPACE,
} from "./board-fixture.ts";

describe("followBoard()", () => {
  let board: BoardServer;

  beforeEach(async () => {
    board = await boardServer();
  });

  afterEach(async () => {
    await board.close();
  });

  /**
   * Follows the board, handing each assembly to `step`, which returns `true`
   * once it has seen what it waits for; the following then stops and the
   * session closes.
   */
  async function follow(
    step: (refreshed: Refreshed, count: number) => boolean | Promise<boolean>,
  ): Promise<MirrorData> {
    const data: MirrorData = { pieces: {}, docs: {} };
    const { client, session } = await board.mount();
    const stop = new AbortController();
    let count = 0;
    await followBoard(session, SPACE, data, BOARD, async (refreshed) => {
      if (await step(refreshed, ++count)) {
        stop.abort();
        await client.close();
      }
    }, stop.signal);
    return data;
  }

  /** The bodies of Topic 1's comments. */
  function comments(topics: readonly Topic[]): string[] {
    return topics[0].comments.map((comment) => comment.body);
  }

  it("reports the board, then a comment the server pushes, fetching its document", async () => {
    const seen: string[][] = [];
    await follow(async ({ topics }, count) => {
      seen.push(comments(topics));
      if (count === 1) {
        await board.write({
          "of:fid1:comment-2": {
            value: { author: { name: "Bo" }, body: "Live.", sentAt: 9000 },
          },
          "of:fid1:input-1": {
            value: {
              ...INPUT_1,
              comments: [link("of:fid1:comment-1"), link("of:fid1:comment-2")],
            },
          },
        });
      }
      return count === 2;
    });

    expect(seen).toEqual([
      ["Reproduced with cold oil."],
      ["Reproduced with cold oil.", "Live."],
    ]);
  });

  it("reports an edit to a comment fetched while following, and a new Topic", async () => {
    const seen: (string | number)[][] = [];
    await follow(async ({ topics }, count) => {
      seen.push([topics.length, ...comments(topics)]);
      if (count === 1) {
        await board.write({
          "of:fid1:comment-2": { value: { body: "Draft.", sentAt: 9000 } },
          "of:fid1:input-1": {
            value: {
              ...INPUT_1,
              comments: [link("of:fid1:comment-1"), link("of:fid1:comment-2")],
            },
          },
        });
      } else if (count === 2) {
        await board.write({
          "of:fid1:comment-2": {
            value: { body: "Edited.", sentAt: 9000, editedAt: 9500 },
          },
        });
      } else if (count === 3) {
        await board.write({
          "of:fid1:topic-piece-3": {
            value: {},
            argument: link("of:fid1:input-3"),
          },
          "of:fid1:input-3": {
            value: { title: "Third", comments: [], links: [] },
          },
          "of:fid1:board-input": {
            value: {
              names: {
                "1": link("of:fid1:topic-alias-1"),
                "2": link("of:fid1:topic-piece-2"),
                "3": link("of:fid1:topic-piece-3"),
              },
            },
          },
        });
      }
      return count === 4;
    });

    expect(seen).toEqual([
      [2, "Reproduced with cold oil."],
      [2, "Reproduced with cold oil.", "Draft."],
      [2, "Reproduced with cold oil.", "Edited."],
      [3, "Reproduced with cold oil.", "Edited."],
    ]);
  });

  it("throws when the session ends while it waits for a change, unless it was stopped", async () => {
    const { client, session } = await board.mount();
    const counts: number[] = [];
    const following = followBoard(
      session,
      SPACE,
      { pieces: {}, docs: {} },
      BOARD,
      async ({ topics }) => {
        counts.push(topics.length);
        if (counts.length === 1) {
          await board.write({
            "of:fid1:input-2": { value: { title: "Renamed", comments: [] } },
          });
        } else {
          await client.close();
        }
      },
      new AbortController().signal,
    );

    await expect(following).rejects.toThrow("memory session closed");
    expect(counts).toEqual([2, 2]);
  });

  it("reads a Topic dropped from the board and named again as it stands", async () => {
    const names = (entries: Record<string, string>) => ({
      "of:fid1:board-input": {
        value: {
          names: Object.fromEntries(
            Object.entries(entries).map(([n, id]) => [n, link(id)]),
          ),
        },
      },
    });
    const seen: string[][] = [];
    await follow(async ({ topics }, count) => {
      seen.push(topics.map((topic) => `${topic.number} ${topic.title}`));
      if (count === 1) {
        await board.write(names({ "1": "of:fid1:topic-alias-1" }));
      } else if (count === 2) {
        await board.write(names({
          "1": "of:fid1:topic-alias-1",
          "2": "of:fid1:topic-piece-2",
        }));
      }
      return count === 3;
    });

    expect(seen).toEqual([
      ["1 Flaky fryer test", "2 Donut glaze"],
      ["1 Flaky fryer test"],
      ["1 Flaky fryer test", "2 Donut glaze"],
    ]);
  });

  it("does not take a change pushed before it was watching back over a later one", async () => {
    const seen: string[][] = [];
    await follow(async ({ topics }, count) => {
      seen.push(comments(topics));
      if (count === 1) {
        for (const body of ["A.", "B."]) {
          await board.write({
            "of:fid1:comment-1": {
              value: { author: { name: "Ada" }, body, sentAt: 2000 },
            },
          });
        }
      }
      // A later write, which arrives after anything queued before it.
      if (seen.at(-1)?.[0] === "B." && topics[1].title !== "Marker") {
        await board.write({
          "of:fid1:input-2": {
            value: { title: "Marker", comments: [], links: [] },
          },
        });
      }
      return topics[1].title === "Marker";
    });

    // Each reported comment is the one written last or a later one.
    const order = ["Reproduced with cold oil.", "A.", "B."];
    const ranks = seen.map((bodies) => order.indexOf(bodies[0]));

    expect(ranks).toEqual(ranks.toSorted());
    expect(seen.at(-1)).toEqual(["B."]);
  });

  it("reports nothing more once it is stopped", async () => {
    const { client, session } = await board.mount();
    const stop = new AbortController();
    let calls = 0;
    await followBoard(
      session,
      SPACE,
      { pieces: {}, docs: {} },
      BOARD,
      () => {
        calls++;
        stop.abort();
      },
      stop.signal,
    );
    await client.close();

    expect(calls).toBe(1);
  });

  it("reports nothing once it is stopped, even a board it finished reading after", async () => {
    const { client, session } = await board.mount();
    const stop = new AbortController();
    const reading = Promise.withResolvers<void>();
    const read = Promise.withResolvers<void>();
    const set = session.watchSetSync.bind(session);
    session.watchSetSync = async (...args) => {
      reading.resolve();
      const result = await set(...args);
      await read.promise;
      return result;
    };
    let calls = 0;
    const following = followBoard(
      session,
      SPACE,
      { pieces: {}, docs: {} },
      BOARD,
      () => void calls++,
      stop.signal,
    );
    await reading.promise;
    stop.abort();
    read.resolve();
    await following;
    await client.close();

    expect(calls).toBe(0);
  });

  it("keeps following comments past a few hundred, including one missing before the watches were set again", async () => {
    const { client, session } = await board.mount();
    const stop = new AbortController();
    const add = session.watchAddSync.bind(session);
    const set = session.watchSetSync.bind(session);
    let adds = 0;
    let most = 0;
    session.watchAddSync = (...args) => {
      most = Math.max(most, ++adds);
      return add(...args);
    };
    session.watchSetSync = (...args) => {
      adds = 0;
      return set(...args);
    };
    const id = (n: number) => `of:fid1:many-${n}`;
    const comment = (n: number, body: string) => ({
      [id(n)]: { value: { author: { name: "Bo" }, body, sentAt: 9000 + n } },
    });
    const COUNT = 300;
    // Comment 1, let go of once the comments are replaced, is deleted and
    // linked again, so that it is read as missing while already watched.
    const RELINK = 5;
    let written = 0;
    let last: string[] = [];
    await followBoard(
      session,
      SPACE,
      { pieces: {}, docs: {} },
      BOARD,
      async ({ topics }) => {
        last = comments(topics);
        if (written < COUNT) {
          written++;
          if (written === RELINK) await board.delete("of:fid1:comment-1");
          await board.write({
            ...comment(written, `${written}.`),
            "of:fid1:input-1": {
              value: {
                ...INPUT_1,
                comments: [
                  ...(written >= RELINK ? [link("of:fid1:comment-1")] : []),
                  ...Array.from(
                    { length: written },
                    (_, n) => link(id(n + 1)),
                  ),
                ],
              },
            },
          });
        } else if (last[0] === "") {
          await board.write({
            "of:fid1:comment-1": {
              value: { author: { name: "Ada" }, body: "Back.", sentAt: 2000 },
            },
          });
        } else {
          stop.abort();
          await client.close();
        }
      },
      stop.signal,
    );

    expect(last.length).toBe(COUNT + 1);
    expect(last[0]).toBe("Back.");
    expect(most).toBeLessThanOrEqual(256);
  });

  it("reads a linked document with no value as nothing, and goes on following", async () => {
    const seen: string[][] = [];
    await follow(async ({ topics }, count) => {
      seen.push(comments(topics));
      if (count === 1) {
        await board.write({
          "of:fid1:bare": { value: undefined, argument: link("of:fid1:x") },
          "of:fid1:input-1": {
            value: {
              ...INPUT_1,
              comments: [link("of:fid1:comment-1"), link("of:fid1:bare")],
            },
          },
        });
      } else if (count === 2) {
        await board.write({
          "of:fid1:comment-1": {
            value: { author: { name: "Ada" }, body: "Later.", sentAt: 2000 },
          },
        });
      }
      return count === 3;
    });

    expect(seen.at(-1)?.[0]).toBe("Later.");
  });

  it("follows a board whose input document is gone, and reads it once it is back", async () => {
    await board.delete("of:fid1:board-input");
    const seen: number[] = [];
    await follow(async ({ topics }, count) => {
      seen.push(topics.length);
      if (count === 1) {
        await board.write({
          "of:fid1:board-input": BOARD_DOCS["of:fid1:board-input"],
        });
      }
      return count === 2;
    });

    expect(seen).toEqual([0, 2]);
  });

  it("reports nothing once it is stopped while it reads what a change needs", async () => {
    const { client, session } = await board.mount();
    const stop = new AbortController();
    const add = session.watchAddSync.bind(session);
    let calls = 0;
    session.watchAddSync = (...args) => {
      if (calls > 0) stop.abort();
      return add(...args);
    };
    await followBoard(
      session,
      SPACE,
      { pieces: {}, docs: {} },
      BOARD,
      async () => {
        if (++calls === 1) {
          await board.write({
            "of:fid1:comment-2": {
              value: { author: { name: "Bo" }, body: "Live.", sentAt: 9000 },
            },
            "of:fid1:input-1": {
              value: {
                ...INPUT_1,
                comments: [
                  link("of:fid1:comment-1"),
                  link("of:fid1:comment-2"),
                ],
              },
            },
          });
        }
      },
      stop.signal,
    );
    await client.close();

    expect(calls).toBe(1);
  });

  it("reads an entry once where it leads exists, whether named before following began or after", async () => {
    await board.delete("of:fid1:topic-alias-1");
    const seen: string[][] = [];
    await follow(async ({ topics, unreached }, count) => {
      seen.push([...topics.map((topic) => topic.number), "/", ...unreached]);
      if (count === 1) {
        await board.write({
          "of:fid1:topic-alias-1": BOARD_DOCS["of:fid1:topic-alias-1"],
        });
      } else if (count === 2) {
        await board.write({
          "of:fid1:board-input": {
            value: {
              names: {
                "1": link("of:fid1:topic-alias-1"),
                "2": link("of:fid1:topic-piece-2"),
                "3": link("of:fid1:topic-alias-3"),
              },
            },
          },
        });
      } else if (count === 3) {
        await board.write({
          "of:fid1:topic-piece-3": {
            value: {},
            argument: link("of:fid1:input-3"),
          },
          "of:fid1:input-3": {
            value: { title: "Third", comments: [], links: [] },
          },
          "of:fid1:topic-alias-3": { value: link("of:fid1:topic-piece-3") },
        });
      }
      return count === 4;
    });

    expect(seen).toEqual([
      ["2", "/", "1"],
      ["1", "2", "/"],
      ["1", "2", "/", "3"],
      ["1", "2", "3", "/"],
    ]);
  });

  it("reads a document a Topic links once it is written, whether it was missing or deleted when following began", async () => {
    await board.delete("of:fid1:comment-1");
    await board.write({
      "of:fid1:input-1": {
        value: {
          ...INPUT_1,
          comments: [link("of:fid1:comment-1"), link("of:fid1:comment-9")],
        },
      },
    });
    const seen: string[][] = [];
    await follow(async ({ topics }, count) => {
      seen.push(comments(topics));
      const body = ["Back.", "New."][count - 1];
      if (body !== undefined) {
        await board.write({
          [count === 1 ? "of:fid1:comment-1" : "of:fid1:comment-9"]: {
            value: { author: { name: "Bo" }, body, sentAt: 9000 },
          },
        });
      }
      return count === 3;
    });

    expect(seen).toEqual([["", ""], ["Back.", ""], ["Back.", "New."]]);
  });

  it("reads an entry whose document leads nowhere yet once it leads to a Topic", async () => {
    await board.write({
      "of:fid1:topic-alias-3": { value: {} },
      "of:fid1:board-input": {
        value: {
          names: {
            "1": link("of:fid1:topic-alias-1"),
            "2": link("of:fid1:topic-piece-2"),
            "3": link("of:fid1:topic-alias-3"),
          },
        },
      },
    });
    const seen: string[][] = [];
    await follow(async ({ topics, unreached }, count) => {
      seen.push([...topics.map((topic) => topic.number), "/", ...unreached]);
      if (count === 1) {
        await board.write({
          "of:fid1:topic-piece-3": {
            value: {},
            argument: link("of:fid1:input-3"),
          },
          "of:fid1:input-3": {
            value: { title: "Third", comments: [], links: [] },
          },
        });
        await board.write({
          "of:fid1:topic-alias-3": { value: link("of:fid1:topic-piece-3") },
        });
      }
      return count === 2;
    });

    expect(seen).toEqual([["1", "2", "/", "3"], ["1", "2", "3", "/"]]);
  });

  it("reports nothing for a change to a document no Topic links any more", async () => {
    const titles: string[] = [];
    await follow(async ({ topics }, count) => {
      titles.push(topics[1].title);
      if (count === 1) {
        await board.write({
          "of:fid1:input-1": { value: { ...INPUT_1, comments: [] } },
        });
      } else if (count === 2) {
        await board.write({
          "of:fid1:comment-1": {
            value: { author: { name: "Ada" }, body: "Gone.", sentAt: 2000 },
          },
        });
        await board.write({
          "of:fid1:input-2": {
            value: { title: "Marker", comments: [], links: [] },
          },
        });
      }
      return count === 3;
    });

    expect(titles).toEqual(["Donut glaze", "Donut glaze", "Marker"]);
  });

  it("throws a failure that comes before it was stopped", async () => {
    const { client, session } = await board.mount();
    await client.close();

    await expect(
      followBoard(
        session,
        SPACE,
        { pieces: {}, docs: {} },
        BOARD,
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/closed/);
  });

  it("leaves the copy holding what it followed", async () => {
    const data = await follow(() => true);

    expect(data.boardInput).toBe("of:fid1:board-input");
    expect(Object.keys(data.pieces).length).toBe(2);
  });
});
