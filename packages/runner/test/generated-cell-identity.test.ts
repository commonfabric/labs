import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { assertNoReservedCauseKeys } from "../src/builder/pattern.ts";
import {
  brandTrustedPattern,
  generatedInternalCellCause,
  noteDerivedCopy,
  parseGeneratedCellIdentity,
  prepareGeneratedCellIdentity,
  setArtifactEntryRef,
} from "../src/builder/pattern-metadata.ts";
import { withAliasBindings } from "../src/builder/to-encodable-form.ts";
import { isPattern, type Pattern } from "../src/builder/types.ts";

/** A factory-shaped artifact whose serializer closes over its original graph. */
function artifact() {
  const graph: Pattern = {
    argumentSchema: {},
    resultSchema: {},
    result: {},
    nodes: [],
    derivedInternalCells: [
      { partialCause: { $generated: 0 } },
      { partialCause: "intentional-name" },
    ],
  };
  return brandTrustedPattern({ ...graph, toEncodableForm: () => graph });
}

/** Read the effective cause of the anonymous descriptor. */
function cause(pattern: Pattern) {
  return generatedInternalCellCause(pattern.derivedInternalCells![0]);
}

describe("generated-cell-identity", () => {
  it("refuses unsupported formats and durable keyless selections", () => {
    for (
      const value of [null, {}, {
        version: 2,
        identity: "real",
        symbol: "default",
      }, { version: 1, identity: "keyless:session", symbol: "default" }]
    ) {
      expect(() => parseGeneratedCellIdentity(value)).toThrow(
        "Unsupported generated cell identity metadata",
      );
    }
    expect(parseGeneratedCellIdentity(undefined)).toBeUndefined();
  });

  it("isolates prepared instances, serializer copies, and explicit legacy selection", () => {
    const root = artifact();
    const selection = {
      version: 1 as const,
      identity: "artifact-a",
      symbol: "default",
    };
    const a = prepareGeneratedCellIdentity(root, selection);
    const b = prepareGeneratedCellIdentity(root, {
      ...selection,
      identity: "artifact-b",
    });
    const legacy = prepareGeneratedCellIdentity(a, null);
    const serialized = withAliasBindings(a);
    expect(isPattern(serialized)).toBe(true);
    if (!isPattern(serialized)) {
      throw new Error("Expected a serialized pattern");
    }
    const copy = {
      ...serialized,
      derivedInternalCells: serialized.derivedInternalCells!.map((d) => ({
        ...d,
      })),
    };
    noteDerivedCopy(copy, serialized);
    expect(cause(copy)).toEqual(cause(a));
    expect(cause(b)).not.toEqual(cause(a));
    expect(cause(root)).toEqual({ $generated: 0 });
    expect(cause(legacy)).toEqual(cause(root));
    expect(generatedInternalCellCause(a.derivedInternalCells![1])).toBe(
      "intentional-name",
    );
    const before = cause(a);
    selection.identity = "keyless:later-mutation";
    expect(cause(a)).toEqual(before);
    expect(cause(copy)).toEqual(before);
    expect(cause(a)).toMatchObject({ $generated: 0 });
    expect(() => assertNoReservedCauseKeys(cause(a))).toThrow();
  });

  it("keeps a prepared keyless instance stable after real artifact promotion", () => {
    const root = artifact();
    setArtifactEntryRef(root, {
      identity: "keyless:session",
      symbol: "default",
    });
    const session = prepareGeneratedCellIdentity(root, null);
    const real = { identity: "loadable-artifact", symbol: "default" };
    setArtifactEntryRef(root, real);
    const promoted = prepareGeneratedCellIdentity(root, {
      version: 1,
      ...real,
    });
    expect(cause(session)).toEqual({ $generated: 0 });
    expect(cause(promoted)).not.toEqual(cause(session));
    expect(() =>
      prepareGeneratedCellIdentity(root, {
        version: 1,
        identity: "keyless:invalid",
        symbol: "default",
      })
    ).toThrow("loadable artifact");
    expect(() =>
      prepareGeneratedCellIdentity({ ...root }, { version: 1, ...real })
    ).toThrow("trusted");
  });
});
