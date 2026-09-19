import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type {
  LiveEnvironment,
  NonterminalCodec,
  TerminalCodec,
} from "@/codec-common/index.ts";
import type {
  FabricInstancePlus,
  FabricValue,
  FabricValuePlus,
} from "@/index.ts";

// The assertions in this file are made when it is type-checked, which the
// package's `test` task does before it runs anything, not when it runs. Each
// carrier below is a function that is never called: an assignment in it that
// must type-check pins a direction the types admit, and a `@ts-expect-error`
// marks one they must refuse -- if the refusal regresses, the directive
// becomes unused and the type check fails on it.

declare const env: LiveEnvironment;
declare const nonterminal: NonterminalCodec;
declare const nonterminalNever: NonterminalCodec<never>;
declare const nonterminalError: NonterminalCodec<Error>;
declare const terminalFabricValue: TerminalCodec<FabricValue>;
declare const terminalString: TerminalCodec<string>;
declare const terminalNumberOrString: TerminalCodec<number | string>;
declare const instancePlusError: FabricInstancePlus<Error>;

/** Carrier for the `NonterminalCodec` checks. */
function nonterminalCodecTypeChecks() {
  // `NonterminalCodec<never>` is `NonterminalCodec`, in both directions.
  const widened: NonterminalCodec<never> = nonterminal;
  const narrowed: NonterminalCodec = nonterminalNever;

  // At another `PlusType`, both sides of the codec are at that type: what
  // `encode()` takes and what `decode()` returns hold it, and what `encode()`
  // emits is what the walker expands.
  const state: FabricValuePlus<Error> = nonterminalError.encode(
    instancePlusError,
    env,
  );
  const decoded: FabricValuePlus<Error> = nonterminalError.decode(
    "Error@1",
    state,
    env,
  );
  // @ts-expect-error a `NonterminalCodec<Error>` decodes to a value that may hold an `Error`
  const notValue: FabricValue = nonterminalError.decode("Error@1", state, env);

  // A codec at another `PlusType` is not one at `never`: its state and its
  // decoded values may hold what a wire format cannot carry. The other
  // direction holds, since a codec over `FabricValue` alone emits nothing a
  // wider walker refuses.
  // @ts-expect-error a `NonterminalCodec<Error>` is not a `NonterminalCodec`
  const notNever: NonterminalCodec = nonterminalError;
  const wider: NonterminalCodec<Error> = nonterminal;

  return { widened, narrowed, state, decoded, notValue, notNever, wider };
}

/** Carrier for the `TerminalCodec` checks. */
function terminalCodecTypeChecks() {
  // `TerminalCodec<FabricValue>` is `NonterminalCodec`: the type does not
  // tell the two kinds apart, which is why a codec declares its kind by the
  // base class it extends.
  const asNonterminal: NonterminalCodec = terminalFabricValue;
  const asTerminal: TerminalCodec<FabricValue> = nonterminal;

  // `FabricCodec` is covariant in `Encoded`: the members are methods, so
  // only the return position of `encode()` decides, and a codec at a narrower
  // `Encoded` is one at a wider.
  const widerEncoded: TerminalCodec<number | string> = terminalString;
  const stringAsNonterminal: NonterminalCodec = terminalString;
  // @ts-expect-error a codec emitting numbers is not one emitting strings
  const narrowerEncoded: TerminalCodec<string> = terminalNumberOrString;

  // Which is why the two arms of `CodecForFormat` are named separately: a
  // `NonterminalCodec` emits `FabricValue`s, which is a subtype of no format's
  // own value type.
  // @ts-expect-error a `NonterminalCodec` emits `FabricValue`s, not strings
  const notTerminal: TerminalCodec<string> = nonterminal;

  return {
    asNonterminal,
    asTerminal,
    widerEncoded,
    stringAsNonterminal,
    narrowerEncoded,
    notTerminal,
  };
}

describe("interface", () => {
  // Each `it()` names the claim its carrier holds; the type checker is what
  // decides it, and at run time only the carrier is observable.

  describe("NonterminalCodec", () => {
    it("is `NonterminalCodec<never>`, holds its `PlusType` on both sides, and is not a `NonterminalCodec` at another `PlusType`", () => {
      expect(typeof nonterminalCodecTypeChecks).toBe("function");
    });
  });

  describe("TerminalCodec", () => {
    it("is `NonterminalCodec` at `FabricValue`, covariant in `Encoded`, and takes no `NonterminalCodec` at a format's own type", () => {
      expect(typeof terminalCodecTypeChecks).toBe("function");
    });
  });
});
