import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { WorkerReconciler } from "@commonfabric/html/worker";
import type { VDomOp } from "@commonfabric/html/vdom-ops";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  type Cell,
  cellWriteSchema,
  convertCellsToLinks,
  lookupSchemaDocument,
  Runtime,
  type SigilLink,
} from "@commonfabric/runner";
import {
  carryCfcReferenceProvenance,
  getCfcReferenceProvenance,
  readStoredCfcMetadata,
} from "@commonfabric/runner/cfc";
import { linkRefFrom, linkRefPayload } from "@commonfabric/runner/shared";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { ReferenceRegistry } from "@/backends/reference-registry.ts";
import {
  createCellRef,
  getCell,
  mapCellRefsToSigilLinks,
} from "@/backends/utils.ts";
import {
  type CellRef,
  ClientNotificationType,
  type IPCClientRequest,
  NotificationType,
  RequestType,
} from "@/protocol/mod.ts";
import type { WorkerClient } from "@/backends/worker-client.ts";
import { $conn, $onCellUpdate, CellHandle, RuntimeClient } from "@/mod.ts";
import { createSigilLinkFromParsedLink } from "../../../runner/src/link-utils.ts";
import { getCellOrThrow } from "../../../runner/src/query-result-proxy.ts";
import { decomposeSchema } from "../../../runner/src/schema-decompose.ts";
import type { URI } from "@commonfabric/memory/interface";
import { deriveFlowJoin } from "../../../runner/src/cfc/prepare.ts";
import {
  getCfcReferenceView,
  withCfcReferenceConfidentiality,
} from "../../../runner/src/cfc/reference-provenance.ts";
import { normalizeClause } from "../../../runner/src/cfc/clause.ts";
import type { LabelMapEntry } from "../../../runner/src/cfc/types.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../../runner/test/cfc-seed-envelope.ts";
import { cellRefToKey } from "@/shared/utils.ts";
import { buildProcessor } from "./build-processor.ts";

const signer = await Identity.fromPassphrase("worker-reference-registry");
const space = signer.did();
const selection = normalizeClause({
  anyOf: ["selection", cfcAtom.space(space)],
});

/** Models the transport crossing, which discards live WeakMap associations. */
const wireCopy = <T>(value: T): T => structuredClone(value);

describe("reference-registry", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let registry: ReferenceRegistry;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
    });
    registry = new ReferenceRegistry(runtime);
  });

  afterEach(async () => {
    registry.clear();
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  const seed = async (
    cause: string,
    value: FabricValue,
    entries: LabelMapEntry[] = [],
  ) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, cause, undefined, tx);
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, { ...cell.getAsNormalizedFullLink(), path: [] }, {
      value,
      cfc: {
        version: 3,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit()).error).toBeUndefined();
    return cell.withTx(undefined);
  };

  const acquireSelected = async () => {
    const target = await seed("target", { public: "visible" });
    const selected = await seed("selection", target.getAsLink(), [{
      path: [],
      observes: "followRef",
      origin: "link",
      referenceAcquisition: "complete",
      label: { confidentiality: [selection] },
    }]);
    const tx = runtime.edit();
    const acquired = selected.withTx(tx).resolveAsCell();
    expect(getCfcReferenceProvenance(acquired)?.confidentiality).toEqual([
      selection,
    ]);
    tx.abort();
    return acquired.withTx(undefined);
  };

  it("acquires an address through the client and worker request boundary", async () => {
    const target = await seed("client-acquisition", { public: "visible" });
    const processor = buildProcessor({ runtime, identity: signer, space });
    const requests: IPCClientRequest[] = [];
    const conn = {
      on: () => {},
      request: (request: IPCClientRequest) => {
        requests.push(wireCopy(request));
        return processor.handleRequest(wireCopy(request));
      },
    };
    const client = new (RuntimeClient as unknown as {
      new (conn: unknown, principal: string): RuntimeClient;
    })(conn, space);
    const address = wireCopy(target.getAsNormalizedFullLink());
    const handle = await client.acquireCell<{ public: string }>(address);
    expect(requests).toEqual([{ type: RequestType.AcquireCell, address }]);
    expect(handle.ref().cfcReferenceToken).toBeDefined();
    expect(await handle.key("public").sync()).toBe("visible");
    expect(() => getCell(runtime, handle.ref())).toThrow(
      "Reference acquisition registry is missing",
    );
  });

  for (const path of [[], ["branch"]]) {
    it(`retains an acquisition on a cycle read at /${path.join("/")}`, async () => {
      const target = runtime.getCell(space, "cycle");
      const link = target.getAsNormalizedFullLink();
      const value = {
        name: "cycle target",
        self: linkRefFrom({ ...link, path }),
      };
      await seed("cycle", path.length === 0 ? value : { branch: value }, [{
        path: [...path, "self"],
        origin: "link",
        observes: "followRef",
        referenceAcquisition: "complete",
        label: {},
      }]);
      const processor = buildProcessor({ runtime, identity: signer, space });
      const ref = processor.handleAcquireCell({
        type: RequestType.AcquireCell,
        address: {
          ...link,
          path,
        },
      }).cell;
      const client = {
        [$conn]: () => ({
          request: (request: IPCClientRequest) =>
            processor.handleRequest(wireCopy(request)),
        }),
      } as unknown as RuntimeClient;
      const handle = new CellHandle<{ self: CellHandle<{ name: string }> }>(
        client,
        wireCopy(ref),
      );
      const response = processor.handleCellGet({
        type: RequestType.CellGet,
        cell: ref,
      });
      handle[$onCellUpdate](wireCopy(response.value));
      const self = handle.get()!.self;
      expect(self.ref().cfcReferenceToken).toBeDefined();
      expect(self.ref().path).toEqual(path);
      expect(await self.key("name").sync()).toBe("cycle target");
      if (path.length > 0) {
        expect(() =>
          processor.handleCellGet({
            type: RequestType.CellGet,
            cell: { ...self.ref(), path: [] },
          })
        ).toThrow("Reference acquisition token does not match its binding");
      }
    });
  }

  it("rejects an unrelated or less restricted retained cell at export", async () => {
    const acquired = await acquireSelected();
    const unrelated = await seed("unrelated-cell", "other content");
    expect(() => registry.exportLink(acquired.getAsLink(), unrelated))
      .toThrow("Retained cell does not match its reference acquisition");
    const unselected = runtime.getCellFromLink(
      wireCopy(acquired.getAsNormalizedFullLink()),
    );
    expect(() => registry.exportLink(acquired.getAsLink(), unselected))
      .toThrow("Retained cell does not match its reference acquisition");
    const capped = runtime.getCellFromLink({
      ...acquired.getAsNormalizedFullLink(),
      scopeCaps: [{ depth: 0, scope: "space" }],
    });
    const uncapped = runtime.getCellFromLink({
      ...acquired.getAsNormalizedFullLink(),
      scopeCaps: undefined,
    });
    expect(() => registry.exportLink(capped.getAsLink(), uncapped))
      .toThrow("Retained cell does not match its reference acquisition");
  });

  it("rejects a retained cell whose policy origins were discarded", async () => {
    const acquired = await acquireSelected();
    const provenance = getCfcReferenceProvenance(acquired)!;
    expect(provenance.originSpaces).toContain(space);
    const withoutOrigins = runtime.getCellFromLink(
      wireCopy(acquired.getAsNormalizedFullLink()),
      undefined,
      undefined,
      withCfcReferenceConfidentiality(undefined, provenance.confidentiality),
    );
    expect(getCfcReferenceProvenance(withoutOrigins)?.confidentiality)
      .toEqual(provenance.confidentiality);
    expect(() => registry.exportLink(acquired.getAsLink(), withoutOrigins))
      .toThrow("Retained cell does not match its reference acquisition");
  });

  it("keeps materialized mutation declarations distinct from explicit scope declarations", async () => {
    const target = runtime.getCell<{ count: number }>(
      space,
      "scope-mutation-target",
    );
    const seed = runtime.edit();
    target.withTx(seed).set({ count: 1 });
    expect((await seed.commit()).error).toBeUndefined();
    const held = target.asSchema<Cell<{ count: number }>>({
      type: "object",
      properties: { count: { type: "number" } },
      asCell: [{ kind: "cell", scope: "user" }],
    }).get();
    const declared = held.asSchema<{ count: number }>(held.schema);
    expect(held.getAsNormalizedFullLink()).toEqual(
      declared.getAsNormalizedFullLink(),
    );
    expect(cellWriteSchema(held)).not.toEqual(cellWriteSchema(declared));
    const heldRef = createCellRef(held, undefined, registry);
    const declaredRef = createCellRef(declared, undefined, registry);
    expect(heldRef.cfcReferenceToken).not.toBe(declaredRef.cfcReferenceToken);
    expect(
      createCellRef(held.withTx(undefined), undefined, registry)
        .cfcReferenceToken,
    )
      .toBe(heldRef.cfcReferenceToken);
    expect(cellWriteSchema(registry.importCell(wireCopy(heldRef))))
      .toEqual(cellWriteSchema(held));
    expect(cellWriteSchema(registry.importCell(wireCopy(declaredRef))))
      .toEqual(cellWriteSchema(declared));
    const childProjection = registry.importCell({
      ...wireCopy(heldRef),
      path: [...heldRef.path, "count"],
    });
    expect(childProjection.schema).toEqual(heldRef.schema);
    expect(cellWriteSchema(childProjection)).toEqual(heldRef.schema);
    const write = runtime.edit();
    registry.importCell(wireCopy(heldRef)).withTx(write).set({ count: 2 });
    expect((await write.commit()).error).toBeUndefined();
    expect(target.get()).toEqual({ count: 2 });
    expect(
      runtime.getCell(
        space,
        "scope-mutation-target",
        undefined,
        undefined,
        "user",
      ).getRaw(),
    ).toBeUndefined();
  });

  it("keeps references with distinct selection witnesses in separate acquisitions", async () => {
    const acquired = await acquireSelected();
    const provenance = getCfcReferenceProvenance(acquired)!;
    const witness = {
      type: CFC_ATOM_TYPE.TransformedBy,
      identity: { kind: "builtin", builtinId: "worker-selector" },
    } as const;
    const witnessed = runtime.getCellFromLink(
      wireCopy(acquired.getAsNormalizedFullLink()),
      undefined,
      undefined,
      withCfcReferenceConfidentiality(
        getCfcReferenceView(acquired),
        provenance.confidentiality,
        [witness],
      ),
    );
    expect(getCfcReferenceProvenance(witnessed)?.selectionWitnesses)
      .toEqual([witness]);
    for (const lazy of [false, true]) {
      const read = runtime.edit();
      try {
        read.markLazyMaterialize(lazy);
        const schema = {
          type: "object",
          properties: { public: { type: "string" } },
        } as const;
        const plainView = acquired.withTx(read).asSchema(schema).get();
        const witnessedView = witnessed.withTx(read).asSchema(schema).get();
        expect(
          getCfcReferenceProvenance(getCellOrThrow(plainView))
            ?.selectionWitnesses ?? [],
        )
          .toEqual([]);
        expect(
          getCfcReferenceProvenance(getCellOrThrow(witnessedView))
            ?.selectionWitnesses,
        )
          .toEqual([witness]);
      } finally {
        read.abort();
      }
    }
    expect(() => registry.exportLink(acquired.getAsLink(), witnessed))
      .toThrow("Retained cell does not match its reference acquisition");
    expect(() => registry.exportLink(witnessed.getAsLink(), acquired))
      .toThrow("Retained cell does not match its reference acquisition");
    const plainRef = createCellRef(acquired, undefined, registry);
    const witnessedRef = createCellRef(witnessed, undefined, registry);
    expect(plainRef.cfcReferenceToken).not.toBe(witnessedRef.cfcReferenceToken);
    expect(
      getCfcReferenceProvenance(registry.importCell(witnessedRef))
        ?.selectionWitnesses,
    )
      .toEqual([witness]);
    expect(
      getCfcReferenceProvenance(registry.importCell(plainRef))
        ?.selectionWitnesses ?? [],
    )
      .toEqual([]);
  });

  it("rejects exporting a carrier after its binding is changed", async () => {
    const acquired = await acquireSelected();
    const original = acquired.getAsLink();
    const payload = linkRefPayload(original);
    for (
      const altered of [
        { ...payload, id: "of:other" as const },
        { ...payload, path: ["other"] },
        { ...payload, space: undefined },
        { ...payload, scope: "inherit" as const },
      ]
    ) {
      const link = carryCfcReferenceProvenance(original, linkRefFrom(altered));
      expect(() => registry.exportLink(link)).toThrow(
        "Reference acquisition does not match its binding",
      );
    }
    const { scope: _scope, ...unscoped } = payload;
    const exported = registry.exportLink(
      carryCfcReferenceProvenance(original, linkRefFrom(unscoped)),
      acquired,
    );
    expect(
      getCfcReferenceProvenance(registry.importLink(wireCopy(exported)))
        ?.confidentiality,
    ).toEqual([selection]);
  });

  it("issues usable acquisitions for home and newly ensured space roots", async () => {
    const held = await acquireSelected();
    const processor = buildProcessor({
      runtime,
      identity: signer,
      space,
      cc: {
        getDefaultPattern: () => Promise.resolve(undefined),
        ensureDefaultPattern: () => Promise.resolve({ getCell: () => held }),
      },
    });
    const home = processor.handleGetHomeSpaceCell({
      type: RequestType.GetHomeSpaceCell,
    });
    expect(home.cell.cfcReferenceToken).toBeDefined();
    const address = runtime.getHomeSpaceCell().getAsNormalizedFullLink();
    expect(home.cell).toMatchObject({
      space: address.space,
      id: address.id,
      scope: address.scope,
      path: address.path,
    });
    const root = await processor.handleGetSpaceRootPattern({
      type: RequestType.GetSpaceRootPattern,
      space,
      start: false,
    });
    expect(root.piece.cell.cfcReferenceToken).toBeDefined();
    expect(
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: { ...root.piece.cell, path: ["public"] },
      }).value,
    ).toBe("visible");
  });

  it("rejects importing a token attached to a relative address", async () => {
    const acquired = await acquireSelected();
    const issued = registry.exportLink(acquired.getAsLink(), acquired);
    const payload = linkRefPayload(issued);
    expect(payload).toHaveProperty("cfcReferenceToken");
    for (
      const relative of [
        { ...payload, id: undefined },
        { ...payload, space: undefined },
      ]
    ) {
      expect(() => registry.importLink(linkRefFrom(relative))).toThrow(
        "Reference acquisition token needs an absolute binding",
      );
    }
    expect(
      getCfcReferenceProvenance(registry.importLink(wireCopy(issued)))
        ?.confidentiality,
    ).toEqual([selection]);
  });

  it("keeps immutable tokens distinct by captured slots while deduplicating identical acquisitions", async () => {
    const held = await acquireSelected();
    const trusted = runtime.getImmutableCell(space, [held.getAsLink()]);
    const identical = runtime.getImmutableCell(space, [held.getAsLink()]);
    const independent = runtime.getCellFromLink(
      wireCopy(held.getAsNormalizedFullLink()),
    );
    const publicLiteral = runtime.getImmutableCell(space, [
      independent.getAsLink(),
    ]);
    const opaque = runtime.getImmutableCell(space, [
      wireCopy(independent.getAsLink()),
    ]);
    const trustedRef = createCellRef(trusted, undefined, registry);
    const identicalRef = createCellRef(identical, undefined, registry);
    const opaqueRef = createCellRef(opaque, undefined, registry);
    const publicRef = createCellRef(publicLiteral, undefined, registry);
    expect(getCfcReferenceProvenance(publicLiteral)?.confidentiality).toEqual(
      [],
    );
    expect(getCfcReferenceProvenance(opaque)?.confidentiality).toEqual([]);
    expect(publicRef.cfcReferenceToken).not.toBe(opaqueRef.cfcReferenceToken);
    expect(cellRefToKey(publicRef)).not.toBe(cellRefToKey(opaqueRef));
    expect(trustedRef.id).toBe(opaqueRef.id);
    expect(trustedRef.cfcReferenceToken).toBe(identicalRef.cfcReferenceToken);
    expect(trustedRef.cfcReferenceToken).not.toBe(opaqueRef.cfcReferenceToken);

    const tx = runtime.edit();
    const imported = getCell(runtime, wireCopy(trustedRef), registry).withTx(
      tx,
    );
    expect(imported.key("0", "public").get()).toBe("visible");
    expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
    const transferred = registry.importLink(
      wireCopy(registry.exportLink(trusted.getAsLink(), trusted)),
    );
    const output = runtime.getCell(
      space,
      "immutable-token-write",
      undefined,
      tx,
    );
    output.set(transferred);
    expect((await tx.commit()).ok).toBeDefined();
    const read = runtime.edit();
    expect(output.withTx(read).key("0", "public").get()).toBe("visible");
    expect(deriveFlowJoin(read).confidentiality).toContainEqual(selection);
    const unproven = getCell(runtime, wireCopy(opaqueRef), registry).withTx(
      read,
    );
    expect(() => unproven.key("0").resolveAsCell()).toThrow(
      "Reference acquisition lacks complete legacy provenance",
    );
    read.abort();
  });

  it("retains selected identity through a client reference and child dereference", async () => {
    const acquired = await acquireSelected();
    const ref = wireCopy(createCellRef(acquired, undefined, registry));
    expect(ref.cfcReferenceToken).toBeDefined();
    expect(createCellRef(acquired, undefined, registry).cfcReferenceToken)
      .toBe(ref.cfcReferenceToken);
    const child = getCell(runtime, {
      ...ref,
      path: ["public"],
      schema: { type: "string" },
    }, registry);
    const tx = runtime.edit();
    expect(child.withTx(tx).get()).toBe("visible");
    expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
    tx.abort();
  });

  for (const kind of ["piece root", "piece subpath", "document"] as const) {
    it(`retains a slug's private selection through a ${kind} and worker forwarding`, async () => {
      const piece = await seed("piece-get-private", { slot: "visible" });
      if (kind !== "document") {
        const metadata = runtime.edit();
        piece.withTx(metadata).setMetaRaw(
          "patternIdentity",
          { identity: "piece-get-private", symbol: "default" },
          rawMetaWriteAuthorization,
        );
        expect((await metadata.commit()).error).toBeUndefined();
      }
      const target = kind === "piece subpath" ? piece.key("slot") : piece;
      const slug = await seed(
        "piece-get-private-slug",
        target.getAsWriteRedirectLink(),
        [{
          path: [],
          origin: "link",
          referenceAcquisition: "complete",
          observes: "followRef",
          label: { confidentiality: [selection] },
        }],
      );
      const output = await seed("piece-get-private-output", null);
      const pieces = new PiecesController(
        await createSession({ identity: signer, spaceDid: space }),
        runtime,
        { deferSpaceCellSync: true },
      );
      const processor = buildProcessor({
        runtime,
        identity: signer,
        space,
        cc: pieces,
      });
      const response = await processor.handlePieceGet({
        type: RequestType.PieceGet,
        space,
        pieceId: entityRefToString(slug.entityId),
        runIt: false,
      });
      expect(response.piece.cell.cfcReferenceToken).toBeDefined();
      expect(response.piece.cell).toMatchObject({
        id: target.getAsNormalizedFullLink().id,
        path: target.getAsNormalizedFullLink().path,
      });
      const issuedOutput = processor.handleAcquireCell({
        type: RequestType.AcquireCell,
        address: wireCopy(output.getAsNormalizedFullLink()),
      });
      const result = await processor.applyCellSet({
        type: RequestType.CellSet,
        cell: wireCopy(issuedOutput.cell),
        value: wireCopy(response.piece.cell),
      });
      expect(result.error).toBeUndefined();
      const labels = readStoredCfcMetadata(
        runtime.readTx(),
        output.getAsNormalizedFullLink(),
      );
      expect(
        labels?.labelMap.entries.flatMap((entry) =>
          entry.observes === "followRef"
            ? entry.label.confidentiality ?? []
            : []
        ),
      ).toContainEqual(selection);
      expect(piece.key("slot").get()).toBe("visible");
    });
  }

  it("retains a piece subpath's scope restriction through its issued reference", async () => {
    const tx = runtime.edit();
    const secret = runtime.getCellFromLink(
      {
        space,
        id: "of:piece-get-session-target",
        path: [],
        scope: "session",
      },
      { type: "string" },
      tx,
    );
    secret.set("private session");
    expect((await tx.commit()).error).toBeUndefined();
    const piece = await seed("piece-get-scope", {
      slot: secret.withTx(undefined).getAsLink({ includeSchema: true }),
    }, [{
      path: ["slot"],
      origin: "link",
      referenceAcquisition: "complete",
      observes: "followRef",
      label: {},
    }]);
    const metadata = runtime.edit();
    piece.withTx(metadata).setMetaRaw(
      "patternIdentity",
      { identity: "piece-get-scope", symbol: "default" },
      rawMetaWriteAuthorization,
    );
    expect((await metadata.commit()).error).toBeUndefined();
    const capped = piece.key("slot").asSchema({
      type: "string",
      scope: "space",
    });
    const slug = await seed(
      "piece-get-scope-slug",
      capped.getAsWriteRedirectLink({ includeSchema: true }),
      [{
        path: [],
        origin: "link",
        referenceAcquisition: "complete",
        observes: "followRef",
        label: {},
      }],
    );
    const processor = buildProcessor({
      runtime,
      identity: signer,
      space,
      cc: { getSpace: () => space },
    });
    const response = await processor.handlePieceGet({
      type: RequestType.PieceGet,
      space,
      pieceId: entityRefToString(slug.entityId),
      runIt: false,
    });
    expect(response.piece.cell.cfcReferenceToken).toBeDefined();
    expect(
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: wireCopy(response.piece.cell),
      }).value,
    ).toBeUndefined();
    expect(secret.withTx(undefined).get()).toBe("private session");
  });

  it("retains selected identity when forwarding a sigil through the canonical converter", async () => {
    const acquired = await acquireSelected();
    for (const value of [acquired, acquired.getAsLink()]) {
      const exported = convertCellsToLinks({ result: value }, {
        includeSchema: true,
        transformLink: (cell, link) => registry.exportLink(link, cell),
      });
      const imported = mapCellRefsToSigilLinks(
        wireCopy(exported),
        registry,
      ) as { result: SigilLink };
      expect(linkRefPayload(imported.result)).not.toHaveProperty(
        "cfcReferenceToken",
      );
      expect(getCfcReferenceProvenance(imported.result)?.confidentiality)
        .toEqual([selection]);
      const tx = runtime.edit();
      runtime.getCellFromLink(imported.result, undefined, tx).getAsLink();
      expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
      tx.abort();
    }
  });

  it("preserves tokens through client hydration, schema projection, and key narrowing", async () => {
    const acquired = await acquireSelected();
    const ref = wireCopy(createCellRef(acquired, undefined, registry));
    const client = { [$conn]: () => ({}) } as unknown as RuntimeClient;
    const root = new CellHandle<{ public: string }>(client, ref);
    const child = root.key("public").asSchema({ type: "string" });
    const hydrated = CellHandle.deserialize(
      root,
      wireCopy(child.toSigilLink()),
    ) as CellHandle;
    const imported = mapCellRefsToSigilLinks(
      hydrated.toSigilLink(),
      registry,
    ) as SigilLink;
    expect(getCfcReferenceProvenance(imported)?.confidentiality).toEqual([
      selection,
    ]);
    expect(runtime.getCellFromLink(imported).get()).toBe("visible");
  });

  it("admits a forwarded acquisition and refuses the same link after token stripping", async () => {
    const acquired = await acquireSelected();
    const output = await seed("forward-output", {});
    const ref = wireCopy(createCellRef(acquired, undefined, registry));
    const forwarded = mapCellRefsToSigilLinks(ref, registry);
    const tx = runtime.edit();
    output.withTx(tx).set(forwarded);
    expect((await tx.commit()).error).toBeUndefined();
    const labels = readStoredCfcMetadata(
      runtime.readTx(),
      output.getAsNormalizedFullLink(),
    );
    expect(
      labels?.labelMap.entries.filter((entry) => entry.observes === "followRef")
        .flatMap((entry) => entry.label.confidentiality ?? []),
    )
      .toContainEqual(selection);

    const { cfcReferenceToken: _token, ...stripped } = ref;
    const rejectedOutput = await seed("stripped-output", {});
    const rejected = runtime.edit();
    rejectedOutput.withTx(rejected).set(
      mapCellRefsToSigilLinks(stripped, registry),
    );
    expect((await rejected.commit()).error?.message).toContain(
      "reference acquisition is unresolved",
    );
    expect(rejectedOutput.get()).toEqual({});
  });

  it("preserves a scope cap through client schema rewrites", async () => {
    const tx = runtime.edit();
    const session = runtime.getCell(
      space,
      "session-value",
      undefined,
      tx,
      "session",
    );
    session.set("private session");
    const link = runtime.getCell(space, "scope-holder", undefined, tx);
    link.set(session);
    expect((await tx.commit()).error).toBeUndefined();
    const capped = link.withTx(undefined).asSchema({
      type: "string",
      scope: "space",
    });
    const ref = wireCopy(createCellRef(capped, undefined, registry));
    expect(
      getCell(
        runtime,
        { ...ref, schema: { type: "string", scope: "session" } },
        registry,
      ).get(),
    ).toBeUndefined();
    expect(() =>
      mapCellRefsToSigilLinks({
        ...ref,
        schema: { type: "string", scope: "session" },
      }, registry)
    ).toThrow("scope cap cannot be widened for storage");
    const forwarded = mapCellRefsToSigilLinks(ref, registry) as SigilLink;
    expect(runtime.getCellFromLink(forwarded).get()).toBeUndefined();
    const output = await seed("scope-forward-output", {});
    const forward = runtime.edit();
    output.withTx(forward).set(forwarded);
    const result = await forward.commit();
    expect(result.error).toBeUndefined();
    expect(output.get()).toBeUndefined();
    const uncapped = link.withTx(undefined).asSchema({
      type: "string",
      scope: "session",
    });
    expect(uncapped.get()).toBe("private session");
  });

  it("retains explicit scope caps when acquiring a host address", async () => {
    const tx = runtime.edit();
    const session = runtime.getCell(
      space,
      "acquire-session",
      undefined,
      tx,
      "session",
    );
    session.set("private session");
    const holder = runtime.getCell(
      space,
      "acquire-capped-holder",
      undefined,
      tx,
    );
    holder.set(session);
    expect((await tx.commit()).error).toBeUndefined();
    const processor = buildProcessor({ runtime, identity: signer, space });
    const ref = processor.handleAcquireCell({
      type: RequestType.AcquireCell,
      address: {
        ...holder.getAsNormalizedFullLink(),
        schema: { type: "string", scope: "session" },
        scopeCaps: [{ depth: 0, scope: "space" }],
      },
    }).cell;
    expect(
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: wireCopy(ref),
      }).value,
    ).toBeUndefined();
  });

  it("roundtrips an acquired VDOM binding through a real event handler", async () => {
    const acquired = (await acquireSelected()).key("public");
    await seed("vdom-source", {
      type: "vnode",
      name: "cf-input",
      props: { $value: acquired.getAsLink() },
      children: [],
    }, [{
      path: ["props", "$value"],
      observes: "followRef",
      origin: "link",
      referenceAcquisition: "complete",
      label: { confidentiality: [selection] },
    }]);
    const output = await seed("event-output", {});
    const processor = buildProcessor({ runtime, identity: signer, space });
    const source = processor.handleGetCell({
      type: RequestType.GetCell,
      space,
      cause: "vdom-source",
    }).cell;
    const operations: VDomOp[] = [];
    const client: WorkerClient = {
      id: 0,
      post: (message) => {
        if ("type" in message && message.type === NotificationType.VDomBatch) {
          operations.push(...message.ops);
        }
        return true;
      },
    };
    processor.handleVDomMount({
      type: RequestType.VDomMount,
      mountId: 1,
      cell: source,
    }, client);
    const sourceMount = processor.accessForTestingOnly.vdomMounts.get(
      "0 1",
    )!;
    await runtime.idle();
    sourceMount.reconciler.flush();
    const binding = operations.find((op) => op.op === "set-binding");
    expect(binding).toBeDefined();
    if (!binding) throw new Error("VDOM did not emit its binding");
    expect(binding.cellRef.cfcReferenceToken).toBeDefined();
    expect(
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: binding.cellRef,
      }).value,
    ).toBe("visible");

    const clientRuntime = { [$conn]: () => ({}) } as unknown as RuntimeClient;
    const handle = new CellHandle(clientRuntime, wireCopy(binding.cellRef));
    const event = wireCopy({
      type: "drop",
      detail: { source: handle.toSigilLink() },
    });
    const eventOps: VDomOp[] = [];
    let commit: ReturnType<ReturnType<Runtime["edit"]>["commit"]> | undefined;
    const receiver = new WorkerReconciler({
      onError: (error) => {
        throw error;
      },
      onOps: (ops) => {
        eventOps.push(...ops);
      },
    });
    const cancel = receiver.mount({
      type: "vnode",
      name: "div",
      props: {
        ondrop: (value: unknown) => {
          const incoming = value as typeof event;
          expect(
            getCfcReferenceProvenance(incoming.detail.source)?.confidentiality,
          ).toEqual([selection]);
          const tx = runtime.edit();
          output.withTx(tx).set(incoming.detail.source);
          commit = tx.commit();
        },
      },
      children: [],
    });
    receiver.flush();
    processor.accessForTestingOnly.vdomMounts.set("0 2", {
      reconciler: receiver,
      cancel,
      client,
    });
    try {
      const handler = eventOps.find((op) => op.op === "set-event");
      expect(handler).toBeDefined();
      if (!handler) throw new Error("VDOM did not register its event handler");
      processor.handleVDomEvent({
        type: ClientNotificationType.VDomEvent,
        mountId: 2,
        handlerId: handler.handlerId,
        nodeId: handler.nodeId,
        event,
      }, client);
      expect(commit).toBeDefined();
      expect((await commit)?.error).toBeUndefined();
      const labels = readStoredCfcMetadata(
        runtime.readTx(),
        output.getAsNormalizedFullLink(),
      );
      expect(
        labels?.labelMap.entries.flatMap((entry) =>
          entry.label.confidentiality ?? []
        ),
      )
        .toContainEqual(selection);
    } finally {
      processor.handleVDomUnmount({
        type: RequestType.VDomUnmount,
        mountId: 1,
      }, client);
      processor.handleVDomUnmount({
        type: RequestType.VDomUnmount,
        mountId: 2,
      }, client);
    }
  });

  it("rejects forged, expired, foreign, widened, and rebound tokens", async () => {
    const cell = (await acquireSelected()).key("public");
    const ref = wireCopy(createCellRef(cell, undefined, registry));
    for (
      const changed of [
        { ...ref, cfcReferenceToken: crypto.randomUUID() },
        { ...ref, path: [] },
        { ...ref, path: ["other"] },
        { ...ref, id: "of:other" as CellRef["id"] },
        { ...ref, space: "did:key:other" as CellRef["space"] },
        { ...ref, scope: "session" as const },
        { ...ref, overwrite: "redirect" as const },
      ]
    ) {
      expect(() => getCell(runtime, changed, registry)).toThrow(
        "Reference acquisition token",
      );
    }
    const foreign = new ReferenceRegistry(runtime);
    expect(() => getCell(runtime, ref, foreign)).toThrow("missing or expired");
    registry.clear();
    expect(() => getCell(runtime, ref, registry)).toThrow("missing or expired");
  });

  it("does not recover stripped tokens from display labels or write imports", async () => {
    const acquired = await acquireSelected();
    const { cfcReferenceToken: _token, ...stripped } = wireCopy(
      createCellRef(acquired, undefined, registry),
    );
    expect(() => getCell(runtime, stripped, registry)).toThrow(
      "missing or expired",
    );
    const imported = mapCellRefsToSigilLinks(stripped, registry) as SigilLink;
    expect(getCfcReferenceProvenance(imported)).toBeUndefined();
    expect(linkRefPayload(imported)).not.toHaveProperty("cfcLabelView");
    const exported = registry.exportLink(imported);
    expect(linkRefPayload(exported)).not.toHaveProperty("cfcReferenceToken");
  });

  it("requires worker tokens for get, resolve, and set targets after host bootstrap", async () => {
    await seed("bootstrap", "value");
    const processor = buildProcessor({ runtime, identity: signer, space });
    const issued = processor.handleGetCell({
      type: RequestType.GetCell,
      space,
      cause: "bootstrap",
    }).cell;
    expect(
      processor.handleCellGet({ type: RequestType.CellGet, cell: issued })
        .value,
    ).toBe("value");
    const { cfcReferenceToken: _token, ...stripped } = wireCopy(issued);
    expect(() =>
      processor.handleCellGet({ type: RequestType.CellGet, cell: stripped })
    ).toThrow("missing or expired");
    expect(() =>
      processor.handleCellResolveAsCell({
        type: RequestType.CellResolveAsCell,
        cell: stripped,
      })
    ).toThrow("missing or expired");
    expect(() =>
      processor.applyCellSet({
        type: RequestType.CellSet,
        cell: stripped,
        value: "changed",
      })
    ).toThrow("missing or expired");
  });

  it("acquires an existing host address without admitting tokenless ordinary requests", async () => {
    const target = await seed("address-bootstrap", { public: "existing" });
    const address = wireCopy(target.key("public").getAsNormalizedFullLink());
    const processor = buildProcessor({ runtime, identity: signer, space });
    const issued = processor.handleAcquireCell({
      type: RequestType.AcquireCell,
      address,
    }).cell;
    expect(issued.id).toBe(address.id);
    expect(issued.path).toEqual(["public"]);
    expect(issued.cfcReferenceToken).toBeDefined();
    expect(
      processor.handleCellGet({ type: RequestType.CellGet, cell: issued })
        .value,
    ).toBe("existing");
    const { cfcReferenceToken: _token, ...stripped } = wireCopy(issued);
    expect(() =>
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: stripped,
      })
    ).toThrow("missing or expired");
    expect(() =>
      processor.handleCellResolveAsCell({
        type: RequestType.CellResolveAsCell,
        cell: stripped,
      })
    ).toThrow("missing or expired");
    expect(() =>
      processor.applyCellSet({
        type: RequestType.CellSet,
        cell: stripped,
        value: "changed",
      })
    ).toThrow("missing or expired");
  });

  it("reads child metadata while retaining selection and refusing parent widening", async () => {
    const selectedTarget = await acquireSelected();
    const argument = await seed("metadata-argument", {
      public: "argument value",
    });
    const setup = runtime.edit();
    selectedTarget.withTx(setup).setMetaRaw(
      "argument",
      argument.asSchema({
        type: "object",
        properties: { public: { type: "string" } },
        required: ["public"],
      }).getAsLink({ includeSchema: true }),
      rawMetaWriteAuthorization,
    );
    expect((await setup.commit()).error).toBeUndefined();
    const processor = buildProcessor({ runtime, identity: signer, space });
    const source = processor.handleAcquireCell({
      type: RequestType.AcquireCell,
      address: runtime.getCell(space, "selection").key("public")
        .getAsNormalizedFullLink(),
    }).cell;
    const child = processor.handleCellResolveAsCell({
      type: RequestType.CellResolveAsCell,
      cell: source,
    }).cell;
    expect(child.path).toEqual(["public"]);
    expect(() =>
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: { ...wireCopy(child), path: [] },
      })
    ).toThrow("does not match its binding");
    const response = processor.handleCellGet({
      type: RequestType.CellGet,
      cell: wireCopy(child),
      meta: "argument",
      includeRef: true,
    });
    expect(response.value).toBe("argument value");
    expect(response.cell?.path).toEqual(["public"]);
    expect(response.cell?.cfcReferenceToken).toBeDefined();
    const output = await seed("metadata-forward", {});
    const outputRef = processor.handleAcquireCell({
      type: RequestType.AcquireCell,
      address: output.getAsNormalizedFullLink(),
    }).cell;
    expect(
      (await processor.applyCellSet({
        type: RequestType.CellSet,
        cell: outputRef,
        value: wireCopy(response.cell!),
      })).error,
    ).toBeUndefined();
    const labels = readStoredCfcMetadata(
      runtime.readTx(),
      output.getAsNormalizedFullLink(),
    );
    expect(
      labels?.labelMap.entries.filter((entry) => entry.observes === "followRef")
        .flatMap((entry) => entry.label.confidentiality ?? []),
    )
      .toContainEqual(selection);
    expect(output.get()).toBe("argument value");
  });

  it("projects linked metadata through a delivered external schema", async () => {
    const piece = await seed("cold-metadata-piece", { uniqueChild: "piece" });
    const argument = await seed("cold-metadata-argument", {
      uniqueChild: "argument",
    });
    const { rootRef, documents } = decomposeSchema({
      type: "object",
      properties: { uniqueChild: { type: "string", minLength: 3 } },
      required: ["uniqueChild"],
    });
    expect(lookupSchemaDocument(rootRef.slice(4))).toBeUndefined();
    const setup = runtime.edit();
    for (const [hash, schema] of documents) {
      setup.writeOrThrow({
        space,
        id: `cid:${hash}` as URI,
        scope: "space",
        path: [],
      }, { value: schema as FabricValue });
    }
    piece.withTx(setup).setMetaRaw(
      "argument",
      createSigilLinkFromParsedLink({
        ...argument.getAsNormalizedFullLink(),
        schema: { $ref: rootRef },
      }, { includeSchema: true }),
      rawMetaWriteAuthorization,
    );
    expect((await setup.commit()).error).toBeUndefined();
    expect(lookupSchemaDocument(rootRef.slice(4))).toBeDefined();
    const processor = buildProcessor({ runtime, identity: signer, space });
    const child = processor.handleAcquireCell({
      type: RequestType.AcquireCell,
      address: piece.key("uniqueChild").getAsNormalizedFullLink(),
    }).cell;
    expect(
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: child,
        meta: "argument",
      }).value,
    ).toBe("argument");
  });

  it("retains acquired scope caps when reading linked metadata", async () => {
    const piece = await seed("capped-metadata-piece", { child: {} });
    const setup = runtime.edit();
    const session = runtime.getCell(
      space,
      "metadata-session",
      undefined,
      setup,
      "session",
    );
    session.set("private session");
    const argument = runtime.getCell(
      space,
      "capped-metadata-argument",
      undefined,
      setup,
    );
    argument.set({ nested: { child: session } });
    piece.withTx(setup).setMetaRaw(
      "argument",
      argument.key("nested").getAsLink(),
      rawMetaWriteAuthorization,
    );
    piece.withTx(setup).setMetaRaw(
      "result",
      argument.key("nested").asSchema({ scope: "space" }).getAsLink({
        includeSchema: true,
      }),
      rawMetaWriteAuthorization,
    );
    expect((await setup.commit()).error).toBeUndefined();
    const processor = buildProcessor({ runtime, identity: signer, space });
    const address = piece.key("child").getAsNormalizedFullLink();
    const capped = processor.handleAcquireCell({
      type: RequestType.AcquireCell,
      address: { ...address, schema: { type: "object", scope: "space" } },
    }).cell;
    const uncapped = processor.handleAcquireCell({
      type: RequestType.AcquireCell,
      address: { ...address, schema: { type: "object" } },
    }).cell;
    expect(
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: uncapped,
        meta: "argument",
      }).value,
    ).toBe("private session");
    expect(
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: uncapped,
        meta: "result",
      }).value,
    ).toBeUndefined();
    expect(
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: {
          ...wireCopy(capped),
          schema: { type: "object", scope: "session" },
        },
        meta: "argument",
      }).value,
    ).toBeUndefined();
  });

  it("returns importable references from an internal metadata manifest", async () => {
    const piece = await seed("manifest-piece", { public: "piece" });
    const internal = await seed("manifest-internal", true);
    const setup = runtime.edit();
    piece.withTx(setup).setMetaRaw("internal", [{
      partialCause: "showNewNotePrompt",
      link: internal.getAsLink(),
    }], rawMetaWriteAuthorization);
    expect((await setup.commit()).error).toBeUndefined();
    const processor = buildProcessor({ runtime, identity: signer, space });
    const issued = processor.handleAcquireCell({
      type: RequestType.AcquireCell,
      address: piece.getAsNormalizedFullLink(),
    }).cell;
    const response = processor.handleCellGet({
      type: RequestType.CellGet,
      cell: wireCopy(issued),
      meta: "internal",
    });
    const client = {
      [$conn]: () => ({
        request: (
          request: { type: RequestType.CellGet; cell: CellRef },
        ) => Promise.resolve(processor.handleCellGet(request)),
      }),
    } as unknown as RuntimeClient;
    const manifest = CellHandle.deserialize(
      new CellHandle(client, issued),
      wireCopy(response.value),
    ) as Array<{ partialCause: string; link: CellHandle<boolean> }>;
    expect(manifest).toHaveLength(1);
    expect(manifest[0].partialCause).toBe("showNewNotePrompt");
    expect(manifest[0].link.ref().cfcReferenceToken).toBeDefined();
    expect(await manifest[0].link.sync()).toBe(true);
    const { cfcReferenceToken: _token, ...stripped } = manifest[0].link.ref();
    expect(() =>
      processor.handleCellGet({
        type: RequestType.CellGet,
        cell: stripped,
      })
    ).toThrow("missing or expired");
  });

  it("retains acquired scope caps on references returned in metadata manifests", async () => {
    const piece = await seed("capped-manifest-piece", {});
    const setup = runtime.edit();
    const session = runtime.getCell(
      space,
      "manifest-session",
      undefined,
      setup,
      "session",
    );
    session.set("private session");
    const internal = runtime.getCell(
      space,
      "capped-manifest-internal",
      undefined,
      setup,
    );
    internal.set(session);
    piece.withTx(setup).setMetaRaw("internal", [{
      partialCause: "session-state",
      link: internal.getAsLink(),
    }], rawMetaWriteAuthorization);
    expect((await setup.commit()).error).toBeUndefined();
    const processor = buildProcessor({ runtime, identity: signer, space });
    const client = {
      [$conn]: () => ({
        request: (
          request: { type: RequestType.CellGet; cell: CellRef },
        ) => Promise.resolve(processor.handleCellGet(request)),
      }),
    } as unknown as RuntimeClient;
    for (const scope of [undefined, "space"] as const) {
      const issued = processor.handleAcquireCell({
        type: RequestType.AcquireCell,
        address: {
          ...piece.getAsNormalizedFullLink(),
          schema: { type: "object", ...(scope !== undefined && { scope }) },
        },
      }).cell;
      const response = processor.handleCellGet({
        type: RequestType.CellGet,
        cell: {
          ...wireCopy(issued),
          schema: { type: "object", scope: "session" },
        },
        meta: "internal",
      });
      const manifest = CellHandle.deserialize(
        new CellHandle(client, issued),
        wireCopy(response.value),
      ) as Array<{ partialCause: string; link: CellHandle<string> }>;
      expect(manifest[0].link.ref().cfcReferenceToken).toBeDefined();
      const projected = manifest[0].link.asSchema({
        type: "string",
        scope: "session",
      });
      expect(await projected.sync()).toBe(
        scope === undefined ? "private session" : undefined,
      );
    }
  });
});
