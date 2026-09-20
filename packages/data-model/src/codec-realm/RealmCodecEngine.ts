import { BaseCodecEngine } from "@/codec-common";

import type { LiveEnvironment } from "@/codec-interface/interface.ts";
import { RealmDecodeAct } from "./RealmDecodeAct.ts";
import { RealmEncodeAct } from "./RealmEncodeAct.ts";
import { type RealmCodecValue, type RealmEncodedValue } from "./interface.ts";

/**
 * Whole-value codec engine for the realm-crossing wire format: the form a
 * `FabricValue` takes when it is handed to `structuredClone()` or
 * `postMessage()` to reach another realm, or to a durable store that serializes
 * the same way.
 *
 * The format is specified by `4-realm-encoding.md` of the formal spec, which is
 * the authority on the shape of an encoded value, the marker and its rules,
 * what the walks refuse, and what each direction does with the memory it is
 * given. Two of its terms are worth naming here because they are what the
 * methods below are written in: the **outer envelope** is the two-element
 * `[marker, tree]` that crosses, and a **tagged form** is the three-element
 * `[marker, tag, state]` that a codec's output wears inside it.
 *
 * The marker answers both of the questions `BaseCodecEngine.encode()` frames.
 * Which parts of a payload are the format's own: identity settles that, where
 * JSON escapes instead, and it is the question a private channel does not
 * excuse. And what wrote this: the marker carries a version, and `decode()`
 * refuses one it does not implement.
 *
 * **Cycles are refused and a shared reference survives exactly where nothing
 * beneath it needed encoding**, per Section 1.6 of the formal spec, which
 * requires an engine to say which of these it does. Section 4 of the realm spec
 * gives both, and the encode and decode sides of the ownership contract are
 * Section 5 -- the half a caller is likeliest to get wrong being that an
 * encoded tree shares structure with the value it came from and is not frozen.
 *
 * TODO(danfuzz): A memo from each visited object to its encoded counterpart
 * closes cycles and sharing at once: a repeat visit yields the node already
 * built for it, which preserves sharing through a rebuild and lets a back-edge
 * resolve instead of recursing. It belongs on `BaseEncodeAct` and
 * `BaseDecodeAct`, beside the in-progress set, since a cycle can run through a
 * codec-matched object as readily as through a container and both walks need
 * it.
 */
export class RealmCodecEngine extends BaseCodecEngine<
  RealmCodecValue,
  RealmEncodedValue,
  RealmEncodeAct,
  RealmDecodeAct
> {
  //
  // Instance members
  //

  /** @inheritDoc */
  protected override newEncodeAct(
    env: LiveEnvironment,
  ): RealmEncodeAct {
    return new RealmEncodeAct(this, env);
  }

  /**
   * @inheritDoc
   *
   * The form is not read here. The act takes the sender's marker off the
   * envelope in `encodedFromSerializedForm()`, which the base calls before any
   * of the walk -- so there is nothing this needs the form for.
   */
  protected override newDecodeAct(
    env: LiveEnvironment,
    _data: RealmEncodedValue,
  ): RealmDecodeAct {
    return new RealmDecodeAct(this, env);
  }
}
