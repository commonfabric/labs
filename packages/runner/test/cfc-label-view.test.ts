import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredReferenceEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { toCell } from "../src/back-to-cell.ts";
import { type FactoryInput, UI } from "../src/builder/types.ts";
import { type Cell, CellImpl } from "../src/cell.ts";
import {
  type CfcLabelView,
  cfcLabelViewForAddress,
  cfcLabelViewForCell,
  cfcLabelViewForCellFailClosed,
  cfcLabelViewForCellFailClosedWithStatus,
  cfcLabelViewFromMetadata,
  cfcLabelViewSourceForCell,
  getCarriedCfcLabelView,
} from "../src/cfc/mod.ts";
import {
  cfcLabelViewOriginSpaces,
  cfcLabelViewsEqual,
  cloneCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
  withCfcLabelViewOrigins,
} from "../src/cfc/label-view-core.ts";
import { stripSigilCfcLabelViews } from "../src/cfc/link-label-view.ts";
import { cfcLabelViewFromSchema } from "../src/cfc/schema-label-view.ts";
import type { CfcMetadata } from "../src/cfc/types.ts";
import { parseLink } from "../src/link-utils.ts";
import { startReadStats } from "../src/read-stats.ts";
import { Runtime } from "../src/runtime.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

/**
 * Runs `body` with a runtime whose storage holds one document, labeled `label`
 * at its root when one is given, and a cell naming that document.
 */
async function withLabeledDocument(
  label: CfcLabelView["entries"][number]["label"] | undefined,
  body: (runtime: Runtime, cell: Cell<unknown>) => void,
): Promise<void> {
  const signer = await Identity.fromPassphrase("cfc label view document");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const tx = runtime.edit();
    const link = runtime.getCell(
      signer.did(),
      "cfc-label-view-document",
      undefined,
      tx,
    ).getAsNormalizedFullLink();
    writeSeedEnvelopeDoc(tx, signer.did());
    seedStoredReferenceEnvelope(tx, {
      space: signer.did(),
      id: link.id,
      type: "application/json",
      path: [],
    }, {
      value: { body: "labeled content" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: label === undefined ? [] : [{ path: [], label }],
        },
      },
    });
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    body(runtime, runtime.getCellFromLink(link));
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("CFC label view helpers", () => {
  it("carries a view's origin spaces through clone, merge and rebase, outside its data", () => {
    const fromS = withCfcLabelViewOrigins({
      version: 1,
      entries: [{ path: ["a"], label: { confidentiality: ["s-label"] } }],
    }, ["did:key:s"]);
    const fromE = withCfcLabelViewOrigins({
      version: 1,
      entries: [{ path: ["b"], label: { confidentiality: ["e-label"] } }],
    }, ["did:key:e"]);
    expect(cfcLabelViewOriginSpaces(cloneCfcLabelView(fromS))).toEqual([
      "did:key:s",
    ]);
    const merged = mergeCfcLabelViews([fromS, undefined, fromE]);
    expect(cfcLabelViewOriginSpaces(merged)).toEqual([
      "did:key:s",
      "did:key:e",
    ]);
    expect(cfcLabelViewOriginSpaces(rebaseCfcLabelView(merged, ["a"])))
      .toEqual(["did:key:s", "did:key:e"]);
    // Origins are not label data: they neither serialize nor distinguish
    // two views carrying the same labels.
    const bare = {
      version: 1 as const,
      entries: [{ path: ["a"], label: { confidentiality: ["s-label"] } }],
    };
    expect(cfcLabelViewOriginSpaces(bare)).toEqual([]);
    expect(JSON.stringify(fromS)).toEqual(JSON.stringify(bare));
    expect(cfcLabelViewsEqual(fromS, bare)).toBe(true);
  });

  it("collects labels that apply to a logical value path", () => {
    const metadata: CfcMetadata = {
      version: 1,
      schemaHash: "hash",
      labelMap: {
        version: 1,
        entries: [
          {
            path: ["body"],
            label: { confidentiality: ["prompt-influenced"] },
          },
          {
            path: ["body", "summary"],
            label: { integrity: ["summarized-by-trusted-pattern"] },
          },
          {
            path: ["other"],
            label: { confidentiality: ["not-rendered"] },
          },
        ],
      },
    };

    expect(cfcLabelViewFromMetadata(metadata, ["body"])).toEqual({
      version: 1,
      entries: [
        {
          path: [],
          label: { confidentiality: ["prompt-influenced"] },
        },
        {
          path: ["summary"],
          label: { integrity: ["summarized-by-trusted-pattern"] },
        },
      ],
    });
  });

  it("collects declared labels from schema paths and local references", () => {
    expect(cfcLabelViewFromSchema({
      type: "object",
      ifc: {
        confidentiality: ["workspace"],
        maxConfidentiality: ["workspace"],
      },
      properties: {
        items: {
          type: "array",
          items: { $ref: "#/$defs/Reviewed" },
        },
      },
      $defs: {
        Reviewed: {
          type: "string",
          ifc: { integrity: ["reviewed"], observes: "value" },
        },
      },
    })).toEqual({
      version: 1,
      entries: [
        {
          path: [],
          label: { confidentiality: ["workspace"] },
        },
        {
          path: ["items", "*"],
          label: { integrity: ["reviewed"] },
          observes: "value",
        },
      ],
    });
  });

  it("ignores a root value that is not a schema", () => {
    expect(cfcLabelViewFromSchema(null as never)).toBeUndefined();
  });

  it("keeps declarations beside an unresolved schema reference", () => {
    expect(cfcLabelViewFromSchema({
      $ref: "#/$defs/Missing",
      ifc: { confidentiality: ["workspace"] },
    })).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: ["workspace"] },
      }],
    });
  });

  it("ignores an IFC block that is not an object", () => {
    expect(cfcLabelViewFromSchema({ ifc: null } as never)).toBeUndefined();
  });

  it("ignores IFC label fields that are not arrays", () => {
    expect(cfcLabelViewFromSchema({
      ifc: { confidentiality: 7, integrity: { trusted: true } },
    } as never)).toBeUndefined();
    expect(cfcLabelViewFromSchema({
      ifc: { integrity: "trusted" },
    } as never)).toBeUndefined();
  });

  it("ignores a properties value that is not an object", () => {
    expect(cfcLabelViewFromSchema({
      ifc: { confidentiality: ["workspace"] },
      properties: null,
    } as never)).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: ["workspace"] },
      }],
    });
  });

  it("rebases wildcard label paths onto concrete array item paths", () => {
    const metadata: CfcMetadata = {
      version: 1,
      schemaHash: "hash",
      labelMap: {
        version: 1,
        entries: [
          {
            path: ["*"],
            label: { integrity: ["trusted-item"] },
          },
          {
            path: ["*", "title"],
            label: { integrity: ["trusted-title"] },
          },
        ],
      },
    };

    expect(cfcLabelViewFromMetadata(metadata, ["0"])).toEqual({
      version: 1,
      entries: [
        {
          path: [],
          label: { integrity: ["trusted-item"] },
        },
        {
          path: ["title"],
          label: { integrity: ["trusted-title"] },
        },
      ],
    });
    expect(cfcLabelViewFromMetadata(metadata, ["0", "title"])).toEqual({
      version: 1,
      entries: [
        {
          path: [],
          label: {
            integrity: expect.arrayContaining([
              "trusted-item",
              "trusted-title",
            ]),
          },
        },
      ],
    });
  });

  it("does not treat schema constraints as display labels", () => {
    const cell = {
      getAsNormalizedFullLink: () => ({
        id: "of:labeled-cell",
        space: "did:key:test",
        type: "application/json",
        path: [],
      }),
      get schema() {
        return {
          type: "string",
          ifc: { maxConfidentiality: ["prompt-influence"] },
        };
      },
    };

    expect(cfcLabelViewForCell(cell)).toBeUndefined();
  });

  it("does not ask result metadata for label display", () => {
    const cell = {
      getAsNormalizedFullLink: () => ({
        id: "of:labeled-result-cell",
        space: "did:key:test",
        type: "application/json",
        path: [],
      }),
      getMetaRaw: () => {
        throw new Error("result metadata should not be consulted");
      },
    };

    expect(cfcLabelViewForCell(cell)).toBeUndefined();
  });

  it("does not synthesize runtime reads for linked cells", async () => {
    const signer = await Identity.fromPassphrase("cfc label view linked read");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-label-view-source",
        undefined,
        tx,
      );
      const sourceLink = parseLink(source.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: sourceLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: "labeled content",
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { confidentiality: ["prompt-influence"] },
            }],
          },
        },
      });
      const target = runtime.getCell(
        signer.did(),
        "cfc-label-view-target",
        undefined,
        tx,
      );
      const targetLink = parseLink(target.getAsLink());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: targetLink.id!,
        type: "application/json",
        path: [],
      }, { value: source.getAsLink() });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).ok).toBeDefined();

      expect(cfcLabelViewForCell(target)).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rebases nested linked value labels to the linked target path", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view nested linked target path",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-label-view-nested-source",
        undefined,
        tx,
      );
      const sourceLink = parseLink(source.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: sourceLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: { title: "shared", details: "restricted" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: ["shared-space"],
                integrity: ["authored-by-bob"],
              },
            }, {
              path: ["details"],
              label: { confidentiality: ["target-detail"] },
            }],
          },
        },
      });

      const target = runtime.getCell(
        signer.did(),
        "cfc-label-view-nested-link",
        undefined,
        tx,
      );
      const targetLink = parseLink(target.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: targetLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: {
          detail: source.key("details").getAsLink(),
        },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["detail"],
              label: { integrity: ["selected-detail"] },
            }],
          },
        },
      });
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      expect(cfcLabelViewForCell(target.key("detail"))).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            confidentiality: expect.arrayContaining([
              "shared-space",
              "target-detail",
            ]),
            integrity: expect.arrayContaining([
              "authored-by-bob",
              "selected-detail",
            ]),
          },
        }, {
          path: [],
          observes: "followRef",
          label: { integrity: ["selected-detail"] },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("names the spaces of the documents a view was read from", async () => {
    // A module policy's manifest is installed beside the label that selects
    // it, so the display boundary reads it from these spaces. The labeled
    // value lives in another space and is reached through a link, so the
    // cell's own space alone would be the wrong answer.
    const signer = await Identity.fromPassphrase("cfc label view spaces");
    const elsewhere = (await Identity.fromPassphrase(
      "cfc label view spaces elsewhere",
    )).did();
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const seedIn = async (
        space: typeof elsewhere,
        id: string,
        value: unknown,
        entries: unknown[],
      ) => {
        const tx = runtime.edit();
        const cell = runtime.getCell(space, id, undefined, tx);
        writeSeedEnvelopeDoc(tx, space);
        seedStoredReferenceEnvelope(tx, {
          space,
          id: parseLink(cell.getAsLink()).id!,
          type: "application/json",
          path: [],
        }, {
          value,
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: { version: 1, entries },
          },
        } as never);
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit()).ok).toBeDefined();
        return runtime.getCell(space, id);
      };
      const source = await seedIn(elsewhere, "spaces-source", "sealed", [{
        path: [],
        label: { confidentiality: ["source-label"] },
      }]);
      const unlabeledHolder = await seedIn(signer.did(), "spaces-holder", {
        detail: source.getAsLink(),
      }, []);
      const labeledHolder = await seedIn(signer.did(), "spaces-labeled", {
        detail: source.getAsLink(),
      }, [{ path: ["detail"], label: { integrity: ["holder-label"] } }]);

      expect(cfcLabelViewSourceForCell(unlabeledHolder.key("detail")).spaces)
        .toEqual([elsewhere]);
      expect(cfcLabelViewSourceForCell(labeledHolder.key("detail")).spaces)
        .toEqual([signer.did(), elsewhere]);
      expect(cfcLabelViewSourceForCell(source).spaces).toEqual([elsewhere]);

      // A carried view names the spaces it was read from wherever it was
      // first read. Resolving the holder's link carries the holder's stored
      // label onto a cell in the target's space; the label, and so its
      // manifest, lives in the holder's space, which the cell's own link and
      // its resolution never name.
      const bareSource = await seedIn(elsewhere, "spaces-bare", "open", []);
      const crossHolder = await seedIn(signer.did(), "spaces-cross", {
        detail: bareSource.getAsLink(),
      }, [{ path: ["detail"], label: { confidentiality: ["holder-conf"] } }]);
      const resolved = crossHolder.key("detail").resolveAsCell();
      expect(resolved.getAsNormalizedFullLink().space).toEqual(elsewhere);
      expect(cfcLabelViewSourceForCell(resolved).spaces).toEqual([
        signer.did(),
      ]);
      // The same through the child and schema cells the view is carried on.
      expect(
        cfcLabelViewSourceForCell(resolved.asSchema({ type: "string" }))
          .spaces,
      ).toEqual([signer.did()]);
      // A schema traversal slices the carried view per field through its
      // rebaser, and a cell it mints below the link keeps the same origins.
      const objectSource = await seedIn(elsewhere, "spaces-object", {
        text: "open",
      }, []);
      const objectHolder = await seedIn(signer.did(), "spaces-object-holder", {
        detail: objectSource.getAsLink(),
      }, [{ path: ["detail"], label: { confidentiality: ["holder-conf"] } }]);
      const minted = objectHolder.key("detail").asSchema({
        type: "object",
        properties: { text: { type: "string", asCell: ["cell"] } },
      }).get().text as unknown;
      expect(
        getCarriedCfcLabelView(minted)?.entries.map((entry) =>
          entry.label.confidentiality
        ),
      ).toEqual([["holder-conf"]]);
      expect(cfcLabelViewSourceForCell(minted).spaces).toEqual([
        signer.did(),
      ]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("takes content integrity from the terminal target of a reference chain", async () => {
    const signer = await Identity.fromPassphrase("cfc terminal content labels");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const space = signer.did();
      const target = runtime.getCell(space, "terminal-target");
      const intermediate = runtime.getCell(space, "terminal-intermediate");
      const source = runtime.getCell(space, "terminal-source");
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, space);
      const write = (
        cell: Cell<unknown>,
        value: FabricValue,
        entries: CfcMetadata["labelMap"]["entries"],
      ) =>
        seedStoredReferenceEnvelope(seed, {
          ...cell.getAsNormalizedFullLink(),
          path: [],
        }, {
          value,
          cfc: {
            version: 3,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: { version: 1, entries },
          },
        });
      write(target, { field: "value" }, [{
        path: ["field"],
        label: { integrity: ["terminal-content"] },
      }]);
      write(intermediate, target.getAsLink(), [
        { path: [], label: { confidentiality: ["selected-reference"] } },
        { path: ["field"], label: { integrity: ["projected-content"] } },
      ]);
      write(source, intermediate.key("field").getAsLink(), []);
      expect((await seed.commit()).error).toBeUndefined();

      const resolved = source.resolveAsCell();
      expect(resolved.get()).toBe("value");
      const entries = cfcLabelViewForCell(resolved)?.entries ?? [];
      expect(entries.flatMap((entry) => entry.label.integrity ?? []))
        .toEqual(["terminal-content"]);
      expect(entries.flatMap((entry) => entry.label.confidentiality ?? []))
        .toEqual(["selected-reference"]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("carries the link slot's label on a second resolution of the same link", async () => {
    // Every caller that derives a hop's label view brackets the resolution
    // with the trace-array length and slices off what it appended
    // (`Cell.resolveAsCell` here; `deriveDereferenceLabelView` and the
    // query-result proxy identically). So a resolution MUST append its traces
    // even when it repeats one the transaction already recorded — suppressing
    // the repeat empties the slice, and the label view falls back to the
    // resolved document's own labels.
    //
    // The link slot's label is what that loses: it lives on the CONTAINER,
    // reachable only through the trace's `source` address, so the resolved
    // document cannot supply it. Deduplication belongs in
    // `canonicalizePreparedDigestInput`, which reads the finished list.
    const signer = await Identity.fromPassphrase("cfc label view repeat hop");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-label-view-repeat-source",
        undefined,
        tx,
      );
      source.set({ detail: "linked content" } as never);
      const target = runtime.getCell(
        signer.did(),
        "cfc-label-view-repeat-target",
        undefined,
        tx,
      );
      const targetLink = parseLink(target.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      // The link and its label map are seeded in one whole-envelope write.
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: targetLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: { inner: source.getAsLink() },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["inner"],
              label: { confidentiality: ["link-slot-only"] },
            }],
          },
        },
      });
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      // Both resolutions run on ONE transaction, so the second is the repeat.
      const readTx = runtime.edit();
      const handle = runtime.getCell(
        signer.did(),
        "cfc-label-view-repeat-target",
        undefined,
        readTx,
      );
      const first = handle.key("inner").withTx(readTx).resolveAsCell();
      const second = handle.key("inner").withTx(readTx).resolveAsCell();
      expect(cfcLabelViewForCell(first)).toEqual({
        version: 1,
        entries: [{
          path: [],
          observes: "followRef",
          label: {
            confidentiality: expect.arrayContaining(["link-slot-only"]),
          },
        }],
      });
      expect(cfcLabelViewForCell(second)).toEqual(cfcLabelViewForCell(first));
      readTx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("returns from `cfcLabelViewForAddress()` the stored labels rebased onto the address", async () => {
    // The view at an address is read from an index of the document's
    // entries by path. It has to match a rebase of every entry, wildcards,
    // observation classes, and repeated paths included.

    const signer = await Identity.fromPassphrase("cfc label view index");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const space = signer.did();
      const tx = runtime.edit();
      const cell = runtime.getCell(space, "label-view-index", undefined, tx);
      const id = parseLink(cell.getAsLink()).id!;
      const metadata: CfcMetadata = {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [
            { path: [], label: { confidentiality: ["root"] } },
            { path: ["*"], label: { integrity: ["any-item"] } },
            {
              path: ["list", "*", "title"],
              label: { confidentiality: ["title"] },
            },
            {
              path: ["list"],
              label: { confidentiality: ["list-shape"] },
              observes: "shape",
            },
            {
              path: ["list", "0"],
              label: { confidentiality: ["first-link"] },
              origin: "link",
            },
            {
              path: ["list", "0"],
              label: { confidentiality: ["first-again"] },
            },
            {
              path: ["other", "deep"],
              label: { confidentiality: ["deep"] },
            },
          ],
        },
      };
      writeSeedEnvelopeDoc(tx, space);
      seedStoredReferenceEnvelope(tx, {
        space,
        id,
        type: "application/json",
        path: [],
      }, {
        value: { list: [{ title: "a" }, { title: "b" }], other: { deep: 1 } },
        cfc: metadata,
      } as never);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).ok).toBeDefined();

      const readTx = runtime.edit();
      const queries = [
        [],
        ["list"],
        ["list", "0"],
        ["list", "0", "title"],
        ["list", "1"],
        ["list", "1", "title", "more"],
        ["other"],
        ["other", "deep"],
        ["missing"],
        ["*"],
        ["list", "*"],
      ];
      let labeled = 0;
      for (const path of queries) {
        const address = { space, id, scope: "space" as const, path };
        const expected = withCfcLabelViewOrigins(
          cfcLabelViewFromMetadata(metadata, path),
          [space],
        );
        const actual = cfcLabelViewForAddress(readTx, address);
        expect(actual).toEqual(expected);
        expect(cfcLabelViewOriginSpaces(actual)).toEqual(
          cfcLabelViewOriginSpaces(expected),
        );
        if (actual !== undefined) labeled++;
      }
      expect(labeled).toBe(queries.length);
      readTx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  describe("handles minted by a schema read", () => {
    // A schema read that crosses a link held in a labeled slot consumes that
    // slot's label, so every handle it mints below the link carries it, as
    // `Cell.resolveAsCell()` does for the same hop. `resolveAsCell()` on the
    // same slot is the reference each case compares against where it can.

    type Space = ReturnType<Identity["did"]>;

    const withRuntime = async (
      passphrase: string,
      body: (fixture: {
        /** Writes `value` and its label map as a document, and returns it. */
        seed: (
          space: Space,
          id: string,
          value: unknown,
          entries: unknown[],
        ) => Promise<ReturnType<Runtime["getCell"]>>;
        home: Space;
        elsewhere: Space;
        runtime: Runtime;
      }) => Promise<void>,
    ) => {
      const signer = await Identity.fromPassphrase(passphrase);
      const elsewhere = (await Identity.fromPassphrase(`${passphrase} other`))
        .did();
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        await body({
          seed: async (space, id, value, entries) => {
            const tx = runtime.edit();
            const cell = runtime.getCell(space, id, undefined, tx);
            writeSeedEnvelopeDoc(tx, space);
            seedStoredReferenceEnvelope(tx, {
              space,
              id: parseLink(cell.getAsLink()).id!,
              type: "application/json",
              path: [],
            }, {
              value,
              cfc: {
                version: 1,
                schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
                labelMap: { version: 1, entries },
              },
            } as never);
            runtime.prepareTxForCommit(tx);
            expect((await tx.commit()).ok).toBeDefined();
            return runtime.getCell(space, id);
          },
          home: signer.did(),
          elsewhere,
          runtime,
        });
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };

    const confidentialityOf = (value: unknown) =>
      getCarriedCfcLabelView(value)?.entries.map((entry) => ({
        path: entry.path,
        confidentiality: entry.label.confidentiality,
      }));

    it("carries the slot's label on a handle for a link in a property, a nested property, and an array item", async () => {
      await withRuntime(
        "cfc handle slot label",
        async ({ seed, home, elsewhere }) => {
          const note = await seed(
            elsewhere,
            "slot-note",
            { text: "hello" },
            [],
          );
          const holder = await seed(home, "slot-holder", {
            note: note.getAsLink(),
            wrap: { note: note.getAsLink() },
            list: [note.getAsLink()],
          }, [
            { path: ["note"], label: { confidentiality: ["note-slot"] } },
            {
              path: ["wrap", "note"],
              label: { confidentiality: ["wrap-slot"] },
            },
            { path: ["list", "0"], label: { confidentiality: ["list-slot"] } },
          ]);

          const read = holder.asSchema({
            type: "object",
            properties: {
              note: { asCell: ["cell"] },
              wrap: {
                type: "object",
                properties: { note: { asCell: ["cell"] } },
              },
              list: { type: "array", items: { asCell: ["cell"] } },
            },
          }).get() as any;

          expect(confidentialityOf(read.note)).toEqual(
            confidentialityOf(holder.key("note").resolveAsCell()),
          );
          expect(confidentialityOf(read.note)).toEqual([
            { path: [], confidentiality: ["note-slot"] },
          ]);
          expect(confidentialityOf(read.wrap.note)).toEqual([
            { path: [], confidentiality: ["wrap-slot"] },
          ]);
          expect(confidentialityOf(read.list[0])).toEqual([
            { path: [], confidentiality: ["list-slot"] },
          ]);
          // Below the link, a handle carries the slot's label too, since it was
          // reached through the slot.
          const text = holder.asSchema({
            type: "object",
            properties: {
              note: {
                type: "object",
                properties: { text: { type: "string", asCell: ["cell"] } },
              },
            },
          }).get() as any;
          expect(confidentialityOf(text.note.text)).toEqual([
            { path: [], confidentiality: ["note-slot"] },
          ]);
        },
      );
    });

    it("carries the consumed target's content label on a materialized value", async () => {
      await withRuntime(
        "cfc consumed target content",
        async ({ seed, home }) => {
          const target = await seed(home, "content-target", { text: "hello" }, [
            {
              path: [],
              label: {
                confidentiality: ["target-content"],
                integrity: ["target-author"],
              },
            },
          ]);
          const holder = await seed(home, "content-holder", {
            ref: target.getAsLink(),
          }, []);
          const value = holder.asSchema({
            type: "object",
            properties: {
              ref: { type: "object", properties: { text: { type: "string" } } },
            },
          }).get() as any;
          expect(getCarriedCfcLabelView(value.ref[toCell]())?.entries).toEqual([
            {
              path: [],
              label: {
                confidentiality: ["target-content"],
                integrity: ["target-author"],
              },
            },
          ]);
        },
      );
    });

    it("takes materialized content integrity from the terminal target of a link chain", async () => {
      await withRuntime(
        "cfc materialized terminal content",
        async ({ seed, home }) => {
          const target = await seed(home, "terminal-content-target", {
            field: { text: "hello" },
          }, [{
            path: ["field"],
            label: { integrity: ["terminal-author"] },
          }]);
          const middle = await seed(
            home,
            "terminal-content-middle",
            target.getAsLink(),
            [{
              path: ["field"],
              label: { integrity: ["projected-author"] },
            }],
          );
          const holder = await seed(home, "terminal-content-holder", {
            ref: middle.key("field").getAsLink(),
          }, [{
            path: ["ref"],
            label: { confidentiality: ["selected-reference"] },
          }]);
          const value = holder.asSchema({
            type: "object",
            properties: {
              ref: { type: "object", properties: { text: { type: "string" } } },
            },
          }).get() as any;
          expect(getCarriedCfcLabelView(value.ref[toCell]())?.entries).toEqual([
            {
              path: [],
              observes: "followRef",
              label: { confidentiality: ["selected-reference"] },
            },
            { path: [], label: { integrity: ["terminal-author"] } },
          ]);
        },
      );
    });

    it("carries the label of every slot on a chain of links", async () => {
      await withRuntime("cfc handle chain label", async ({ seed, home }) => {
        const note = await seed(home, "chain-note", "hello", []);
        const middle = await seed(home, "chain-middle", {
          next: note.getAsLink(),
        }, [{ path: ["next"], label: { confidentiality: ["middle-slot"] } }]);
        const holder = await seed(home, "chain-holder", {
          first: middle.getAsLink(),
        }, [{ path: ["first"], label: { confidentiality: ["holder-slot"] } }]);

        const read = holder.asSchema({
          type: "object",
          properties: {
            first: {
              type: "object",
              properties: { next: { asCell: ["cell"] } },
            },
          },
        }).get() as any;

        expect(getCarriedCfcLabelView(read.first.next)?.entries).toEqual([
          {
            path: [],
            observes: "followRef",
            label: { confidentiality: ["holder-slot", "middle-slot"] },
          },
        ]);
      });
    });

    it("carries only the label of the slot a handle was reached through", async () => {
      // Three slots hold links to one document, and only the middle one is
      // labeled. The handles below the target are minted at one address
      // under one schema each time, so a read that reused one arrival's
      // handles for another would show the middle slot's label on a
      // neighbor, or lose it from the middle.

      await withRuntime("cfc handle route label", async ({ seed, home }) => {
        const note = await seed(home, "route-note", {
          inner: { deep: { text: "hello" } },
        }, []);
        const holder = await seed(home, "route-holder", {
          before: note.getAsLink(),
          labeled: note.getAsLink(),
          after: note.getAsLink(),
        }, [{ path: ["labeled"], label: { confidentiality: ["route-slot"] } }]);
        const noteSchema = {
          type: "object",
          properties: {
            inner: {
              type: "object",
              properties: { deep: { asCell: ["cell"] } },
            },
          },
        } as const;

        const read = holder.asSchema({
          type: "object",
          properties: {
            before: noteSchema,
            labeled: noteSchema,
            after: noteSchema,
          },
        }).get() as any;

        expect(confidentialityOf(read.before.inner.deep)).toBeUndefined();
        expect(confidentialityOf(read.labeled.inner.deep)).toEqual([
          { path: [], confidentiality: ["route-slot"] },
        ]);
        expect(confidentialityOf(read.after.inner.deep)).toBeUndefined();
      });
    });

    it("carries a slot's label only on handles reached through its link when the link stays in its own document", async () => {
      // The read passes through `alias` into `target` first, then reaches
      // `target` again as a property of its own, crossing no link.

      await withRuntime(
        "cfc handle same document",
        async ({ seed, home, runtime }) => {
          const id = "same-doc-holder";
          const target = runtime.getCell(home, id).key("target").getAsLink();
          const holder = await seed(home, id, {
            alias: target,
            target: { deep: { text: "hello" } },
          }, [{ path: ["alias"], label: { confidentiality: ["alias-slot"] } }]);
          const targetSchema = {
            type: "object",
            properties: { deep: { asCell: ["cell"] } },
          } as const;

          const read = holder.asSchema({
            type: "object",
            properties: { alias: targetSchema, target: targetSchema },
          }).get() as any;

          expect(confidentialityOf(read.alias.deep)).toEqual([
            { path: [], confidentiality: ["alias-slot"] },
          ]);
          expect(confidentialityOf(read.target.deep)).toBeUndefined();
        },
      );
    });

    it("labels a value at a link's own slot by the route that reached the slot", async () => {
      // `plain` and `labeled` both link to `middle`, whose `ref` slot links
      // to `note`. Both slots carry `slot`, so the view below `note` is the
      // same either way. Reading the value consumes `middle.ref`, so its
      // backpointer retains that slot's confidentiality on both routes.

      await withRuntime("cfc handle own slot route", async ({ seed, home }) => {
        const note = await seed(home, "own-slot-note", { text: "a" }, []);
        const middle = await seed(home, "own-slot-middle", {
          ref: note.getAsLink(),
        }, [{ path: ["ref"], label: { confidentiality: ["slot"] } }]);
        const holder = await seed(home, "own-slot-holder", {
          plain: middle.getAsLink(),
          labeled: middle.getAsLink(),
        }, [{ path: ["labeled"], label: { confidentiality: ["slot"] } }]);
        const middleSchema = {
          type: "object",
          properties: {
            ref: { type: "object", properties: { text: { type: "string" } } },
          },
        } as const;

        const read = holder.asSchema({
          type: "object",
          properties: { plain: middleSchema, labeled: middleSchema },
        }).get() as any;

        const plainView = getCarriedCfcLabelView(read.plain.ref[toCell]());
        expect(plainView?.entries).toEqual([
          {
            path: [],
            observes: "followRef",
            label: { confidentiality: ["slot"] },
          },
        ]);
        expect(getCarriedCfcLabelView(read.labeled.ref[toCell]())?.entries)
          .toEqual(plainView?.entries);
      });
    });

    it("carries no label from one list item's link onto the next item", async () => {
      // The first item links back to the whole document through a labeled
      // slot, and the second is an inline object beside it.

      await withRuntime(
        "cfc handle list item routes",
        async ({ seed, home, runtime }) => {
          const id = "item-route-holder";
          const self = runtime.getCell(home, id).getAsLink();
          const holder = await seed(home, id, {
            list: [self, { text: "a" }],
          }, [{ path: ["list", "0"], label: { confidentiality: ["self"] } }]);

          const read = holder.asSchema({
            type: "object",
            properties: {
              list: {
                type: "array",
                items: { asCell: ["cell"] },
              },
            },
          }).get() as any;

          expect(getCarriedCfcLabelView(read.list[0])?.entries).toEqual([
            {
              path: [],
              observes: "followRef",
              label: { confidentiality: ["self"] },
            },
          ]);
          expect(confidentialityOf(read.list[1])).toBeUndefined();
        },
      );
    });

    it("keeps what the read's own handle carries under a link that stays in its document", async () => {
      // The handle the read starts from carries a label for `target`, and
      // `alias` links to `target` in the same document. Reached through
      // `alias`, `target` is still under the handle, so it carries both.

      await withRuntime(
        "cfc handle carried same document",
        async ({ seed, home, runtime }) => {
          const id = "carried-doc-holder";
          const target = runtime.getCell(home, id).key("target").getAsLink();
          await seed(home, id, {
            alias: target,
            target: { deep: { text: "hello" } },
          }, [{ path: ["alias"], label: { confidentiality: ["alias-slot"] } }]);
          const link = runtime.getCell(home, id).getAsLink() as any;
          link["/"][LINK_V1_TAG].cfcLabelView = {
            version: 1,
            entries: [{
              path: ["target"],
              label: { confidentiality: ["carried"] },
            }],
          };
          const targetSchema = {
            type: "object",
            properties: { deep: { asCell: ["cell"] } },
          } as const;

          const read = runtime.getCellFromLink(link).asSchema({
            type: "object",
            properties: { alias: targetSchema, target: targetSchema },
          }).get() as any;

          expect(confidentialityOf(read.target.deep)).toEqual([
            { path: [], confidentiality: ["carried"] },
          ]);
          expect(getCarriedCfcLabelView(read.alias.deep)?.entries).toEqual([
            { path: [], label: { confidentiality: ["carried"] } },
            {
              path: [],
              observes: "followRef",
              label: { confidentiality: ["alias-slot"] },
            },
          ]);
        },
      );
    });

    it("carries a link-origin slot label on every handle reached through the link", async () => {
      // A label a link write stores at its slot is of the `followRef` class,
      // and a dereference retains it for everything it reaches, however deep
      // (CFC §4.6.3, §8.2.4). So does a template at the slot's container.

      await withRuntime("cfc handle link origin", async ({
        seed,
        home,
        runtime,
      }) => {
        const note = await seed(home, "origin-note", { text: "a" }, []);
        const holder = await seed(home, "origin-holder", {
          note: note.getAsLink(),
          list: [note.getAsLink()],
        }, [
          {
            path: ["note"],
            label: { confidentiality: ["pointer"] },
            origin: "link",
          },
          {
            path: ["list", "*"],
            label: { confidentiality: ["item-pointer"] },
            origin: "link",
          },
        ]);
        const noteSchema = {
          type: "object",
          properties: { text: { type: "string", asCell: ["cell"] } },
        } as const;

        const read = holder.asSchema({
          type: "object",
          properties: {
            note: noteSchema,
            list: { type: "array", items: noteSchema },
          },
        }).get() as any;

        expect(confidentialityOf(read.note.text)).toEqual([
          { path: [], confidentiality: ["pointer"] },
        ]);
        expect(confidentialityOf(read.list[0].text)).toEqual([
          { path: [], confidentiality: ["item-pointer"] },
        ]);

        // A lazy read, and a cell below a resolved handle, carry it too.
        const tx = runtime.edit();
        tx.markLazyMaterialize();
        const lazy = holder.withTx(tx).asSchema({
          type: "object",
          properties: { note: noteSchema },
        }).get() as any;
        const lazyText = confidentialityOf(lazy.note.text) ?? [];
        tx.abort();
        expect(lazyText.flatMap((entry) => entry.confidentiality ?? []))
          .toContain("pointer");
        const resolvedText = confidentialityOf(
          holder.key("note").resolveAsCell().key("text"),
        ) ?? [];
        expect(resolvedText.flatMap((entry) => entry.confidentiality ?? []))
          .toContain("pointer");
      });
    });

    it("accumulates link-origin slot labels along a chain of links", async () => {
      await withRuntime("cfc handle origin chain", async ({ seed, home }) => {
        const note = await seed(home, "origin-chain-note", { text: "a" }, []);
        const middle = await seed(home, "origin-chain-middle", {
          next: note.getAsLink(),
        }, [{
          path: ["next"],
          label: { confidentiality: ["second"] },
          origin: "link",
        }]);
        const holder = await seed(home, "origin-chain-holder", {
          first: middle.getAsLink(),
        }, [{
          path: ["first"],
          label: { confidentiality: ["first"] },
          origin: "link",
        }]);

        const read = holder.asSchema({
          type: "object",
          properties: {
            first: {
              type: "object",
              properties: {
                next: {
                  type: "object",
                  properties: { text: { type: "string", asCell: ["cell"] } },
                },
              },
            },
          },
        }).get() as any;

        const [entry, ...rest] = confidentialityOf(read.first.next.text) ?? [];
        expect(rest).toEqual([]);
        expect(entry.path).toEqual([]);
        expect([...entry.confidentiality ?? []].sort()).toEqual([
          "first",
          "second",
        ]);
      });
    });

    it("carries neither the entries below a link's slot nor any integrity onto what the link reaches", async () => {
      // The reference restrictions are what resolves at the slot, the
      // container's content label included. What the holder stores below the
      // slot names positions of the target, which the target's own labels
      // label, and observing a reference endorses nothing it reaches.

      await withRuntime("cfc handle restrictions only", async ({
        seed,
        home,
      }) => {
        const note = await seed(home, "only-note", { text: "a" }, []);
        const holder = await seed(home, "only-holder", {
          note: note.getAsLink(),
        }, [
          {
            path: [],
            label: {
              confidentiality: ["holder-root"],
              integrity: ["holder-integrity"],
            },
          },
          {
            path: ["note"],
            label: {
              confidentiality: ["slot"],
              integrity: ["slot-integrity"],
            },
          },
          {
            path: ["note", "text"],
            label: { confidentiality: ["below-slot"] },
          },
        ]);

        const read = holder.asSchema({
          type: "object",
          properties: {
            note: {
              type: "object",
              properties: { text: { type: "string", asCell: ["cell"] } },
            },
          },
        }).get() as any;

        const view = getCarriedCfcLabelView(read.note.text);
        expect(view?.entries.map((entry) => entry.path)).toEqual([[]]);
        expect([...view!.entries[0].label.confidentiality ?? []].sort())
          .toEqual(["holder-root", "slot"]);
        expect(view!.entries[0].label.integrity).toBeUndefined();
      });
    });

    it("labels a value at a slot inside a chain of links by the route that reached it, in either order", async () => {
      // `plain` and `labeled` both link to `middle`, whose `ref` slot links
      // through `relay.x` to `note`, both hops resolved in one step. Only
      // `labeled` is labeled, with the label `middle.ref` also stores, so
      // consuming `middle.ref` retains the same label on both backpointers.
      // Each order of the two properties is read.

      await withRuntime("cfc handle chain route", async ({ seed, home }) => {
        const note = await seed(home, "chain-route-note", { text: "a" }, []);
        const relay = await seed(home, "chain-route-relay", {
          x: note.getAsLink(),
        }, []);
        const middle = await seed(home, "chain-route-middle", {
          ref: relay.key("x").getAsLink(),
        }, [{ path: ["ref"], label: { confidentiality: ["slot"] } }]);
        const middleSchema = {
          type: "object",
          properties: {
            ref: { type: "object", properties: { text: { type: "string" } } },
          },
        } as const;
        for (
          const [id, first, second] of [
            ["chain-route-plain-first", "plain", "labeled"],
            ["chain-route-labeled-first", "labeled", "plain"],
          ] as const
        ) {
          const holder = await seed(home, id, {
            [first]: middle.getAsLink(),
            [second]: middle.getAsLink(),
          }, [{ path: ["labeled"], label: { confidentiality: ["slot"] } }]);

          const read = holder.asSchema({
            type: "object",
            properties: { plain: middleSchema, labeled: middleSchema },
          }).get() as any;

          const plainView = getCarriedCfcLabelView(read.plain.ref[toCell]());
          expect(plainView?.entries).toEqual([
            {
              path: [],
              observes: "followRef",
              label: { confidentiality: ["slot"] },
            },
          ]);
          expect(getCarriedCfcLabelView(read.labeled.ref[toCell]())?.entries)
            .toEqual(plainView?.entries);
        }
      });
    });

    it("depends on the labels stored at a crossed slot, so a change to them runs the reader again", async () => {
      // The slot is in `middle`, which the read reaches through a link, so
      // only the crossing reads its labels.

      await withRuntime("cfc handle label dependency", async ({
        seed,
        home,
        runtime,
      }) => {
        const note = await seed(home, "dependency-note", { text: "a" }, []);
        const middle = await seed(home, "dependency-middle", {
          note: note.getAsLink(),
        }, [{ path: ["note"], label: { confidentiality: ["slot"] } }]);
        const holder = await seed(home, "dependency-holder", {
          middle: middle.getAsLink(),
        }, []);
        const middleId = parseLink(middle.getAsLink()).id;

        const tx = runtime.edit();
        holder.withTx(tx).asSchema({
          type: "object",
          properties: {
            middle: {
              type: "object",
              properties: {
                note: {
                  type: "object",
                  properties: { text: { type: "string", asCell: ["cell"] } },
                },
              },
            },
          },
        }).get();
        const reads = tx.getReactivityLog!().reads;
        tx.abort();

        expect(
          reads.some((read) => read.id === middleId && read.path[0] === "cfc"),
        ).toBe(true);
      });
    });

    it("carries each slot's label on the items of a list of plain links", async () => {
      // A list of two or more plain links, and a list of one, take different
      // routes to the linked rows. Each row's back-to-cell handle carries the
      // label of its own slot.

      await withRuntime("cfc handle plain links", async ({ seed, home }) => {
        const first = await seed(home, "plain-first", { title: "a" }, []);
        const second = await seed(home, "plain-second", { title: "b" }, []);
        const holder = await seed(home, "plain-holder", {
          pair: [first.getAsLink(), second.getAsLink()],
          single: [first.getAsLink()],
        }, [
          { path: ["pair", "0"], label: { confidentiality: ["pair-0"] } },
          { path: ["pair", "1"], label: { confidentiality: ["pair-1"] } },
          { path: ["single", "0"], label: { confidentiality: ["single-0"] } },
        ]);
        const rows = {
          type: "array",
          items: { type: "object", properties: { title: { type: "string" } } },
        } as const;

        const read = holder.asSchema({
          type: "object",
          properties: { pair: rows, single: rows },
        }).get() as any;

        expect(confidentialityOf(read.pair[0][toCell]())).toEqual([
          { path: [], confidentiality: ["pair-0"] },
        ]);
        expect(confidentialityOf(read.pair[1][toCell]())).toEqual([
          { path: [], confidentiality: ["pair-1"] },
        ]);
        expect(confidentialityOf(read.single[0][toCell]())).toEqual([
          { path: [], confidentiality: ["single-0"] },
        ]);
      });
    });

    it("carries the labels stored at an inline array item on the handles inside it", async () => {
      // An inline object in a list is read as a document of its own. The
      // labels at the item's position, and at the slot of a link the list
      // was reached through, still apply to what is inside it.

      await withRuntime("cfc handle inline items", async ({ seed, home }) => {
        const note = await seed(home, "inline-note", {
          items: [{ text: "a" }],
        }, [{
          path: ["items", "0", "text"],
          label: { confidentiality: ["item"] },
        }]);
        const holder = await seed(home, "inline-holder", {
          labeled: note.getAsLink(),
        }, [{ path: ["labeled"], label: { confidentiality: ["slot"] } }]);
        const items = {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { text: { asCell: ["cell"] } },
              },
            },
          },
        } as const;

        const direct = note.asSchema(items).get() as any;
        expect(confidentialityOf(direct.items[0].text)).toEqual([
          { path: [], confidentiality: ["item"] },
        ]);

        const linked = holder.asSchema({
          type: "object",
          properties: { labeled: items },
        }).get() as any;
        expect(getCarriedCfcLabelView(linked.labeled.items[0].text)?.entries)
          .toEqual([
            { path: [], label: { confidentiality: ["item"] } },
            {
              path: [],
              observes: "followRef",
              label: { confidentiality: ["slot"] },
            },
          ]);
      });
    });

    it("reads a recursive union at a property holding a link", async () => {
      // `R` is `A` or `R` together with `B`. Each branch evaluated at the
      // linked position follows the link again, and each must still find the
      // traversal of `R` it comes back to.

      await withRuntime(
        "cfc handle recursive union",
        async ({ seed, home }) => {
          const target = await seed(home, "union-target", { a: 1, b: 2 }, []);
          const holder = await seed(home, "union-holder", {
            node: target.getAsLink(),
          }, [{ path: ["node"], label: { confidentiality: ["union-slot"] } }]);
          const A = {
            type: "object",
            properties: { a: { type: "number" } },
            additionalProperties: false,
          } as const;
          const B = {
            type: "object",
            properties: { b: { type: "number" } },
            additionalProperties: false,
          } as const;

          const read = holder.asSchema({
            type: "object",
            properties: { node: { $ref: "#/$defs/R" } },
            $defs: {
              R: { anyOf: [A, { allOf: [{ $ref: "#/$defs/R" }, B] }] },
            },
          }).get() as any;

          expect(read.node).toEqual({ a: 1, b: 2 });
          // The backpointer retains both the slot's content label and the
          // reference observation consumed while reading its value.
          expect(cfcLabelViewForCell(read.node[toCell]())?.entries).toEqual([
            { path: [], label: { confidentiality: ["union-slot"] } },
            {
              path: [],
              observes: "followRef",
              label: { confidentiality: ["union-slot"] },
            },
          ]);
        },
      );
    });

    it("follows each link once where several slots link to one document", async () => {
      // Each level of the chain links to the next through two slots, so the
      // number of routes to the last document doubles with every level while
      // the documents on them grow by one. Only the first level's slots are
      // labeled, differently, so two views reach every document below.

      await withRuntime("cfc handle shared documents", async ({
        seed,
        home,
        runtime,
      }) => {
        const levels = 12;
        let next = await seed(home, `shared-${levels}`, {}, []);
        for (let level = levels - 1; level >= 0; level--) {
          next = await seed(
            home,
            `shared-${level}`,
            {
              left: next.getAsLink(),
              right: next.getAsLink(),
            },
            level === 0
              ? [
                { path: ["left"], label: { confidentiality: ["left"] } },
                { path: ["right"], label: { confidentiality: ["right"] } },
              ]
              : [],
          );
        }
        const tx = runtime.edit();
        const finish = startReadStats(tx);
        next.withTx(tx).asSchema({
          $ref: "#/$defs/Node",
          $defs: {
            Node: {
              type: "object",
              properties: {
                left: { $ref: "#/$defs/Node" },
                right: { $ref: "#/$defs/Node" },
              },
            },
          },
        }).get();
        const { linkResolutions } = finish(0);
        tx.abort();

        // Two views, two slots per level, and at most a few hops per slot.
        expect(linkResolutions).toBeLessThanOrEqual(2 * 2 * 4 * levels);
      });
    });
  });

  it("preserves ref-carried label views when creating cells from sigil links", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view sigil carried state",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const view = {
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["carried-through-sigil"] },
        }],
      } as const;
      const cell = runtime.getCell(
        signer.did(),
        "cfc-label-view-carried-sigil",
      );
      const link = cell.getAsLink() as any;
      link["/"][LINK_V1_TAG].cfcLabelView = view;

      const recovered = runtime.getCellFromLink(link);
      expect(cfcLabelViewForCell(recovered)).toEqual(view);
      expect(linkRefPayload(recovered.getAsLink())).not.toHaveProperty(
        "cfcLabelView",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("distinguishes stored link-field labels from dereferenced cell-view labels", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view stored link field",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-label-view-shared-source",
        undefined,
        tx,
      );
      const sourceLink = parseLink(source.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: sourceLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: { title: "shared", details: "restricted" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: ["shared-space"],
                integrity: ["authored-by-bob"],
              },
            }, {
              path: ["details"],
              label: { confidentiality: ["target-detail"] },
            }],
          },
        },
      });

      const target = runtime.getCell(
        signer.did(),
        "cfc-label-view-personal-link",
        undefined,
        tx,
      );
      const targetLink = parseLink(target.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: targetLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: source.getAsLink(),
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: ["personal-space"],
                integrity: ["selected-by-alice"],
              },
            }],
          },
        },
      });
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      const storedLinkField = cfcLabelViewFromMetadata(
        {
          version: 1,
          schemaHash: "target-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: ["personal-space"],
                integrity: ["selected-by-alice"],
              },
            }],
          },
        },
        [],
      );
      expect(storedLinkField).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            confidentiality: ["personal-space"],
            integrity: ["selected-by-alice"],
          },
        }],
      });

      expect(cfcLabelViewForCell(target)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            confidentiality: ["personal-space"],
            integrity: ["selected-by-alice"],
          },
        }],
      });

      const resolvedTarget = target.resolveAsCell();
      expect(cfcLabelViewForCell(resolvedTarget)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            confidentiality: ["shared-space"],
            integrity: ["authored-by-bob"],
          },
        }, {
          path: [],
          observes: "followRef",
          label: {
            confidentiality: ["personal-space"],
            integrity: ["selected-by-alice"],
          },
        }, {
          path: ["details"],
          label: { confidentiality: ["target-detail"] },
        }],
      });

      expect(cfcLabelViewForCell(resolvedTarget.asSchema({
        type: "object",
        properties: { details: { type: "string" } },
      }))).toEqual(cfcLabelViewForCell(resolvedTarget));
      const siblingTx = runtime.edit();
      expect(cfcLabelViewForCell(resolvedTarget.withTx(siblingTx)))
        .toEqual(cfcLabelViewForCell(resolvedTarget));
      siblingTx.abort();

      expect(cfcLabelViewForCell(resolvedTarget.key("details"))).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            confidentiality: expect.arrayContaining([
              "shared-space",
              "target-detail",
            ]),
            integrity: ["authored-by-bob"],
          },
        }, {
          path: [],
          observes: "followRef",
          label: {
            confidentiality: ["personal-space"],
          },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps accumulated link labels on cells recovered from query results", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view query result to cell",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-label-view-query-source",
        undefined,
        tx,
      );
      const sourceLink = parseLink(source.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: sourceLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: { title: "shared" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { integrity: ["authored-by-bob"] },
            }],
          },
        },
      });

      const target = runtime.getCell(
        signer.did(),
        "cfc-label-view-query-target",
        undefined,
        tx,
      );
      const targetLink = parseLink(target.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: targetLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: source.getAsLink(),
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { integrity: ["selected-by-alice"] },
            }],
          },
        },
      });
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      const value = target.get();
      const recovered = (value as { [toCell]: () => unknown })[toCell]();
      expect(cfcLabelViewForCell(recovered)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["authored-by-bob"] },
        }, {
          path: [],
          observes: "followRef",
          label: { integrity: ["selected-by-alice"] },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps accumulated link labels on schema asCell materialization", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view schema asCell",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-label-view-as-cell-source",
        undefined,
        tx,
      );
      const sourceLink = parseLink(source.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: sourceLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: { title: "as cell" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { integrity: ["authored-by-bob"] },
            }],
          },
        },
      });

      const target = runtime.getCell(
        signer.did(),
        "cfc-label-view-as-cell-target",
        {
          asCell: ["cell"],
          type: "object",
          properties: { title: { type: "string" } },
        },
        tx,
      );
      const targetLink = parseLink(target.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: targetLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: source.getAsLink(),
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { integrity: ["selected-by-alice"] },
            }],
          },
        },
      });
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      const recovered = target.get();
      expect(cfcLabelViewForCell(recovered)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["authored-by-bob"] },
        }, {
          path: [],
          observes: "followRef",
          label: { integrity: ["selected-by-alice"] },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not leak sibling labels on cross-document schema asCell children", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view cross doc sibling labels",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-label-view-sibling-source",
        undefined,
        tx,
      );
      const sourceLink = parseLink(source.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: sourceLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: { a: "first", b: "second" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["a"],
              label: { integrity: ["source-a"] },
            }, {
              path: ["b"],
              label: { integrity: ["source-b"] },
            }],
          },
        },
      });

      const target = runtime.getCell(
        signer.did(),
        "cfc-label-view-sibling-target",
        {
          type: "object",
          properties: {
            a: { type: "string", asCell: ["cell"] },
            b: { type: "string", asCell: ["cell"] },
          },
        },
        tx,
      );
      const targetLink = parseLink(target.getAsLink());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: targetLink.id!,
        type: "application/json",
        path: [],
      }, { value: source.getAsLink() });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).ok).toBeDefined();

      const recovered = target.get() as { a: unknown; b: unknown };
      expect(cfcLabelViewForCell(recovered.a)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["source-a"] },
        }],
      });
      expect(cfcLabelViewForCell(recovered.b)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["source-b"] },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps accumulated link labels on default-created asCell values", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view default asCell",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-label-view-default-source",
        undefined,
        tx,
      );
      const sourceLink = parseLink(source.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: sourceLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: {},
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { integrity: ["authored-by-bob"] },
            }],
          },
        },
      });

      const target = runtime.getCell(
        signer.did(),
        "cfc-label-view-default-target",
        {
          type: "object",
          properties: {
            item: {
              asCell: ["cell"],
              type: "object",
              default: { title: "fallback" },
              properties: { title: { type: "string" } },
            },
          },
        },
        tx,
      );
      const targetLink = parseLink(target.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: targetLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: source.getAsLink(),
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { integrity: ["selected-by-alice"] },
            }],
          },
        },
      });
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      const recovered = target.get() as { item: unknown };
      expect(cfcLabelViewForCell(recovered.item)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["authored-by-bob"] },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps per-element labels through native array map proxies", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view array map proxies",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const first = runtime.getCell(
        signer.did(),
        "cfc-label-view-array-first",
        undefined,
        tx,
      );
      const second = runtime.getCell(
        signer.did(),
        "cfc-label-view-array-second",
        undefined,
        tx,
      );
      const firstLink = parseLink(first.getAsLink());
      const secondLink = parseLink(second.getAsLink());
      for (
        const [link, value, integrity] of [
          [firstLink, { title: "first" }, "authored-first"],
          [secondLink, { title: "second" }, "authored-second"],
        ] as const
      ) {
        writeSeedEnvelopeDoc(tx, signer.did());
        seedStoredReferenceEnvelope(tx, {
          space: signer.did(),
          id: link.id!,
          type: "application/json",
          path: [],
        }, {
          value,
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: [],
                label: { integrity: [integrity] },
              }],
            },
          },
        });
      }

      const list = runtime.getCell(
        signer.did(),
        "cfc-label-view-array-list",
        undefined,
        tx,
      );
      const listLink = parseLink(list.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: listLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: [first.getAsLink(), second.getAsLink()],
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["0"],
              label: { integrity: ["selected-first"] },
            }, {
              path: ["1"],
              label: { integrity: ["selected-second"] },
            }],
          },
        },
      });
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      const recovered = (list.get() as unknown[]).map((item) =>
        (item as { [toCell]: () => unknown })[toCell]()
      );
      expect(cfcLabelViewForCell(recovered[0])).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["authored-first"] },
        }, {
          path: [],
          observes: "followRef",
          label: { integrity: ["selected-first"] },
        }],
      });
      expect(cfcLabelViewForCell(recovered[1])).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["authored-second"] },
        }, {
          path: [],
          observes: "followRef",
          label: { integrity: ["selected-second"] },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not reuse query proxies across different carried label views", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view query proxy cache",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-label-view-cache-source",
        undefined,
        tx,
      );
      const sourceLink = parseLink(source.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: sourceLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: { title: "shared" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { integrity: ["authored-shared"] },
            }],
          },
        },
      });

      const list = runtime.getCell(
        signer.did(),
        "cfc-label-view-cache-list",
        undefined,
        tx,
      );
      const listLink = parseLink(list.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: listLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: [source.getAsLink(), source.getAsLink()],
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["0"],
              label: { integrity: ["selected-first"] },
            }, {
              path: ["1"],
              label: { integrity: ["selected-second"] },
            }],
          },
        },
      });
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      const recovered = (list.get() as unknown[]).map((item) =>
        (item as { [toCell]: () => unknown })[toCell]()
      );
      expect(cfcLabelViewForCell(recovered[0])).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["authored-shared"] },
        }, {
          path: [],
          observes: "followRef",
          label: { integrity: ["selected-first"] },
        }],
      });
      expect(cfcLabelViewForCell(recovered[1])).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["authored-shared"] },
        }, {
          path: [],
          observes: "followRef",
          label: { integrity: ["selected-second"] },
        }],
      });
      expect(
        cfcLabelViewForCell(recovered[1])?.entries[0].label.integrity,
      ).not.toContain("selected-first");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("recovers per-item integrity from mapped VDOM output cells", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view pattern map vdom",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      // The items are seeded in their own transaction, committed before the
      // pattern runs.
      const seedTx = runtime.edit();
      const first = runtime.getCell(
        signer.did(),
        "cfc-label-view-pattern-first",
        undefined,
        seedTx,
      );
      const second = runtime.getCell(
        signer.did(),
        "cfc-label-view-pattern-second",
        undefined,
        seedTx,
      );
      for (
        const [cell, value, integrity] of [
          [first, { title: "First" }, "item-integrity-first"],
          [second, { title: "Second" }, "item-integrity-second"],
        ] as const
      ) {
        const link = parseLink(cell.getAsLink());
        writeSeedEnvelopeDoc(seedTx, signer.did());
        seedStoredReferenceEnvelope(seedTx, {
          space: signer.did(),
          id: link.id!,
          type: "application/json",
          path: [],
        }, {
          value,
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: [],
                label: { integrity: [integrity] },
              }],
            },
          },
        });
      }
      runtime.prepareTxForCommit(seedTx);
      await seedTx.commit();

      const tx = runtime.edit();
      const { commonfabric } = createTrustedBuilder(runtime);
      const { pattern } = commonfabric;
      const renderLabels = pattern<{ items: unknown[] }>(({ items }) => {
        const rendered = (items as any).mapWithPattern(
          pattern(({ element, index, array }: FactoryInput<any>) =>
            (((item: any) => ({
              [UI]: {
                type: "vnode" as const,
                name: "cf-cfc-label",
                props: { value: item },
                children: [],
              },
            })) as any)(element, index, array)
          ),
          {},
        );
        return { rendered };
      });

      const resultCell = runtime.getCell(
        signer.did(),
        "cfc-label-view-pattern-result",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        renderLabels,
        { items: [first.withTx(tx), second.withTx(tx)] },
        resultCell,
      );
      runtime.prepareTxForCommit(tx);
      await tx.commit();
      await result.pull();

      const firstValue = result
        .key("rendered")
        .key("0")
        .key(UI)
        .key("props")
        .key("value")
        .resolveAsCell();
      const secondValue = result
        .key("rendered")
        .key("1")
        .key(UI)
        .key("props")
        .key("value")
        .resolveAsCell();

      // The view of a mapped output carries a second entry describing the
      // link the slot holds, and that entry's atoms name the reference. The
      // set below holds every named integrity atom at the root path, so it
      // covers the item's own label and any other item's that reached it.
      const rootIntegrityAtoms = (cell: unknown) =>
        new Set(
          (cfcLabelViewForCell(cell)?.entries ?? [])
            .filter((entry) => entry.path.length === 0)
            .flatMap((entry) => entry.label.integrity ?? [])
            .filter((atom) => typeof atom === "string"),
        );

      expect(rootIntegrityAtoms(firstValue)).toEqual(
        new Set(["item-integrity-first"]),
      );
      expect(rootIntegrityAtoms(secondValue)).toEqual(
        new Set(["item-integrity-second"]),
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("follows array-element links to stored metadata", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view linked array entry",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-label-view-array-source",
        undefined,
        tx,
      );
      const sourceLink = parseLink(source.getAsLink());
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: sourceLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: { body: "labeled content" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { integrity: ["trusted-source"] },
            }],
          },
        },
      });
      const target = runtime.getCell(
        signer.did(),
        "cfc-label-view-array-target",
        { type: "array", items: true },
        tx,
      );
      seedStoredReferenceEnvelope(tx, {
        ...target.getAsNormalizedFullLink(),
        path: [],
      }, { value: [source.getAsLink()] });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).ok).toBeDefined();

      const schemaLessEntry = runtime.getCellFromLink({
        ...target.key(0).getAsNormalizedFullLink(),
        schema: undefined,
      });

      expect(cfcLabelViewForCell(schemaLessEntry)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["trusted-source"] },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("reads stored metadata directly from the queried cell", async () => {
    await withLabeledDocument(
      { integrity: ["trusted-source"] },
      (_runtime, cell) => {
        expect(cfcLabelViewForCell(cell)).toEqual({
          version: 1,
          entries: [{
            path: [],
            label: { integrity: ["trusted-source"] },
          }],
        });
      },
    );
  });

  it("returns `undefined` for an object that only resembles a cell", () => {
    const lookalike = {
      getAsNormalizedFullLink: () => ({
        id: "of:labeled-cell",
        space: "did:key:test",
        type: "application/json",
        path: [],
      }),
      runtime: {
        readTx: () => ({
          readOrThrow: () => ({
            version: 1,
            schemaHash: "test-schema",
            labelMap: {
              version: 1,
              entries: [{
                path: [],
                label: { integrity: ["trusted-source"] },
              }],
            },
          }),
        }),
      },
    };

    expect(cfcLabelViewForCell(lookalike)).toBeUndefined();
  });

  it("reports a successful fail-closed read through the public status wrapper", async () => {
    const label = {
      confidentiality: ["private-source"],
      integrity: ["trusted-source"],
    };
    await withLabeledDocument(label, (_runtime, cell) => {
      const expectedView = { version: 1, entries: [{ path: [], label }] };

      expect(cfcLabelViewForCellFailClosedWithStatus(cell)).toEqual({
        view: expectedView,
        readFailed: false,
      });
      expect(cfcLabelViewForCellFailClosed(cell)).toEqual(expectedView);
    });
  });

  it("reports a failed read while retaining confidentiality in its fail-closed view", async () => {
    await withLabeledDocument(undefined, (runtime, cell) => {
      // A transaction whose every read throws, standing in for a store that
      // cannot answer, under a cell that carries a label of its own.
      class FailingReads extends TransactionWrapper {
        override readOrThrow(): never {
          throw new Error("metadata read failed");
        }
      }
      const failing = new CellImpl(
        runtime,
        new FailingReads(runtime.edit()),
        cell.getAsNormalizedFullLink(),
        false,
        undefined,
        "cell",
        {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: ["private-source"] },
          }],
        },
      );

      expect(cfcLabelViewForCellFailClosedWithStatus(failing)).toEqual({
        view: {
          version: 1,
          entries: [{
            path: [],
            label: {
              confidentiality: [
                "private-source",
                "cfc:label-read-failed",
              ],
            },
          }],
        },
        readFailed: true,
      });
    });
  });

  it("skips result metadata for result-cell internal paths", async () => {
    await withLabeledDocument(undefined, (runtime, cell) => {
      // A cell whose result metadata throws when consulted.
      class UnconsultedMetadata extends CellImpl<FabricValue> {
        override getMetaRaw(): never {
          throw new Error("result metadata should not be consulted");
        }
      }
      const resultCell = new UnconsultedMetadata(runtime, undefined, {
        ...cell.getAsNormalizedFullLink(),
        path: ["internal", "__#3"],
      });

      expect(cfcLabelViewForCell(resultCell)).toBeUndefined();
    });
  });

  it("re-fires an includeCfcLabel sink on a label-only write (value unchanged)", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view sink reactivity",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const cell = runtime.getCell<{ body: string }>(
        signer.did(),
        "cfc-label-sink-reactivity",
      );
      const id = parseLink(cell.getAsLink()).id!;
      const writeDoc = (integrityAtom: string) => {
        const tx = runtime.edit();
        writeSeedEnvelopeDoc(tx, signer.did());
        seedStoredReferenceEnvelope(tx, {
          space: signer.did(),
          id,
          type: "application/json",
          path: [],
        }, {
          // SAME value both times — only the label changes.
          value: { body: "unchanging" },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{ path: [], label: { integrity: [integrityAtom] } }],
            },
          },
        });
        runtime.prepareTxForCommit(tx);
        return tx.commit();
      };

      await writeDoc("authored-by-alice");
      await runtime.idle();

      const fires: Array<
        { value: { body: string } | undefined; label: unknown }
      > = [];
      const cancel = cell.sink((value, cfcLabel) => {
        fires.push({ value, label: cfcLabel });
      }, { includeCfcLabel: true });

      // The label-only write: value identical, integrity atom changed.
      await writeDoc("authored-by-bob");
      await runtime.idle();
      cancel();

      // Fired on subscribe AND again on the label-only write.
      expect(fires.length).toBeGreaterThanOrEqual(2);
      // The value never changed across fires — this was purely a label change.
      for (const fire of fires) {
        expect(fire.value).toEqual({ body: "unchanging" });
      }
      // The first delivered label carried alice, the last carries bob.
      expect(JSON.stringify(fires[0].label)).toContain("authored-by-alice");
      expect(JSON.stringify(fires.at(-1)!.label)).toContain("authored-by-bob");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("delivers an includeConsumedLabel sink the labels its read followed a link to", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc consumed label sink",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const target = runtime.getCell<string>(
        signer.did(),
        "cfc-consumed-label-target",
      );
      const writeTarget = (atom: string) => {
        const tx = runtime.edit();
        writeSeedEnvelopeDoc(tx, signer.did());
        seedStoredReferenceEnvelope(tx, {
          space: signer.did(),
          id: parseLink(target.getAsLink()).id!,
          type: "application/json",
          path: [],
        }, {
          value: "held",
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{ path: [], label: { confidentiality: [atom] } }],
            },
          },
        });
        runtime.prepareTxForCommit(tx);
        return tx.commit();
      };
      await writeTarget("first-secret");
      const holder = runtime.getCell<{ inner: string }>(
        signer.did(),
        "cfc-consumed-label-holder",
      );
      {
        const tx = runtime.edit();
        holder.withTx(tx).setRawUntyped({ inner: target.getAsLink() });
        runtime.prepareTxForCommit(tx);
        await tx.commit();
      }
      await runtime.idle();

      const consumed: unknown[] = [];
      const plain: unknown[] = [];
      const cancel = holder.sink((_value, _label, read) => {
        consumed.push(read?.confidentiality);
      }, { includeConsumedLabel: true });
      const cancelPlain = holder.sink((_value, _label, read) => {
        plain.push(read);
      });

      // A label-only write to the linked document re-fires the sink.
      await writeTarget("second-secret");
      await runtime.idle();
      cancel();
      cancelPlain();

      expect(consumed[0]).toEqual(["first-secret"]);
      expect(consumed.at(-1)).toEqual(["second-secret"]);
      expect(plain.every((read) => read === undefined)).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("delivers to an includeCfcLabel sink the label of the doc a mid-path link resolves to", async () => {
    // A value bound to a UI badge is often reached through a list whose
    // element links to another document, as a profile's `verifiedIdentities`
    // links each assertion. The label that vouches for the value lives on the
    // linked document, so the sink has to report it, still report the list
    // document's own label, and re-fire when the linked document's label
    // changes.
    const signer = await Identity.fromPassphrase(
      "cfc label view sink mid-path link",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const assertion = runtime.getCell(
        signer.did(),
        "cfc-label-sink-mid-path-assertion",
        undefined,
        tx,
      );
      const assertionAddress = {
        space: signer.did(),
        id: parseLink(assertion.getAsLink()).id!,
        type: "application/json",
        path: [],
      } as const;
      const assertionEnvelope = (integrityAtom: string) => ({
        value: { type: "email", value: "ada@example.com" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { integrity: [integrityAtom] } }],
          },
        },
      } satisfies { value: unknown; cfc: CfcMetadata });
      const list = runtime.getCell(
        signer.did(),
        "cfc-label-sink-mid-path-list",
        undefined,
        tx,
      );
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredReferenceEnvelope(
        tx,
        assertionAddress,
        assertionEnvelope("verified-source"),
      );
      seedStoredReferenceEnvelope(tx, {
        space: signer.did(),
        id: parseLink(list.getAsLink()).id!,
        type: "application/json",
        path: [],
      }, {
        value: [assertion.getAsLink()],
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { integrity: ["list-owner"] } }],
          },
        },
      });
      runtime.prepareTxForCommit(tx);
      await tx.commit();
      await runtime.idle();

      const labels: unknown[] = [];
      const cancel = list.key(0).key("value").sink((_value, cfcLabel) => {
        labels.push(cfcLabel);
      }, { includeCfcLabel: true });
      await runtime.idle();

      expect(labels.length).toBeGreaterThan(0);
      const delivered = JSON.stringify(labels.at(-1));
      expect(delivered).toContain("verified-source");
      expect(delivered).toContain("list-owner");

      // A label-only write to the linked document: same value, new atom.
      const relabelTx = runtime.edit();
      writeSeedEnvelopeDoc(relabelTx, signer.did());
      seedStoredReferenceEnvelope(
        relabelTx,
        assertionAddress,
        assertionEnvelope("reverified-source"),
      );
      runtime.prepareTxForCommit(relabelTx);
      await relabelTx.commit();
      await runtime.idle();
      cancel();

      expect(JSON.stringify(labels.at(-1))).toContain("reverified-source");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

describe("stripSigilCfcLabelViews", () => {
  // Inv-12: a view arriving from the main thread is an untrusted display
  // artifact, and the ingress removes it from every sigil link in a value
  // rather than letting it become worker label state.

  const caveat = {
    type: "https://commonfabric.org/cfc/atom/Caveat",
    kind: "derived-from",
    source: "did:key:alice",
  };
  const linkWithView = (id: string) => ({
    "/": {
      [LINK_V1_TAG]: {
        id,
        space: "did:key:test",
        path: [],
        cfcLabelView: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: [caveat] },
          }],
        },
      },
    },
  });

  it("removes views and keeps addressing intact", () => {
    const value = {
      items: [linkWithView("of:strip-a")],
      plain: 7,
    };
    const stripped = stripSigilCfcLabelViews(value) as {
      items: Array<{ "/": Record<string, Record<string, unknown>> }>;
      plain: number;
    };
    const payload = stripped.items[0]["/"][LINK_V1_TAG];
    expect(payload.id).toBe("of:strip-a");
    expect("cfcLabelView" in payload).toBe(false);
    expect(stripped.plain).toBe(7);
    // Copy-on-write: a viewless tree passes through by reference, and the
    // input is not mutated.
    const viewless = { link: { "/": { [LINK_V1_TAG]: { id: "of:e" } } } };
    expect(stripSigilCfcLabelViews(viewless)).toBe(viewless);
    expect(
      (value.items[0] as ReturnType<typeof linkWithView>)["/"][LINK_V1_TAG]
        .cfcLabelView,
    ).toBeDefined();
  });

  //
  // A `FabricSpecialObject` on the strip path
  //
  // A `FabricSpecialObject` is `isObjectOrArray`, so it reaches the record
  // branch rather than the leaf return. What keeps it whole is the
  // copy-on-write gate: such a value has zero enumerable own properties, so no
  // member can come back changed, `changed` stays false, and the original goes
  // back by identity. That is a real guarantee resting on nothing but the
  // zero-property fact -- give a special object an enumerable property and
  // this walk starts flattening values on the ingress path. Where the walk
  // cannot make that guarantee it refuses instead, rather than leaving a view
  // in place.
  //

  it("keeps a `FabricBytes` whole while stripping a sibling's view", () => {
    const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
    const value = { bytes, tagged: linkWithView("of:strip-bytes") };

    // The discriminating shape: the sibling's view forces the surrounding
    // record to clone, which is where a descended-into special object would be
    // lost. The clone carries the reference across instead.
    const stripped = stripSigilCfcLabelViews(value) as typeof value;

    expect(stripped).not.toBe(value);
    expect(stripped.bytes).toBe(bytes);
  });

  it("throws for a `FabricError` rather than leaving a view inside it", () => {
    // The inv-12 boundary: an instance's codec contents can carry a sigil link
    // with an untrusted `cfcLabelView` riding it, unreachable by property name.
    // Passing one through leaves that view in place, which is the strip failing
    // open, so it refuses instead.
    //
    // The control is the point -- the same view _is_ stripped on a plain
    // object, so what changes the outcome is the wrapper.
    const plain = stripSigilCfcLabelViews({
      tagged: linkWithView("of:strip-control"),
    }) as { tagged: { "/": Record<string, Record<string, unknown>> } };
    expect("cfcLabelView" in plain.tagged["/"][LINK_V1_TAG]).toBe(false);

    const failure = FabricError.fromNativeError(new Error("boom"));
    expect(() => stripSigilCfcLabelViews({ failure })).toThrow(
      "Cannot yet handle `FabricError` (a `FabricInstance`) when " +
        "stripping sigil CFC label views.",
    );
  });

  //
  // Cycles and sharing
  //

  it("throws for a value that contains itself, naming the path where the cycle closes", () => {
    const items: unknown[] = [linkWithView("of:cycle")];
    const value = { items };
    items.push(value);

    expect(() => stripSigilCfcLabelViews(value)).toThrow(
      "Cannot strip sigil CFC label views from a value with a cycle; " +
        "the cycle closes at path `items.1`.",
    );
  });

  it("strips a subtree reachable from two positions at each, rather than taking it for a cycle", () => {
    const shared = { tagged: linkWithView("of:shared") };

    const stripped = stripSigilCfcLabelViews({ a: shared, b: shared }) as {
      a: { tagged: { "/": Record<string, Record<string, unknown>> } };
      b: { tagged: { "/": Record<string, Record<string, unknown>> } };
    };

    expect("cfcLabelView" in stripped.a.tagged["/"][LINK_V1_TAG]).toBe(false);
    expect("cfcLabelView" in stripped.b.tagged["/"][LINK_V1_TAG]).toBe(false);
  });
});
