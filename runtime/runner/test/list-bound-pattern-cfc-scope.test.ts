import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  createFactoryShell,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";

import { type Cell, createCell } from "../src/cell.ts";
import { createNodeFactory } from "../src/builder/module.ts";
import { setDurableArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import { withPatternParamsSchema } from "../src/builder/pattern.ts";
import type {
  BuilderFunctionsAndConstants,
  FabricValue,
  JSONSchema,
  PatternFactory,
} from "../src/builder/types.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "bound list factory CFC and scope test",
);
const space = signer.did();

const LIST_ARGUMENT_SCHEMA = {
  type: "object",
  properties: {
    element: { type: "number" },
    index: { type: "number" },
    array: { type: "array", items: { type: "number" } },
  },
  required: ["element", "index", "array"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const PARAMS_SCHEMA = {
  type: "object",
  properties: { captured: { type: "number" } },
  required: ["captured"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const NUMBER_SCHEMA = { type: "number" } as const satisfies JSONSchema;
const BOOLEAN_SCHEMA = { type: "boolean" } as const satisfies JSONSchema;
const NUMBER_ARRAY_SCHEMA = {
  type: "array",
  items: NUMBER_SCHEMA,
} as const satisfies JSONSchema;

const REFS = {
  map: {
    identity: "MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "scopedMap",
  },
  filter: {
    identity: "FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "scopedFilter",
  },
  flatMap: {
    identity: "XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "scopedFlatMap",
  },
} as const;

type Kind = keyof typeof REFS;
type CurryView<T, R> = PatternFactory<T, R> & {
  curry(params: unknown): PatternFactory<T, R>;
};
type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[] };
  origin?: string;
};

function curry<T, R>(
  factory: PatternFactory<T, R>,
  params: unknown,
): PatternFactory<T, R> {
  return (factory as CurryView<T, R>).curry(params);
}

describe("bound list factory CFC and scope", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let commonfabric: BuilderFunctionsAndConstants;
  let tx: IExtendedStorageTransaction;
  let artifacts: Map<string, PatternFactory<any, any>>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
    });
    commonfabric = createTrustedBuilder(runtime).commonfabric;
    tx = runtime.edit();
    artifacts = new Map();
    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) =>
      artifacts.get(`${identity}#${symbol}`);
    runtime.patternManager.isArtifactAvailableInSpace = (identity, source) =>
      source === space &&
      [...artifacts.keys()].some((key) => key.startsWith(`${identity}#`));
  });

  afterEach(async () => {
    if (tx.status().status === "ready") {
      tx.abort(new Error("test cleanup"));
    }
    await runtime.dispose();
    await storageManager.close();
  });

  async function commitAndRenew(): Promise<void> {
    if (tx.status().status === "ready") {
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    tx = runtime.edit();
  }

  function install(
    kind: Kind,
    base: PatternFactory<any, any>,
  ): void {
    const ref = REFS[kind];
    setDurableArtifactEntryRef(base, ref);
    artifacts.set(`${ref.identity}#${ref.symbol}`, base);
  }

  async function labeledScopedCapture(): Promise<Cell<number>> {
    const base = runtime.getCell<number>(
      space,
      "bound-list-scoped-capture",
      NUMBER_SCHEMA,
      tx,
    );
    const capture = createCell<number>(
      runtime,
      { ...base.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    const link = capture.getAsNormalizedFullLink();
    writeSeedEnvelopeDoc(tx, link.space);
    tx.writeOrThrow({
      space: link.space,
      scope: link.scope,
      id: link.id,
      type: "application/json",
      path: [],
    }, {
      value: 2,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: ["captured-list-secret"] },
          }],
        },
      },
    });
    await commitAndRenew();
    return createCell(runtime, link, tx);
  }

  async function labeledSelector(
    kind: Kind,
    value: FabricValue,
  ): Promise<Cell<unknown>> {
    const selector = runtime.getCell<unknown>(
      space,
      `bound-list-${kind}-selector`,
      undefined,
      tx,
    );
    const link = selector.getAsNormalizedFullLink();
    writeSeedEnvelopeDoc(tx, link.space);
    tx.writeOrThrow({
      space: link.space,
      scope: link.scope,
      id: link.id,
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
            label: { confidentiality: [`${kind}-factory-secret`] },
          }],
        },
      },
    });
    await commitAndRenew();
    return runtime.getCellFromLink(link);
  }

  function entriesOf(link: NormalizedFullLink): StoredEntry[] {
    const replica = storageManager.open(link.space).replica as unknown as {
      getDocument(
        id: string,
        scope?: "space" | "user" | "session",
      ): { cfc?: { labelMap?: { entries: StoredEntry[] } } } | undefined;
    };
    return replica.getDocument(link.id, link.scope)?.cfc?.labelMap?.entries ??
      [];
  }

  function confidentiality(
    link: NormalizedFullLink,
    origin: "derived" | "structure",
  ): string[] {
    return entriesOf(link)
      .filter((entry) => entry.origin === origin && entry.path.length === 0)
      .flatMap((entry) => entry.label.confidentiality ?? []);
  }

  function aggregateConfidentiality(link: NormalizedFullLink): string[] {
    return entriesOf(link)
      .filter((entry) =>
        (entry.origin === "derived" || entry.origin === "structure") &&
        entry.path.length === 0
      )
      .flatMap((entry) => entry.label.confidentiality ?? []);
  }

  function resultLink(
    result: Cell<Record<string, unknown>>,
    key: string,
  ): NormalizedFullLink {
    const raw = result.key(key).getRaw({ lastNode: "writeRedirect" });
    const link = parseLink(raw, result);
    if (!link) throw new Error(`missing ${key} result link`);
    return link;
  }

  function mapRowLink(mappedLink: NormalizedFullLink): NormalizedFullLink {
    const mapped = runtime.getCellFromLink(mappedLink);
    const raw = mapped.getRaw({ lastNode: "value" });
    const link = Array.isArray(raw) ? parseLink(raw[0], mapped) : undefined;
    if (!link) throw new Error("missing mapped row link");
    return link;
  }

  it("keeps map labels pointwise while narrowing filter/flatMap structure", async () => {
    const captured = await labeledScopedCapture();
    const calculate = commonfabric.lift(
      ({ element, captured }: { element: number; captured: number }) =>
        element + captured,
    );
    const predicate = commonfabric.lift(
      ({ element, captured }: { element: number; captured: number }) =>
        element > captured,
    );
    const expand = commonfabric.lift(
      ({ element, captured }: { element: number; captured: number }) =>
        element > captured ? [element] : [],
    );

    const mapBase = commonfabric.pattern(
      withPatternParamsSchema(
        ((argument: any, params: any) =>
          calculate({
            element: argument.element,
            captured: params.captured,
          })) as any,
        PARAMS_SCHEMA,
      ) as any,
      LIST_ARGUMENT_SCHEMA,
      NUMBER_SCHEMA,
    );
    const filterBase = commonfabric.pattern(
      withPatternParamsSchema(
        ((argument: any, params: any) =>
          predicate({
            element: argument.element,
            captured: params.captured,
          })) as any,
        PARAMS_SCHEMA,
      ) as any,
      LIST_ARGUMENT_SCHEMA,
      BOOLEAN_SCHEMA,
    );
    const flatMapBase = commonfabric.pattern(
      withPatternParamsSchema(
        ((argument: any, params: any) =>
          expand({
            element: argument.element,
            captured: params.captured,
          })) as any,
        PARAMS_SCHEMA,
      ) as any,
      LIST_ARGUMENT_SCHEMA,
      NUMBER_ARRAY_SCHEMA,
    );
    install("map", mapBase);
    install("filter", filterBase);
    install("flatMap", flatMapBase);
    const capturedLink = captured.getAsLink({ includeSchema: true });

    const mapSelector = await labeledSelector(
      "map",
      createFactoryShell(
        sealFactoryState(curry(mapBase, { captured: capturedLink })),
      ),
    );
    const filterSelector = await labeledSelector(
      "filter",
      createFactoryShell(
        sealFactoryState(curry(filterBase, { captured: capturedLink })),
      ),
    );
    const flatMapSelector = await labeledSelector(
      "flatMap",
      createFactoryShell(
        sealFactoryState(curry(flatMapBase, { captured: capturedLink })),
      ),
    );

    const mapNode = createNodeFactory({ type: "ref", implementation: "map" });
    const filterNode = createNodeFactory({
      type: "ref",
      implementation: "filter",
    });
    const flatMapNode = createNodeFactory({
      type: "ref",
      implementation: "flatMap",
    });
    const outer = commonfabric.pattern(
      (({ values, mapOp, filterOp, flatMapOp }: any) => ({
        mapped: mapNode({ list: values, op: mapOp }),
        filtered: filterNode({ list: values, op: filterOp }),
        flattened: flatMapNode({ list: values, op: flatMapOp }),
      })) as any,
      {
        type: "object",
        properties: {
          values: { type: "array", items: NUMBER_SCHEMA },
          mapOp: true,
          filterOp: true,
          flatMapOp: true,
        },
        required: ["values", "mapOp", "filterOp", "flatMapOp"],
        additionalProperties: false,
      },
    );
    expect(
      outer.nodes.every((node) =>
        !Object.hasOwn(node.inputs as object, "params")
      ),
    ).toBe(true);

    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      "bound-list-cfc-scope-result",
      outer.resultSchema,
      tx,
    );
    const result = runtime.run(tx, outer, {
      values: [1, 3],
      mapOp: mapSelector,
      filterOp: filterSelector,
      flatMapOp: flatMapSelector,
    }, resultCell);
    await commitAndRenew();

    expect(await result.pull()).toEqual({
      mapped: [3, 5],
      filtered: [3],
      flattened: [3],
    });
    await runtime.idle();
    await runtime.storageManager.synced();

    const mappedLink = resultLink(result, "mapped");
    const mappedRow = mapRowLink(mappedLink);
    const filteredLink = resultLink(result, "filtered");
    const flattenedLink = resultLink(result, "flattened");

    expect(mappedLink.scope).toBe("space");
    expect(mappedRow.scope).toBe("user");
    expect(filteredLink.scope).toBe("user");
    expect(flattenedLink.scope).toBe("user");

    expect(confidentiality(mappedRow, "derived")).toEqual(
      expect.arrayContaining([
        "captured-list-secret",
        "map-factory-secret",
      ]),
    );
    expect(aggregateConfidentiality(mappedLink)).not.toContain(
      "captured-list-secret",
    );
    expect(aggregateConfidentiality(mappedLink)).not.toContain(
      "map-factory-secret",
    );
    expect(confidentiality(filteredLink, "structure")).toEqual(
      expect.arrayContaining([
        "captured-list-secret",
        "filter-factory-secret",
      ]),
    );
    expect(confidentiality(flattenedLink, "structure")).toEqual(
      expect.arrayContaining([
        "captured-list-secret",
        "flatMap-factory-secret",
      ]),
    );

    const mapSelectorLink = mapSelector.getAsNormalizedFullLink();
    writeSeedEnvelopeDoc(tx, mapSelectorLink.space);
    tx.writeOrThrow({
      space: mapSelectorLink.space,
      scope: mapSelectorLink.scope,
      id: mapSelectorLink.id,
      type: "application/json",
      path: [],
    }, {
      value: mapSelector.getRaw() as FabricValue,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: ["map-factory-secret-updated"] },
          }],
        },
      },
    });
    await commitAndRenew();

    // A provenance-only selector write cannot relabel a byte-identical numeric
    // result because that storage write is intentionally a no-op. Change a
    // regular input next; the stable row's next real execution must reread the
    // selector and carry its current label without replacing the row identity.
    captured.withTx(tx).set(4);
    await commitAndRenew();

    expect(await result.pull()).toEqual({
      mapped: [5, 7],
      filtered: [],
      flattened: [],
    });
    await runtime.idle();
    await runtime.storageManager.synced();
    expect(mapRowLink(mappedLink)).toEqual(mappedRow);
    expect(confidentiality(mappedRow, "derived")).toEqual(
      expect.arrayContaining([
        "captured-list-secret",
        "map-factory-secret-updated",
      ]),
    );
  });
});
