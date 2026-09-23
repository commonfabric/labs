// Hermetic test for the HTML explorer: the bundle carries rich per-entity
// details with context-aware labels (named streams, module imports), parsed CFC,
// and live-base passthrough; the rendered page is self-contained with a
// parseable, `</script>`-safe embedded bundle.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import { buildInspectorBundle, renderInspectorHtml } from "../html.ts";
import type { EntityDetail } from "../detail.ts";

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
INSERT INTO branch (name, head_seq, status) VALUES ('', 6, 'active');
`;

const MODULE_IDENTITY = "pf1v3J_M5Nep7cq-Uh8EYG0ZQaE217FfDfcjbwGdjVI";

function link(id: string, schema?: unknown) {
  return {
    "/": {
      "link@1": { id, path: [], ...(schema === undefined ? {} : { schema }) },
    },
  };
}

function seed(path: string) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, 'session:did:key:zX:u', ?, '{}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  );
  // module — carries CFC integrity, and a `</script>` guard in the source.
  commit.run(1, 1);
  rev.run(
    "of:mod",
    1,
    JSON.stringify({
      value: {
        kind: "source",
        identity: MODULE_IDENTITY,
        code: "// </script> guard\nexport default () => null;\n",
        filename: "/api/patterns/notes/notebook.tsx",
        imports: [],
      },
      cfc: {
        version: 1,
        schemaHash: "fid1:hash",
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: { integrity: ["cf-compiled-by:cf-compiler"] },
            origin: "declared",
          }],
        },
      },
    }),
    1,
  );
  // piece — value names an owned stream by the key `addNote`.
  commit.run(2, 2);
  rev.run(
    "of:piece",
    2,
    JSON.stringify({
      value: { $NAME: "My Notebook", $UI: {}, addNote: link("of:stream") },
      argument: link("of:input"),
      internal: [
        { partialCause: "q", link: link("of:owned") },
        { partialCause: "q", link: link("of:stream") },
        {
          partialCause: "q",
          link: link("of:stream-ref", { $ref: "cid:streamschema" }),
        },
      ],
      patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
      schema: {
        type: "object",
        properties: {
          // the `addNote` stream's payload schema lives here on the owner piece
          addNote: { $ref: "#/$defs/AddNoteEvent", asCell: ["stream"] },
        },
        $defs: {
          AddNoteEvent: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      },
    }),
    2,
  );
  commit.run(3, 3);
  rev.run("of:input", 3, JSON.stringify({ value: { title: "t" } }), 3);
  commit.run(4, 4);
  rev.run(
    "of:owned",
    4,
    JSON.stringify({ value: "hi", result: link("of:piece") }),
    4,
  );
  commit.run(5, 5);
  rev.run(
    "of:stream",
    5,
    JSON.stringify({ value: { $stream: true }, result: link("of:piece") }),
    5,
  );
  // a stream holding no value, declared by the manifest link its owner keeps
  // for it, which references the schema document holding the schema
  commit.run(10, 10);
  rev.run(
    "cid:streamschema",
    10,
    JSON.stringify({
      value: {
        asCell: ["stream"],
        type: "object",
        properties: { tag: { type: "string" } },
      },
    }),
    10,
  );
  commit.run(11, 11);
  rev.run(
    "of:stream-ref",
    11,
    JSON.stringify({ result: link("of:piece") }),
    11,
  );
  // an import cell: { link, specifier }
  commit.run(6, 6);
  rev.run(
    "of:imp",
    6,
    JSON.stringify({ value: { link: link("of:mod"), specifier: "./dep.tsx" } }),
    6,
  );
  // a per-user-scoped cell — the multiplayer dimension the explorer must show.
  commit.run(7, 7);
  db.prepare(
    `INSERT INTO revision (id, scope_key, seq, op_index, op, data, commit_seq)
     VALUES ('of:pref', 'user:did%3Akey%3AzUser', 7, 0, 'set', ?, 7)`,
  ).run(JSON.stringify({ value: { theme: "dark" } }));
  // a label document, and a document whose version-2 envelope holds one
  // label by reference to it and one by a reference nothing resolves.
  commit.run(8, 8);
  rev.run(
    "cid:lbl",
    8,
    JSON.stringify({ value: { confidentiality: ["room-secret"] } }),
    8,
  );
  commit.run(9, 9);
  rev.run(
    "of:labeled",
    9,
    JSON.stringify({
      value: { a: 1, b: 2 },
      cfc: {
        version: 2,
        schemaHash: "fid1:hash",
        labelMap: {
          version: 1,
          entries: [
            { path: ["a"], label: { $ref: "cid:lbl" }, origin: "declared" },
            { path: ["b"], label: { $ref: "of:piece" }, origin: "declared" },
            "bogus",
          ],
        },
      },
    }),
    9,
  );
  db.close();
}

Deno.test("html explorer: rich bundle + self-contained render", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-html-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    seed(dbPath);
    const space = openSpace(dbPath);
    try {
      const bundle = buildInspectorBundle(space, {
        generatedAt: "2026-01-01",
        liveBase: "https://app.test",
      });
      const byId = (id: string): EntityDetail =>
        bundle.details.find((d) => d.id === id)!;

      await t.step("bundle carries rich per-entity details", () => {
        assert(bundle.details.length >= 5);
        assertEquals(bundle.liveBase, "https://app.test");
        assert(bundle.graph.edges.some((e) => e.kind === "pattern"));
        assert(bundle.timeline.length >= 1);

        const piece = byId("of:piece");
        assertEquals(piece.kind, "piece");
        assertEquals(piece.label, "My Notebook");
        assertEquals(piece.lineage.pattern?.id, "of:mod");
        assert(piece.schemaKeys?.includes("type"));
        assert(piece.versions.length >= 1);
      });

      await t.step("labels are context-aware (no bare stream / link)", () => {
        // A stream named by the piece's `addNote` key.
        const stream = byId("of:stream");
        assertEquals(stream.kind, "stream");
        assertEquals(stream.contextName, "addNote");
        assertEquals(stream.label, "⊙ addNote");
        // its payload schema is resolved from the owner piece's schema.
        assert(stream.streamPayload, "stream payload schema resolved");
        assert(
          stream.schemaKeys?.includes("properties"),
          "payload shape present",
        );
        assertStringIncludes(stream.schemaSource ?? "", "addNote");
        // A stream whose document holds no value is a stream by its owner's
        // manifest, and the schema shown is the one the manifest link
        // references; the source names the manifest and the schema document.
        const declared = byId("of:stream-ref");
        assertEquals(declared.kind, "stream");
        assertEquals(declared.label, "⊙ stream");
        assert(declared.streamPayload, "stream payload schema resolved");
        assert(declared.schemaKeys?.includes("properties"));
        assertStringIncludes(
          declared.schemaSource ?? "",
          "declared in owner manifest · of:piece",
        );
        assertStringIncludes(
          declared.schemaSource ?? "",
          "schema document · cid:streamschema",
        );
        // A `{ link, specifier }` cell is a module import.
        const imp = byId("of:imp");
        assertEquals(imp.label, "import ./dep.tsx");
        assertEquals(imp.role, "module import");
      });

      await t.step("bundle surfaces per-identity scopes + overlays", () => {
        assert(
          bundle.scopes.some((s) => s.kind === "user"),
          "user scope enumerated",
        );
        const ov = bundle.overlays.find((o) => o.id === "of:pref");
        assert(ov, "per-user cell has a scope overlay");
        assertEquals(ov!.variants[0].kind, "user");
        // conflicts surface is present (single-session seed → none contested)
        assert(Array.isArray(bundle.conflicts));
        assert(Array.isArray(bundle.participants));
      });

      await t.step("CFC labels are parsed", () => {
        const mod = byId("of:mod");
        assert(mod.cfc, "module should carry cfc");
        assertEquals(mod.cfc!.schemaHash, "fid1:hash");
        assertEquals(mod.cfc!.entries[0].integrity, [
          "cf-compiled-by:cf-compiler",
        ]);
        assert(mod.code, "module should carry source");
      });

      await t.step(
        "CFC labels held by reference are resolved or marked",
        () => {
          const labeled = byId("of:labeled");
          assert(labeled.cfc, "labeled document should carry cfc");
          assertEquals(labeled.cfc!.entries.length, 2);
          assertEquals(labeled.cfc!.entries[0].confidentiality, [
            "room-secret",
          ]);
          assertEquals(labeled.cfc!.entries[0].unresolved, undefined);
          assertEquals(labeled.cfc!.entries[1].confidentiality, []);
          assertEquals(labeled.cfc!.entries[1].unresolved, true);
        },
      );

      await t.step("render is self-contained HTML", () => {
        const html = renderInspectorHtml(bundle);
        assertStringIncludes(html, "<!doctype html>");
        assertStringIncludes(html, bundle.space);
        assertStringIncludes(html, "My Notebook");
        // No external resources: all `<` in embedded data are escaped, so any
        // literal tag is ours — and none load a remote resource.
        assert(!html.includes("<script src"), "no external scripts");
        assert(!html.includes("<link "), "no external stylesheets");
      });

      await t.step("embedded bundle is parseable + script-safe", () => {
        const html = renderInspectorHtml(bundle);
        const m = html.match(
          /<script id="bundle" type="application\/json">(.*?)<\/script>/s,
        );
        assert(m, "bundle script block present");
        assert(!m![1].includes("</script>"), "payload must escape </script>");
        const parsed = JSON.parse(m![1].replaceAll("\\u003c", "<"));
        assertEquals(parsed.space, bundle.space);
        assertEquals(parsed.details.length, bundle.details.length);
      });

      await t.step(
        "hostile DB-derived strings can't inject into the shell",
        () => {
          // A malicious space DID / op name must not break out into live markup in
          // the standalone HTML (the chrome interpolates DB/path-derived strings).
          const evil = "</title><script>alert(1)</script>";
          const hostile = {
            ...bundle,
            space: evil,
            summary: {
              ...bundle.summary,
              ops: { "<img src=x onerror=alert(2)>": 1 },
            },
          };
          const html = renderInspectorHtml(hostile);
          assert(
            !html.includes("<script>alert(1)"),
            "space DID must be HTML-escaped in the shell",
          );
          assert(
            !html.includes("<img src=x onerror"),
            "op names must be HTML-escaped in the shell",
          );
          assertStringIncludes(html, "&lt;img src=x onerror");
        },
      );
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
