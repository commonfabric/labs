/**
 * `topics-export.ts` against a seeded snapshot, run the way an operator runs
 * it: as a subprocess, under a permission list that grants no right to start
 * a process.
 *
 * That framing carries the property this file exists to hold. The export
 * reads the store once through `@commonfabric/state-inspector` instead of
 * shelling out to `cf` per entity, which is the difference between 24 seconds
 * and days against the real Topics space — and a permission list is where
 * that choice becomes observable from outside a wall clock. Reading the store
 * needs FFI, the environment, and on a cold cache the network; spawning `cf`
 * needs `--allow-run`, which is withheld here, so a selection that went back
 * to a subprocess fails on its first read rather than merely taking hours.
 *
 * The rest of the assertions cover what the export must not quietly change
 * while getting faster: comment elements resolved to their stored content,
 * the annotated `$link` shape kept in the forensic copy, and a listing that
 * cannot cover the space refused rather than written out as if it had.
 */

import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";
import { fromFileUrl } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import type { TopicsExport } from "./topics-rehearsal-lib.ts";

const SCRIPT = fromFileUrl(new URL("./topics-export.ts", import.meta.url));
const REPO_ROOT = fromFileUrl(new URL("../", import.meta.url));

/**
 * The permissions every run below is given — written out here rather than
 * read back from the shebang, so that reverting the script to a subprocess
 * per entity fails these tests instead of travelling with them.
 *
 * The two hosts are where `plug` fetches the SQLite library on a cold cache,
 * and they are here so that this list and the shebang can be asserted equal.
 * The runs below never reach them: seeding opens SQLite in this process
 * first, which leaves the library cached for the subprocess.
 */
const RUN_PERMISSIONS = [
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-ffi",
  "--allow-net=github.com,release-assets.githubusercontent.com",
];

/** The `--allow-…` flags the script's own shebang declares, in order. */
function shebangPermissions(): string[] {
  return Deno.readTextFileSync(SCRIPT)
    .split("\n")[0]
    .split(/\s+/)
    .filter((word) => word.startsWith("--allow-"));
}

const SESSION = "session:did%3Akey%3AzTopicsDrill:s1";
const BOARD_IDENTITY = "MKlcErXYo-5CPTDJD2r1Gl08KwiWcxqxmuDGikVcTqk";
const TOPIC_IDENTITY = "uqb-PnkKp_PJYZ6F82dth3k5KNaZLzt9sBgFafbllkw";

const BOARD = "of:fid1:board";
const BOARD_ARGUMENT = "of:fid1:board-argument";
const TOPIC = "of:fid1:topic";
const TOPIC_ARGUMENT = "of:fid1:topic-argument";
const COMMENT = "of:fid1:comment";

/** A stored link, in the sigil form the engine writes. */
const link = (id: string) => ({ "/": { "link@1": { id } } });

const stream = { $stream: true };

/** The comment body an element of `comments` points at, never inlines. */
const COMMENT_VALUE = {
  author: { kind: "agent", name: "drill" },
  authorName: "drill (agent)",
  body: "first drill comment",
  sentAt: 1786913119000,
};

const TOPIC_BODY = "# Drill\n\n    indented code block\n\ntrailing prose";

/**
 * A board, one topic, their argument documents, the topic's one comment, and
 * a free cell that is none of those. Selection is by verb shape, so the two
 * pieces differ only in the keys their result offers.
 */
const ENTITIES: { id: string; document: Record<string, unknown> }[] = [
  {
    id: BOARD,
    document: {
      value: { $NAME: "Topics", addTopic: stream, topics: [link(TOPIC)] },
      patternIdentity: { identity: BOARD_IDENTITY, symbol: "default" },
      argument: link(BOARD_ARGUMENT),
    },
  },
  { id: BOARD_ARGUMENT, document: { value: { topics: [link(TOPIC)] } } },
  {
    id: TOPIC,
    document: {
      value: {
        $NAME: "Drill: alpha",
        addComment: stream,
        addLink: stream,
        setBody: stream,
      },
      patternIdentity: { identity: TOPIC_IDENTITY, symbol: "default" },
      argument: link(TOPIC_ARGUMENT),
    },
  },
  {
    id: TOPIC_ARGUMENT,
    document: {
      value: {
        title: "Drill: alpha",
        body: TOPIC_BODY,
        createdAt: 1786913118000,
        createdByName: "drill",
        comments: [link(COMMENT)],
        links: [],
        mentionable: link(BOARD_ARGUMENT),
      },
    },
  },
  { id: COMMENT, document: { value: COMMENT_VALUE } },
  { id: "of:fid1:unrelated", document: { value: "a free cell" } },
];

const SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON,
  commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
CREATE TABLE branch (
  name TEXT NOT NULL PRIMARY KEY DEFAULT '', parent_branch TEXT,
  fork_seq INTEGER, created_seq INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO branch (name, head_seq, status) VALUES ('', 999, 'active');`;

const SECOND_COMMENT = "of:fid1:second-comment";
const NESTED = "of:fid1:nested";

/**
 * A stored link to a path inside another document, naming the space and the
 * scope in `at` where it gives them.
 */
const linkAt = (
  id: string,
  path: string[],
  at: { space?: string; scope?: string } = {},
) => ({
  "/": { "link@1": { id, path, ...at } },
});

/** The space the seeded snapshot's file name names. */
const SEEDED_SPACE = "did:key:zSeededTopicsSpace";

/**
 * The topic's second comment, whose author is not a value of its own but a
 * link to the first comment's author: the shape a record takes when a write
 * set its field to another record's field.
 */
const SECOND_COMMENT_VALUE = {
  author: linkAt(COMMENT, ["author"]),
  authorName: "drill (agent)",
  body: "second drill comment",
  sentAt: 1786913120000,
};

/**
 * The fixture's entities with the topic holding a second comment, whose
 * author links `target` at `path` in the space and scope `at` names, and a
 * document holding a link inside an author for a link to point at.
 */
function withSecondComment(
  target: string,
  path: string[],
  at: { space?: string; scope?: string } = {},
): typeof ENTITIES {
  return [
    ...ENTITIES.map((entity) =>
      entity.id === TOPIC_ARGUMENT
        ? {
          id: entity.id,
          document: {
            value: {
              ...(entity.document.value as Record<string, unknown>),
              comments: [link(COMMENT), link(SECOND_COMMENT)],
            },
          },
        }
        : entity
    ),
    {
      id: SECOND_COMMENT,
      document: {
        value: { ...SECOND_COMMENT_VALUE, author: linkAt(target, path, at) },
      },
    },
    {
      id: NESTED,
      document: { value: { author: { kind: "agent", name: link(COMMENT) } } },
    },
  ];
}

/**
 * Write the fixture space. `undecodable` adds a payload no reconstruction can
 * read, which a `kind` scan drops because it cannot classify it — the shape
 * that makes a piece listing cover less than the space. `entities` replaces
 * the fixture's entities.
 */
function seed(
  path: string,
  opts: { undecodable?: boolean; entities?: typeof ENTITIES } = {},
): void {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, '{}', '{"seq":0}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  );
  let seq = 0;
  for (const entity of opts.entities ?? ENTITIES) {
    seq++;
    commit.run(seq, SESSION, seq);
    rev.run(entity.id, seq, JSON.stringify(entity.document), seq);
  }
  if (opts.undecodable) {
    seq++;
    commit.run(seq, SESSION, seq);
    rev.run("of:fid1:corrupt", seq, "<<< not a document >>>", seq);
  }
  db.close();
}

interface ExportRun {
  code: number;
  stdout: string;
  stderr: string;
  outPath: string;
}

/**
 * Seed a space, export it, and return the process result. The seeding opens
 * SQLite in THIS process first, so the dynamic library is already cached by
 * the time the subprocess loads it and no run here depends on the network.
 */
async function runExport(
  opts: { undecodable?: boolean; entities?: typeof ENTITIES } = {},
): Promise<ExportRun> {
  const dir = await Deno.makeTempDir({ prefix: "topics-export-" });
  const dbPath = `${dir}/${SEEDED_SPACE}.sqlite`;
  const outPath = `${dir}/export.json`;
  seed(dbPath, opts);
  const output = await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    args: (lockPath) => [
      "run",
      "--lock",
      lockPath,
      "--frozen=true",
      ...RUN_PERMISSIONS,
      SCRIPT,
      dbPath,
      "--out",
      outPath,
    ],
  });
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    outPath,
  };
}

describe("topics-export", () => {
  describe("a seeded topics space", () => {
    let run: ExportRun;
    let exported: TopicsExport;

    beforeAll(async () => {
      run = await runExport();
      if (run.code === 0) {
        exported = JSON.parse(await Deno.readTextFile(run.outPath));
      }
    });

    it("exits zero with no permission to start a process", () => {
      expect(run.stderr).not.toContain("NotCapable");
      expect(run.code).toBe(0);
    });

    it("declares that same permission list in its shebang", () => {
      expect(shebangPermissions()).toEqual(RUN_PERMISSIONS);
    });

    it("selects the topic by its verbs and records where it came from", () => {
      expect(exported.topics.map((t) => t.fid)).toEqual([TOPIC]);
      expect(exported.topics[0].patternIdentity).toBe(TOPIC_IDENTITY);
      expect(exported.topics[0].argumentId).toBe(TOPIC_ARGUMENT);
    });

    it("resolves a comment element to the content it links", () => {
      expect(exported.topics[0].content.comments).toEqual([COMMENT_VALUE]);
      expect(exported.topics[0].content.body).toBe(TOPIC_BODY);
    });

    it("keeps the annotated link shape in the forensic copy", () => {
      const raw = exported.topics[0].rawArgument as Record<string, unknown>;
      expect(raw.comments).toEqual([{ $link: { id: COMMENT } }]);
      expect(raw.mentionable).toEqual({ $link: { id: BOARD_ARGUMENT } });
    });

    it("records the board's membership links as links", () => {
      expect(exported.board?.fid).toBe(BOARD);
      expect(exported.board?.patternIdentity).toBe(BOARD_IDENTITY);
      expect(exported.board?.topicsLinks).toEqual([{ $link: { id: TOPIC } }]);
    });

    it("manifests every piece in the space and nothing that is not one", () => {
      expect(exported.manifest.map((m) => m.fid).sort()).toEqual([
        BOARD,
        TOPIC,
      ]);
    });

    it("summarizes the counts an operator cross-checks the manifest against", () => {
      expect(run.stdout).toContain("topics: 1  comments: 1  links: 0");
      expect(run.stdout).toContain("1 membership links");
    });
  });

  describe("a comment whose author links another comment's author", () => {
    let run: ExportRun;
    let exported: TopicsExport;

    beforeAll(async () => {
      run = await runExport({
        entities: withSecondComment(COMMENT, ["author"]),
      });
      if (run.code === 0) {
        exported = JSON.parse(await Deno.readTextFile(run.outPath));
      }
    });

    it("exits zero", () => {
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
    });

    it("records the author the link reaches as the comment's author", () => {
      expect(exported.topics[0].content.comments).toEqual([
        COMMENT_VALUE,
        { ...SECOND_COMMENT_VALUE, author: COMMENT_VALUE.author },
      ]);
    });

    it("names the field it resolved", () => {
      expect(exported.topics[0].aliased).toEqual(["comments[1].author"]);
    });
  });

  describe("a comment whose author links a value holding a link", () => {
    let run: ExportRun;

    beforeAll(async () => {
      run = await runExport({
        entities: withSecondComment(NESTED, ["author"]),
      });
    });

    it("exits nonzero naming the link it cannot flatten", () => {
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain(
        "comments[1] holds a link at $.author.name",
      );
    });
  });

  describe("a comment whose author links within the snapshot's space", () => {
    let run: ExportRun;
    let exported: TopicsExport;

    beforeAll(async () => {
      run = await runExport({
        entities: withSecondComment(COMMENT, ["author"], {
          space: SEEDED_SPACE,
          scope: "space",
        }),
      });
      if (run.code === 0) {
        exported = JSON.parse(await Deno.readTextFile(run.outPath));
      }
    });

    it("records the author the link reaches", () => {
      expect(run.stderr).toBe("");
      expect(exported.topics[0].content.comments[1]).toEqual({
        ...SECOND_COMMENT_VALUE,
        author: COMMENT_VALUE.author,
      });
    });
  });

  describe("a comment whose author links into another space", () => {
    let run: ExportRun;

    beforeAll(async () => {
      run = await runExport({
        entities: withSecondComment(COMMENT, ["author"], {
          space: "did:key:zOtherSpace",
        }),
      });
    });

    it("exits nonzero naming the link and the space it leads into", () => {
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain(
        "comments[1].author links into did:key:zOtherSpace",
      );
    });
  });

  describe("a comment whose author links into a user's instance", () => {
    let run: ExportRun;

    beforeAll(async () => {
      run = await runExport({
        entities: withSecondComment(COMMENT, ["author"], {
          space: SEEDED_SPACE,
          scope: "user",
        }),
      });
    });

    it("exits nonzero naming the link and the scope it leads into", () => {
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain(
        "comments[1].author links into the user scope",
      );
    });
  });

  describe("a space whose piece listing cannot cover it", () => {
    let run: ExportRun;

    beforeAll(async () => {
      run = await runExport({ undecodable: true });
    });

    it("exits nonzero naming the entities it could not reconstruct", () => {
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain(
        "refusing: the piece listing does not cover the space",
      );
      expect(run.stderr).toContain("could not be reconstructed");
    });

    it("writes no export beside the refusal", async () => {
      const wrote = await Deno.stat(run.outPath).then(() => true).catch(() =>
        false
      );
      expect(wrote).toBe(false);
    });
  });
});
