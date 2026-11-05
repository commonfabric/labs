/**
 * Reactivity over `FabricPrimitive` arguments, observed through a compiled
 * pattern rather than through a cell.
 *
 * The distinction is load-bearing, and is why this file exists alongside
 * `fabric-primitive-cell-update.test.ts`. A schemaless cell read with `sink()`
 * takes a different route through change detection than a pattern argument
 * declared with its real type: the former is compared as a whole value, the
 * latter as a shape. Only the pattern route reaches the shape comparison, so
 * only tests written this way can observe whether it re-fires.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  FabricBytes,
  FabricDurationDay,
  FabricDurationNsec,
  FabricEpochDay,
  FabricEpochNsec,
  FabricHash,
} from "@commonfabric/data-model/fabric-primitives";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase(
  "fabric primitive pattern reactivity",
);
const space = signer.did();

/**
 * Builds a single-argument pattern whose result recomputes from `args.v`.
 *
 * The argument's *declared type* is the part that matters: an argument typed
 * as a `Fabric` class is read shape-only, while an untyped one is not.
 *
 * @param declaredType - Type to declare the changing argument as.
 * @param read - Expression producing a distinguishing scalar from `args.v`.
 */
function patternProgram(declaredType: string, read: string): RuntimeProgram {
  const needsTypeImport = declaredType.startsWith("Fabric");
  const imports = needsTypeImport
    ? `import { computed, pattern, type ${declaredType} } from 'commonfabric';`
    : "import { computed, pattern } from 'commonfabric';";

  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        imports,
        `interface Args { v: ${declaredType}; }`,
        "export default pattern<Args>((args) => {",
        `  const seen = computed(() => ${read});`,
        "  return { seen };",
        "});",
      ].join("\n"),
    }],
  };
}

/**
 * Runs a pattern twice against the same result cell, with a different argument
 * value each time, and reports what the `computed` observed on each run.
 */
async function observeAcrossUpdate(
  caseName: string,
  declaredType: string,
  read: string,
  first: unknown,
  second: unknown,
): Promise<[string | undefined, string | undefined]> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  let tx = runtime.edit();

  try {
    const compiled = await runtime.patternManager.compilePattern(
      patternProgram(declaredType, read),
    );
    const resultCell = runtime.getCell<{ seen: string }>(
      space,
      `fabric-primitive-reactivity-${caseName}`,
      compiled.resultSchema,
      tx,
    );

    const observe = async (value: unknown) => {
      const result = runtime.run(
        tx,
        compiled,
        { v: value } as never,
        resultCell,
      );
      runtime.prepareTxForCommit(tx);
      await tx.commit().settled;
      tx = runtime.edit();

      const cancel = result.sink(() => {});
      await runtime.settled();
      await runtime.idle();
      const seen = result.get()?.seen;
      cancel();
      return seen;
    };

    return [await observe(first), await observe(second)];
  } finally {
    await tx.commit().settled.catch(() => {});
    await runtime.dispose();
    await storageManager.close();
  }
}

const primitiveCases = [
  {
    name: "FabricBytes",
    read: "String(args.v?.length ?? -1)",
    first: new FabricBytes(new Uint8Array(4)),
    second: new FabricBytes(new Uint8Array(7)),
    firstSeen: "4",
    secondSeen: "7",
  },
  {
    name: "FabricEpochNsec",
    read: "String(args.v?.value ?? -1n)",
    first: new FabricEpochNsec(1000n),
    second: new FabricEpochNsec(2000n),
    firstSeen: "1000",
    secondSeen: "2000",
  },
  {
    name: "FabricEpochDay",
    read: "String(args.v?.value ?? -1n)",
    first: new FabricEpochDay(10n),
    second: new FabricEpochDay(20n),
    firstSeen: "10",
    secondSeen: "20",
  },
  {
    name: "FabricDurationNsec",
    read: "String(args.v?.value ?? -1n)",
    first: new FabricDurationNsec(9_007_199_254_740_993n),
    second: new FabricDurationNsec(-5n),
    firstSeen: "9007199254740993",
    secondSeen: "-5",
  },
  {
    name: "FabricDurationDay",
    read: "String(args.v?.value ?? -1n)",
    first: new FabricDurationDay(9_007_199_254_740_993n),
    second: new FabricDurationDay(-7n),
    firstSeen: "9007199254740993",
    secondSeen: "-7",
  },
  {
    name: "FabricHash",
    read: "String(args.v?.length ?? -1)",
    first: new FabricHash(new Uint8Array(4), "fid1"),
    second: new FabricHash(new Uint8Array(8), "fid1"),
    firstSeen: "4",
    secondSeen: "8",
  },
];

describe("pattern reactivity over a changing argument", () => {
  for (const testCase of primitiveCases) {
    it(`re-runs a computed over a changed \`${testCase.name}\``, async () => {
      const [firstSeen, secondSeen] = await observeAcrossUpdate(
        testCase.name,
        testCase.name,
        testCase.read,
        testCase.first,
        testCase.second,
      );

      // The first read is asserted too, so that a read which cannot tell the
      // two values apart fails here rather than silently reporting "no change"
      // and looking like the defect this file covers.
      expect(firstSeen).toBe(testCase.firstSeen);
      expect(secondSeen).toBe(testCase.secondSeen);
    });
  }

  it("re-runs a computed over a changed value declared `any`", async () => {
    // The same value and the same read, declared `any` rather than as its
    // class. This pins the asymmetry: it is the declared type, not the value,
    // that decides whether the change is observed.

    const [firstSeen, secondSeen] = await observeAcrossUpdate(
      "any",
      "any",
      "String(args.v?.length ?? -1)",
      new FabricBytes(new Uint8Array(4)),
      new FabricBytes(new Uint8Array(7)),
    );

    expect(firstSeen).toBe("4");
    expect(secondSeen).toBe("7");
  });

  it("re-runs a computed over a changed number", async () => {
    const [firstSeen, secondSeen] = await observeAcrossUpdate(
      "number",
      "number",
      "String(args.v ?? -1)",
      4,
      7,
    );

    expect(firstSeen).toBe("4");
    expect(secondSeen).toBe("7");
  });
});
