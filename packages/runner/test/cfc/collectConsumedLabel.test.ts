import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/api";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";

import { collectConsumedLabel } from "../../src/cfc/prepare.ts";
import { describeRefusalInputs } from "../../src/cfc/refusal-detail.ts";
import type {
  CfcAddress,
  CfcExternalContentObservation,
  CfcLabelMetadataObservation,
} from "../../src/cfc/types.ts";
import type {
  IExtendedStorageTransaction,
  IReadActivity,
} from "../../src/storage/interface.ts";

const address = {
  space: "did:key:source",
  id: "of:source" as const,
  scope: "space",
  path: ["field"],
} satisfies CfcAddress;

/** Supplies the collector's read surfaces without preprocessing their identity. */
function transaction(
  observations: readonly CfcLabelMetadataObservation[] = [],
  reads: readonly IReadActivity[] = [],
  entries: FabricValue = [],
  externalContentObservations: readonly CfcExternalContentObservation[] = [],
): IExtendedStorageTransaction {
  const state = {
    triggerReadGating: false,
    labelMetadataObservations: [...observations],
    externalContentObservations: [...externalContentObservations],
  } satisfies Partial<ReturnType<IExtendedStorageTransaction["getCfcState"]>>;
  const surfaces: Partial<IExtendedStorageTransaction> = {
    getCfcState: () =>
      state as ReturnType<IExtendedStorageTransaction["getCfcState"]>,
    getReadActivities: () => reads,
    readOrThrow: () => ({
      version: 1,
      schemaHash: "test-schema",
      labelMap: { version: 1, entries },
    }),
  };
  return surfaces as IExtendedStorageTransaction;
}

/** One metadata observation contributing the supplied clauses at an address. */
function observation(
  target: CfcAddress,
  confidentiality: CfcLabelMetadataObservation["confidentiality"],
): CfcLabelMetadataObservation {
  return { target, observes: "labelMetadata", confidentiality };
}

describe("collectConsumedLabel()", () => {
  it("attributes external module-policy evidence to its source read space", () => {
    const modulePolicy = {
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module" as const,
      moduleIdentity: "module:test",
      symbol: "canPublish",
      policyDigest: "sha256:test",
    };
    const observed = {
      source: { ...address, space: "did:key:observation" },
      flow: { confidentiality: [], integrity: [] },
      consumed: {
        confidentiality: [modulePolicy],
        integrity: [{ type: "verified" }],
      },
      labeledSpaces: [address.space],
      sources: [{ atom: modulePolicy, read: address, labelPath: [] }],
    } satisfies CfcExternalContentObservation;

    const result = collectConsumedLabel(transaction([], [], [], [observed]));

    expect(result.confidentiality).toEqual([modulePolicy]);
    expect(result.integrity).toEqual([{ type: "verified" }]);
    expect([...result.modulePolicySpaces.values()]).toEqual([
      new Set([address.space]),
    ]);
    expect(result.sources).toEqual(observed.sources);
  });

  it("keeps distinct atoms at one source while collapsing structural duplicates", () => {
    const atoms = Array.from({ length: 40 }, (_, index) => ({
      type: "secret",
      index,
    }));
    const clones = atoms.map(({ type, index }) => ({ index, type }));
    const result = collectConsumedLabel(transaction([
      observation(address, [...atoms, ...clones]),
    ]));
    expect(result.sources.map((source) => source.atom)).toEqual(atoms);
    expect(result.sources.every((source) => source.read === address)).toBe(
      true,
    );
  });

  it("keeps structurally distinct clauses and their first source in encounter order", () => {
    const first = { a: 1, b: 2 };
    const second = { a: 2, b: 1 };
    const sources = collectConsumedLabel(transaction([
      observation(address, [first, second, { b: 2, a: 1 }, -0, 0, -0]),
      observation({ ...address }, [{ b: 1, a: 2 }]),
    ])).sources;

    expect(sources).toHaveLength(4);
    expect(sources[0].atom).toBe(first);
    expect(sources[1].atom).toBe(second);
    expect(sources[2].atom).toBe(-0);
    expect(sources[3].atom).toBe(0);
    expect(sources[0].read).toBe(address);
  });

  it("distinguishes every address field and preserves escaped path segments", () => {
    const addresses: CfcAddress[] = [
      address,
      { ...address, id: "of:other" },
      { ...address, space: "did:key:other" },
      { ...address, scope: "user" },
      { ...address, id: "of:source\0did:key:extra" },
      { ...address, space: "did:key:extra\0did:key:source" },
      ...[[], [""], ["a/b"], ["a", "b"], ["~1"], ["/"]].map((path) => ({
        ...address,
        path,
      })),
      { ...address, path: ["a\0/b"], id: "of:source\0extra" },
      { ...address, path: ["extra\0/a\0/b"] },
    ];
    const sources = collectConsumedLabel(transaction(
      [...addresses, ...addresses].map((target) =>
        observation(target, ["private"])
      ),
    )).sources;

    expect(sources.map((source) => source.read)).toEqual(addresses);
    const detail = describeRefusalInputs(["private"], sources);
    expect(detail.attribution).toBe("complete");
    expect(detail.inputs.map((input) => input.read)).toEqual(addresses);
  });

  it("preserves encounter order when clauses from different addresses interleave", () => {
    const other = { ...address, id: "of:other" };
    const sources = collectConsumedLabel(transaction([
      observation(address, ["first"]),
      observation(other, ["first"]),
      observation(address, ["second"]),
      observation(other, ["first"]),
      observation(address, ["second", "first"]),
    ])).sources;

    expect(sources).toEqual([
      { atom: "first", read: address, labelPath: address.path },
      { atom: "first", read: other, labelPath: other.path },
      { atom: "second", read: address, labelPath: address.path },
    ]);
  });

  it("deduplicates canonical path aliases while retaining the first address", () => {
    const first = { ...address, path: ["value", "field"] };
    const sources = collectConsumedLabel(transaction([
      observation(first, ["private"]),
      observation(address, ["private"]),
    ])).sources;

    expect(sources).toHaveLength(1);
    expect(sources[0].read).toBe(first);
  });

  it("keeps distinct label paths for one read and joins payload and metadata sources", () => {
    const read: IReadActivity = {
      ...address,
      id: "of:source",
      path: ["value", "field"],
      meta: {},
    };
    const result = collectConsumedLabel(transaction(
      [
        observation(address, ["private"]),
      ],
      [read, read],
      [
        {
          path: [],
          label: { confidentiality: ["private"], integrity: ["guard"] },
        },
        { path: ["field"], label: { confidentiality: ["private"] } },
        { path: ["value", "field"], label: { confidentiality: ["private"] } },
      ],
    ));

    expect(result.sources).toEqual([
      { atom: "private", read: address, labelPath: [] },
      { atom: "private", read: address, labelPath: ["field"] },
    ]);
    expect(result.confidentiality).toEqual(["private"]);
    expect(result.integrity).toEqual(["guard"]);
    expect(result.modulePolicySpaces.size).toBe(0);
  });

  it("starts a fresh source set for each collection", () => {
    const tx = transaction([observation(address, ["private"])]);
    const first = collectConsumedLabel(tx);
    const second = collectConsumedLabel(tx);

    expect(first.sources).toHaveLength(1);
    expect(second.sources).toEqual(first.sources);
    expect(second.sources).not.toBe(first.sources);
    expect(collectConsumedLabel(transaction()).sources).toEqual([]);
  });

  it("keeps structure and recursive-read rules when selecting label paths", () => {
    const entries = [
      { path: ["field", "child"], label: { confidentiality: ["child"] } },
      { path: [], origin: "structure", label: { confidentiality: ["shape"] } },
      { path: [], label: { confidentiality: ["root"] } },
      { path: ["other"], label: { confidentiality: ["other"] } },
      {
        path: ["field"],
        origin: "structure",
        label: { confidentiality: ["own"] },
      },
      {
        path: ["*"],
        origin: "structure",
        label: { confidentiality: ["template"] },
      },
    ];
    const read: IReadActivity = {
      ...address,
      path: ["value", "field"],
      meta: {},
    };
    const collect = (nonRecursive: boolean) =>
      collectConsumedLabel(
        transaction([], [{ ...read, nonRecursive }], entries),
      );

    expect(collect(false).sources.map((source) => source.atom)).toEqual([
      "child",
      "root",
      "own",
      "template",
    ]);
    expect(collect(true).sources.map((source) => source.atom)).toEqual([
      "root",
      "own",
      "template",
    ]);
  });

  it("refreshes metadata between collections and separates document scopes and media types", () => {
    const reads: IReadActivity[] = [
      { ...address, path: ["value", "field"], meta: {} },
      { ...address, path: ["value", "other"], meta: {} },
      { ...address, scope: "user", path: ["value", "field"], meta: {} },
      { ...address, type: "text/plain", path: ["value", "field"], meta: {} },
      { ...address, id: "of:other", path: ["value", "field"], meta: {} },
      {
        ...address,
        space: "did:key:other",
        path: ["value", "field"],
        meta: {},
      },
    ];
    let generation = 1;
    const tx = transaction([], reads);
    tx.readOrThrow = (read) => ({
      version: 1,
      schemaHash: "test-schema",
      labelMap: {
        version: 1,
        entries: [{
          path: [],
          label: {
            confidentiality: [
              JSON.stringify([
                generation,
                read.space,
                read.id,
                read.scope,
                read.type,
              ]),
            ],
          },
        }],
      },
    });
    const expected = () =>
      reads.map((read) =>
        JSON.stringify([
          generation,
          read.space,
          read.id,
          read.scope,
          read.type ?? "application/json",
        ])
      );

    expect(collectConsumedLabel(tx).sources.map((source) => source.atom))
      .toEqual(expected());
    generation++;
    expect(collectConsumedLabel(tx).sources.map((source) => source.atom))
      .toEqual(expected());
  });

  it("rejects malformed metadata even when its entry is outside the consumed path", () => {
    const read: IReadActivity = {
      ...address,
      path: ["value", "field"],
      meta: {},
    };
    const tx = transaction([], [read], [
      { path: ["field"], label: { confidentiality: ["private"] } },
      { path: ["other"], label: { confidentiality: "invalid" } },
    ]);
    expect(() => collectConsumedLabel(tx)).toThrow();
  });
});
