import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { toCell } from "../src/back-to-cell.ts";
import { type FactoryInput, UI } from "../src/builder/types.ts";
import {
  cfcLabelViewForCell,
  cfcLabelViewForCellFailClosed,
  cfcLabelViewForCellFailClosedWithStatus,
  cfcLabelViewFromMetadata,
  cfcLabelViewSourceForCell,
  cfcLabelViewSymbol,
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
import { Runtime } from "../src/runtime.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

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
            path: ["value", "body"],
            label: { confidentiality: ["prompt-influenced"] },
          },
          {
            path: ["value", "body", "summary"],
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
            path: ["value", "*"],
            label: { integrity: ["trusted-item"] },
          },
          {
            path: ["value", "*", "title"],
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
      seedStoredEnvelope(tx, {
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
      tx.writeOrThrow({
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
      seedStoredEnvelope(tx, {
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
      seedStoredEnvelope(tx, {
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
        seedStoredEnvelope(tx, {
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
      seedStoredEnvelope(tx, {
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
      seedStoredEnvelope(tx, {
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
      seedStoredEnvelope(tx, {
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
            confidentiality: expect.arrayContaining([
              "personal-space",
              "shared-space",
            ]),
            integrity: expect.arrayContaining([
              "selected-by-alice",
              "authored-by-bob",
            ]),
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
              "personal-space",
              "shared-space",
              "target-detail",
            ]),
            integrity: expect.arrayContaining([
              "selected-by-alice",
              "authored-by-bob",
            ]),
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
      seedStoredEnvelope(tx, {
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
      seedStoredEnvelope(tx, {
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
          label: {
            integrity: expect.arrayContaining([
              "selected-by-alice",
              "authored-by-bob",
            ]),
          },
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
      seedStoredEnvelope(tx, {
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
      seedStoredEnvelope(tx, {
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
          label: {
            integrity: expect.arrayContaining([
              "selected-by-alice",
              "authored-by-bob",
            ]),
          },
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
      seedStoredEnvelope(tx, {
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
      tx.writeOrThrow({
        space: signer.did(),
        id: targetLink.id!,
        type: "application/json",
        path: [],
      }, { value: source.getAsLink() });
      runtime.prepareTxForCommit(tx);
      await tx.commit();

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
      seedStoredEnvelope(tx, {
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
      seedStoredEnvelope(tx, {
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
          label: {
            integrity: expect.arrayContaining([
              "selected-by-alice",
              "authored-by-bob",
            ]),
          },
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
        seedStoredEnvelope(tx, {
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
      seedStoredEnvelope(tx, {
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
          label: {
            integrity: expect.arrayContaining([
              "selected-first",
              "authored-first",
            ]),
          },
        }],
      });
      expect(cfcLabelViewForCell(recovered[1])).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            integrity: expect.arrayContaining([
              "selected-second",
              "authored-second",
            ]),
          },
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
      seedStoredEnvelope(tx, {
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
      seedStoredEnvelope(tx, {
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
          label: {
            integrity: expect.arrayContaining([
              "selected-first",
              "authored-shared",
            ]),
          },
        }],
      });
      expect(cfcLabelViewForCell(recovered[1])).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            integrity: expect.arrayContaining([
              "selected-second",
              "authored-shared",
            ]),
          },
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
        seedStoredEnvelope(seedTx, {
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
      seedStoredEnvelope(tx, {
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
      target.setRawUntyped([source.getAsLink()]);
      runtime.prepareTxForCommit(tx);
      await tx.commit();

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

  it("reads stored metadata directly from the queried cell", () => {
    const cell = {
      getAsNormalizedFullLink: () => ({
        id: "of:labeled-cell",
        space: "did:key:test",
        type: "application/json",
        path: [],
      }),
      runtime: {
        readTx: () => ({
          // The reserved `["cfc"]` position is what the reader addresses,
          // so the read returns the envelope itself.
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

    expect(cfcLabelViewForCell(cell)).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: { integrity: ["trusted-source"] },
      }],
    });
  });

  it("reports a successful fail-closed read through the public status wrapper", () => {
    let metadataReads = 0;
    const cell = {
      getAsNormalizedFullLink: () => ({
        id: "of:labeled-cell",
        space: "did:key:test",
        type: "application/json",
        path: [],
      }),
      runtime: {
        readTx: () => ({
          readOrThrow: () => {
            metadataReads++;
            return {
              version: 1,
              schemaHash: "test-schema",
              labelMap: {
                version: 1,
                entries: [{
                  path: [],
                  label: {
                    confidentiality: ["private-source"],
                    integrity: ["trusted-source"],
                  },
                }],
              },
            };
          },
        }),
      },
    };
    const expectedView = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          confidentiality: ["private-source"],
          integrity: ["trusted-source"],
        },
      }],
    };

    expect(cfcLabelViewForCellFailClosedWithStatus(cell)).toEqual({
      view: expectedView,
      readFailed: false,
    });
    expect(metadataReads).toBe(1);
    expect(cfcLabelViewForCellFailClosed(cell)).toEqual(expectedView);
    expect(metadataReads).toBe(2);
  });

  it("reports a failed read while retaining confidentiality in its fail-closed view", () => {
    let metadataReads = 0;
    const cell = {
      getAsNormalizedFullLink: () => ({
        id: "of:labeled-cell",
        space: "did:key:test",
        type: "application/json",
        path: [],
      }),
      runtime: {
        readTx: () => ({
          readOrThrow: () => {
            metadataReads++;
            throw new Error("metadata read failed");
          },
        }),
      },
      [cfcLabelViewSymbol]: () => ({
        version: 1 as const,
        entries: [{
          path: [],
          label: { confidentiality: ["private-source"] },
        }],
      }),
    };

    expect(cfcLabelViewForCellFailClosedWithStatus(cell)).toEqual({
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
    expect(metadataReads).toBe(1);
  });

  it("skips result metadata for result-cell internal paths", () => {
    const resultCell = {
      getAsNormalizedFullLink: () => ({
        id: "of:result-cell",
        space: "did:key:test",
        type: "application/json",
        path: ["internal", "__#3"],
      }),
      runtime: {
        readTx: () => ({
          readOrThrow: () => undefined,
        }),
      },
      getMetaRaw: () => {
        throw new Error("result metadata should not be consulted");
      },
    };

    expect(cfcLabelViewForCell(resultCell)).toBeUndefined();
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
        seedStoredEnvelope(tx, {
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
      });
      const list = runtime.getCell(
        signer.did(),
        "cfc-label-sink-mid-path-list",
        undefined,
        tx,
      );
      writeSeedEnvelopeDoc(tx, signer.did());
      seedStoredEnvelope(
        tx,
        assertionAddress,
        assertionEnvelope("verified-source"),
      );
      seedStoredEnvelope(tx, {
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
      seedStoredEnvelope(
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
