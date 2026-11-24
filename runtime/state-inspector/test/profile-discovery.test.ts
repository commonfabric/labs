import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import type { DiscoveredSpace } from "../discover.ts";
import { homeProfileLinks } from "../grouping.ts";
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
/** Stored text that decodes to no document. */
class Raw {
  constructor(readonly text: string) {}
}

const PROFILE_VALUE = {
  name: "Ada",
  setName: { $stream: true },
  setAvatar: { $stream: true },
};

describe("discoverProfiles()", () => {
  let dir: string;
  let discovered: DiscoveredSpace[];

  /**
   * Writes a space database holding `docs`, each a `[id, value]`; a value
   * given as a `Raw` is stored as its text, verbatim, rather than encoded.
   */
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
        ).run(
          id,
          seq,
          value instanceof Raw ? value.text : JSON.stringify({ value }),
          seq,
        );
      });
    } finally {
      db.close();
    }
    discovered.push({ did, path, sizeBytes: 0, mtimeMs: 0 });
  };

  /** The links `homeProfileLinks()` reads from the space written for `did`. */
  const linksOf = (did: string) => {
    const opened = openSpace(`${dir}/${did}.sqlite`);
    try {
      return homeProfileLinks(opened);
    } finally {
      opened.close();
    }
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
      unreadable: [],
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
      unreadable: [],
    });
  });

  it("skips a document that does not decode, and reports the rest of its space", () => {
    space(STRAY, [
      ["of:undecodable", new Raw("setName setAvatar is not a document")],
      ["of:stray-profile", PROFILE_VALUE],
    ]);
    space(HOME, [
      ["of:undecodable-home", new Raw('createProfile "profiles" garbled')],
      ["of:home", {
        profiles: link("of:list"),
        createProfile: { $stream: true },
      }],
      ["of:list", [link("of:slot", LISTED)]],
    ]);

    expect(discoverProfiles(discovered)).toEqual({
      listed: [{ home: HOME, space: LISTED, id: "of:slot" }],
      unlisted: [{ space: STRAY, id: "of:stray-profile" }],
      unreadable: [],
    });
  });

  it("finds no Home in a space whose piece has a `profiles` field but is not one", () => {
    space(OTHER, [
      ["of:mentions", { profiles: 3, note: "createProfile" }],
    ]);

    expect(linksOf(OTHER)).toBeUndefined();
  });

  it("finds a Home listing nothing when its profile list does not decode", () => {
    space(HOME, [
      ["of:home", {
        profiles: link("of:list"),
        createProfile: { $stream: true },
      }],
      ["of:list", new Raw("not a document")],
    ]);

    expect(linksOf(HOME)).toEqual([]);
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

    const found = discoverProfiles(discovered);
    expect(found.unlisted).toEqual([{ space: STRAY, id: "of:stray-profile" }]);
    expect(found.unreadable).toEqual([]);
  });

  it("reports a file that does not open as a database as unreadable", async () => {
    const path = `${dir}/${OTHER}.sqlite`;
    await Deno.writeTextFile(path, "not a database");
    discovered.push({ did: OTHER, path, sizeBytes: 0, mtimeMs: 0 });
    space(STRAY, [["of:stray-profile", PROFILE_VALUE]]);

    const found = discoverProfiles(discovered);
    expect(found.unlisted).toEqual([{ space: STRAY, id: "of:stray-profile" }]);
    expect(found.unreadable.map((u) => u.space)).toEqual([OTHER]);
  });

  it("reports a memory space whose reading fails as unreadable, with nothing read from it", () => {
    // The tables a memory space has, with a revision table missing a column
    // every read of it names.
    const path = `${dir}/${HOME}.sqlite`;
    const db = new Database(path, { create: true });
    try {
      db.exec(`
        CREATE TABLE "commit" (seq INTEGER PRIMARY KEY, session_id TEXT);
        CREATE TABLE revision (id TEXT, seq INTEGER, data JSON);
      `);
    } finally {
      db.close();
    }
    discovered.push({ did: HOME, path, sizeBytes: 0, mtimeMs: 0 });

    const found = discoverProfiles(discovered);
    expect(found.listed).toEqual([]);
    expect(found.unlisted).toEqual([]);
    expect(found.unreadable.map((u) => u.space)).toEqual([HOME]);
  });
});
