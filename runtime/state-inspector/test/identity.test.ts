// Hermetic test for the identity world: a DID's spaces (home → profile) joined
// with the per-user/session scopes it owns within them.

import { assert, assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";

import type { DiscoveredSpace } from "../discover.ts";
import { describeIdentity } from "../identity.ts";

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
const USER = "user:did%3Akey%3AzHomeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function link(id: string, space?: string) {
  return { "/": { "link@1": { id, path: [], ...(space ? { space } : {}) } } };
}
function db(path: string): Database {
  const d = new Database(path, { create: true });
  d.exec(SCHEMA);
  return d;
}
function commit(d: Database, seq: number) {
  d.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, '{}', '{}')`,
  ).run(seq, `session:${HOME}:sid`, seq);
}
function rev(d: Database, id: string, scope: string, seq: number, v: unknown) {
  d.prepare(
    `INSERT INTO revision (id, scope_key, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, ?, 0, 'set', ?, ?)`,
  ).run(id, scope, seq, JSON.stringify(v), seq);
}
function disc(path: string): DiscoveredSpace {
  const did = (path.split("/").pop() ?? path).replace(/\.sqlite$/, "");
  return { did, path, sizeBytes: 0, mtimeMs: 0 };
}

Deno.test("identity world: spaces + owned scopes", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-identity-" });
  const homePath = `${dir}/${HOME}.sqlite`;
  const profilePath = `${dir}/${PROFILE}.sqlite`;
  try {
    // HOME: a home piece linking to PROFILE, plus a per-user owned cell.
    {
      const d = db(homePath);
      commit(d, 1);
      rev(d, "of:profilescell", "space", 1, {
        value: [link("of:prof1", PROFILE)],
      });
      commit(d, 2);
      rev(d, "of:home", "space", 2, {
        value: {
          $NAME: "Home",
          profiles: link("of:profilescell"),
          createProfile: { $stream: true },
        },
      });
      // a per-user cell OWNED by this identity
      commit(d, 3);
      rev(d, "of:userpref", USER, 3, { value: { theme: "dark" } });
      d.close();
    }
    {
      const d = db(profilePath);
      commit(d, 1);
      rev(d, "of:profile", "space", 1, { value: { name: "Ada" } });
      d.close();
    }

    const world = describeIdentity([disc(homePath), disc(profilePath)], HOME);

    await t.step("joins spaces with owned scopes", () => {
      assertEquals(world.did, HOME);
      const byDid = Object.fromEntries(world.spaces.map((s) => [s.did, s]));
      assertEquals(byDid[HOME].role, "home");
      assertEquals(byDid[PROFILE].role, "profile");
      // the home carries this identity's per-user scope
      assertEquals(byDid[HOME].ownedScopes.length, 1);
      assertEquals(byDid[HOME].ownedScopes[0].kind, "user");
      assertEquals(byDid[HOME].scopedEntities, 1);
      // the profile has no per-user state for this identity
      assertEquals(byDid[PROFILE].scopedEntities, 0);
    });

    await t.step("totals roll up", () => {
      assertEquals(world.totals.presentSpaces, 2);
      assertEquals(world.totals.spacesWithScopedState, 1);
      assertEquals(world.totals.scopedEntities, 1);
      assert(world.homePresent);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
