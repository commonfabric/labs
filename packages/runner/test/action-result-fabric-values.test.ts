import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  FabricBytes,
  FabricEpochNsec,
  FabricRegExp,
} from "@commonfabric/data-model/fabric-primitives";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("action result FabricValues");
const space = signer.did();

const FIRST_RESULT_CAUSE = "action-result-fabric-values-first";
const REEMITTED_RESULT_CAUSE = "action-result-fabric-values-reemitted";

type ActionValues = {
  bytes: unknown;
  nativeBytes: unknown;
  bigint: unknown;
  nan: unknown;
  positiveInfinity: unknown;
  negativeInfinity: unknown;
  negativeZero: unknown;
  symbol: unknown;
  date: unknown;
  regexp: unknown;
  error?: unknown;
};

const ACTION_VALUES_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { computed, fetchBinary, pattern } from "commonfabric";',
      "",
      "// CT-1851: schema vocabulary does not cover this FabricValue table.",
      "export default pattern<{}, { values?: any }>(() => {",
      '  const art = fetchBinary({ url: "https://mock.test/image" });',
      "  const values = computed(() => {",
      "    const bytes = art.result?.bytes;",
      "    if (!bytes) return undefined;",
      "    return ({",
      "      // Motivating case: materialized FabricBytes returned by a lift.",
      "      bytes,",
      "      nativeBytes: new Uint8Array([9, 8, 7]),",
      '      date: new Date("2026-07-21T12:34:56.789Z"),',
      "      regexp: /fabric-values/gi,",
      '      error: new TypeError("action result round trip"),',
      "      bigint: 9_007_199_254_740_993n,",
      "      nan: NaN,",
      "      positiveInfinity: Infinity,",
      "      negativeInfinity: -Infinity,",
      "      negativeZero: -0,",
      '      symbol: Symbol.for("action-result-fabric-value") as any,',
      "    }) as any;",
      "  });",
      "  return { values };",
      "});",
    ].join("\n"),
  }],
};

const REEMIT_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { computed, pattern } from "commonfabric";',
      "",
      "// CT-1851: schema vocabulary does not cover this FabricValue table.",
      "export default pattern<{ value: any }, { values: any }>(",
      "  ({ value }) => {",
      "    const values = computed(() => ({",
      "      bytes: value.bytes,",
      "      nativeBytes: value.nativeBytes,",
      "      bigint: value.bigint,",
      "      nan: value.nan,",
      "      positiveInfinity: value.positiveInfinity,",
      "      negativeInfinity: value.negativeInfinity,",
      "      negativeZero: value.negativeZero,",
      "      symbol: value.symbol,",
      "      date: value.date,",
      "      regexp: value.regexp,",
      "    }) as any);",
      "    return { values };",
      "  },",
      ");",
    ].join("\n"),
  }],
};

function newRuntime(storageManager: EmulatedStorageManager): Runtime {
  return new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
}

function expectActionValues(value: ActionValues, expectError = true): void {
  expect(value.bytes).toBeInstanceOf(FabricBytes);
  expect(Array.from((value.bytes as FabricBytes).slice())).toEqual([
    1,
    2,
    3,
    4,
  ]);
  expect(value.nativeBytes).toBeInstanceOf(FabricBytes);
  expect(Array.from((value.nativeBytes as FabricBytes).slice())).toEqual([
    9,
    8,
    7,
  ]);

  expect(value.bigint).toBe(9_007_199_254_740_993n);
  expect(Number.isNaN(value.nan)).toBe(true);
  expect(value.positiveInfinity).toBe(Infinity);
  expect(value.negativeInfinity).toBe(-Infinity);
  expect(Object.is(value.negativeZero, -0)).toBe(true);
  expect(value.symbol).toBe(Symbol.for("action-result-fabric-value"));

  expect(value.date).toBeInstanceOf(FabricEpochNsec);
  expect((value.date as FabricEpochNsec).value).toBe(
    1_784_637_296_789_000_000n,
  );
  expect(value.regexp).toBeInstanceOf(FabricRegExp);
  expect((value.regexp as FabricRegExp).source).toBe("fabric-values");
  expect((value.regexp as FabricRegExp).flags).toBe("gi");
  if (expectError) {
    const error = value.error as {
      constructor: { name: string };
      type: string;
      message: string;
    };
    // Compiled actions and the host load distinct class identities, so pin the
    // codec-visible FabricError shape rather than realm-local `instanceof`.
    expect(error.constructor.name).toBe("FabricError");
    expect(error.type).toBe("TypeError");
    expect(error.message).toBe(
      "action result round trip",
    );
  } else {
    expect(value.error).toBeUndefined();
  }
}

describe("action results use FabricValue legality", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let coldStorage: EmulatedStorageManager;
  let writer: Runtime;
  let coldReader: Runtime;

  beforeEach(() => {
    server = new MemoryV2Server.Server(TEST_MEMORY_SERVER_AUTH);
    writerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    coldStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
      fetch: () =>
        Promise.resolve(
          new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "content-type": "image/test" },
          }),
        ),
    });
    coldReader = newRuntime(coldStorage);
  });

  afterEach(async () => {
    await writer?.dispose();
    await coldReader?.dispose();
    await writerStorage?.close();
    await coldStorage?.close();
    await server?.close();
  });

  it("round-trips newly admitted action values through a cold replica and re-emits them", async () => {
    const writerTx = writer.edit();
    const actionValuesPattern = await writer.patternManager.compilePattern(
      ACTION_VALUES_PROGRAM,
      { space, tx: writerTx },
    );
    const firstResult = writer.getCell<{ values?: ActionValues }>(
      space,
      FIRST_RESULT_CAUSE,
      undefined,
      writerTx,
    );
    const first = writer.run(
      writerTx,
      actionValuesPattern,
      {},
      firstResult,
    );
    writer.prepareTxForCommit(writerTx);
    await writerTx.commit().settled;
    const cancelFirst = first.sink(() => {});
    await writer.settled();
    await writer.idle();
    await first.pull();
    const firstValues = await first.key("values").pull();
    expect(firstValues).toBeDefined();
    expectActionValues(firstValues!);
    cancelFirst();
    await writer.idle();
    await writer.storageManager.synced();

    // This manager owns separate replicas and has not opened the result cell,
    // so the read below must reconstruct every value from the shared store.
    const coldResult = coldReader.getCell<{ values: ActionValues }>(
      space,
      FIRST_RESULT_CAUSE,
    );
    await coldResult.sync();
    await coldResult.pull();
    expectActionValues(await coldResult.key("values").pull());

    const reemitTx = coldReader.edit();
    const reemitPattern = await coldReader.patternManager.compilePattern(
      REEMIT_PROGRAM,
      { space, tx: reemitTx },
    );
    const reemittedResult = coldReader.getCell<{ values: ActionValues }>(
      space,
      REEMITTED_RESULT_CAUSE,
      undefined,
      reemitTx,
    );
    const reemitted = coldReader.run(
      reemitTx,
      reemitPattern,
      { value: coldResult.key("values") },
      reemittedResult,
    );
    coldReader.prepareTxForCommit(reemitTx);
    await reemitTx.commit().settled;
    const cancelReemitted = reemitted.sink(() => {});
    await coldReader.settled();
    await coldReader.idle();
    await reemitted.pull();
    // Explicit downstream carve-out: a cold FabricError is reconstructed by
    // the memory package's data-model module identity. Re-emitting that value
    // through runner's independently loaded FabricInstance identity is not yet
    // recognized, so this second lift omits only `error`; the first write and
    // cold read above still pin its wire round-trip.
    expectActionValues(await reemitted.key("values").pull(), false);
    cancelReemitted();
    await coldReader.idle();
    await coldReader.storageManager.synced();
  });
});
