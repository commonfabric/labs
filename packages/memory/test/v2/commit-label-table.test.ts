import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  cloneIfNecessary,
  type FabricPlainObject,
  type FabricValue,
  hashOf,
  isDeepFrozen,
  isValidFabricValue,
} from "@commonfabric/data-model";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { isPlainObject } from "@commonfabric/utils/types";

import {
  decodeTrustedMemoryBoundary,
  encodeMemoryBoundary,
  type EntityDocument,
  isEntityDocument,
  type Operation,
  type PatchOp,
  type ResponseMessage,
  type ServerMessage,
  toValuePath,
  type TransactRequest,
} from "../../v2.ts";
import {
  compressClientMessageLabels,
  compressServerMessageCommitLabels,
  expandClientMessageLabels,
  expandServerMessageCommitLabels,
  hasClientMessageLabelMetadata,
  hasServerMessageCommitLabelMetadata,
} from "../../v2/commit-label-table.ts";
import type { AppliedCommit, AppliedRevision } from "../../v2/engine.ts";
import { MAX_LABEL_METADATA_EXPANSION_BYTES } from "../../v2/label-metadata-table.ts";
import { applyPatchToDocument } from "../../v2/patch.ts";
import {
  parseRoutedText,
  ROUTED_DEFAULT_SLOT_LIMIT,
} from "../../v2/routed-parser.ts";
import {
  compressServerMessageLabels,
  expandServerMessageLabels,
} from "../../v2/sync-label-table.ts";
import {
  compressServerMessageSchemas,
  expandServerMessageSchemas,
} from "../../v2/sync-schema-table.ts";

/** Builds independent objects whose content repeats across metadata entries. */
function label(index = 0): FabricPlainObject {
  return {
    confidentiality: undefined,
    integrity: [{
      type: "provenance",
      source: { id: `of:source-${index}`, path: ["value", "items", "0"] },
      stamp: "metadata-not-application-data",
    }],
  };
}

/** Builds a labeled document with explicit application-data lookalikes. */
function document(count = 80) {
  return {
    value: {
      count: 0,
      cfc: { labelMap: { entries: [{ label: 7, path: 8 }] } },
      labelTable: [9],
      labelPathTable: [10],
    },
    cfc: {
      version: 1,
      labelMap: {
        version: 1,
        entries: Array.from({ length: count }, (_, index) => ({
          path: ["value", "items", `${index % 7}`],
          label: label(index % 3),
          origin: "link",
          observes: index % 2 ? "shape" : "value",
        })),
      },
    },
  };
}

/** Builds the ordinary request shape without changing non-operation fields. */
function request(operations: Operation[]): TransactRequest {
  return {
    type: "transact",
    requestId: "request:metadata",
    space: "did:key:metadata",
    sessionId: "session:metadata",
    commit: {
      localSeq: 42,
      reads: { confirmed: [], pending: [] },
      operations,
      preconditions: [{
        kind: "entity-value-hash",
        id: "of:guard",
        valueHash: "original",
      }],
    },
  };
}

/** Reads an untyped boundary result as a request envelope. */
function commitOf(value: unknown): Record<string, unknown> {
  assert(isPlainObject(value) && isPlainObject(value.commit));
  return value.commit;
}

/** Encodes a boundary result through the canonical memory codec. */
function canonical(value: unknown): string {
  assert(isValidFabricValue(value));
  return encodeMemoryBoundary(value);
}

/** Produces a compact wire request for input-validation tests. */
function wire(
  labelValue: FabricValue,
  pathValue: FabricValue,
  tables: FabricPlainObject = {},
) {
  const base = request([]);
  return {
    ...base,
    commit: {
      ...base.commit,
      ...tables,
      operations: [{
        op: "set",
        id: "of:wire",
        value: {
          cfc: {
            labelMap: { entries: [{ label: labelValue, path: pathValue }] },
          },
        },
      }],
    },
  };
}

describe("commit-label-table", () => {
  it("round-trips thirty labeled ACK revisions below the routed node limit without changing replay results", () => {
    const source = {
      ...ack(
        Array.from(
          { length: 30 },
          (_, index) => revision(document(410), index),
        ),
      ),
      nextSeq: 20,
    };
    const before = canonical(source);
    expect(() => parseRoutedText(before, ROUTED_DEFAULT_SLOT_LIMIT)).toThrow();
    const compact = compressServerMessageCommitLabels(source);
    expect(hasServerMessageCommitLabelMetadata(source)).toBe(false);
    expect(hasServerMessageCommitLabelMetadata(compact)).toBe(true);
    expect(canonical(compact).length).toBeLessThan(before.length * 0.5);
    expect(
      parseRoutedText(canonical(compact), ROUTED_DEFAULT_SLOT_LIMIT).body.type,
    ).toBe("response");
    expect(Object.isFrozen(source.ok)).toBe(false);
    expect(Object.isFrozen(source.ok.revisions[0].document)).toBe(false);
    const expanded = expandServerMessageCommitLabels(
      decodeTrustedMemoryBoundary(canonical(compact)),
    );
    expect(canonical(expanded)).toBe(before);
    assert(isValidFabricValue(expanded));
    expect(hashOf(expanded).toString()).toBe(hashOf(source).toString());
    expect(isDeepFrozen(expanded)).toBe(true);
    expect(hasServerMessageCommitLabelMetadata(expanded)).toBe(false);
    expect(canonical(source)).toBe(before);
    expect(canonical(compressServerMessageCommitLabels(source))).toBe(
      canonical(compact),
    );
    const inline = decodeTrustedMemoryBoundary(before);
    assert(isValidFabricValue(inline));
    const frozen = cloneIfNecessary(inline);
    expect(isDeepFrozen(frozen)).toBe(true);
    expect(canonical(compressServerMessageCommitLabels(frozen))).toBe(
      canonical(compact),
    );
    expect(canonical(frozen)).toBe(before);
  });

  it("round-trips patch ACKs, absent documents, and delete revisions without interpreting user payloads", () => {
    const patches: PatchOp[] = [
      { op: "replace", path: "", value: document() },
      {
        op: "append",
        path: "/cfc/labelMap/entries",
        values: document().cfc.labelMap.entries,
      },
      { op: "replace", path: "/value/cfc/labelMap/entries/0/label", value: 0 },
      { op: "replace", path: "/cfc", value: null },
    ];
    const base = revision(document());
    const { document: _document, ...identity } = base;
    const source = ack([
      base,
      { ...identity, opIndex: 1, op: "patch", patches },
      { ...identity, opIndex: 2, op: "delete" },
      { ...identity, opIndex: 3, document: undefined },
    ]);
    const before = canonical(source);
    const compact = compressServerMessageCommitLabels(source);
    expect(hasServerMessageCommitLabelMetadata(compact)).toBe(true);
    const expanded = expandServerMessageCommitLabels(compact);
    expect(canonical(expanded)).toBe(before);
    expect(isDeepFrozen(expanded)).toBe(true);
    const decoded = decodeTrustedMemoryBoundary<ResponseMessage<AppliedCommit>>(
      canonical(expanded),
    );
    assert(decoded.ok && decoded.ok.revisions[1].patches);
    expect(canonical(applyPatchToDocument({}, decoded.ok.revisions[1].patches)))
      .toBe(
        canonical(applyPatchToDocument({}, patches)),
      );
    const indexedPatch = ack([{
      ...identity,
      op: "patch",
      patches: [
        { op: "replace", path: "/cfc/labelMap/entries/0/label", value: 0 },
      ],
    }]);
    expect(hasServerMessageCommitLabelMetadata(indexedPatch)).toBe(true);
    expect(() => expandServerMessageCommitLabels(indexedPatch)).toThrow(
      "reference",
    );
    expect(() => compressServerMessageCommitLabels(indexedPatch)).toThrow(
      "reference",
    );
  });

  it("scopes ACK dictionaries independently of sync label and schema tables", () => {
    const doc = document();
    doc.cfc.labelMap.entries[0].label = {
      integrity: [
        linkRefFrom({ id: "of:linked", path: [], schema: { type: "string" } }),
      ],
    };
    const source = ack([revision(doc), revision(doc, 1)]);
    const before = canonical(source);
    const compress: (message: ServerMessage) => ServerMessage =
      compressServerMessageCommitLabels;
    const compact = compress(source);
    expect(compressServerMessageSchemas(compact)).toBe(compact);
    expect(compressServerMessageLabels(compact)).toBe(compact);
    expect(expandServerMessageSchemas(compact)).toBe(compact);
    expect(expandServerMessageLabels(compact)).toBe(compact);
    expect(canonical(expandServerMessageCommitLabels(compact))).toBe(before);
    const syncResponse = {
      type: "response",
      requestId: "ack-looking-name",
      ok: {
        sync: { type: "sync", upserts: [{ doc }], labelTable: [{}] },
      },
    };
    expect(hasServerMessageCommitLabelMetadata(syncResponse)).toBe(false);
    expect(compressServerMessageCommitLabels(syncResponse)).toBe(syncResponse);
    expect(expandServerMessageCommitLabels(syncResponse)).toBe(syncResponse);
    const dataResponse = {
      type: "response",
      requestId: "transact",
      ok: {
        rows: [{ revisions: [revision(doc)], labelTable: [0] }],
      },
    };
    expect(hasServerMessageCommitLabelMetadata(dataResponse)).toBe(false);
    expect(expandServerMessageCommitLabels(dataResponse)).toBe(dataResponse);
    const missingTable = ack([
      revision({ cfc: { labelMap: { entries: [{ label: 0, path: [] }] } } }),
    ]);
    const siblingTable = {
      ...missingTable,
      ok: {
        ...missingTable.ok,
        sync: { type: "sync", upserts: [], labelTable: [{}] },
      },
    };
    expect(() => expandServerMessageCommitLabels(siblingTable)).toThrow(
      "reference",
    );
  });

  it("rejects table-free ACK references under invalid result parents while preserving inline metadata", () => {
    for (const parent of [{ seq: 19 }, { branch: "", seq: "19" }]) {
      for (const field of ["label", "path"]) {
        const source = {
          type: "response",
          requestId: "opaque",
          ok: {
            ...parent,
            revisions: [
              revision({ cfc: { labelMap: { entries: [{ [field]: 0 }] } } }),
            ],
          },
        };
        expect(() => hasServerMessageCommitLabelMetadata(source)).toThrow(
          "Invalid commit result",
        );
        expect(() => expandServerMessageCommitLabels(source)).toThrow(
          "Invalid commit result",
        );
        expect(() => compressServerMessageCommitLabels(source)).toThrow(
          "Invalid commit result",
        );
        const patch = {
          ...revision({}),
          op: "patch",
          patches: [{
            op: "replace",
            path: `/cfc/labelMap/entries/0/${field}`,
            value: 0,
          }],
        };
        const patchSource = {
          ...source,
          ok: { ...parent, revisions: [patch] },
        };
        expect(() => hasServerMessageCommitLabelMetadata(patchSource)).toThrow(
          "Invalid commit result",
        );
        expect(() => expandServerMessageCommitLabels(patchSource)).toThrow(
          "Invalid commit result",
        );
      }
      const inline = {
        type: "response",
        requestId: "opaque",
        ok: {
          ...parent,
          revisions: [
            revision(document()),
            revision({ cfc: null }, 1),
            revision(
              { cfc: { labelMap: { entries: [{ path: ["secret"] }] } } },
              2,
            ),
          ],
          application: {
            revisions: [{
              document: { cfc: { labelMap: { entries: [{ label: 0 }] } } },
            }],
          },
        },
      };
      const before = canonical(inline);
      expect(hasServerMessageCommitLabelMetadata(inline)).toBe(false);
      expect(compressServerMessageCommitLabels(inline)).toBe(inline);
      expect(expandServerMessageCommitLabels(inline)).toBe(inline);
      expect(canonical(inline)).toBe(before);
    }
  });

  it("preserves inline ACK revisions without scope keys and rejects their indexed metadata", () => {
    const { scopeKey: _scopeKey, ...inlineRevision } = revision(document());
    const source = {
      ...ack([]),
      ok: { seq: 19, branch: "", revisions: [inlineRevision] },
    };
    const before = canonical(source);
    expect(hasServerMessageCommitLabelMetadata(source)).toBe(false);
    expect(compressServerMessageCommitLabels(source)).toBe(source);
    expect(expandServerMessageCommitLabels(source)).toBe(source);
    expect(canonical(source)).toBe(before);
    const mixed = {
      ...source,
      ok: {
        ...source.ok,
        revisions: [inlineRevision, revision(document(), 1)],
      },
    };
    const compact = compressServerMessageCommitLabels(mixed);
    expect(hasServerMessageCommitLabelMetadata(compact)).toBe(true);
    expect(canonical(expandServerMessageCommitLabels(compact))).toBe(
      canonical(mixed),
    );
    for (const field of ["label", "path"]) {
      const indexed = {
        ...source,
        ok: {
          ...source.ok,
          revisions: [{
            ...inlineRevision,
            document: { cfc: { labelMap: { entries: [{ [field]: 0 }] } } },
          }],
        },
      };
      expect(() => hasServerMessageCommitLabelMetadata(indexed)).toThrow(
        "Invalid commit revision",
      );
      expect(() => compressServerMessageCommitLabels(indexed)).toThrow(
        "Invalid commit revision",
      );
      expect(() => expandServerMessageCommitLabels(indexed)).toThrow(
        "Invalid commit revision",
      );
    }
  });

  it("validates ACK table labels for self-contained schemas even when unused", () => {
    for (const schema of ["schema-ref@2:missing", "schema-cas@1:missing"]) {
      const source = ack([]);
      const indexed = {
        ...source,
        ok: {
          ...source.ok,
          labelTable: [{
            integrity: [linkRefFrom({ id: "of:linked", path: [], schema })],
          }],
        },
      };
      expect(hasServerMessageCommitLabelMetadata(indexed)).toBe(true);
      expect(() => expandServerMessageCommitLabels(indexed)).toThrow(
        "reserved schema reference",
      );
    }
    const malformed = { type: "response", ok: { labelTable: [] } };
    expect(hasServerMessageCommitLabelMetadata(malformed)).toBe(true);
    expect(() => expandServerMessageCommitLabels(malformed)).toThrow(
      "commit result",
    );
  });

  it("bounds ACK label and path references together across all revisions", () => {
    const bigLabel = { integrity: [{ body: "x".repeat(65536) }] };
    const bigPath = ["value", "p".repeat(65536)];
    const cost = new TextEncoder().encode(canonical(bigLabel)).length +
      new TextEncoder().encode(canonical(bigPath)).length;
    const maximum = Math.floor(MAX_LABEL_METADATA_EXPANSION_BYTES / cost);
    const item = revision({
      cfc: { labelMap: { entries: [{ label: 0, path: 0 }] } },
    });
    const source = ack(Array(maximum).fill(item));
    const valid = {
      ...source,
      ok: { ...source.ok, labelTable: [bigLabel], labelPathTable: [bigPath] },
    };
    expect(isDeepFrozen(expandServerMessageCommitLabels(valid))).toBe(true);
    const oversized = {
      ...valid,
      ok: { ...valid.ok, revisions: [...valid.ok.revisions, item] },
    };
    expect(() => expandServerMessageCommitLabels(oversized)).toThrow(
      "byte limit",
    );
  });

  it("round-trips repeated set metadata with identical canonical bytes and hashes", () => {
    const source = request(Array.from({ length: 30 }, (_, index) => ({
      op: "set",
      id: `of:document-${index}`,
      scope: "space",
      value: document(),
    })));
    const before = canonical(source);
    const compact = compressClientMessageLabels(source);
    const tables = commitOf(compact);
    expect(tables.labelTable).toHaveLength(3);
    expect(tables.labelPathTable).toHaveLength(7);
    expect(canonical(compact).length).toBeLessThan(before.length * 0.5);
    expect(compact).not.toBe(source);
    expect(compact.type).toBe("transact");
    assert(compact.type === "transact");
    expect(compact.commit.reads).toBe(source.commit.reads);
    expect(compact.commit.preconditions).toBe(source.commit.preconditions);
    const op = compact.commit.operations[0];
    const originalOp = source.commit.operations[0];
    assert(op.op === "set" && originalOp.op === "set");
    expect(op.value.value).toBe(originalOp.value.value);
    expect(isDeepFrozen(source)).toBe(false);
    expect(Object.isFrozen(originalOp.value)).toBe(false);
    const expanded = expandClientMessageLabels(
      decodeTrustedMemoryBoundary(canonical(compact)),
    );
    expect(canonical(expanded)).toBe(before);
    assert(isValidFabricValue(expanded));
    expect(hashOf(expanded).toString()).toBe(hashOf(source).toString());
    expect(isDeepFrozen(expanded)).toBe(true);
    expect(canonical(source)).toBe(before);
    expect(hasClientMessageLabelMetadata(source)).toBe(false);
    expect(hasClientMessageLabelMetadata(compact)).toBe(true);
    expect(hasClientMessageLabelMetadata(expanded)).toBe(false);
  });

  it("expands every value-bearing patch form before array edits and moves apply", () => {
    const doc = document();
    const entry = doc.cfc.labelMap.entries[0];
    const entriesPath = "/cfc/labelMap/entries";
    const patches: PatchOp[] = [
      { op: "replace", path: "", value: doc },
      { op: "add", path: "/cfc", value: doc.cfc },
      { op: "replace", path: "/cfc/labelMap", value: doc.cfc.labelMap },
      { op: "replace", path: entriesPath, value: doc.cfc.labelMap.entries },
      { op: "add", path: `${entriesPath}/-`, value: entry },
      { op: "add", path: `${entriesPath}/0`, value: entry },
      { op: "replace", path: `${entriesPath}/0`, value: entry },
      { op: "replace", path: `${entriesPath}/0/label`, value: label() },
      { op: "replace", path: `${entriesPath}/0/path`, value: entry.path },
      {
        op: "splice",
        path: entriesPath,
        index: 1,
        remove: 2,
        add: [entry, entry],
      },
      { op: "append", path: entriesPath, values: [entry] },
      { op: "add-unique", path: entriesPath, values: [entry] },
      { op: "remove-by-value", path: entriesPath, value: entry },
      { op: "move", from: `${entriesPath}/0`, path: `${entriesPath}/1` },
      { op: "remove", path: `${entriesPath}/0` },
      {
        op: "splice",
        path: `${entriesPath}/0/path`,
        index: 0,
        remove: 0,
        add: ["prefix"],
      },
      { op: "append", path: `${entriesPath}/0/path`, values: ["tail"] },
      { op: "remove-by-value", path: `${entriesPath}/0/path`, value: "tail" },
      {
        op: "add-unique",
        path: `${entriesPath}/0/label/integrity`,
        values: [{ number: 0 }],
      },
      { op: "increment", path: "/value/count", by: 1 },
    ];
    const source = request([{ op: "patch", id: "of:patch", patches }]);
    const before = canonical(source);
    const compact = compressClientMessageLabels(source);
    expect(hasClientMessageLabelMetadata(compact)).toBe(true);
    const expanded = expandClientMessageLabels(compact);
    expect(canonical(expanded)).toBe(before);
    expect(isDeepFrozen(expanded)).toBe(true);
    const decoded = decodeTrustedMemoryBoundary<TransactRequest>(
      canonical(expanded),
    );
    const operation = decoded.commit.operations[0];
    assert(operation.op === "patch");
    expect(canonical(applyPatchToDocument({}, operation.patches))).toBe(
      canonical(applyPatchToDocument({}, patches)),
    );
    expect(canonical(source)).toBe(before);
  });

  it("leaves user values, escaped lookalikes, and label components opaque", () => {
    const numericEntry = { label: 0, path: 1 };
    const patches: PatchOp[] = [
      {
        op: "replace",
        path: "/value/cfc/labelMap/entries/0",
        value: numericEntry,
      },
      { op: "replace", path: "/cf~1c/labelMap/entries/0", value: numericEntry },
      { op: "replace", path: "/cfc/label~0Map/entries/0", value: numericEntry },
      {
        op: "replace",
        path: "/cfc/labelMap/entries/0/label/numeric",
        value: 0,
      },
      { op: "replace", path: "/cfc/labelMap/entries/0/path/0", value: "0" },
      {
        op: "replace",
        path: "/cfc/labelMap/entries/0/extension",
        value: numericEntry,
      },
      {
        op: "splice",
        path: "/value/items",
        index: 0,
        remove: 0,
        add: [numericEntry],
      },
      { op: "append", path: "/value/items", values: [numericEntry] },
      { op: "remove-by-value", path: "/value/items", value: numericEntry },
      { op: "replace", path: "/cfc", value: undefined },
      { op: "replace", path: "/cfc/labelMap", value: undefined },
    ];
    const source = request([
      {
        op: "set",
        id: "of:user",
        value: { value: { cfc: { labelMap: { entries: [numericEntry] } } } },
      },
      { op: "patch", id: "of:patch", patches },
      { op: "delete", id: "of:deleted" },
      {
        op: "apply-op",
        id: "of:operation",
        path: toValuePath(["cfc"]),
        codec: "test",
        submissionId: "submission",
        base: null,
        payload: { cfc: { labelMap: { entries: [numericEntry] } } },
      },
      {
        op: "release-op-field",
        id: "of:operation",
        path: toValuePath(["cfc"]),
        codec: "test",
        cursor: { epoch: 0, version: 1 },
      },
      {
        op: "sqlite",
        db: { id: "of:database" },
        sql: "SELECT ?",
        params: [{ cfc: { labelMap: { entries: [numericEntry] } } }],
      },
    ]);
    expect(hasClientMessageLabelMetadata(source)).toBe(false);
    expect(compressClientMessageLabels(source)).toBe(source);
    expect(expandClientMessageLabels(source)).toBe(source);
    const unrelated = { type: "other", commit: { labelTable: [numericEntry] } };
    expect(hasClientMessageLabelMetadata(unrelated)).toBe(false);
    expect(expandClientMessageLabels(unrelated)).toBe(unrelated);
  });

  it("uses independent beneficial-only dictionaries and preserves inline requests", () => {
    const unique = request([{
      op: "set",
      id: "of:unique",
      value: document(1),
    }]);
    expect(compressClientMessageLabels(unique)).toBe(unique);
    expect(expandClientMessageLabels(unique)).toBe(unique);
    const labelOnlyDoc = document();
    labelOnlyDoc.cfc.labelMap.entries.forEach((entry, index) =>
      entry.path = [`unique-${index}`]
    );
    const labelOnly = compressClientMessageLabels(
      request([{ op: "set", id: "of:labels", value: labelOnlyDoc }]),
    );
    expect(commitOf(labelOnly).labelTable).toBeDefined();
    expect(commitOf(labelOnly).labelPathTable).toBeUndefined();
    const pathOnlyDoc = document();
    pathOnlyDoc.cfc.labelMap.entries.forEach((entry, index) =>
      entry.label = label(index)
    );
    const pathOnly = compressClientMessageLabels(
      request([{ op: "set", id: "of:paths", value: pathOnlyDoc }]),
    );
    expect(commitOf(pathOnly).labelTable).toBeUndefined();
    expect(commitOf(pathOnly).labelPathTable).toBeDefined();
    expect(canonical(expandClientMessageLabels(pathOnly))).toBe(
      canonical(request([{ op: "set", id: "of:paths", value: pathOnlyDoc }])),
    );
  });

  it("detects unnegotiated numeric refs at direct patch and collection entry positions", () => {
    const root = "/cfc/labelMap/entries";
    const patches: PatchOp[] = [
      { op: "replace", path: `${root}/0/label`, value: 0 },
      { op: "add", path: `${root}/0/path`, value: 0 },
      { op: "add", path: `${root}/-`, value: { label: 0, path: [] } },
      {
        op: "splice",
        path: root,
        index: 0,
        remove: 0,
        add: [{ label: {}, path: 0 }],
      },
      { op: "append", path: root, values: [{ label: 0, path: [] }] },
      { op: "add-unique", path: root, values: [{ label: 0, path: [] }] },
      { op: "remove-by-value", path: root, value: { label: 0, path: [] } },
    ];
    for (const patch of patches) {
      const source = request([{
        op: "patch",
        id: "of:wire",
        patches: [patch],
      }]);
      expect(hasClientMessageLabelMetadata(source)).toBe(true);
      expect(() => expandClientMessageLabels(source)).toThrow("reference");
      expect(() => compressClientMessageLabels(source)).toThrow();
    }
  });

  it("rejects malformed tables and references without changing the input", () => {
    for (const name of ["labelTable", "labelPathTable"]) {
      for (const table of [undefined, null, {}, 0, [0], [null], new Array(1)]) {
        const source = wire({}, [], { [name]: table });
        expect(hasClientMessageLabelMetadata(source)).toBe(true);
        expect(() => expandClientMessageLabels(source)).toThrow();
      }
    }
    for (const index of [-1, -0, 0.5, 1, NaN, Infinity]) {
      const source = wire(index, 0, {
        labelTable: [label()],
        labelPathTable: [[]],
      });
      const before = canonical(source);
      expect(() => expandClientMessageLabels(source)).toThrow("reference");
      expect(canonical(source)).toBe(before);
    }
    expect(() =>
      expandClientMessageLabels(wire({}, 0, { labelPathTable: [[2]] }))
    ).toThrow();
    expect(() =>
      expandClientMessageLabels(
        wire(0, [], {
          labelTable: [{
            integrity: [
              linkRefFrom({
                id: "of:link",
                path: [],
                schema: "schema-ref@2:missing",
              }),
            ],
          }],
        }),
      )
    )
      .toThrow("reserved schema reference");
  });

  it("shares immutable metadata and freezes operation document roots for copy-on-write", () => {
    const expanded = expandClientMessageLabels(
      compressClientMessageLabels(request([
        { op: "set", id: "of:first", value: document() },
        { op: "set", id: "of:second", value: document() },
      ])),
    );
    const commit = commitOf(expanded);
    assert(Array.isArray(commit.operations));
    const first: unknown = commit.operations[0];
    const second: unknown = commit.operations[1];
    assert(isPlainObject(first) && isPlainObject(second));
    assert(isPlainObject(first.value) && isPlainObject(second.value));
    expect(isDeepFrozen(expanded)).toBe(true);
    assert(
      isPlainObject(first.value.cfc) && isPlainObject(first.value.cfc.labelMap),
    );
    assert(
      isPlainObject(second.value.cfc) &&
        isPlainObject(second.value.cfc.labelMap),
    );
    const a = first.value.cfc.labelMap.entries;
    const b = second.value.cfc.labelMap.entries;
    assert(
      Array.isArray(a) && Array.isArray(b) && isPlainObject(a[0]) &&
        isPlainObject(b[0]),
    );
    expect(a[0].label).toBe(b[0].label);
    expect(a[0].path).toBe(b[0].path);
    assert(isEntityDocument(first.value));
    const copy = cloneIfNecessary<EntityDocument>(first.value, {
      deep: false,
      frozen: false,
      force: false,
    });
    expect(copy).not.toBe(first.value);
    copy.value = { forged: true };
    expect(first.value.value).not.toEqual(copy.value);
  });

  it("applies the combined reference expansion budget across all commit operations", () => {
    const bigLabel = { integrity: [{ body: "x".repeat(65536) }] };
    const bigPath = ["value", "p".repeat(65536)];
    const cost = new TextEncoder().encode(canonical(bigLabel)).length +
      new TextEncoder().encode(canonical(bigPath)).length;
    const maximum = Math.floor(MAX_LABEL_METADATA_EXPANSION_BYTES / cost);
    const prototype = wire(0, 0, {
      labelTable: [bigLabel],
      labelPathTable: [bigPath],
    });
    const operation = prototype.commit.operations[0];
    const valid = {
      ...prototype,
      commit: {
        ...prototype.commit,
        operations: Array(maximum).fill(operation),
      },
    };
    expect(isDeepFrozen(expandClientMessageLabels(valid))).toBe(true);
    const oversized = {
      ...prototype,
      commit: {
        ...prototype.commit,
        operations: Array(maximum + 1).fill(operation),
      },
    };
    expect(() => expandClientMessageLabels(oversized)).toThrow("byte limit");
  });
});

/** Builds a stored set revision with sequence and scope identity. */
function revision(value: EntityDocument, opIndex = 0): AppliedRevision {
  return {
    id: `of:revision-${opIndex}`,
    branch: "",
    scope: "space",
    scopeKey: "space",
    seq: 19,
    commitSeq: 19,
    opIndex,
    op: "set",
    document: value,
  };
}

/** Builds a replayed ACK with metadata that must survive transport unchanged. */
function ack(revisions: AppliedRevision[]) {
  return {
    type: "response" as const,
    requestId: "opaque:request",
    ok: {
      seq: 19,
      branch: "",
      revisions,
      replayed: true,
      elidedOpIndexes: [31],
    },
  } satisfies ResponseMessage<AppliedCommit>;
}
