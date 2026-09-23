/**
 * Error messages that quote the value they refused, checked at the sites where
 * the quoted text arrives from outside.
 *
 * A refusal is only useful if it names what it refused, and what it refused is
 * arbitrary text -- a class name, a hash string, a fragment of wire data --
 * which may itself contain backticks. So each case makes the same demand:
 * whatever went in comes back out intact, rather than being truncated or
 * having its quoting broken by its own content.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { backtickQuote } from "@commonfabric/utils/markdown";

import { cloneIfNecessary, hashOf } from "@";
import { NullLiveEnvironment } from "@/codec-common";
import { newDefaultJsonCodecEngine } from "@/codecs.ts";
import { FabricHash } from "@/fabric-primitives";

/**
 * Builds a class instance whose `constructor.name` holds the given text.
 * `Function.prototype.name` is configurable, so a value arriving from user
 * data can carry any name at all -- including backticks.
 */
function instanceNamed(name: string): object {
  class Named {}
  Object.defineProperty(Named, "name", { value: name });
  return new Named();
}

// Text that breaks a hand-written pair of backticks: a lone backtick closes
// the span early, a doubled run defeats a two-backtick delimiter, and a
// leading backtick merges into the opening delimiter.
const HOSTILE = ["a`b", "a``b", "`lead", "trail`", "`", "``"];

describe("message-quoting", () => {
  describe("FabricHash.fromString()", () => {
    it("hands back the source it refused, whatever backticks it held", () => {
      for (const source of HOSTILE) {
        let message = "";
        try {
          FabricHash.fromString(source);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message).toContain(
          `Invalid content hash string: ${backtickQuote(source)}`,
        );
      }
    });
  });

  describe("hashOf()", () => {
    it("hands back the class name it refused", () => {
      for (const name of HOSTILE) {
        let message = "";
        try {
          hashOf(instanceNamed(name) as never);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message).toContain(
          `unsupported object type ${backtickQuote(name)}`,
        );
      }
    });
  });

  describe("cloneIfNecessary()", () => {
    it("hands back the class name it refused", () => {
      for (const name of HOSTILE) {
        let message = "";
        try {
          cloneIfNecessary(instanceNamed(name) as never);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message).toContain(`Cannot clone: ${backtickQuote(name)}`);
      }
    });
  });

  describe("JsonCodecEngine.decode()", () => {
    it("hands back the excerpt it refused", () => {
      const env = new NullLiveEnvironment(false);
      for (const data of HOSTILE) {
        let message = "";
        try {
          newDefaultJsonCodecEngine().decode(data, env);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message).toContain(
          "Not a JSON-encoded `FabricValue` string: " + backtickQuote(data),
        );
      }
    });
  });
});
