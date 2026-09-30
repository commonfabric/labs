import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { type FabricValue, valueEqual } from "@commonfabric/data-model";
import {
  FabricBytes,
  FabricEpochNsec,
  FabricRegExp,
} from "@commonfabric/data-model/fabric-primitives";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("pattern prop conversion");
const space = signer.did();

describe("pattern-prop-conversion", () => {
  // A pattern called with a prop that is not plain data gets the prop's fabric
  // form, or a refusal where the prop has none a pattern binding can carry.
  // Each case is driven twice: from a pattern body, which binds the call when
  // the enclosing pattern is built, and from a lift, which binds it when the
  // lift runs and reports a failure through the scheduler.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let errors: unknown[];

  beforeEach(() => {
    errors = [];
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtime.scheduler.onError((error) => {
      errors.push(error);
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * Helper for these tests, which builds a root pattern handing `make()` to a
   * sub-pattern as its `value` prop, calling the sub-pattern from the root's
   * body or from a lift, runs it, and returns what the sub-pattern's `read`
   * output holds. By default the sub-pattern echoes the prop.
   */
  async function readThroughPatternCall(
    make: () => unknown,
    caller: "body" | "lift",
    cause: string,
    read?: (value: unknown) => unknown,
  ): Promise<unknown> {
    const { cell, lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const sub = pattern<{ value: unknown }>(({ value }) => ({
      read: read === undefined ? value : lift(read)(value),
    }));
    const root = caller === "body"
      ? pattern(() => ({ card: sub({ value: make() }) }))
      : pattern(() => ({
        card: lift((_tick: number) => sub({ value: make() }))(cell(1)),
      }));

    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ card: { read: unknown } }>(
      space,
      cause,
      undefined,
      tx,
    );
    const result = runtime.run(tx, root, {}, resultCell);
    await tx.commit();
    const stop = result.key("card").sink(() => {});
    try {
      await runtime.idle();
      await result.pull();
      return result.key("card").key("read").get();
    } finally {
      stop();
    }
  }

  class Point {
    constructor(readonly x: number) {}
  }

  const MINTED: ReadonlyArray<[string, () => object, string, FabricValue]> = [
    ["a `Date`", () => new Date(0), "FabricEpochNsec", new FabricEpochNsec(0n)],
    ["a `RegExp`", () => /a+/g, "FabricRegExp", new FabricRegExp(/a+/g)],
    [
      "a `Uint8Array`",
      () => new Uint8Array([1, 2, 3]),
      "FabricBytes",
      new FabricBytes(new Uint8Array([1, 2, 3])),
    ],
  ];

  const NOT_AN_INERT_OBJECT = "Not representable as a `FabricValue`: object " +
    "that is not an inert plain object";

  // A `FabricError` holding what the conversion leaves unconverted cannot yet
  // be carried by a pattern binding, and a `Map` or a `Set` has no fabric form
  // yet at all. The rest have none, and never will.
  const REFUSED: ReadonlyArray<[string, () => object, string]> = [
    [
      "an `Error` whose `cause` is a record",
      () => new TypeError("nope", { cause: { k: 1 } }),
      "Cannot yet handle `FabricError` (a `FabricInstance`) in a pattern " +
      "binding.",
    ],
    [
      "a `Map`",
      () => new Map([["k", 1]]),
      "Not already a `FabricValue`: `Map` (a `FabricConvertibleJsObject`, so " +
      "conversion is what decides it)",
    ],
    [
      "a `Set`",
      () => new Set([1]),
      "Not already a `FabricValue`: `Set` (a `FabricConvertibleJsObject`, so " +
      "conversion is what decides it)",
    ],
    [
      "a class instance",
      () => new Point(1),
      "Not representable as a `FabricValue`: `Point` (not a recognized " +
      "fabric type)",
    ],
    [
      "a record with a `null` prototype",
      () => Object.assign(Object.create(null), { a: 1 }),
      NOT_AN_INERT_OBJECT,
    ],
    [
      "a record with an accessor",
      () => ({
        get a() {
          return 1;
        },
      }),
      NOT_AN_INERT_OBJECT,
    ],
    [
      "a record with a symbol key",
      () => ({ [Symbol("s")]: 1, a: 2 }),
      NOT_AN_INERT_OBJECT,
    ],
    [
      "a record with a non-enumerable key",
      () => Object.defineProperty({ a: 1 }, "hidden", { value: 2 }),
      NOT_AN_INERT_OBJECT,
    ],
    [
      "an array with a named property",
      () => Object.assign([1, 2], { extra: 3 }),
      "Not representable as a `FabricValue`: array that is not an inert array",
    ],
  ];

  for (const caller of ["body", "lift"] as const) {
    describe(`called from a pattern ${caller}`, () => {
      for (const [shape, make, fabricName, expected] of MINTED) {
        it(`hands the sub-pattern ${shape} as a \`${fabricName}\``, async () => {
          const received = await readThroughPatternCall(
            make,
            caller,
            `${caller} ${shape}`,
          );

          expect(errors).toEqual([]);
          expect(valueEqual(received as FabricValue, expected)).toBe(true);
        });
      }

      it("hands the sub-pattern an `Error` whose `message` it reads", async () => {
        const message = await readThroughPatternCall(
          () => new TypeError("nope"),
          caller,
          `${caller} an Error`,
          (error) => (error as Error).message,
        );

        expect(errors).toEqual([]);
        expect(message).toBe("nope");
      });

      for (const [shape, make, message] of REFUSED) {
        it(`throws for ${shape}`, async () => {
          const reading = readThroughPatternCall(
            make,
            caller,
            `${caller} ${shape}`,
          );

          if (caller === "body") {
            await expect(reading).rejects.toThrow(message);
          } else {
            expect(await reading).toBeUndefined();
            expect(errors.map((error) => (error as Error).message)).toEqual([
              message,
            ]);
          }
        });
      }
    });
  }
});
