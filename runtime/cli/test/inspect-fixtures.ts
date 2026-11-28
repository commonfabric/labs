/**
 * Seeding and output-capture helpers for the `inspect-space` and
 * `inspect-multispace` tests, which drive `cf inspect` in-process against
 * memory-v2 space DBs written here with plain SQL.
 */

import { Database } from "@db/sqlite";
import { inspect } from "../commands/inspect.ts";

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
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
CREATE TABLE branch (
  name TEXT NOT NULL PRIMARY KEY DEFAULT '', parent_branch TEXT,
  fork_seq INTEGER, created_seq INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active'
);
`;

export const ALICE = "did:key:z6MkInspectCmdAliceAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const BOB = "did:key:z6MkInspectCmdBobBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

/** A session id whose principal the inspector can read back. */
export function sessionOf(principal: string, uuid: string): string {
  return `session:${principal}:${uuid}`;
}

/** The scope key a principal's per-user rows are stored under. */
export function userScope(principal: string): string {
  return `user:${encodeURIComponent(principal)}`;
}

/** The scope key a principal's per-session rows are stored under. */
export function sessionScope(principal: string, uuid: string): string {
  return `session:${encodeURIComponent(principal)}:${uuid}`;
}

/** A plain-JSON sigil link, optionally naming another space. */
export function link(id: string, space?: string): unknown {
  return { "/": { "link@1": { id, path: [], ...(space ? { space } : {}) } } };
}

export interface RevisionSpec {
  id: string;
  op?: "set" | "delete";
  scope?: string;

  /** The stored document, written as JSON. */
  document?: unknown;

  /** Stored verbatim in place of `document`. */
  raw?: string;
}

export interface CommitSpec {
  session: string;
  createdAt?: string;

  /** Confirmed reads the commit records, each at the seq it observed, of the
   * whole document as admission stores one (an empty path). */
  reads?: { id: string; seq: number }[];

  revisions: RevisionSpec[];
}

/**
 * Write a memory-v2 space DB at `path`. Commit `i` of `commits` gets seq
 * `i + 1`, and each of its revisions takes that seq and is recorded as one of
 * the commit's operations. `extraSql` runs last.
 */
export function seedSpace(
  path: string,
  commits: CommitSpec[],
  extraSql = "",
): void {
  const db = new Database(path, { create: true });
  try {
    db.exec(SCHEMA);
    const commit = db.prepare(
      `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution, created_at)
       VALUES (?, ?, ?, ?, '{}', ?)`,
    );
    const revision = db.prepare(
      `INSERT INTO revision (id, scope_key, seq, op_index, op, data, commit_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    commits.forEach((spec, index) => {
      const seq = index + 1;
      commit.run(
        seq,
        spec.session,
        seq,
        JSON.stringify({
          reads: {
            confirmed: (spec.reads ?? []).map((read) => ({
              ...read,
              path: [],
            })),
            pending: [],
          },
          operations: spec.revisions.map((rev) => ({
            op: rev.op ?? "set",
            id: rev.id,
            scope: rev.scope ?? "space",
          })),
        }),
        spec.createdAt ?? `2026-01-01 00:${String(index).padStart(2, "0")}:00`,
      );
      spec.revisions.forEach((rev, opIndex) => {
        const op = rev.op ?? "set";
        revision.run(
          rev.id,
          rev.scope ?? "space",
          seq,
          opIndex,
          op,
          op === "delete"
            ? null
            : rev.raw ?? JSON.stringify(rev.document ?? null),
          seq,
        );
      });
    });
    db.prepare(`INSERT INTO branch (name, head_seq) VALUES ('', ?)`).run(
      commits.length,
    );
    if (extraSql) db.exec(extraSql);
  } finally {
    db.close();
  }
}

export interface InspectOutput {
  stdout: string[];
  stderr: string[];
}

/** Run `cf inspect` with `argv`, capturing what it prints. */
export async function runInspect(argv: string[]): Promise<InspectOutput> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const { log, error } = console;
  console.log = (...values: unknown[]) => stdout.push(values.join(" "));
  console.error = (...values: unknown[]) => stderr.push(values.join(" "));
  try {
    await inspect.parse(argv);
    return { stdout, stderr };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** Run `cf inspect` with `argv` and `--json`, parsing what it prints. */
export async function runInspectJson(argv: string[]): Promise<unknown> {
  const { stdout } = await runInspect([...argv, "--json"]);
  return JSON.parse(stdout.join("\n"));
}

export const ALICE_S1 = "aaaaaaaa-1111-4111-8111-111111111111";
export const ALICE_S3 = "cccccccc-3333-4333-8333-333333333333";
export const BOB_S2 = "bbbbbbbb-2222-4222-8222-222222222222";
export const BARE_SESSION = "bare-session-without-a-principal";
export const OTHER_SPACE =
  "did:key:z6MkInspectCmdOtherSpaceOOOOOOOOOOOOOOOOOOOOOOOO";
export const MODULE_IDENTITY = "inspect-module-identity";
export const MODULE_CODE = "export default () => {\n  return null;\n};\n";
export const LONG_TEXT =
  "a free cell whose summary runs well past the column width";

/**
 * One space exercising every single-space subcommand: a piece with its
 * pattern, input, schema, and owned cell; a cell two identities write in turn
 * with stale reads against it; cells one identity writes from two sessions;
 * per-user, per-session, and unrecognized scopes; a deletion; and a commit
 * from a session id with no principal.
 */
export function seedRichSpace(path: string): void {
  const alice1 = sessionOf(ALICE, ALICE_S1);
  const alice3 = sessionOf(ALICE, ALICE_S3);
  const bob2 = sessionOf(BOB, BOB_S2);
  seedSpace(
    path,
    [
      // seq 1
      {
        session: alice1,
        revisions: [
          {
            id: "of:module",
            document: {
              value: {
                kind: "source",
                identity: MODULE_IDENTITY,
                code: MODULE_CODE,
                filename: "/api/patterns/demo/counter.tsx",
                imports: [],
              },
            },
          },
          { id: "of:input", document: { value: { count: 1 } } },
          { id: "of:solo", document: { value: { solo: 1 } } },
          { id: "of:doomed", document: { value: "short-lived" } },
          { id: "of:shape", document: { value: { gone: 1, kept: 1 } } },
          {
            id: "of:bare-piece",
            document: {
              value: {},
              patternIdentity: { identity: "no-such-module" },
            },
          },
        ],
      },
      // seq 2
      {
        session: alice1,
        revisions: [
          {
            id: "of:piece",
            document: {
              value: {
                $NAME: "Counter",
                count: link("of:input"),
                elsewhere: link("of:far", OTHER_SPACE),
              },
              patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
              argument: link("of:input"),
              internal: [{ partialCause: "child", link: link("of:child") }],
              schema: { type: "object", properties: {} },
            },
          },
          {
            id: "of:child",
            document: {
              result: link("of:piece"),
              value: {
                alpha: 1,
                bravo: 2,
                charlie: 3,
                delta: 4,
                echo: 5,
                foxtrot: 6,
              },
            },
          },
          { id: "of:long", document: { value: LONG_TEXT } },
          { id: "of:pair", document: { value: "pair one" } },
        ],
      },
      // seq 3
      {
        session: bob2,
        revisions: [
          { id: "of:shared", document: { value: { n: 1 } } },
          {
            id: "of:shared",
            scope: userScope(BOB),
            document: { value: { n: "bob's own" } },
          },
        ],
      },
      // seq 4
      {
        session: alice1,
        revisions: [{ id: "of:shared", document: { value: { n: 2 } } }],
      },
      // seq 5
      {
        session: bob2,
        revisions: [{ id: "of:shared", document: { value: { n: 3 } } }],
      },
      // seq 6: reads `of:shared` as of seq 4, missing seq 5, then writes it.
      {
        session: alice1,
        reads: [{ id: "of:shared", seq: 4 }],
        revisions: [
          { id: "of:shared", document: { value: { n: 4 } } },
          {
            id: "of:shared",
            scope: sessionScope(ALICE, ALICE_S1),
            document: { value: { n: "alice's session" } },
          },
        ],
      },
      // seq 7
      {
        session: alice3,
        revisions: [
          { id: "of:solo", document: { value: { solo: 2 } } },
          { id: "of:pair", document: { value: "pair two" } },
          { id: "of:doomed", op: "delete" },
          { id: "of:shape", document: { value: { kept: 1, fresh: 2 } } },
        ],
      },
      // seq 8: reads `of:shared` as of seq 4 without writing it.
      {
        session: alice1,
        reads: [{ id: "of:shared", seq: 4 }],
        revisions: [{ id: "of:solo", document: { value: { solo: 3 } } }],
      },
      // seq 9
      {
        session: BARE_SESSION,
        revisions: [
          {
            id: "of:odd",
            scope: "custom%3Aweird",
            document: { value: "odd scope" },
          },
        ],
      },
    ],
    `CREATE TABLE scheduler_basis (x INTEGER);
      INSERT INTO scheduler_basis VALUES (1), (2);`,
  );
}

/**
 * A space whose ACL document holds a deletion tombstone by `ALICE`, with an
 * empty scheduler basis table.
 */
export function seedDeletedSpace(path: string, spaceDid: string): void {
  const acl = `of:${spaceDid}`;
  const session = sessionOf(ALICE, ALICE_S1);
  seedSpace(
    path,
    [
      {
        session,
        revisions: [{ id: acl, document: { value: { [ALICE]: "OWNER" } } }],
      },
      {
        session,
        revisions: [{
          id: acl,
          document: { value: { deleted: { by: ALICE } } },
        }],
      },
    ],
    `CREATE TABLE head (
       branch TEXT NOT NULL, id TEXT NOT NULL, scope_key TEXT NOT NULL,
       seq INTEGER NOT NULL, op_index INTEGER NOT NULL
     );
     INSERT INTO head VALUES ('', '${acl}', 'space', 2, 0);
     CREATE TABLE scheduler_basis (x INTEGER);`,
  );
}

/**
 * A space written only from a session id with no principal, into a scope the
 * inspector does not recognize.
 */
export function seedOddSpace(path: string): void {
  seedSpace(path, [{
    session: BARE_SESSION,
    revisions: [{
      id: "of:odd",
      scope: "custom%3Aweird",
      document: { value: "odd scope" },
    }],
  }]);
}

/**
 * One entity whose history holds a write that changes nothing, a write that
 * does not decode, and a write after it.
 */
export function seedTimelineSpace(path: string): void {
  const session = sessionOf(ALICE, ALICE_S1);
  seedSpace(path, [
    { session, revisions: [{ id: "of:steady", document: { value: 1 } }] },
    { session, revisions: [{ id: "of:steady", document: { value: 1 } }] },
    { session, revisions: [{ id: "of:steady", raw: "{not json" }] },
    { session, revisions: [{ id: "of:steady", document: { value: 2 } }] },
  ]);
}

/** `count` free cells, each linking to `of:hub`. */
export function seedFanInSpace(path: string, count: number): void {
  seedSpace(path, [{
    session: sessionOf(ALICE, ALICE_S1),
    revisions: [
      { id: "of:hub", document: { value: "hub" } },
      ...Array.from({ length: count }, (_, i) => ({
        id: `of:spoke-${String(i).padStart(2, "0")}`,
        document: { value: { to: link("of:hub") } },
      })),
    ],
  }]);
}

export const CONV_A = "did:key:z6MkInspectCmdConvAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const CONV_B = "did:key:z6MkInspectCmdConvBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
export const CONV_C = "did:key:z6MkInspectCmdConvCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

/**
 * Three spaces in `dir`, named for their DIDs, sharing entities that agree
 * (`of:same`), differ with a cross-space link naming one copy (`of:drift`),
 * agree where present but are missing from one space (`of:partial`), fail to
 * decode in one space (`of:broken`), and are written by no recorded commit
 * (`of:orphan`).
 */
export function seedConvergeSpaces(dir: string): void {
  const session = sessionOf(ALICE, ALICE_S1);
  const same = { id: "of:same", document: { value: { deep: { x: 1 } } } };
  seedSpace(`${dir}/${CONV_A}.sqlite`, [{
    session,
    revisions: [
      same,
      { id: "of:drift", document: { value: 1 } },
      { id: "of:linker", document: { value: link("of:drift", CONV_B) } },
      { id: "of:partial", document: { value: "same" } },
      { id: "of:broken", document: { value: "ok" } },
    ],
  }]);
  seedSpace(`${dir}/${CONV_B}.sqlite`, [{
    session,
    revisions: [
      same,
      { id: "of:drift", document: { value: 2 } },
      { id: "of:partial", document: { value: "same" } },
      { id: "of:broken", raw: "{not json" },
    ],
  }]);
  seedSpace(
    `${dir}/${CONV_C}.sqlite`,
    [{ session, revisions: [same] }],
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES ('of:orphan', 1, 1, 'set', '{"value":1}', 999);`,
  );
}

export const HOME = "did:key:z6MkInspectCmdHomeHHHHHHHHHHHHHHHHHHHHHHHHHHHH";
export const PROFILE =
  "did:key:z6MkInspectCmdProfilePPPPPPPPPPPPPPPPPPPPPPPPPPPPP";
export const ABSENT_PROFILE =
  "did:key:z6MkInspectCmdAbsentXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
export const MAIN = "did:key:z6MkInspectCmdMainMMMMMMMMMMMMMMMMMMMMMMMMMMMM";
export const EMPTY = "did:key:z6MkInspectCmdEmptyEEEEEEEEEEEEEEEEEEEEEEEEEEE";
export const HOME_S = "11111111-2222-4333-8444-555555555555";

/**
 * One user's world in `dir`: a home whose `profiles` cell names a present and
 * an absent profile space, the present profile, and a main space the home's
 * principal writes, holding per-user and per-session rows for that principal
 * and per-user rows for `BOB`. Beside it, a space with no commits and a file
 * that is not a database.
 */
export function seedWorld(dir: string): void {
  const homeSession = sessionOf(HOME, HOME_S);
  seedSpace(`${dir}/${HOME}.sqlite`, [
    {
      session: homeSession,
      revisions: [{
        id: "of:profiles",
        document: {
          value: [link("of:p1", PROFILE), link("of:p2", ABSENT_PROFILE)],
        },
      }],
    },
    {
      session: homeSession,
      revisions: [{
        id: "of:home",
        document: {
          value: {
            $NAME: "Home",
            $UI: {},
            profiles: link("of:profiles"),
            createProfile: { $stream: true },
            favorites: [],
            mru: [],
          },
          patternIdentity: { identity: "homehash", symbol: "default" },
        },
      }],
    },
  ]);
  seedSpace(`${dir}/${PROFILE}.sqlite`, [{
    session: homeSession,
    revisions: [{ id: "of:profile", document: { value: { name: "Ada" } } }],
  }]);
  seedSpace(`${dir}/${MAIN}.sqlite`, [
    {
      session: homeSession,
      revisions: [
        { id: "of:doc", document: { value: { count: 1 } } },
        {
          id: "of:doc",
          scope: userScope(HOME),
          document: { value: { count: 2 } },
        },
        {
          id: "of:draft",
          scope: sessionScope(HOME, HOME_S),
          document: { value: "draft" },
        },
      ],
    },
    {
      session: homeSession,
      revisions: [{ id: "of:doc", document: { value: { count: 3 } } }],
    },
    {
      session: sessionOf(BOB, BOB_S2),
      revisions: [{
        id: "of:doc",
        scope: userScope(BOB),
        document: { value: { count: 4 } },
      }],
    },
  ]);
  seedSpace(`${dir}/${EMPTY}.sqlite`, []);
  Deno.writeTextFileSync(`${dir}/junk.sqlite`, "not a database");
}
