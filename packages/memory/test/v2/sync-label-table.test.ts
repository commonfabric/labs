import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  cloneIfNecessary,
  deepFreeze,
  type FabricPlainObject,
  type FabricValue,
  isDeepFrozen,
  isValidFabricValue,
} from "@commonfabric/data-model";
import {
  linkRefFrom,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { internSchema } from "@commonfabric/data-model-schema";
import { isPlainObject } from "@commonfabric/utils/types";

import {
  decodeTrustedMemoryBoundary,
  encodeMemoryBoundary,
  type ServerMessage,
  type SessionSync,
} from "../../v2.ts";
import {
  compressServerMessageLabels,
  compressSessionSyncLabels,
  expandServerMessageLabels,
  expandSessionSyncLabels,
  MAX_SYNC_LABEL_EXPANSION_BYTES,
} from "../../v2/sync-label-table.ts";
import {
  compressServerMessageSchemas,
  compressSessionSyncSchemas,
  expandServerMessageSchemas,
  expandSessionSyncSchemas,
} from "../../v2/sync-schema-table.ts";

/** Builds distinct, heterogeneous metadata without normalizing its contents. */
function labelFor(index: number): FabricPlainObject {
  return {
    confidentiality: index % 2 ? undefined : [{
      anyOf: ["principal:second", "principal:first", "principal:second"],
    }],
    integrity: [{
      type: "provenance",
      source: { id: `of:source-${index}`, path: ["value", "items", "0"] },
    }, { type: "claim", name: 'é\n\\"', index }],
  };
}

/** Builds a frame with independent label objects carrying repeated content. */
function repeatedSync(count = 120): SessionSync {
  return {
    type: "sync",
    fromSeq: 3,
    toSeq: 9,
    caughtUpLocalSeq: 4,
    upserts: Array.from({ length: 3 }, (_, docIndex) => ({
      branch: "",
      id: `of:labels-${docIndex}`,
      seq: 9,
      scope: "space",
      doc: {
        value: {
          labelTable: [labelFor(10)],
          labelPathTable: [["value", "ordinary-data"]],
          cfc: { labelMap: { entries: [{ label: 99999, path: 99999 }] } },
          marker: "sync-label:ordinary-application-string",
          numeric: 0,
        },
        source: { "/": "of:source" },
        cfc: {
          revision: 5,
          labelMap: {
            version: 1,
            entries: Array.from({ length: count }, (_, index) => ({
              path: ["value", "items", `${index}`],
              label: labelFor(index % 4),
              observes: index % 2 ? "shape" : "value",
              origin: "link",
              auxiliary: undefined,
            })),
          },
        },
        extraMetadata: { label: labelFor(22), labelTable: [7] },
      },
    })),
    removes: [{ branch: "", id: "of:deleted" }],
    crossings: [{ space: "did:key:other", id: "of:crossing", path: [] }],
  };
}

/** Reads transformed metadata positions without assuming their wire types. */
function labelsOf(sync: unknown, field: "label" | "path" = "label"): unknown[] {
  assert(isPlainObject(sync) && Array.isArray(sync.upserts));
  return sync.upserts.flatMap((upsert: unknown) => {
    assert(isPlainObject(upsert) && isPlainObject(upsert.doc));
    const cfc = upsert.doc.cfc;
    assert(isPlainObject(cfc) && isPlainObject(cfc.labelMap));
    assert(Array.isArray(cfc.labelMap.entries));
    return cfc.labelMap.entries.map((entry: unknown) => {
      assert(isPlainObject(entry));
      return entry[field];
    });
  });
}

/** Encodes a boundary result after validating its untyped return value. */
function canonical(value: unknown): string {
  assert(isValidFabricValue(value));
  return encodeMemoryBoundary(value);
}

/** Builds a minimal wire sync for malformed-input and cost-boundary cases. */
function wireSync(
  labels: FabricValue[],
  table?: FabricValue,
  paths?: FabricValue[],
  pathTable?: FabricValue,
): FabricPlainObject {
  return {
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:wire",
      seq: 1,
      doc: {
        cfc: {
          labelMap: {
            entries: labels.map((label, index) => ({
              label,
              path: paths === undefined ? ["value", `${index}`] : paths[index],
            })),
          },
        },
      },
    }],
    removes: [],
    ...(table === undefined ? {} : { labelTable: table }),
    ...(pathTable === undefined ? {} : { labelPathTable: pathTable }),
  };
}

describe("sync-label-table", () => {
  it("round-trips heterogeneous metadata exactly through canonical memory encoding", () => {
    const original = deepFreeze(repeatedSync());
    const before = canonical(original);
    const compact = compressSessionSyncLabels(original);
    assert(isPlainObject(compact) && Array.isArray(compact.labelTable));
    expect(compact.labelTable).toHaveLength(4);
    expect(compact.labelPathTable).toHaveLength(120);
    expect(labelsOf(compact).every(Number.isSafeInteger)).toBe(true);
    expect(labelsOf(compact, "path").every(Number.isSafeInteger)).toBe(true);
    expect(canonical(compact).length).toBeLessThan(before.length * 0.5);
    const decoded = decodeTrustedMemoryBoundary(canonical(compact));
    const expanded = expandSessionSyncLabels(decoded);
    expect(expanded).toEqual(original);
    expect(canonical(expanded)).toBe(before);
    expect(canonical(original)).toBe(before);
    expect(compact.upserts[0].doc?.value).toBe(original.upserts[0].doc?.value);
    expect(compact.upserts[0].doc?.extraMetadata).toBe(
      original.upserts[0].doc?.extraMetadata,
    );
    expect(compact.removes).toBe(original.removes);
    expect(compact.crossings).toBe(original.crossings);
  });

  it("shares frozen label copies without freezing or mutating its inputs", () => {
    const sync = repeatedSync();
    const sourceLabel = labelsOf(sync)[0];
    const compact = compressSessionSyncLabels(sync);
    const before = canonical(compact);
    const expanded = expandSessionSyncLabels(compact);
    const labels = labelsOf(expanded);
    expect(labels[0]).toBe(labels[4]);
    expect(labels[0]).not.toBe(sourceLabel);
    expect(Object.isFrozen(sourceLabel)).toBe(false);
    expect(Object.isFrozen(labels[0])).toBe(true);
    assert(isPlainObject(labels[0]) && Array.isArray(labels[0].integrity));
    expect(Object.isFrozen(labels[0].integrity)).toBe(true);
    expect(Object.isFrozen(labels[0].integrity[0])).toBe(true);
    expect(canonical(compact)).toBe(before);
    const other = labelsOf(expandSessionSyncLabels(compact));
    expect(other[0]).not.toBe(labels[0]);
    const paths = labelsOf(expanded, "path");
    const sourcePath = labelsOf(sync, "path")[0];
    expect(paths[0]).toBe(paths[120]);
    expect(paths[0]).not.toBe(sourcePath);
    expect(Object.isFrozen(paths[0])).toBe(true);
    expect(Object.isFrozen(sourcePath)).toBe(false);
  });

  it("deep-freezes expanded document roots so discarded copy-on-write revisions stay isolated", () => {
    const original = repeatedSync();
    const compact = compressSessionSyncLabels(original);
    expect(Object.isFrozen(original)).toBe(false);
    expect(Object.isFrozen(original.upserts[0].doc)).toBe(false);
    expect(Object.isFrozen(original.upserts[0].doc?.value)).toBe(false);
    const expanded = expandSessionSyncLabels(compact);
    expect(isDeepFrozen(expanded)).toBe(true);
    expect(Object.isFrozen(expanded.upserts)).toBe(true);
    const upsert = expanded.upserts[0];
    const doc = upsert.doc;
    assert(doc !== undefined);
    expect(Object.isFrozen(upsert)).toBe(true);
    expect(Object.isFrozen(doc)).toBe(true);
    expect(Object.isFrozen(doc.cfc)).toBe(true);
    assert(isPlainObject(doc.cfc) && isPlainObject(doc.cfc.labelMap));
    expect(Object.isFrozen(doc.cfc.labelMap)).toBe(true);
    const entries = doc.cfc.labelMap.entries;
    assert(Array.isArray(entries));
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(labelsOf(expanded)[0]).toBe(labelsOf(expanded)[4]);
    expect(labelsOf(expanded, "path")[0]).toBe(labelsOf(expanded, "path")[120]);
    const before = canonical(expanded);
    const revision = cloneIfNecessary(doc, {
      frozen: false,
      deep: false,
      force: false,
    });
    expect(revision).not.toBe(doc);
    revision.value = { forged: true };
    expect(canonical(expanded)).toBe(before);
  });

  it("leaves unique labels and unprofitable dictionaries inline", () => {
    const unique = wireSync(Array.from({ length: 50 }, (_, i) => labelFor(i)));
    expect(compressSessionSyncLabels(unique)).toBe(unique);
    const tiny = wireSync([{}, {}]);
    expect(compressSessionSyncLabels(tiny)).toBe(tiny);
    for (let count = 1; count <= 20; count++) {
      const source = wireSync(Array.from({ length: count }, () => ({})));
      const compact = compressSessionSyncLabels(source);
      expect(canonical(compact).length).toBeLessThanOrEqual(
        canonical(source).length,
      );
      expect(canonical(expandSessionSyncLabels(compact))).toBe(
        canonical(source),
      );
    }
  });

  it("selects only profitable labels in a mixed frame", () => {
    const repeated = labelFor(1);
    const source = wireSync([{}, labelFor(99), ...Array(20).fill(repeated)]);
    const compact = compressSessionSyncLabels(source);
    assert(isPlainObject(compact) && Array.isArray(compact.labelTable));
    expect(compact.labelTable).toEqual([repeated]);
    expect(compact.labelPathTable).toBeUndefined();
    expect(labelsOf(compact).slice(0, 2)).toEqual([{}, labelFor(99)]);
    expect(labelsOf(compact).slice(2)).toEqual(Array(20).fill(0));
    expect(canonical(expandSessionSyncLabels(compact))).toBe(canonical(source));
  });

  it("retains absent and undefined fields, array order, and numeric distinctions", () => {
    const variants = [
      {},
      { confidentiality: undefined },
      { integrity: [{ index: 0 }] },
      { integrity: [{ index: -0 }] },
      { confidentiality: ["first", "second", "first"] },
      { confidentiality: ["second", "first", "first"] },
    ];
    const source = wireSync(
      Array.from({ length: 300 }, (_, i) => variants[i % 6]),
    );
    const compact = compressSessionSyncLabels(source);
    assert(isPlainObject(compact) && Array.isArray(compact.labelTable));
    expect(compact.labelTable).toHaveLength(6);
    expect(canonical(expandSessionSyncLabels(compact))).toBe(canonical(source));
  });

  it("accounts for reference digit widths and UTF-8 table costs", () => {
    const labels = Array.from({ length: 130 }, (_, index) => ({
      integrity: [{ index, detail: "é🙂".repeat(20) }],
    }));
    const source = wireSync([...labels, ...labels]);
    const compact = compressSessionSyncLabels(source);
    assert(isPlainObject(compact) && Array.isArray(compact.labelTable));
    expect(compact.labelTable).toHaveLength(130);
    expect(labelsOf(compact)[129]).toBe(129);
    expect(new TextEncoder().encode(canonical(compact)).length).toBeLessThan(
      new TextEncoder().encode(canonical(source)).length,
    );
    expect(canonical(expandSessionSyncLabels(compact))).toBe(canonical(source));
  });

  it("compresses paths independently of unique labels and preserves exact segments", () => {
    const paths = [
      [],
      ["value", "items", "01", "", "*", "a/b", "é🙂"],
      ["value", "items", "1", "", "*", "a/b", "é🙂"],
      ["value", "items", "1", "*", "", "a/b", "é🙂"],
    ];
    const source = wireSync(
      Array.from({ length: 160 }, (_, index) => labelFor(index)),
      undefined,
      Array.from({ length: 160 }, (_, index) => [...paths[index % 4]]),
    );
    const compact = compressSessionSyncLabels(source);
    assert(isPlainObject(compact));
    expect(compact.labelTable).toBeUndefined();
    expect(compact.labelPathTable).toEqual(paths);
    expect(labelsOf(compact, "path").every(Number.isSafeInteger)).toBe(true);
    expect(labelsOf(compact)).toEqual(labelsOf(source));
    const expanded = expandSessionSyncLabels(compact);
    expect(canonical(expanded)).toBe(canonical(source));
    expect(labelsOf(expanded, "path")[1]).toBe(labelsOf(expanded, "path")[5]);
    expect(Object.isFrozen(labelsOf(expanded, "path")[1])).toBe(true);
  });

  it("preserves uncompressed sync identity and ignores unrelated messages", () => {
    const sync = repeatedSync();
    expect(expandSessionSyncLabels(sync)).toBe(sync);
    const messages: ServerMessage[] = [
      {
        type: "response",
        requestId: "error",
        error: { name: "Error", message: "x" },
      },
      {
        type: "response",
        requestId: "data",
        ok: { value: { labelTable: [0] } },
      },
      {
        type: "session/revoked",
        space: "space",
        sessionId: "s",
        reason: "taken-over",
      },
    ];
    for (const message of messages) {
      expect(compressServerMessageLabels(message)).toBe(message);
      expect(expandServerMessageLabels(message)).toBe(message);
    }
    const deletion: SessionSync = {
      type: "sync",
      fromSeq: 0,
      toSeq: 1,
      removes: [],
      upserts: [{ branch: "", id: "of:deleted", seq: 1, deleted: true }],
    };
    expect(compressSessionSyncLabels(deletion)).toBe(deletion);
  });

  it("round-trips effects and successful response syncs", () => {
    const sync = repeatedSync();
    const messages: ServerMessage[] = [
      { type: "session/effect", space: "space", sessionId: "s", effect: sync },
      { type: "response", requestId: "open", ok: { sessionId: "s", sync } },
      { type: "response", requestId: "watch", ok: { serverSeq: 9, sync } },
    ];
    for (const message of messages) {
      const compact = compressServerMessageLabels(message);
      expect(canonical(compact).length).toBeLessThan(canonical(message).length);
      expect(canonical(expandServerMessageLabels(compact))).toBe(
        canonical(message),
      );
    }
  });

  it("composes with schema tables in either compression order", () => {
    const source = repeatedSync();
    const link = linkRefFrom({
      id: "of:linked",
      path: [],
      schema: { type: "object", properties: { title: { type: "string" } } },
    });
    const sync: SessionSync = {
      ...source,
      upserts: source.upserts.map((upsert) => ({
        ...upsert,
        doc: {
          ...upsert.doc,
          value: { link },
          cfc: {
            labelMap: {
              entries: Array.from({ length: 40 }, () => ({
                path: ["value"],
                label: labelFor(0),
              })),
            },
          },
        },
      })),
    };
    const schemaFirst = compressSessionSyncLabels(
      compressSessionSyncSchemas(sync),
    );
    const labelFirst = compressSessionSyncSchemas(
      compressSessionSyncLabels(sync),
    );
    for (
      const [compact, expanded] of [
        [
          schemaFirst,
          expandSessionSyncSchemas(expandSessionSyncLabels(schemaFirst)),
        ],
        [
          labelFirst,
          expandSessionSyncLabels(expandSessionSyncSchemas(labelFirst)),
        ],
      ]
    ) {
      assert("labelTable" in compact && "labelPathTable" in compact);
      expect(compact.labelTable).toBeDefined();
      expect(compact.labelPathTable).toBeDefined();
      expect(canonical(compact).length).toBeLessThan(canonical(sync).length);
      expect(canonical(expanded)).toBe(canonical(sync));
    }
  });

  it("refuses reserved schema refs in received label tables and never interns such a label when sending", () => {
    const schema = internSchema({ type: "string" }, true);
    for (const modern of [false, true]) {
      setModernCellRepConfig(modern);
      try {
        for (const prefix of ["schema-ref@2:", "schema-cas@1:"]) {
          for (const defined of [false, true]) {
            const hash = defined ? schema.taggedHashString : "missing";
            const label = {
              integrity: [{
                source: {
                  nested: [linkRefFrom({
                    id: "of:linked",
                    path: [],
                    schema: `${prefix}${hash}`,
                  })],
                },
              }],
            };
            for (const referenced of [false, true]) {
              const sync = {
                ...wireSync(referenced ? [0] : [], [label]),
                ...(defined
                  ? {
                    schemaTable: { [schema.taggedHashString]: schema.schema },
                  }
                  : {}),
              };
              const message = {
                type: "response",
                requestId: "table-ref",
                ok: { sync },
              };
              const before = canonical(message);
              expect(() => expandSessionSyncLabels(sync))
                .toThrow("reserved schema reference");
              expect(() =>
                expandServerMessageLabels(
                  expandServerMessageSchemas(
                    decodeTrustedMemoryBoundary(before),
                  ),
                )
              ).toThrow("reserved schema reference");
              expect(canonical(message)).toBe(before);
              expect(Object.isFrozen(label)).toBe(false);
            }
            // The sender never interns such a label: it stays inline with no
            // slot, and a frame of nothing else gets no table.
            const inlineOnly = wireSync(Array(20).fill(label));
            expect(compressSessionSyncLabels(inlineOnly)).toBe(inlineOnly);
            const mixed = wireSync([
              ...Array(20).fill(label),
              ...Array(20).fill(labelFor(1)),
            ]);
            const compact = compressSessionSyncLabels(mixed);
            assert(isPlainObject(compact) && Array.isArray(compact.labelTable));
            expect(compact.labelTable).toEqual([labelFor(1)]);
            expect(labelsOf(compact).slice(0, 20)).toEqual(
              Array(20).fill(label),
            );
            expect(labelsOf(compact).slice(20)).toEqual(Array(20).fill(0));
            expect(canonical(expandSessionSyncLabels(compact))).toBe(
              canonical(mixed),
            );
          }
        }
        const alias = {
          integrity: [{
            nested: {
              $alias: {
                cell: { "/": "of:alias" },
                path: [],
                schema: "schema-ref@2:missing",
              },
            },
          }],
        };
        expect(() => expandSessionSyncLabels(wireSync([0], [alias])))
          .toThrow("reserved schema reference");
      } finally {
        resetModernCellRepConfig();
      }
    }
  });

  it("preserves inline and content-addressed link schemas in self-contained labels", () => {
    const cid = `cid:${
      internSchema({ type: "string" }, true).taggedHashString
    }`;
    for (const modern of [false, true]) {
      setModernCellRepConfig(modern);
      try {
        const labels = [
          { type: "object", properties: { title: { type: "string" } } },
          { $ref: cid },
        ].map((schema) => ({
          integrity: [{
            source: {
              nested: [linkRefFrom({
                id: "of:linked",
                path: [],
                schema,
              })],
            },
          }],
          ordinaryData: "schema-ref@2:ordinary-string",
        }));
        const sync = wireSync(
          Array.from({ length: 40 }, (_, i) => labels[i % 2]),
        );
        const message: ServerMessage = {
          type: "response",
          requestId: "self-contained",
          ok: { sync },
        };
        const before = canonical(message);
        const compressed = compressServerMessageSchemas(
          compressServerMessageLabels(message),
        );
        const expanded = expandServerMessageLabels(
          expandServerMessageSchemas(compressed),
        );
        expect(canonical(expanded)).toBe(before);
        expect(canonical(message)).toBe(before);
        expect(Object.isFrozen(labels[0])).toBe(false);
        const wire = wireSync([0, 1], labels);
        const expandedLabels = labelsOf(expandSessionSyncLabels(wire));
        expect(canonical(expandedLabels)).toBe(canonical(labels));
        expect(Object.isFrozen(expandedLabels[0])).toBe(true);
      } finally {
        resetModernCellRepConfig();
      }
    }
  });

  it("throws for malformed label tables and dictionary references while preserving inline labels and table-free numbers", () => {
    for (
      const table of [null, {}, 0, "table", [0], [null], ["ref"], [false], [[]]]
    ) {
      expect(() => expandSessionSyncLabels(wireSync([], table))).toThrow();
    }
    const sparse = new Array(2);
    sparse[1] = labelFor(0);
    expect(() => expandSessionSyncLabels(wireSync([], sparse))).toThrow(
      "sparse",
    );
    for (
      const ref of [-1, -0, 0.5, NaN, Infinity, 1, Number.MAX_SAFE_INTEGER + 1]
    ) {
      expect(() => expandSessionSyncLabels(wireSync([ref], [labelFor(0)])))
        .toThrow("reference");
    }
    // A number is a reference only beside its dictionary; a stored one
    // travels inline in both directions.
    for (const ref of [0, 99]) {
      const stored = wireSync([ref]);
      expect(expandSessionSyncLabels(stored)).toBe(stored);
      expect(compressSessionSyncLabels(stored)).toBe(stored);
    }
    for (
      const label of [
        "sync-label:missing",
        "ordinary-string",
        null,
        false,
        [],
      ]
    ) {
      const sync = wireSync([label]);
      expect(expandSessionSyncLabels(sync)).toBe(sync);
      expect(compressSessionSyncLabels(sync)).toBe(sync);
    }
    expect(() => compressSessionSyncLabels(wireSync([0], [labelFor(0)])))
      .toThrow();
    expect(() =>
      expandSessionSyncLabels({ ...wireSync([]), labelTable: undefined })
    )
      .toThrow();
    expect(() => expandSessionSyncLabels(wireSync([], [() => {}] as never)))
      .toThrow();
  });

  it("preserves malformed inline metadata containers for semantic readers", () => {
    for (
      const doc of [
        null,
        [],
        { cfc: null },
        { cfc: { labelMap: null } },
        { cfc: { labelMap: { entries: {} } } },
        { cfc: { labelMap: { entries: [null] } } },
        { cfc: { labelMap: { entries: [{}] } } },
      ]
    ) {
      const sync = { type: "sync", upserts: [{ doc }] };
      expect(compressSessionSyncLabels(sync)).toBe(sync);
      expect(expandSessionSyncLabels(sync)).toBe(sync);
    }
    expect(() => expandSessionSyncLabels({ type: "sync", upserts: [null] }))
      .toThrow();
    expect(() => expandSessionSyncLabels({ type: "sync", upserts: {} }))
      .toThrow();
  });

  it("throws for malformed path tables and dictionary references while preserving inline paths and table-free numbers", () => {
    for (const table of [null, {}, 0, "table", [0], [null], [{}], [[1]]]) {
      expect(() => expandSessionSyncLabels(wireSync([], undefined, [], table)))
        .toThrow();
    }
    const sparse = new Array(2);
    sparse[1] = ["value"];
    expect(() => expandSessionSyncLabels(wireSync([], undefined, [], sparse)))
      .toThrow("sparse");
    for (
      const ref of [-1, -0, 0.5, NaN, Infinity, 1, Number.MAX_SAFE_INTEGER + 1]
    ) {
      expect(() =>
        expandSessionSyncLabels(wireSync([{}], undefined, [ref], [["value"]]))
      ).toThrow("reference");
    }
    const storedPath = wireSync([{}], undefined, [0]);
    expect(expandSessionSyncLabels(storedPath)).toBe(storedPath);
    expect(compressSessionSyncLabels(storedPath)).toBe(storedPath);
    const sparsePath = new Array(2);
    sparsePath[1] = "value";
    for (
      const path of [
        undefined,
        null,
        {},
        "value",
        [0],
        [false],
        [[]],
        sparsePath,
      ]
    ) {
      const sync = wireSync([{}], undefined, [path]);
      expect(compressSessionSyncLabels(sync)).toBe(sync);
      expect(expandSessionSyncLabels(sync)).toBe(sync);
      expect(() => expandSessionSyncLabels(wireSync([], undefined, [], [path])))
        .toThrow();
    }
    expect(() =>
      expandSessionSyncLabels({ ...wireSync([]), labelPathTable: undefined })
    ).toThrow();
    expect(() => compressSessionSyncLabels(wireSync([], undefined, [], [])))
      .toThrow();
  });

  it("bounds path references and label references by one combined byte budget", () => {
    const label = { integrity: [{ payload: "x".repeat(65536) }] };
    const path = ["value", "p".repeat(65536)];
    const encoder = new TextEncoder();
    const cost = encoder.encode(canonical(label)).length +
      encoder.encode(canonical(path)).length;
    const maximum = Math.floor(MAX_SYNC_LABEL_EXPANSION_BYTES / cost);
    const valid = wireSync(
      Array(maximum).fill(0),
      [label],
      Array(maximum).fill(0),
      [path],
    );
    const expanded = expandSessionSyncLabels(valid);
    expect(labelsOf(expanded)).toHaveLength(maximum);
    expect(labelsOf(expanded, "path")[0]).toBe(
      labelsOf(expanded, "path")[maximum - 1],
    );
    const oversized = wireSync(
      Array(maximum + 1).fill(0),
      [label],
      Array(maximum + 1).fill(0),
      [path],
    );
    expect(() => expandSessionSyncLabels(oversized)).toThrow("byte limit");
    // The sender never produces what the receiver refuses: past the budget
    // it leaves the frame inline, which every receiver accepts.
    const inline = wireSync(
      Array(maximum + 1).fill(label),
      undefined,
      Array(maximum + 1).fill(path),
    );
    expect(compressSessionSyncLabels(inline)).toBe(inline);
    const pathMaximum = Math.floor(
      MAX_SYNC_LABEL_EXPANSION_BYTES /
        encoder.encode(canonical(path)).length,
    );
    expect(() =>
      expandSessionSyncLabels(
        wireSync(
          Array(pathMaximum + 1).fill({}),
          undefined,
          Array(pathMaximum + 1).fill(0),
          [path],
        ),
      )
    )
      .toThrow("byte limit");
  });

  it("throws before delivering a reference amplification beyond the byte budget and sends such frames inline", () => {
    const label = {
      integrity: [{ type: "opaque", payload: "x".repeat(65536) }],
    };
    const cost = new TextEncoder().encode(canonical(label)).byteLength;
    const maximum = Math.floor(MAX_SYNC_LABEL_EXPANSION_BYTES / cost);
    const valid = wireSync(Array(maximum).fill(0), [label]);
    const expandedLabels = labelsOf(expandSessionSyncLabels(valid));
    expect(expandedLabels).toHaveLength(maximum);
    expect(expandedLabels[0]).toBe(expandedLabels[maximum - 1]);
    expect(canonical(valid).length).toBeLessThan(100000);
    expect(() =>
      expandSessionSyncLabels(wireSync(Array(maximum + 1).fill(0), [label]))
    )
      .toThrow("byte limit");
    const inline = wireSync(Array(maximum + 1).fill(label));
    expect(compressSessionSyncLabels(inline)).toBe(inline);
  });
});
