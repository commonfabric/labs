// Hermetic test for space grouping. Seeds a HOME space (a home piece whose
// profiles[] cell links cross-space to a PROFILE space), a PROFILE space, and a
// MAIN space written by the home's principal, then checks they group into one
// user-world with the right roles + a placeholder for an absent referenced space.

import { assert, assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";

import type { DiscoveredSpace } from "../discover.ts";
import { groupDiscoveredSpaces, principalFromSession } from "../grouping.ts";

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
`;

const HOME = "did:key:zHomeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PROFILE = "did:key:zProfileBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const MAIN = "did:key:zMainCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

/** A plain-JSON sigil link, optionally carrying a cross-space `space`. */
function link(id: string, space?: string) {
  return { "/": { "link@1": { id, path: [], ...(space ? { space } : {}) } } };
}

function newDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  return db;
}

function setRev(db: Database, id: string, seq: number, value: unknown) {
  db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  ).run(id, seq, JSON.stringify(value), seq);
}

function commit(db: Database, seq: number, session: string) {
  db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, '{}', '{}')`,
  ).run(seq, session, seq);
}

function disc(path: string): DiscoveredSpace {
  const did = (path.split("/").pop() ?? path).replace(/\.sqlite$/, "");
  return { did, path, sizeBytes: 0, mtimeMs: 0 };
}

Deno.test("space grouping recovers a user's world", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-group-" });
  const homePath = `${dir}/${HOME}.sqlite`;
  const profilePath = `${dir}/${PROFILE}.sqlite`;
  const mainPath = `${dir}/${MAIN}.sqlite`;
  // The home's own principal session — for a home, principal == own DID.
  const homeSession = `session:${HOME}:11111111-2222-3333-4444-555555555555`;

  try {
    // HOME: a home piece whose `profiles` cell links cross-space to PROFILE,
    // plus a reference to an ABSENT profile space (no local DB → placeholder).
    {
      const db = newDb(homePath);
      commit(db, 1, homeSession);
      setRev(db, "of:profilescell", 1, {
        value: [link("of:prof1", PROFILE), link("of:prof2", `${MAIN}XX`)],
      });
      commit(db, 2, homeSession);
      setRev(db, "of:home", 2, {
        value: {
          $NAME: "Home",
          $UI: {},
          profiles: link("of:profilescell"),
          createProfile: { $stream: true },
          favorites: [],
          mru: [],
        },
        patternIdentity: { identity: "homehash", symbol: "default" },
      });
      db.close();
    }

    // PROFILE: a small profile space (content irrelevant to grouping).
    {
      const db = newDb(profilePath);
      commit(db, 1, `session:${HOME}:aaaa1111-2222-3333-4444-555555555555`);
      setRev(db, "of:profile", 1, { value: { name: "Ada" } });
      db.close();
    }

    // MAIN: a pattern space written by the home's principal (no home pieces).
    {
      const db = newDb(mainPath);
      commit(db, 1, `session:${HOME}:bbbb1111-2222-3333-4444-555555555555`);
      setRev(db, "of:doc", 1, { value: { count: 1 } });
      db.close();
    }

    await t.step("principalFromSession extracts the acting DID", () => {
      assertEquals(principalFromSession(homeSession), HOME);
      // URL-encoded form (as stored in real DBs) decodes too.
      assertEquals(
        principalFromSession(`session:did%3Akey%3AzX:uuid`),
        "did:key:zX",
      );
      assertEquals(principalFromSession("bare-uuid-no-principal"), null);
    });

    await t.step("one group: home → profile → main, with a placeholder", () => {
      const result = groupDiscoveredSpaces([
        disc(homePath),
        disc(profilePath),
        disc(mainPath),
      ]);
      assertEquals(result.groups.length, 1);
      const g = result.groups[0];
      assertEquals(g.principal, HOME);
      assert(g.homePresent);

      const byDid = Object.fromEntries(g.spaces.map((s) => [s.did, s]));
      assertEquals(byDid[HOME].role, "home");
      assertEquals(byDid[PROFILE].role, "profile");
      assertEquals(byDid[MAIN].role, "main");

      // The home, profile, and main are all present locally.
      assert(byDid[HOME].present);
      assert(byDid[PROFILE].present);
      assert(byDid[MAIN].present);

      // The second, dangling profile link resolves to an absent placeholder.
      const absent = `${MAIN}XX`;
      assert(byDid[absent], "dangling profile ref should appear as a node");
      assertEquals(byDid[absent].present, false);
      assertEquals(byDid[absent].role, "profile");

      assertEquals(result.ungrouped.length, 0);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
