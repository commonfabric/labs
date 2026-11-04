// Hermetic test for scope awareness: enumerate space/user/session scopes,
// compose "view as identity" (session ⊕ user ⊕ space, most-specific wins), and
// surface the per-scope divergence of one cell. Scope keys are stored %-encoded
// (as in real DBs) to exercise the encode/decode path.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import {
  listScopes,
  parseScope,
  resolveScopeChain,
  scopeOverlay,
  spaceParticipants,
  valueAsIdentity,
} from "../scopes.ts";

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

const DID = "did:key:zUser";
const USER = "user:did%3Akey%3AzUser"; // stored, %-encoded
const SESS = "session:did%3Akey%3AzUser:sid123";

function seed(path: string) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  let seq = 0;
  const put = (id: string, scope: string, value: unknown) => {
    seq++;
    db.prepare(
      `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
       VALUES (?, 'session:did:key:zUser:sid123', ?, '{}', '{}')`,
    ).run(seq, seq);
    db.prepare(
      `INSERT INTO revision (id, scope_key, seq, op_index, op, data, commit_seq)
       VALUES (?, ?, ?, 0, 'set', ?, ?)`,
    ).run(id, scope, seq, JSON.stringify({ value }), seq);
  };
  // A: space-only.  B: space + user + session (divergent).  C: user-only.
  put("of:A", "space", "shared-A");
  put("of:B", "space", "space-B");
  put("of:B", USER, "user-B");
  put("of:B", SESS, "session-B");
  put("of:C", USER, {
    "a/b": "literal slash key",
    a: { b: "nested key" },
    "": "empty key",
  });
  db.close();
}

Deno.test("scope awareness: enumerate, compose, diverge", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-scope-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    seed(dbPath);
    const space = openSpace(dbPath);
    try {
      await t.step("parseScope classifies the three kinds", () => {
        assertEquals(parseScope("space").kind, "space");
        assertEquals(parseScope(USER).kind, "user");
        assertEquals(parseScope(USER).principal, DID);
        const s = parseScope(SESS);
        assertEquals(s.kind, "session");
        assertEquals(s.principal, DID);
        assertEquals(s.sessionId, "sid123");
      });

      await t.step(
        "parseScope reads an unencoded key at its one boundary",
        () => {
          // Nothing in an unencoded key marks where its principal ends, so the
          // principal is the three segments a `did:<method>:<id>` takes and the
          // session id is the rest, colons and all.
          const plain = parseScope("session:did:key:zAlice:11111111-2222");
          assertEquals(plain.kind, "session");
          assertEquals(plain.principal, "did:key:zAlice");
          assertEquals(plain.sessionId, "11111111-2222");
          const colonInSession = parseScope("session:did:key:zAlice:sid:2");
          assertEquals(colonInSession.principal, "did:key:zAlice");
          assertEquals(colonInSession.sessionId, "sid:2");
          // The encoded form carries the boundary, so a colon inside either part
          // survives it.
          const encoded = parseScope("session:did%3Akey%3AzA%3Ab:sid%3A2");
          assertEquals(encoded.principal, "did:key:zA:b");
          assertEquals(encoded.sessionId, "sid:2");
        },
      );

      await t.step("parseScope refuses a key whose principal is no DID", () => {
        assertEquals(parseScope("session:alice:sid").kind, "other");
        assertEquals(parseScope("user:alice").kind, "other");
        assertEquals(parseScope("something-else").kind, "other");
      });

      await t.step("listScopes enumerates with counts", () => {
        const scopes = listScopes(space);
        const byKind = Object.fromEntries(scopes.map((s) => [s.kind, s]));
        assertEquals(byKind.space.entities, 2); // A, B
        assertEquals(byKind.user.entities, 2); // B, C
        assertEquals(byKind.session.entities, 1); // B
      });

      await t.step("valueAsIdentity composes most-specific-wins", () => {
        // B: session wins over user wins over space.
        const withSession = valueAsIdentity(space, {
          id: "of:B",
          identity: DID,
          sessionId: "sid123",
        });
        assertEquals(withSession.resolvedKind, "session");
        assertEquals(withSession.value, "session-B");
        assert(withSession.overrides);

        // B without a session: user wins over space.
        const userLevel = valueAsIdentity(space, { id: "of:B", identity: DID });
        assertEquals(userLevel.resolvedKind, "user");
        assertEquals(userLevel.value, "user-B");
        assert(userLevel.overrides);

        // A: only space — resolves to space, no override.
        const spaceOnly = valueAsIdentity(space, { id: "of:A", identity: DID });
        assertEquals(spaceOnly.resolvedKind, "space");
        assertEquals(spaceOnly.value, "shared-A");
        assertEquals(spaceOnly.overrides, false);

        const stringLength = valueAsIdentity(space, {
          id: "of:A",
          identity: DID,
          path: ["length"],
        });
        assertEquals(stringLength.pathExists, true);
        assertEquals(stringLength.value, 8);

        // C: user-only — still visible AS the identity (space would miss it).
        const userOnly = valueAsIdentity(space, { id: "of:C", identity: DID });
        assert(userOnly.exists);
        assertEquals(userOnly.resolvedKind, "user");

        const slashKey = valueAsIdentity(space, {
          id: "of:C",
          identity: DID,
          path: ["a/b"],
        });
        assertEquals(slashKey.value, "literal slash key");
        assertEquals(slashKey.pathExists, true);

        const emptyKey = valueAsIdentity(space, {
          id: "of:C",
          identity: DID,
          path: [""],
        });
        assertEquals(emptyKey.value, "empty key");
        assertEquals(emptyKey.pathExists, true);

        const missingKey = valueAsIdentity(space, {
          id: "of:C",
          identity: DID,
          path: ["missing"],
        });
        assertEquals(missingKey.pathExists, false);

        const document = valueAsIdentity(space, {
          id: "of:C",
          identity: DID,
          doc: true,
        });
        assertEquals(document.value, {
          value: {
            "a/b": "literal slash key",
            a: { b: "nested key" },
            "": "empty key",
          },
        });
        assertThrows(
          () =>
            valueAsIdentity(space, {
              id: "of:C",
              identity: DID,
              doc: true,
              path: [],
            }),
          Error,
          "cannot be used together",
        );
        assertThrows(
          () => resolveScopeChain(""),
          Error,
          "`identity` must not be empty",
        );
        assertThrows(
          () => resolveScopeChain(DID, ""),
          Error,
          "`sessionId` must not be empty",
        );
      });

      await t.step("spaceParticipants lists the space's identities", () => {
        const ps = spaceParticipants(space);
        assertEquals(ps.length, 1);
        const p = ps[0];
        assertEquals(p.did, DID);
        assertEquals(p.commits, 5); // all five commits use zUser's session
        assertEquals(p.userEntities, 2); // B, C in user scope
        assertEquals(p.sessionEntities, 1); // B in session scope
        // the seed space DID isn't zUser, so it's not the owner here
        assertEquals(p.isOwner, false);
      });

      await t.step("scopeOverlay shows per-scope divergence", () => {
        const o = scopeOverlay(space, "of:B");
        assertEquals(o.variants.length, 3);
        assert(o.overridden);
        assert(o.divergent);
        // ordered space → user → session
        assertEquals(o.variants.map((v) => v.kind), [
          "space",
          "user",
          "session",
        ]);
        const single = scopeOverlay(space, "of:A");
        assertEquals(single.overridden, false);
      });
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
