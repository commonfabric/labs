/**
 * Where the Topics board keeps its mention pivot and a topic keeps its
 * backlinks, as a session that never runs either reads them. Each derivation is
 * stored in the document its binding names. Where that document's space-scope
 * value is a link to each reader's own session instance, a run stores the
 * derivation behind the link, in the running session's instance, and every
 * other session reads it empty. Each case starts from a board whose pivot is
 * bound as `crossrefs` over a document holding such a link, the state a
 * deployed board is in, and whose topics bind their backlinks as
 * `referencedBy`. A deployed board computes no index of its pivot, so neither
 * does that board, and its topics hold no link to one.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

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
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const BOARD_PATH = fromFileUrl(
  new URL("../apps/topics/main.tsx", import.meta.url),
);
const TOPIC_PATH = fromFileUrl(
  new URL("../apps/topics/topic.tsx", import.meta.url),
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

/** The board's result, read for its index's buckets. */
const INDEX_READ = {
  type: "object",
  properties: {
    crossrefIndex: {
      type: "object",
      properties: {
        byName: {
          type: "object",
          additionalProperties: {
            type: "array",
            items: { type: "object", properties: { topic: TITLED } },
          },
          default: {},
        },
      },
      default: {},
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

interface IndexRead {
  crossrefIndex: { byName: Record<string, { topic?: Titled }[]> };
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

/** The current source with `main` as its entry. */
function currentSource(runtime: Runtime, main = BOARD_PATH) {
  return resolveLocalProgram(
    (resolver) => runtime.harness.resolve(resolver),
    { main, root: ROOT_PATH },
  );
}

/**
 * `program` with the derivation `statement` matches in `file` stored in the
 * document `name`. The rest of the file reaches the derivation by the name the
 * current source binds it as, which here aliases `name`. `statement` captures
 * the binding's name and the expression it binds.
 */
function storedAs(
  program: RuntimeProgram,
  file: string,
  statement: RegExp,
  name: string,
): RuntimeProgram {
  return {
    ...program,
    files: program.files.map((each) => {
      if (!file.endsWith(each.name)) return each;
      const [, bound, expression] = each.contents.match(statement) ?? [];
      if (bound === undefined) {
        throw new Error(`${file} has no binding matching ${statement}`);
      }
      if (bound === name) return each;
      return {
        ...each,
        contents: each.contents.replace(
          statement,
          `const ${name} = ${expression};\n  const ${bound} = ${name};`,
        ),
      };
    }),
  };
}

/** `program` with the one match of `wiring` in `file` taken out. */
function unwired(
  program: RuntimeProgram,
  file: string,
  wiring: RegExp,
): RuntimeProgram {
  return {
    ...program,
    files: program.files.map((each) => {
      if (!file.endsWith(each.name)) return each;
      if (each.contents.match(new RegExp(wiring, "g"))?.length !== 1) {
        throw new Error(`${file} has no single match of ${wiring}`);
      }
      return { ...each, contents: each.contents.replace(wiring, "") };
    }),
  };
}

/**
 * The board's current source with its pivot bound as `crossrefs` and each
 * topic's backlinks bound as `referencedBy`, and with no index in use: the
 * board stores its index in a document the current source does not name, and
 * `addTopic` wires no topic to it. The current source's index is then, as on a
 * deployed board, a document no earlier run has written.
 */
async function deployedSource(runtime: Runtime): Promise<RuntimeProgram> {
  return unwired(
    storedAs(
      storedAs(
        storedAs(
          await currentSource(runtime),
          BOARD_PATH,
          /const (\w+) = (crossrefTable\(\{ sources: topics \}\));/,
          "crossrefs",
        ),
        BOARD_PATH,
        /const (\w+) = (crossrefIndexOf\(\{ rows: \w+ \}\));/,
        "unusedCrossrefIndex",
      ),
      TOPIC_PATH,
      /const (\w+) = (backlinksOf\(\{[^}]*\}\));/,
      "referencedBy",
    ),
    BOARD_PATH,
    /\n\s*boardCrossrefIndex: crossrefIndex,(?=\n\s*\}\);)/,
  );
}

/** The document `result`'s `key` output reads its value from. */
function documentOf(runtime: Runtime, result: Cell<unknown>, key: string) {
  const raw = result.getRaw() as Record<string, unknown> | undefined;
  const link = parseLink(raw?.[key], result);
  if (link === undefined) throw new Error(`the result has no \`${key}\` link`);
  return runtime.getCellFromLink<unknown>({ ...link, overwrite: undefined });
}

/**
 * Sets `document`'s space-scope value to a link to each reader's own session
 * instance of it.
 */
async function redirectToSession(runtime: Runtime, document: Cell<unknown>) {
  await runtime.editWithRetry((tx) => {
    const broad = document.withTx(tx);
    const own = runtime.getCellFromLink(
      { ...document.getAsNormalizedFullLink(), scope: "session" },
      undefined,
      tx,
    );
    broad.setRaw(own.getAsLink({ base: broad }));
  });
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
   * A board started from `deployedSource()` in a session of its own, whose
   * pivot document holds at space scope a link to each reader's session
   * instance, and which holds two topics, Beta mentioning Alpha.
   */
  const boardOverSessionRedirect = async () => {
    const writer = await openSession();
    const board = await writer.pieces.create(
      await deployedSource(writer.runtime),
      { input: {} },
    );
    await writer.runtime.idle();
    const pivot = documentOf(writer.runtime, board.getCell(), "crossrefs");
    await redirectToSession(writer.runtime, pivot);

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

  /**
   * `boardOverSessionRedirect()` with Alpha run in the writer's session before
   * the update, and Alpha's backlinks document holding at space scope a link to
   * each reader's session instance, the state many deployed topics are in.
   */
  const topicOverSessionRedirect = async () => {
    const setup = await boardOverSessionRedirect();
    await runTopic(setup.writer, setup.alpha);
    const backlinks = documentOf(
      setup.writer.runtime,
      setup.alpha,
      "referencedBy",
    );
    await redirectToSession(setup.writer.runtime, backlinks);
    return { ...setup, backlinks };
  };

  /**
   * The update in the rollout's order: the board takes the current source,
   * then each topic is rebound to the board's `crossrefs` output, and to its
   * `crossrefIndex` output when `bindIndex` is set, and, when
   * `topicsTakeSource` is set, takes the current topic source, without being
   * started.
   */
  const update = async (
    { writer, board, alpha, beta }: Awaited<
      ReturnType<typeof boardOverSessionRedirect>
    >,
    { topicsTakeSource, bindIndex = false }: {
      topicsTakeSource: boolean;
      bindIndex?: boolean;
    },
  ) => {
    await board.setPattern(await currentSource(writer.runtime));
    const topicSource = await currentSource(writer.runtime, TOPIC_PATH);
    for (const topic of [alpha, beta]) {
      await writer.pieces.link(
        board.id,
        ["crossrefs"],
        pieceId(topic)!,
        ["boardCrossrefs"],
        { start: false },
      );
      if (bindIndex) {
        await writer.pieces.link(
          board.id,
          ["crossrefIndex"],
          pieceId(topic)!,
          ["boardCrossrefIndex"],
          { start: false },
        );
      }
      if (topicsTakeSource) {
        const controller = await writer.pieces.get(pieceId(topic)!, false);
        await controller.setPattern(topicSource);
      }
    }
    await board.getCell().key("crossrefs").pull();
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

    const setup = await boardOverSessionRedirect();
    await update(setup, { topicsTakeSource: false });
    await runTopic(setup.writer, setup.alpha);

    expect(await readInFreshSession(setup.board, setup.alpha)).toEqual({
      topics: ["Alpha", "Beta"],
      rows: ROWS,
      referencedBy: ["Beta"],
    });
  });

  it("leaves a fresh session no inbound reference for a topic that ran over the redirect and keeps its backlinks bound as `referencedBy`", async () => {
    // The writer's session reads Alpha's backlink after the update, so what
    // the fresh session misses is there to be read.

    const setup = await topicOverSessionRedirect();
    await update(setup, { topicsTakeSource: false });
    await runTopic(setup.writer, setup.alpha);

    expect(
      (setup.alpha.asSchema(TOPIC_READ).get() as unknown as TopicRead)
        .referencedBy.map((each) => each.title),
    ).toEqual(["Beta"]);
    expect(parseLink(setup.backlinks.getRaw(), setup.backlinks))
      .toMatchObject({
        id: setup.backlinks.getAsNormalizedFullLink().id,
        scope: "session",
      });
    expect(await readInFreshSession(setup.board, setup.alpha)).toEqual({
      topics: ["Alpha", "Beta"],
      rows: ROWS,
      referencedBy: [],
    });
  });

  it("gives a fresh session the inbound reference of a topic that ran over the redirect once the topic takes the current source", async () => {
    const setup = await topicOverSessionRedirect();
    await update(setup, { topicsTakeSource: true });
    await runTopic(setup.writer, setup.alpha);

    expect(await readInFreshSession(setup.board, setup.alpha)).toEqual({
      topics: ["Alpha", "Beta"],
      rows: ROWS,
      referencedBy: ["Beta"],
    });
  });

  it("gives a fresh session the board's index and the inbound reference of a topic that ran over the redirect once the topic takes the current source and is bound to the index", async () => {
    // The lookup now reads the index as well as the pivot, and a run stores
    // its result at the narrowest scope it read, so this holds only while the
    // index is stored at space scope, where the fresh session reads it below.

    const setup = await topicOverSessionRedirect();
    await update(setup, { topicsTakeSource: true, bindIndex: true });
    await runTopic(setup.writer, setup.alpha);

    expect(await readInFreshSession(setup.board, setup.alpha)).toEqual({
      topics: ["Alpha", "Beta"],
      rows: ROWS,
      referencedBy: ["Beta"],
    });
    const { runtime } = await openSession();
    const indexRead = runtime.getCellFromLink<IndexRead>(
      setup.board.getCell().getAsNormalizedFullLink(),
      INDEX_READ,
    );
    await indexRead.sync();
    await runtime.storageManager.synced();
    const { byName } = indexRead.get().crossrefIndex;
    expect(
      Object.fromEntries(
        Object.entries(byName).map((
          [name, bucket],
        ) => [name, bucket.map((row) => row.topic?.title)]),
      ),
    ).toEqual({ "1": ["Alpha"], "2": ["Beta"] });
  });
});

/**
 * What a session that reads a topic loads of the other topics. The pivot's
 * rows reach every topic, so a read that followed a row's references would
 * load every topic's piece. Two reads are held to it: a topic's input under
 * the argument schema its piece links it with, which is how `cf piece call`
 * and `cf piece step` read it, and the pivot under the schema the backlinks
 * lookup declares, which is what loading the pivot for the lookup costs.
 */
describe("topic-board-pivot-reads", () => {
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
   * A board on the current source holding four topics, Beta mentioning Alpha
   * and Delta mentioning Gamma, with its pivot and index computed.
   */
  const boardOfFour = async () => {
    const writer = await openSession();
    const board = await writer.pieces.create(
      await currentSource(writer.runtime),
      { input: {} },
    );
    await writer.runtime.idle();
    const result = board.getCell() as Cell<Record<string, unknown>>;
    for (const title of ["Alpha", "Beta", "Gamma", "Delta"]) {
      await result.key("addTopic").pull();
      result.key("addTopic").send({ title, agentName: "Fixture" });
      await writer.runtime.idle();
    }
    const [alpha, beta, gamma, delta] = result.asSchema(TOPIC_CELLS).key(
      "topics",
    ).get() as unknown as Cell<Record<string, unknown>>[];
    for (const [source, target] of [[beta, alpha], [delta, gamma]]) {
      await source.key("mention").pull();
      source.key("mention").send({ topic: target });
      await writer.runtime.idle();
    }
    await result.key("crossrefs").pull();
    await result.key("crossrefIndex").pull();
    await writer.runtime.idle();
    await writer.pieces.synced();
    return { writer, alpha, beta, gamma, delta };
  };

  /** Which of `topics`' pieces `session` holds a document for. */
  const piecesHeld = (session: Session, topics: Cell<unknown>[]) => {
    // Without reading through to the server, as `getDocument` does on a miss.
    const replica = session.runtime.storageManager.open(space)
      .replica as unknown as { confirmedDocumentSeq(id: string): number };
    return topics.filter((topic) =>
      replica.confirmedDocumentSeq(`of:${pieceId(topic)!}`) > 0
    ).map((topic) => (topic.get() as Titled).title);
  };

  /**
   * The schema the backlinks lookup (`backlinksOf`) reads the pivot under,
   * taken from the current topic source as compiled: the lift whose
   * parameters are `table`, `index` and `self`.
   */
  const backlinksTableSchema = async (session: Session) => {
    const topic = await session.runtime.patternManager.compilePattern(
      await currentSource(session.runtime, TOPIC_PATH),
      { space },
    );
    const lookups = topic.nodes.flatMap((node) => {
      const schema = (node.module as { argumentSchema?: JSONSchema })
        .argumentSchema;
      const properties = typeof schema === "object"
        ? schema.properties
        : undefined;
      return properties?.table !== undefined &&
          properties.index !== undefined && properties.self !== undefined
        ? [schema as Exclude<JSONSchema, boolean>]
        : [];
    });
    if (lookups.length !== 1) {
      throw new Error(`the topic has ${lookups.length} backlinks lookups`);
    }
    const [lookup] = lookups;
    return {
      ...(lookup.properties!.table as Exclude<JSONSchema, boolean>),
      ...(lookup.$defs === undefined ? {} : { $defs: lookup.$defs }),
    } as JSONSchema;
  };

  it("reads a topic's input without loading another topic's piece", async () => {
    const { alpha, beta, gamma, delta } = await boardOfFour();
    const argument = parseLink(alpha.getMetaRaw("argument"), alpha);
    if (argument === undefined) throw new Error("Alpha has no argument link");

    const reader = await openSession();
    const input = reader.runtime.getCellFromLink<unknown>(argument);
    await input.sync();
    await reader.runtime.storageManager.synced();

    expect(piecesHeld(reader, [beta, gamma, delta])).toEqual([]);
  });

  it("reads the pivot for a topic's backlinks without loading a topic's piece", async () => {
    // What the lookup's declaration of the rows costs a session that loads
    // the pivot for it. With the lift's `mentionedBy` reverted to `unknown[]`
    // by hand, this read loaded Beta and Delta, the two topics that mention
    // another.
    const { alpha, beta, gamma, delta } = await boardOfFour();
    const argument = parseLink(alpha.getMetaRaw("argument"), alpha);
    if (argument === undefined) throw new Error("Alpha has no argument link");

    const reader = await openSession();
    const table = reader.runtime.getCellFromLink<unknown>({
      ...argument,
      path: [...argument.path, "boardCrossrefs"],
      schema: await backlinksTableSchema(reader),
    });
    await table.sync();
    await reader.runtime.storageManager.synced();

    expect(piecesHeld(reader, [alpha, beta, gamma, delta])).toEqual([]);
  });
});
