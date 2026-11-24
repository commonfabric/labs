import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Database } from "@db/sqlite";

import { hashOf } from "@commonfabric/data-model";

import { openSpace, type SpaceDb } from "../db.ts";
import {
  contentFingerprint,
  fingerprintReader,
  generatedInternalCellIds,
} from "../fingerprint.ts";
import { listEntityModels } from "../model.ts";

/** One revision supplied to the offline fixture. */
interface Revision {
  /** Entity identifier. */
  id: string;

  /** Stored payload, including malformed JSON where the case needs it. */
  data: string | null;

  /** Scope of the entity instance. */
  scope?: string;

  /** Branch holding this revision. */
  branch?: string;

  /** Operation applied to the document. */
  op?: string;
}

/** Runs a case over a closed, read-only store with the supplied revisions. */
function withStore(
  revisions: Revision[],
  run: (space: SpaceDb) => void,
  legacy = false,
): void {
  const dir = Deno.makeTempDirSync({ prefix: "fingerprint-scan-" });
  const path = `${dir}/space.sqlite`;
  try {
    const db = new Database(path);
    db.exec(`
      CREATE TABLE revision (
        branch TEXT NOT NULL, id TEXT NOT NULL,
        ${legacy ? "" : "scope_key TEXT NOT NULL,"}
        seq INTEGER NOT NULL, op_index INTEGER NOT NULL, op TEXT NOT NULL,
        data TEXT, commit_seq INTEGER NOT NULL,
        PRIMARY KEY (branch, id, ${legacy ? "" : "scope_key,"} seq, op_index)
      );
      CREATE TABLE branch (name TEXT PRIMARY KEY, parent_branch TEXT, fork_seq INTEGER);
      INSERT INTO branch VALUES ('', NULL, NULL), ('child', '', 2);
    `);
    const insert = db.prepare(
      `INSERT INTO revision VALUES (?, ?, ${legacy ? "" : "?,"} ?, 0, ?, ?, ?)`,
    );
    for (const [index, row] of revisions.entries()) {
      insert.run(
        row.branch ?? "",
        row.id,
        ...(legacy ? [] : [row.scope ?? "space"]),
        index + 1,
        row.op ?? "set",
        row.data,
        index + 1,
      );
    }
    db.close();
    const space = openSpace(path);
    try {
      run(space);
    } finally {
      space.close();
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

/** A legacy sigil link, with an optional declaration for classification. */
function link(id: string, schema?: unknown) {
  return { "/": { "link@1": { id, path: [], schema } } };
}

/** Encodes a piece whose manifest contributes both kinds of causes. */
function piece(generated: string[], named: string[] = []): string {
  return JSON.stringify({
    value: "piece",
    patternIdentity: {},
    internal: [
      ...generated.map((id) => ({
        link: link(id),
        partialCause: { $generated: 0 },
      })),
      ...named.map((id) => ({ link: link(id), partialCause: "authored" })),
    ],
  });
}

describe("fingerprint-scan", () => {
  it("names the configured branch in primary observations", () => {
    withStore([
      { id: "of:a", data: '{"value":1}' },
      { id: "of:a", branch: "child", data: '{"value":2}' },
    ], (space) => {
      const seen: { branch: string | undefined; value: unknown }[] = [];
      contentFingerprint(space, {
        branch: "child",
        onEntity: (at, outcome) =>
          seen.push({
            branch: at.branch,
            value: outcome.status === "present"
              ? outcome.document.value
              : undefined,
          }),
      });
      expect(seen).toEqual([{ branch: "child", value: 2 }]);
    });
  });

  it("captures head evidence when an address also carries a historical cut", () => {
    withStore([
      { id: "of:a", data: '{"value":1}' },
      { id: "of:a", branch: "child", data: '{"value":2}' },
    ], (space) => {
      const reader = fingerprintReader(space, { branch: "child" });
      const at = { id: "of:a", scope: "space", branch: "", atSeq: 1 };
      expect(reader.read(at)).toEqual({
        status: "present",
        document: { value: 2 },
      });
      expect(reader.finish())
        .toEqual(contentFingerprint(space, { branch: "child" }));
    });
  });

  it("classifies equal primary documents against each reader's own schemas", () => {
    const rows = (stream: boolean): Revision[] => [
      {
        id: "of:owner",
        data: JSON.stringify({
          patternIdentity: {},
          internal: [{
            partialCause: "event",
            link: link("of:event", { $ref: "cid:declaration" }),
          }],
        }),
      },
      { id: "of:event", data: JSON.stringify({ result: link("of:owner") }) },
      {
        id: "cid:declaration",
        data: JSON.stringify({ value: stream ? { asCell: ["stream"] } : {} }),
      },
    ];
    withStore(rows(true), (left) => {
      withStore(rows(false), (right) => {
        const a = fingerprintReader(left);
        const b = fingerprintReader(right);
        const at = { id: "of:event", scope: "space" };
        expect(a.read(at)).toEqual(b.read(at));
        expect(a.finish().perEntity).toContainEqual({
          ...at,
          kind: "stream",
          hash: null,
        });
        expect(b.finish().perEntity).toContainEqual({
          ...at,
          kind: "owned-cell",
          hash: null,
        });
      });
    });
  });

  it("completes captured evidence with independently enumerated addresses", () => {
    withStore([
      { id: "of:g", data: "malformed" },
      { id: "of:orphan", data: '{"value":7}' },
      { id: "of:owner", scope: "user:z", data: piece(["of:g"]) },
      { id: "of:deleted", data: null, op: "delete" },
    ], (space) => {
      const expected = contentFingerprint(space);
      const reader = fingerprintReader(space);
      expect(reader.read({ id: "of:g", scope: "space" }).status)
        .toBe("undecodable");
      expect(reader.read({ id: "of:missing", scope: "space" }).status)
        .toBe("absent");
      expect(reader.read({ id: "of:owner", scope: "user:z" }).status)
        .toBe("present");
      expect(reader.finish()).toEqual(expected);
      expect(expected.perEntity.map((entry) => entry.id)).toEqual([
        "of:deleted",
        "of:orphan",
        "of:owner",
      ]);
    });
  });

  it("reuses captured evidence while enforcing enumeration caps", () => {
    withStore([
      { id: "of:a", data: '{"value":1}' },
      { id: "of:b", data: '{"value":2}' },
    ], (space) => {
      const expected = contentFingerprint(space);
      const get = space.get.bind(space);
      let primaryReads = 0;
      space.get = (sql, ...params) => {
        if (sql.includes("ORDER BY seq DESC, op_index DESC LIMIT 1")) {
          primaryReads++;
        }
        return get(sql, ...params);
      };
      const reader = fingerprintReader(space);
      reader.read({ id: "of:b", scope: "space" });
      expect(reader.finish()).toEqual(expected);
      expect(primaryReads).toBe(2);
      const capped = fingerprintReader(space, { enumerationCap: 1 });
      capped.read({ id: "of:a", scope: "space" });
      capped.read({ id: "of:b", scope: "space" });
      expect(() => capped.finish()).toThrow("refusing to fingerprint");
    });
  });

  it("defers captured decode errors to listing order", () => {
    withStore([
      { id: "of:a", data: "[" },
      { id: "of:z", data: "{" },
      { id: "of:z", data: "{" },
    ], (space) => {
      const reader = fingerprintReader(space);
      const first = reader.read({ id: "of:a", scope: "space" });
      const expected = reader.read({ id: "of:z", scope: "space" });
      expect(first.status).toBe("undecodable");
      expect(expected.status).toBe("undecodable");
      if (expected.status !== "undecodable") {
        throw new Error("Expected corruption");
      }
      let failure: unknown;
      try {
        reader.finish();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBe(expected.error);
    });
  });

  it("applies later scopes' generated causes to every matching address", () => {
    withStore([
      { id: "of:g", data: '{"value":1}' },
      { id: "of:g", scope: "user:a", data: '{"value":2}' },
      { id: "of:namer", data: piece([], ["of:g"]) },
      { id: "of:generator", scope: "user:z", data: piece(["of:g"]) },
    ], (space) => {
      const report = contentFingerprint(space);
      expect(report.excludedGeneratedAddresses).toEqual([
        { id: "of:g", scope: "space" },
        { id: "of:g", scope: "user:a" },
      ]);
      expect(report.ambiguous).toEqual(["of:g"]);
      expect(report.entities).toBe(2);
      expect(contentFingerprint(space, { includeGenerated: true }).perEntity)
        .toContainEqual({
          id: "of:g",
          scope: "user:a",
          kind: "free-cell",
          hash: hashOf(2).toString(),
        });
    });
  });

  it("throws for included corruption and excludes generated corruption", () => {
    withStore([
      { id: "of:g", data: "malformed" },
      { id: "of:owner", scope: "user:z", data: piece(["of:g"]) },
      { id: "of:deleted", data: "malformed", op: "delete" },
      { id: "of:empty", data: null },
    ], (space) => {
      const report = contentFingerprint(space);
      expect(report.excludedGenerated).toBe(1);
      expect(report.unhashable).toEqual([]);
      expect(report.perEntity).toContainEqual({
        id: "of:deleted",
        scope: "space",
        kind: "deleted",
        hash: null,
      });
      expect(report.perEntity).toContainEqual({
        id: "of:empty",
        scope: "space",
        kind: "unknown",
        hash: null,
      });
      expect(() => contentFingerprint(space, { includeGenerated: true }))
        .toThrow();
    });
    withStore([{ id: "of:bad", data: "malformed" }], (space) => {
      expect(() => contentFingerprint(space)).toThrow();
      expect(generatedInternalCellIds(space).generated.size).toBe(0);
    });
  });

  it("keeps diagnostics in listing order across kinds and revision counts", () => {
    withStore([
      { id: "of:z", data: '{"value":1}' },
      { id: "of:z", data: '{"value":2}' },
      { id: "of:a", data: '{"value":3}' },
      { id: "of:stream", data: '{"value":{"$stream":true}}' },
      { id: "of:owner", data: piece(["of:a", "of:stream", "of:z"]) },
    ], (space) => {
      expect(contentFingerprint(space).excludedGeneratedAddresses).toEqual([
        { id: "of:stream", scope: "space" },
        { id: "of:z", scope: "space" },
        { id: "of:a", scope: "space" },
      ]);
    });
  });

  it("reports unhashable values in listing order after generated exclusions", () => {
    let deep: unknown = null;
    for (let i = 0; i < 5000; i++) deep = { a: deep };
    const data = JSON.stringify({ value: deep });
    withStore([
      { id: "of:z", data },
      { id: "of:z", data },
      { id: "of:a", data },
      { id: "of:g", data },
      { id: "of:ok", data: '{"value":1}' },
      { id: "of:owner", scope: "user:z", data: piece(["of:g"]) },
    ], (space) => {
      const report = contentFingerprint(space);
      expect(report.unhashable.map((entry) => entry.id)).toEqual([
        "of:z",
        "of:a",
      ]);
      for (const entry of report.unhashable) {
        expect(entry.reason).toMatch(/\S/);
      }
      expect(report.excludedGeneratedAddresses).toEqual([
        { id: "of:g", scope: "space" },
      ]);
      expect(report.perEntity.map((entry) => entry.id)).toEqual([
        "of:ok",
        "of:owner",
      ]);
      const included = contentFingerprint(space, { includeGenerated: true });
      expect(included.unhashable.map((entry) => entry.id)).toEqual([
        "of:z",
        "of:a",
        "of:g",
      ]);
      expect(included.excludedGenerated).toBe(0);
    });
  });

  it("resolves related documents in their own scope", () => {
    const owner = (stream: boolean) =>
      JSON.stringify({
        value: 1,
        patternIdentity: {},
        internal: [{
          partialCause: "event",
          link: link("of:event", stream ? { asCell: ["stream"] } : {}),
        }],
      });
    withStore([
      { id: "of:owner", data: owner(true) },
      { id: "of:event", data: JSON.stringify({ result: link("of:owner") }) },
      { id: "of:owner", scope: "user:a", data: owner(false) },
      {
        id: "of:event",
        scope: "user:a",
        data: JSON.stringify({ result: link("of:owner") }),
      },
    ], (space) => {
      for (let scan = 0; scan < 2; scan++) {
        const report = contentFingerprint(space);
        expect(report.perEntity.filter((row) => row.id === "of:event"))
          .toEqual([
            { id: "of:event", scope: "space", kind: "stream", hash: null },
            { id: "of:event", scope: "user:a", kind: "owned-cell", hash: null },
          ]);
        for (const scope of ["space", "user:a"]) {
          for (const model of listEntityModels(space, { scope }).entities) {
            expect(
              report.perEntity.find((row) =>
                row.id === model.id && row.scope === scope
              )?.kind,
            ).toBe(model.kind);
          }
        }
      }
    });
  });

  it("reads referenced schemas at space scope from a per-user manifest", () => {
    withStore([
      { id: "cid:stream", data: '{"value":{"asCell":["stream"]}}' },
      { id: "cid:stream", scope: "user:a", data: '{"value":{}}' },
      {
        id: "of:owner",
        scope: "user:a",
        data: JSON.stringify({
          patternIdentity: {},
          internal: [{
            partialCause: "event",
            link: link("of:event", { $ref: "cid:stream" }),
          }],
        }),
      },
      {
        id: "of:event",
        scope: "user:a",
        data: JSON.stringify({ result: link("of:owner") }),
      },
    ], (space) => {
      expect(contentFingerprint(space).perEntity).toContainEqual({
        id: "of:event",
        scope: "user:a",
        kind: "stream",
        hash: null,
      });
    });
  });

  it("reuses negative related reads only within one scope of one scan", () => {
    withStore([
      { id: "of:a", data: JSON.stringify({ result: link("of:missing") }) },
      { id: "of:b", data: JSON.stringify({ result: link("of:missing") }) },
    ], (space) => {
      const get = space.get.bind(space);
      let missingReads = 0;
      space.get = (sql, ...params) => {
        if (params.includes("of:missing")) missingReads++;
        return get(sql, ...params);
      };
      contentFingerprint(space);
      expect(missingReads).toBe(1);
      contentFingerprint(space);
      expect(missingReads).toBe(2);
    });
  });

  it("hashes inherited state at the fork and child patches within the child", () => {
    withStore([
      { id: "of:inherited", data: '{"value":1}' },
      { id: "of:overridden", data: '{"value":{"parent":1}}' },
      { id: "of:inherited", data: '{"value":99}' },
      {
        id: "of:overridden",
        branch: "child",
        op: "patch",
        data: '[{"op":"add","path":"/value","value":{"child":2}}]',
      },
    ], (space) => {
      expect(contentFingerprint(space, { branch: "child" }).perEntity)
        .toEqual([
          {
            id: "of:inherited",
            scope: "space",
            kind: "free-cell",
            hash: hashOf(1).toString(),
          },
          {
            id: "of:overridden",
            scope: "space",
            kind: "free-cell",
            hash: hashOf({ child: 2 }).toString(),
          },
        ]);
    });
  });

  it("reads legacy process manifests from stores without scope columns", () => {
    withStore([
      {
        id: "of:process",
        data: JSON.stringify({
          value: { $TYPE: "legacy", resultRef: link("of:result") },
          internal: [{ link: link("of:g"), partialCause: { $generated: 0 } }],
        }),
      },
      { id: "of:g", data: '{"value":1}' },
    ], (space) => {
      const report = contentFingerprint(space);
      expect(report.excludedGeneratedAddresses).toEqual([
        { id: "of:g", scope: "space" },
      ]);
      expect(report.perEntity.map((row) => [row.id, row.kind])).toEqual([
        ["of:process", "piece"],
      ]);
    }, true);
  });

  it("reconstructs independent entity values once per scan", () => {
    withStore([
      { id: "of:a", data: '{"value":1}' },
      { id: "of:b", data: '{"value":2}' },
    ], (space) => {
      const get = space.get.bind(space);
      let headReads = 0;
      space.get = (sql, ...params) => {
        if (sql.includes("ORDER BY seq DESC, op_index DESC LIMIT 1")) {
          headReads++;
        }
        return get(sql, ...params);
      };
      expect(contentFingerprint(space).entities).toBe(2);
      expect(headReads).toBe(2);
    });
  });
});
