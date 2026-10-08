import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import type { DiscoveredSpace } from "../discover.ts";
import { discoverProfiles } from "../profile-discovery.ts";

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
const LISTED = "did:key:zListedBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const STRAY = "did:key:zStrayCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const OTHER = "did:key:zOtherDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

/** A plain-JSON sigil link, optionally carrying a cross-space `space`. */
function link(id: string, space?: string) {
  return { "/": { "link@1": { id, path: [], ...(space ? { space } : {}) } } };
}

/** A stored profile result: its name and the streams a profile exposes. */
const PROFILE_VALUE = {
  name: "Ada",
  setName: { $stream: true },
  setAvatar: { $stream: true },
};

describe("discoverProfiles()", () => {
  let dir: string;
  let discovered: DiscoveredSpace[];

  /** Writes a space database holding `docs`, each a `[id, value]`. */
  const space = (did: string, docs: [string, unknown][]) => {
    const path = `${dir}/${did}.sqlite`;
    const db = new Database(path, { create: true });
    try {
      db.exec(SCHEMA);
      docs.forEach(([id, value], index) => {
        const seq = index + 1;
        db.prepare(
          `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
           VALUES (?, ?, ?, '{}', '{}')`,
        ).run(seq, `session:${did}:s`, seq);
        db.prepare(
          `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
           VALUES (?, ?, 0, 'set', ?, ?)`,
        ).run(id, seq, JSON.stringify({ value }), seq);
      });
    } finally {
      db.close();
    }
    discovered.push({ did, path, sizeBytes: 0, mtimeMs: 0 });
  };

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "profile-discovery-" });
    discovered = [];
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  it("returns each link a Home's profile list stores, with the Home that lists it", () => {
    space(HOME, [
      ["of:home", {
        profiles: link("of:list"),
        createProfile: { $stream: true },
      }],
      ["of:list", [link("of:slot-b", LISTED), link("of:slot-a", LISTED)]],
    ]);
    space(LISTED, [["of:profile", PROFILE_VALUE]]);

    expect(discoverProfiles(discovered)).toEqual({
      listed: [
        { home: HOME, space: LISTED, id: "of:slot-a" },
        { home: HOME, space: LISTED, id: "of:slot-b" },
      ],
      unlisted: [],
    });
  });

  it("returns a profile-shaped piece in a space no Home lists as unlisted, and nothing else there", () => {
    space(STRAY, [
      ["of:stray-profile", PROFILE_VALUE],
      ["of:not-a-profile", { name: "only a name", setName: { $stream: true } }],
    ]);
    space(OTHER, [["of:plain", { setName: "a string, not a profile" }]]);

    expect(discoverProfiles(discovered)).toEqual({
      listed: [],
      unlisted: [{ space: STRAY, id: "of:stray-profile" }],
    });
  });

  it("skips a SQLite database that holds no memory space", () => {
    const path = `${dir}/${OTHER}.sqlite`;
    const db = new Database(path, { create: true });
    try {
      db.exec("CREATE TABLE unrelated (x INTEGER)");
    } finally {
      db.close();
    }
    discovered.push({ did: OTHER, path, sizeBytes: 0, mtimeMs: 0 });
    space(STRAY, [["of:stray-profile", PROFILE_VALUE]]);

    expect(discoverProfiles(discovered).unlisted).toEqual([
      { space: STRAY, id: "of:stray-profile" },
    ]);
  });

  it("skips a file that is not a space database", async () => {
    const path = `${dir}/${OTHER}.sqlite`;
    await Deno.writeTextFile(path, "not a database");
    discovered.push({ did: OTHER, path, sizeBytes: 0, mtimeMs: 0 });
    space(STRAY, [["of:stray-profile", PROFILE_VALUE]]);

    expect(discoverProfiles(discovered).unlisted).toEqual([
      { space: STRAY, id: "of:stray-profile" },
    ]);
  });
});
