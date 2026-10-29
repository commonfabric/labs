/**
 * Where the Topics board keeps its mention pivot, as a session that never runs
 * the board reads it. The pivot's rows are stored in the document its binding
 * names. Where that document's space-scope value is a link to each reader's own
 * session instance, a run stores the rows behind the link, in the running
 * session's instance, and every other session reads an empty index. Each case
 * starts from a board whose pivot is bound as `crossrefs` over a document
 * holding such a link, the state a deployed board is in.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { pieceId } from "@commonfabric/piece";
import {
  type PieceController,
  PiecesController,
} from "@commonfabric/piece/ops";
import {
  type Cell,
  type JSONSchema,
  type MemorySpace,
  parseLink,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const BOARD_PATH = fromFileUrl(
  new URL("../apps/topics/main.tsx", import.meta.url),
);
const ROOT_PATH = fromFileUrl(new URL("..", import.meta.url));
const signer = await Identity.fromPassphrase("topic board pivot sessions");
const space = signer.did() as MemorySpace;

/** A topic, read for its title alone. */
const TITLED = {
  type: "object",
  properties: { title: { type: "string" } },
} as const satisfies JSONSchema;

/** The board's result, read for its topics and its pivot rows. */
const BOARD_READ = {
  type: "object",
  properties: {
    topics: { type: "array", items: TITLED, default: [] },
    crossrefs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: TITLED,
          mentionedBy: { type: "array", items: TITLED, default: [] },
        },
      },
      default: [],
    },
  },
} as const satisfies JSONSchema;

/** A topic's result, read for the topics that mention it. */
const TOPIC_READ = {
  type: "object",
  properties: {
    referencedBy: { type: "array", items: TITLED, default: [] },
  },
} as const satisfies JSONSchema;

/** The board's result, read for its topics as cells. */
const TOPIC_CELLS = {
  type: "object",
  properties: { topics: { type: "array", items: { asCell: ["cell"] } } },
} as const satisfies JSONSchema;

type Titled = { title?: string };

interface BoardRead {
  topics: Titled[];
  crossrefs: { topic?: Titled; mentionedBy: Titled[] }[];
}

interface TopicRead {
  referencedBy: Titled[];
}

type Session = Awaited<ReturnType<typeof openSessionOn>>;

/** A runtime with a session of its own on `server`. */
async function openSessionOn(server: ReturnType<typeof newLoopbackServer>) {
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: { serverExecution: false },
  });
  const pieces = new PiecesController(
    createSession({ identity: signer, spaceDid: space }),
    runtime,
  );
  await pieces.synced();
  return { runtime, storage, pieces };
}

/** The board's current source. */
function currentSource(runtime: Runtime): Promise<RuntimeProgram> {
  return resolveLocalProgram(
    (resolver) => runtime.harness.resolve(resolver),
    { main: BOARD_PATH, root: ROOT_PATH },
  );
}

/**
 * The board's current source with its pivot bound as `crossrefs`. The rest of
 * the board reaches the pivot by the name the current source binds it as,
 * which here aliases `crossrefs`.
 */
async function crossrefsSource(runtime: Runtime): Promise<RuntimeProgram> {
  const program = await currentSource(runtime);
  const binding = /const (\w+) = crossrefTable\(\{ sources: topics \}\);/;
  return {
    ...program,
    files: program.files.map((file) => {
      if (file.name !== program.main) return file;
      const name = file.contents.match(binding)?.[1];
      if (name === undefined) {
        throw new Error(`${BOARD_PATH} binds no \`crossrefTable\` pivot`);
      }
      if (name === "crossrefs") return file;
      return {
        ...file,
        contents: file.contents.replace(
          binding,
          "const crossrefs = crossrefTable({ sources: topics });\n" +
            `  const ${name} = crossrefs;`,
        ),
      };
    }),
  };
}

/** The document the board's `crossrefs` output reads its rows from. */
function pivotDocumentOf(runtime: Runtime, board: PieceController) {
  const result = board.getCell() as Cell<Record<string, unknown>>;
  const link = parseLink(result.getRaw()?.crossrefs, result);
  if (link === undefined) throw new Error("the board has no pivot link");
  return runtime.getCellFromLink<unknown>({ ...link, overwrite: undefined });
}

/** The titles in `board`'s topics and pivot rows, and in `topic`'s backlinks. */
function titlesOf(board: BoardRead, topic: TopicRead) {
  return {
    topics: board.topics.map((each) => each.title),
    rows: board.crossrefs.map((row) => ({
      topic: row.topic?.title,
      mentionedBy: row.mentionedBy.map((each) => each.title),
    })),
    referencedBy: topic.referencedBy.map((each) => each.title),
  };
}

/** The pivot rows Alpha and Beta make, Beta mentioning Alpha. */
const ROWS = [
  { topic: "Alpha", mentionedBy: ["Beta"] },
  { topic: "Beta", mentionedBy: [] },
];

describe("topic-board-pivot-sessions", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let opened: Session[];

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    opened = [];
  });
  afterEach(async () => {
    for (const { runtime, storage } of opened) {
      await runtime.dispose();
      await storage.close();
    }
    await server.close();
  });

  const openSession = async (): Promise<Session> => {
    const session = await openSessionOn(server);
    opened.push(session);
    return session;
  };

  /**
   * A board started from `crossrefsSource()` in a session of its own, whose
   * pivot document holds at space scope a link to each reader's session
   * instance, and which holds two topics, Beta mentioning Alpha.
   */
  const boardOverSessionRedirect = async () => {
    const writer = await openSession();
    const board = await writer.pieces.create(
      await crossrefsSource(writer.runtime),
      { input: {} },
    );
    await writer.runtime.idle();
    const pivot = pivotDocumentOf(writer.runtime, board);
    await writer.runtime.editWithRetry((tx) => {
      const broad = pivot.withTx(tx);
      const own = writer.runtime.getCellFromLink(
        { ...pivot.getAsNormalizedFullLink(), scope: "session" },
        undefined,
        tx,
      );
      broad.setRaw(own.getAsLink({ base: broad }));
    });

    const result = board.getCell() as Cell<Record<string, unknown>>;
    for (const title of ["Alpha", "Beta"]) {
      await result.key("addTopic").pull();
      result.key("addTopic").send({ title, agentName: "Fixture" });
      await writer.runtime.idle();
    }
    const [alpha, beta] = result.asSchema(TOPIC_CELLS).key("topics")
      .get() as unknown as Cell<Record<string, unknown>>[];
    await beta.key("mention").pull();
    beta.key("mention").send({ topic: alpha });
    await writer.runtime.idle();
    await result.key("crossrefs").pull();
    await writer.runtime.idle();
    await writer.pieces.synced();
    return { writer, board, alpha, beta, pivot };
  };

  /** Starts `topic` in `session` and runs its backlinks there. */
  const runTopic = async (session: Session, topic: Cell<unknown>) => {
    await session.pieces.startPiece(pieceId(topic)!);
    await topic.key("referencedBy").pull();
    await session.runtime.idle();
    await session.pieces.synced();
  };

  /** What a new session that starts nothing reads of `board` and `topic`. */
  const readInFreshSession = async (
    board: PieceController,
    topic: Cell<unknown>,
  ) => {
    const { runtime } = await openSession();
    const boardRead = runtime.getCellFromLink<BoardRead>(
      board.getCell().getAsNormalizedFullLink(),
      BOARD_READ,
    );
    const topicRead = runtime.getCellFromLink<TopicRead>(
      topic.getAsNormalizedFullLink(),
      TOPIC_READ,
    );
    await boardRead.sync();
    await topicRead.sync();
    await runtime.storageManager.synced();
    return titlesOf(boardRead.get(), topicRead.get());
  };

  it("leaves a fresh session an empty index and no inbound reference while the pivot is bound as `crossrefs`", async () => {
    // The board's own session reads the rows and Alpha's backlink, so what the
    // fresh session misses is there to be read.

    const { writer, board, alpha, pivot } = await boardOverSessionRedirect();
    await runTopic(writer, alpha);

    expect(
      titlesOf(
        board.getCell().asSchema(BOARD_READ).get() as unknown as BoardRead,
        alpha.asSchema(TOPIC_READ).get() as unknown as TopicRead,
      ),
    ).toEqual({
      topics: ["Alpha", "Beta"],
      rows: ROWS,
      referencedBy: ["Beta"],
    });
    expect(parseLink(pivot.getRaw(), pivot)).toMatchObject({
      id: pivot.getAsNormalizedFullLink().id,
      scope: "session",
    });
    expect(await readInFreshSession(board, alpha)).toEqual({
      topics: ["Alpha", "Beta"],
      rows: [],
      referencedBy: [],
    });
  });

  it("gives a fresh session the pivot rows and a topic's inbound reference once the current source is applied", async () => {
    // The update runs in the rollout's order: the board takes the current
    // source, then each topic is rebound to the board's `crossrefs` output
    // without being started. Alpha first runs after that rebinding.

    const { writer, board, alpha, beta } = await boardOverSessionRedirect();
    await board.setPattern(await currentSource(writer.runtime));
    for (const topic of [alpha, beta]) {
      await writer.pieces.link(
        board.id,
        ["crossrefs"],
        pieceId(topic)!,
        ["boardCrossrefs"],
        { start: false },
      );
    }
    await board.getCell().key("crossrefs").pull();
    await runTopic(writer, alpha);

    expect(await readInFreshSession(board, alpha)).toEqual({
      topics: ["Alpha", "Beta"],
      rows: ROWS,
      referencedBy: ["Beta"],
    });
  });
});
