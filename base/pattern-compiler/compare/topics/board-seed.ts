/**
 * Reads a Topics board out of a snapshot of its space and writes what the
 * board demands of each of its topics as a seed for `scale.ts --seed`.
 *
 * `deno run -A --no-check base/pattern-compiler/compare/topics/board-seed.ts <snapshot> <board> <seed>`
 *
 * `<snapshot>` is a space's store file, named `<did>.sqlite` as a memory
 * server names it; the script reads a copy of it, so the snapshot is never
 * written. `<board>` is the board's entity (`of:…`). `<seed>` is the JSON file
 * written: each topic's fields of `TopicDemand` (`main.tsx`) as plain values,
 * with `mentions` as the indexes of the topics they refer to, and the board's
 * namespace as each name with the index of its topic.
 *
 * The board is read through its result under a schema of those fields, as
 * the board's own reads see each topic. A mention or a name that refers to
 * no topic of the board is left out and counted, and so is the picture of an
 * author, which `scale.ts` does not carry: the seed holds an author's kind,
 * name and avatar.
 *
 * A seed holds the content of the board's topics. Keep it beside the
 * snapshot and out of the repository.
 */
import { Identity } from "@commonfabric/identity";
import { basename, join, toFileUrl } from "@std/path";

import { Runtime } from "../../../../runtime/runner/src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../../../runtime/runner/src/storage/v2-emulate.ts";

/** What the seed holds of one topic. */
export type SeedTopic = {
  $NAME: string;
  title: string;
  body: string;
  createdAt: number;
  createdBy: { kind: string; name: string; avatar?: string };
  commentCount: number;
  lastActivityAt: number;
  shortName?: string;
  mentions: number[];
};

/** A seed: the topics, the namespace, and what was left out. */
export type Seed = {
  board: string;
  space: string;
  topics: SeedTopic[];
  names: Record<string, number>;
  leftOut: {
    mentions: number;
    names: number;
    pictures: number;
  };
};

const REFERENCE = { asCell: ["cell"] } as const;

const TOPIC_SCHEMA = {
  type: "object",
  properties: {
    $NAME: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    createdAt: { type: "number" },
    createdBy: {
      type: "object",
      properties: {
        kind: { type: "string" },
        name: { type: "string" },
        avatar: { type: "string" },
        picture: true,
      },
    },
    commentCount: { type: "number" },
    lastActivityAt: { type: "number" },
    shortName: { type: "string" },
    mentions: { type: "array", items: REFERENCE },
  },
} as const;

const BOARD_SCHEMA = {
  type: "object",
  properties: {
    topics: { type: "array", items: { ...TOPIC_SCHEMA, asCell: ["cell"] } },
    names: { type: "object", additionalProperties: REFERENCE },
  },
} as const;

// deno-lint-ignore no-explicit-any
type AnyCell = any;

/** The identity of what a reference finally refers to. */
const identityOf = (cell: AnyCell): string => {
  const { id, path } = cell.resolveAsCell().getAsNormalizedFullLink();
  return JSON.stringify([id, path]);
};

/** A copy of `snapshot` in a store directory a memory server reads. */
const storeCopy = async (snapshot: string): Promise<string> => {
  const store = await Deno.makeTempDir({ prefix: "topics-board-seed-" });
  const engine = join(store, "engine-v3");
  await Deno.mkdir(engine);
  const target = join(engine, basename(snapshot));
  // An APFS clone where the file system has one, a copy otherwise.
  const cloned = Deno.build.os === "darwin" &&
    (await new Deno.Command("cp", { args: ["-c", snapshot, target] }).output())
      .success;
  if (!cloned) await Deno.copyFile(snapshot, target);
  return store;
};

const readBoard = async (
  snapshot: string,
  board: string,
): Promise<Seed> => {
  const space = basename(snapshot).replace(/\.sqlite$/, "");
  const store = await storeCopy(snapshot);
  const server = newLoopbackServer({ store: toFileUrl(`${store}/`) });
  const signer = await Identity.fromPassphrase("topics board seed");
  const storageManager = EmulatedStorageManager.connectTo(server, {
    as: signer,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const result: AnyCell = runtime.getCellFromLink(
      {
        id: board as `${string}:${string}`,
        space: space as `did:${string}`,
        path: [],
      },
      BOARD_SCHEMA,
    );
    await result.pull();
    const value = result.get() as {
      topics?: AnyCell[];
      names?: Record<string, AnyCell>;
    };
    const cells = value.topics ?? [];
    const indexOf = new Map<string, number>();
    cells.forEach((cell, index) => indexOf.set(identityOf(cell), index));
    const leftOut = { mentions: 0, names: 0, pictures: 0 };
    const topics = cells.map((cell): SeedTopic => {
      const topic = cell.get() as Record<string, unknown> & {
        createdBy?: Record<string, unknown>;
        mentions?: AnyCell[];
      };
      const mentions: number[] = [];
      for (const mention of topic.mentions ?? []) {
        const index = indexOf.get(identityOf(mention));
        if (index === undefined) leftOut.mentions++;
        else mentions.push(index);
      }
      const author = topic.createdBy ?? {};
      if (author.picture !== undefined) leftOut.pictures++;
      return {
        $NAME: String(topic.$NAME ?? ""),
        title: String(topic.title ?? ""),
        body: String(topic.body ?? ""),
        createdAt: Number(topic.createdAt ?? 0),
        createdBy: {
          kind: String(author.kind ?? "person"),
          name: String(author.name ?? ""),
          ...(typeof author.avatar === "string"
            ? { avatar: author.avatar }
            : {}),
        },
        commentCount: Number(topic.commentCount ?? 0),
        lastActivityAt: Number(topic.lastActivityAt ?? 0),
        ...(typeof topic.shortName === "string"
          ? { shortName: topic.shortName }
          : {}),
        mentions,
      };
    });
    const names: Record<string, number> = {};
    for (const [name, cell] of Object.entries(value.names ?? {})) {
      const index = indexOf.get(identityOf(cell));
      if (index === undefined) leftOut.names++;
      else names[name] = index;
    }
    return { board, space, topics, names, leftOut };
  } finally {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
    await Deno.remove(store, { recursive: true });
  }
};

if (import.meta.main) {
  const [snapshot, board, out] = Deno.args;
  if (snapshot === undefined || board === undefined || out === undefined) {
    console.error("usage: board-seed.ts <snapshot> <board> <seed>");
    Deno.exit(2);
  }
  const began = performance.now();
  const seed = await readBoard(snapshot, board);
  await Deno.writeTextFile(out, JSON.stringify(seed));
  const mentions = seed.topics.reduce((sum, t) => sum + t.mentions.length, 0);
  console.log(JSON.stringify({
    topics: seed.topics.length,
    mentions,
    names: Object.keys(seed.names).length,
    leftOut: seed.leftOut,
    bodyBytes: seed.topics.reduce((sum, t) => sum + t.body.length, 0),
    seconds: Math.round(performance.now() - began) / 1000,
  }));
}
