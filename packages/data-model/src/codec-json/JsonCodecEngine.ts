import { backtickQuote } from "@commonfabric/utils/markdown";

import {
  BaseCodecEngine,
  type CodecRegistry,
  ProblematicValue,
  UnknownValue,
} from "@/codec-common";
import { JsonDecodeAct } from "./JsonDecodeAct.ts";
import { JsonEncodeAct } from "./JsonEncodeAct.ts";
import { seemsLikeEncoded } from "./wire-text.ts";
import { CODEC, type LiveEnvironment } from "@/codec-interface/interface.ts";
import { NullLiveEnvironment } from "@/codec-interface/NullLiveEnvironment.ts";
import { ENCODING_PREFIX_TAG, type JsonCodecValue } from "./interface.ts";
import { createBaseJsonRegistry } from "./createBaseJsonRegistry.ts";

/**
 * Whole-value JSON codec implementing the `/<Type>@<Version>` wire format from
 * the formal spec (Section 5).
 *
 * Public instance surface, one boundary type and two directions:
 * - `encode(value, env?)` -- full pipeline: tree-encode + stringify
 * - `decode(data, env)` -- full pipeline: parse + tree-decode
 *
 * The machinery beneath belongs elsewhere. The walks and this format's account
 * of how a container is written down are `JsonEncodeAct`'s and
 * `JsonDecodeAct`'s, which this class mints through the two `protected`
 * factories -- that pair being the surface a second engine extends. What both
 * an engine and an act need of the wire text is in `wire-text.ts`, so that
 * neither imports the other. Per-type encoding and decoding is delegated to
 * the `FabricCodec`s in the `CodecRegistry`.
 *
 * Three statics are public besides: `seemsLikeEncoded()`, and the
 * `wrapEncodedValueForTesting()` / `unwrapEncodedValueForTesting()` pair
 * that lets a test build and take apart this format's tagged form without
 * reaching into the private wrapper.
 *
 * **Cycles are refused** and **shared references are flattened**, per Section
 * 1.6 of the formal spec, which requires an engine to say which of these it
 * does. Both follow from reaching text: JSON cannot represent a reference,
 * so a cycle has no encoding at all and is raised at the walk, and a value
 * held at two positions is written out twice, arriving as two objects that a
 * receiver cannot tell from two that were always distinct.
 */
export class JsonCodecEngine extends BaseCodecEngine<JsonCodecValue, string> {
  //
  // Instance members
  //

  /** @inheritDoc */
  protected override newEncodeAct(env: LiveEnvironment): JsonEncodeAct {
    return new JsonEncodeAct(this, env);
  }

  /**
   * @inheritDoc
   *
   * A plain one: this walk never enters a node, for the reason {@link #decode}
   * gives, so the act's in-progress set is never allocated.
   */
  protected override newDecodeAct(
    env: LiveEnvironment,
    _data: string,
  ): JsonDecodeAct {
    return new JsonDecodeAct(this, env);
  }

  //
  // Static members
  //

  /**
   * Registry for the throwaway checks in the testing helpers below: this
   * format's primitive determination, plus the two classes the format uses to
   * represent its own failures. No domain class is registered.
   *
   * That line is what makes those checks answer the question they are asked.
   * They validate that text is well-formed in this wire format, not that any
   * particular class is available to receive it, so a body naming any fabric
   * class has to survive the round trip regardless of who registered what.
   * Both fallbacks are needed for it to:
   *
   * * `UnknownValue` receives an unrecognized tag, and re-encodes to the tag
   *   it came from.
   * * `ProblematicValue` receives a state its codec rejects -- which a codec
   *   may hand back directly rather than throwing, independent of `lenient`
   *   -- and likewise re-encodes.
   *
   * A helper drawing on a fuller registry would instead accept or reject text
   * according to a roster its caller never chose.
   */
  static readonly #testingRegistry: CodecRegistry<JsonCodecValue> =
    createBaseJsonRegistry()
      .extend(UnknownValue[CODEC], ProblematicValue[CODEC]);

  /**
   * Live environment for the throwaway checks in the testing helpers
   * below. Deep-freezes, as the ordinary decode path does. Paired with a
   * lenient engine, a cell reference degrades to a `ProblematicValue`
   * rather than throwing.
   */
  static readonly #testingLiveEnvironment = Object.freeze(
    new NullLiveEnvironment(
      true,
      "no live environment (validity check in a test-only helper).",
    ),
  );

  /**
   * Indicates if the given text has a "first-blush" appearance as valid JSON
   * encoded by this class -- that is, whether it carries the encoding prefix
   * tag.
   */
  static seemsLikeEncoded(value: string): boolean {
    return seemsLikeEncoded(value);
  }

  /**
   * **Intended for tests only.** Strips the encoding prefix tag off an encoded
   * value, yielding the bare JSON text underneath.
   *
   * Tests legitimately need the JSON body on its own -- to pretty-print it, to
   * store it in a fixture file, to compare it against a literal. Doing that by
   * hand means writing the prefix a second time, which is how one definition of
   * a format quietly becomes several that can drift apart.
   *
   * This is deliberately not useful outside a test. Its result is precisely a
   * string that is _no longer_ an encoded `FabricValue`: it has shed the very
   * marker whose purpose is to say "this JSON came from here." Production code
   * that wants to recognize an encoded value should call `seemsLikeEncoded()`;
   * production code that wants the value itself should call `decode()`.
   *
   * That is enforced rather than merely advised: by default this performs a
   * throwaway decode of `encoded` and throws if it is not genuinely decodable.
   * So it cannot serve as a cheap "chop off the first few characters," and it
   * is far too expensive to belong on any hot path.
   *
   * Pass `isMalformed` when the payload is bad on purpose. The decode is then
   * skipped entirely -- malformed means malformed, and deliberately broken text
   * cannot be asked to survive a decode. Only the prefix check remains.
   *
   * The tag itself is still required either way. That is not a judgment about
   * the payload: removing a prefix that is not there does not produce the body,
   * it produces nonsense, so there is nothing for this to return.
   *
   * `registry` decides what the check is able to read, and so what counts as
   * decodable. It defaults to the format-only registry described above, under
   * which any tag is acceptable; pass one carrying a class roster to hold the
   * payload to that roster's codecs as well.
   */
  static unwrapEncodedValueForTesting(
    encoded: string,
    isMalformed = false,
    registry: CodecRegistry<JsonCodecValue> = JsonCodecEngine.#testingRegistry,
  ): string {
    if (isMalformed) {
      if (!JsonCodecEngine.seemsLikeEncoded(encoded)) {
        throw new Error(
          `Not a JSON-encoded \`FabricValue\` string: ${
            backtickQuote(encoded)
          }`,
        );
      }
    } else {
      // Throwaway decode. The result is discarded; it is performed only to
      // establish that `encoded` really is one of ours, rather than a string
      // that happens to begin with the right few characters. (`decode()` checks
      // the tag first, so the malformed branch above loses nothing.)
      new JsonCodecEngine({ registry }).decode(
        encoded,
        JsonCodecEngine.#testingLiveEnvironment,
      );
    }

    return encoded.slice(ENCODING_PREFIX_TAG.length);
  }

  /**
   * **Intended for tests only.** Attaches the encoding prefix tag to bare JSON
   * text, producing an encoded value. The inverse of
   * `unwrapEncodedValueForTesting()`, and it exists for the same reason: so a
   * test that took an encoded value apart can put it back together without
   * naming the prefix itself.
   *
   * The same caveats apply, and for the same reason. Nothing in production
   * should be assembling an encoded value out of text -- code that has a value
   * to encode should call `encode()`, which is the only thing that can promise
   * the result is well-formed.
   *
   * Here that promise is checked directly: the tagged result is decoded and
   * then re-encoded, and both steps must succeed. Text earns the prefix only if
   * the codec can actually read what follows it and write it back out. Note
   * that the re-encoded form is not compared against the input, so incidental
   * differences -- whitespace, in particular -- are fine; a pretty-printed body
   * is accepted.
   *
   * Pass `isMalformed` when the payload is bad on purpose -- a test that wants
   * the decoder to choke on it, say. No check runs at all in that case:
   * malformed means malformed, and text that is deliberately broken cannot be
   * asked to survive a decode. The result is the tag with `json` after it,
   * whatever `json` is. The flag is the call site saying out loud that the
   * badness is the point.
   *
   * `registry` decides what the check is able to read, exactly as for
   * `unwrapEncodedValueForTesting()`.
   */
  static wrapEncodedValueForTesting(
    json: string,
    isMalformed = false,
    registry: CodecRegistry<JsonCodecValue> = JsonCodecEngine.#testingRegistry,
  ): string {
    const encoded = ENCODING_PREFIX_TAG + json;

    if (!isMalformed) {
      // Throwaway decode and re-encode; both results are discarded. See above.
      const jsonCodecEngine = new JsonCodecEngine({ registry });
      jsonCodecEngine.encode(
        jsonCodecEngine.decode(
          encoded,
          JsonCodecEngine.#testingLiveEnvironment,
        ),
      );
    }

    return encoded;
  }
}
