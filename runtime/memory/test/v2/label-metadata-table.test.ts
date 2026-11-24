import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type FabricPlainObject,
  hashOf,
  isDeepFrozen,
  isValidFabricValue,
} from "@commonfabric/data-model";
import { isPlainObject } from "@commonfabric/js-values/types";

import { decodeTrustedMemoryBoundary, encodeMemoryBoundary } from "../../v2.ts";
import {
  compressClientMessageLabels,
  compressServerMessageCommitLabels,
  expandClientMessageLabels,
  expandServerMessageCommitLabels,
  hasClientMessageLabelMetadata,
  hasServerMessageCommitLabelMetadata,
} from "../../v2/commit-label-table.ts";
import {
  compressSessionSyncLabels,
  expandSessionSyncLabels,
  hasServerMessageLabelMetadata,
} from "../../v2/sync-label-table.ts";

/** Builds a transact envelope with documents at actual operation positions. */
function request(docs: FabricPlainObject[], tables: FabricPlainObject = {}) {
  return {
    type: "transact",
    commit: {
      ...tables,
      operations: docs.map((value, index) => ({
        op: "set",
        id: `of:${index}`,
        value,
      })),
    },
  };
}

/** Builds a sync envelope with documents at actual upsert positions. */
function sync(docs: FabricPlainObject[], tables: FabricPlainObject = {}) {
  return { type: "sync", ...tables, upserts: docs.map((doc) => ({ doc })) };
}

/** Encodes through the memory boundary after validating the untyped result. */
function canonical(value: unknown): string {
  assert(isValidFabricValue(value));
  return encodeMemoryBoundary(value);
}

/** Builds profitable metadata beside inline semantic errors. */
function compressibleDocument(): FabricPlainObject {
  return {
    cfc: {
      version: 1,
      labelMap: {
        version: 1,
        entries: Array.from({ length: 40 }, () => ({
          path: ["secret", "long-enough-to-compress"],
          label: { integrity: [{ type: "claim", name: "repeated-claim" }] },
        })),
      },
    },
  };
}

const endpoints = [
  {
    wrap: request,
    compress: compressClientMessageLabels,
    expand: expandClientMessageLabels,
    has: hasClientMessageLabelMetadata,
  },
  {
    wrap: (docs: FabricPlainObject[], tables: FabricPlainObject = {}) => ({
      type: "response",
      requestId: "ack",
      ok: {
        seq: 19,
        branch: "",
        ...tables,
        revisions: docs.map((document, opIndex) => ({
          id: `of:${opIndex}`,
          scopeKey: "space",
          branch: "",
          seq: 19,
          commitSeq: 19,
          opIndex,
          op: "set",
          document,
        })),
      },
    }),
    compress: compressServerMessageCommitLabels,
    expand: expandServerMessageCommitLabels,
    has: hasServerMessageCommitLabelMetadata,
  },
  {
    wrap: sync,
    compress: compressSessionSyncLabels,
    expand: expandSessionSyncLabels,
    has: (message: unknown) =>
      hasServerMessageLabelMetadata({
        type: "response",
        ok: { sync: message },
      }),
  },
];

describe("label-metadata-table", () => {
  it("preserves inline semantic errors and null policy through both transports and guards", () => {
    const docs: FabricPlainObject[] = [
      {},
      { cfc: null },
      { cfc: undefined },
      { cfc: false },
      { cfc: NaN },
      { cfc: [] },
      { cfc: { labelMap: null } },
      { cfc: { labelMap: "unreadable" } },
      { cfc: { labelMap: { entries: {} } } },
      { cfc: { labelMap: { entries: NaN } } },
      { cfc: { labelMap: { entries: [null, {}, NaN] } } },
      { cfc: { labelMap: { version: 1, entries: [{ path: ["secret"] }] } } },
      {
        cfc: {
          version: 99,
          labelMap: { version: 99, entries: [{ label: {} }] },
        },
      },
      { cfc: { labelMap: { entries: [{ path: [1], label: {} }] } } },
      { cfc: { labelMap: { entries: [{ path: [], label: "unreadable" }] } } },
      { cfc: { labelMap: { entries: { "0": { path: ["secret"] } } } } },
      { value: { cfc: { labelMap: { entries: [{ label: 0, path: 0 }] } } } },
      {
        cfc: {
          version: 99,
          extension: { labelMap: { entries: [{ label: 0 }] } },
        },
      },
    ];
    for (const endpoint of endpoints) {
      const source = endpoint.wrap(docs);
      const before = canonical(source);
      expect(endpoint.has(source)).toBe(false);
      expect(endpoint.compress(source)).toBe(source);
      expect(endpoint.expand(source)).toBe(source);
      expect(canonical(source)).toBe(before);
      expect(Object.isFrozen(docs[1])).toBe(false);

      const mixed = endpoint.wrap([...docs, compressibleDocument()]);
      const original = canonical(mixed);
      const compact = endpoint.compress(mixed);
      expect(compact).not.toBe(mixed);
      expect(endpoint.has(compact)).toBe(true);
      expect(canonical(compact).length).toBeLessThan(original.length);
      expect(Object.isFrozen(docs[1])).toBe(false);
      const expanded = endpoint.expand(
        decodeTrustedMemoryBoundary(canonical(compact)),
      );
      expect(canonical(expanded)).toBe(original);
      assert(isValidFabricValue(expanded));
      expect(hashOf(expanded).toString()).toBe(hashOf(mixed).toString());
      expect(isDeepFrozen(expanded)).toBe(true);
      expect(endpoint.has(expanded)).toBe(false);
      expect(canonical(mixed)).toBe(original);
    }
  });

  it("keeps table-free numeric fields inline and resolves tabled ones despite missing siblings and unsupported versions", () => {
    for (const endpoint of endpoints) {
      for (const field of ["label", "path"]) {
        for (const recordEntries of [false, true]) {
          for (const ref of [0, -0, -1, 0.5, 1, NaN, Infinity]) {
            const entry = { [field]: ref };
            const doc = {
              cfc: {
                version: 99,
                labelMap: {
                  version: 99,
                  entries: recordEntries ? { "0": entry } : [entry],
                },
              },
            };
            // Without a dictionary the number is stored data: it needs no
            // negotiation, compresses to nothing, and expands to itself.
            const source = endpoint.wrap([doc]);
            const before = canonical(source);
            expect(endpoint.has(source)).toBe(false);
            expect(endpoint.compress(source)).toBe(source);
            expect(endpoint.expand(source)).toBe(source);
            expect(canonical(source)).toBe(before);
            const value = field === "label" ? {} : ["secret"];
            const tables = field === "label"
              ? { labelTable: [value] }
              : { labelPathTable: [value] };
            const withTable = endpoint.wrap([doc], tables);
            if (Object.is(ref, 0)) {
              const expandedEntry = { [field]: value };
              const expected = endpoint.wrap([{
                cfc: {
                  version: 99,
                  labelMap: {
                    version: 99,
                    entries: recordEntries
                      ? { "0": expandedEntry }
                      : [expandedEntry],
                  },
                },
              }]);
              const expanded = endpoint.expand(withTable);
              expect(canonical(expanded)).toBe(canonical(expected));
              expect(isDeepFrozen(expanded)).toBe(true);
            } else {
              expect(() => endpoint.expand(withTable)).toThrow("reference");
            }
          }
        }
      }
    }
  });

  it("validates unused dictionary slots even when inline metadata is unreadable", () => {
    for (const endpoint of endpoints) {
      for (
        const tables of [
          { labelTable: [null] },
          { labelTable: [{}], labelPathTable: [[1]] },
          { labelTable: new Array(1) },
          { labelPathTable: undefined },
        ]
      ) {
        const source = endpoint.wrap([{ cfc: null }], tables);
        expect(endpoint.has(source)).toBe(true);
        expect(() => endpoint.expand(source)).toThrow();
      }
    }
  });

  it("keeps a stored numeric field inline and emits no dictionary beside it", () => {
    for (const endpoint of endpoints) {
      for (const field of ["label", "path"]) {
        const stored = {
          cfc: {
            version: 1,
            labelMap: {
              version: 1,
              entries: [{ path: ["secret"], label: {}, [field]: 7 }],
            },
          },
        };
        // The repeated document alone earns a dictionary; the stored number
        // beside it would then read as a reference, so the envelope stays
        // inline and is delivered to a negotiated receiver unchanged.
        const source = endpoint.wrap([compressibleDocument(), stored]);
        const before = canonical(source);
        expect(endpoint.compress(source)).toBe(source);
        expect(endpoint.has(source)).toBe(false);
        expect(endpoint.expand(source)).toBe(source);
        expect(canonical(source)).toBe(before);
      }
    }
  });

  it("sends the envelope inline when the dictionaries would exceed the expansion budget", () => {
    const label = { confidentiality: ["x".repeat(1024 * 1024)], integrity: [] };
    const doc = {
      cfc: {
        version: 1,
        labelMap: {
          version: 1,
          entries: Array.from({ length: 17 }, () => ({ path: ["p"], label })),
        },
      },
    };
    for (const endpoint of endpoints) {
      const source = endpoint.wrap([doc]);
      expect(endpoint.compress(source)).toBe(source);
      expect(endpoint.has(source)).toBe(false);
    }
  });

  it("preserves malformed inline patch payloads and keeps table-free whole-field numbers inline", () => {
    const root = "/cfc/labelMap/entries";
    const patches = [
      { op: "replace", path: "/cfc", value: null },
      { op: "replace", path: "/cfc/labelMap", value: false },
      { op: "replace", path: root, value: {} },
      { op: "replace", path: `${root}/0`, value: { path: ["secret"] } },
      { op: "replace", path: `${root}/0/label`, value: "unreadable" },
      { op: "replace", path: `${root}/0/path`, value: [1] },
      { op: "append", path: root, values: [null, { path: ["secret"] }] },
      { op: "replace", path: "/value/cfc/labelMap/entries/0/label", value: 0 },
    ];
    const source = {
      type: "transact",
      commit: {
        operations: [{ op: "patch", id: "of:patched", patches }],
      },
    };
    expect(hasClientMessageLabelMetadata(source)).toBe(false);
    expect(compressClientMessageLabels(source)).toBe(source);
    expect(expandClientMessageLabels(source)).toBe(source);
    for (
      const patch of [
        { op: "replace", path: `${root}/0`, value: { label: 0 } },
        { op: "replace", path: `${root}/0/path`, value: 0 },
        { op: "append", path: root, values: [{ path: 0 }] },
        { op: "replace", path: root, value: { "0": { label: 0 } } },
      ]
    ) {
      const indexed = {
        type: "transact",
        commit: {
          operations: [{
            op: "patch",
            id: "of:patched",
            patches: [...patches, patch],
          }],
        },
      };
      expect(hasClientMessageLabelMetadata(indexed)).toBe(false);
      expect(compressClientMessageLabels(indexed)).toBe(indexed);
      expect(expandClientMessageLabels(indexed)).toBe(indexed);
    }
  });

  describe("patch positions", () => {
    const tabledLabel = { integrity: [{ type: "claim", name: "tabled" }] };

    /**
     * A request patching one document, beside a label dictionary when
     * `labelTable` is given.
     */
    function patchRequest(patches: unknown[], labelTable?: unknown[]) {
      return {
        type: "transact",
        commit: {
          ...(labelTable === undefined ? {} : { labelTable }),
          operations: [{ op: "patch", id: "of:patched", patches }],
        },
      };
    }

    it("resolves a number under an entries index and returns one under any other `labelMap` member or entries key unchanged", () => {
      const version = "/cfc/labelMap/version";
      const first = "/cfc/labelMap/entries/first";
      const index = "/cfc/labelMap/entries/0";
      const expanded = expandClientMessageLabels(patchRequest([
        { op: "replace", path: version, value: { "0": { label: 0 } } },
        { op: "replace", path: first, value: { label: 0 } },
        { op: "replace", path: index, value: { label: 0 } },
      ], [tabledLabel]));

      expect(expanded).toEqual(patchRequest([
        { op: "replace", path: version, value: { "0": { label: 0 } } },
        { op: "replace", path: first, value: { label: 0 } },
        { op: "replace", path: index, value: { label: tabledLabel } },
      ]));
    });

    it("resolves the index-keyed members of an entries record and returns its other members unchanged", () => {
      const entries = "/cfc/labelMap/entries";
      const expanded = expandClientMessageLabels(patchRequest([{
        op: "replace",
        path: entries,
        value: { "0": { label: 0 }, first: { label: 0 }, "-": { label: 0 } },
      }], [tabledLabel]));

      // `-` names the end of an array in a patch path, so it reaches an
      // entry there, but as a key of a record it is not an index.
      expect(expanded).toEqual(patchRequest([{
        op: "replace",
        path: entries,
        value: {
          "0": { label: tabledLabel },
          first: { label: 0 },
          "-": { label: 0 },
        },
      }]));
    });

    it("keeps a whole-field label that is not an object inline while tabling the labels beside it", () => {
      const label = "/cfc/labelMap/entries/0/label";
      const source = {
        type: "transact",
        commit: {
          operations: [
            { op: "set", id: "of:compressible", value: compressibleDocument() },
            {
              op: "patch",
              id: "of:patched",
              patches: [{ op: "replace", path: label, value: "inline" }],
            },
          ],
        },
      };

      const compact = compressClientMessageLabels(source);

      assert(isPlainObject(compact) && isPlainObject(compact.commit));
      expect(compact.commit.labelTable).toEqual([
        { integrity: [{ type: "claim", name: "repeated-claim" }] },
      ]);
      assert(Array.isArray(compact.commit.operations));
      expect(compact.commit.operations[1]).toBe(source.commit.operations[1]);
      expect(canonical(expandClientMessageLabels(compact))).toBe(
        canonical(source),
      );
    });
  });
});
