/**
 * The JSON wire format's declarations: the tag its encoded text carries, the
 * intermediate tree type built while walking a value, and the format value a
 * `CodecRegistry` is constructed over.
 *
 * The tree type is not the serialized form -- that is a string -- and the two
 * are easy to conflate. Which of those trees are deep-frozen is a real
 * distinction rather than an incidental one, and it is recorded on the type
 * itself rather than restated here.
 */

import type { WireFormat } from "@/codec-interface/interface.ts";
import { JSON_CODEC } from "@/codec-interface/interface.ts";

/**
 * Tag prefix on the encoded form of a `FabricValue`. The prefix is explicit so
 * as to make it unambiguous whether a given JSON-ish text string is the result
 * of encoding by `JsonCodecEngine` vs. being JSON from some other source. The
 * tag stands for "Fabric Value Json, version 1."
 */
export const ENCODING_PREFIX_TAG = "fvj1:" as const;

/**
 * JSON-compatible codec value. This is the intermediate tree representation
 * used during encode tree walking -- NOT the final serialized form (which is
 * `string`). Internal to the JSON implementation.
 *
 * Frozenness invariant: every such tree that *enters decoding* is deep-frozen
 * for a frozen decode, and freshly built and shared with nothing for a mutable
 * one. This is enforced at the one construction site that feeds the decode
 * walk, `parseWireText()`, and is what lets `unwrapTag()` / the `/quote` arm
 * hand back extracted sub-trees directly (see their contracts): either way,
 * such a sub-tree already has the frozenness the decode owes its caller. The
 * transient trees built on the *encode* side are not covered by this
 * invariant: they are `JSON.stringify`-ed and discarded by `encode()` and
 * never reach a caller.
 * (The encode-side `/quote` form happens to be deep-frozen as a side effect of
 * `#unquote()`'s recursive rebuild, but no other encode output is, and none
 * needs to be.)
 */
export type JsonCodecValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonCodecValue[]
  | { readonly [key: string]: JsonCodecValue };

/**
 * The JSON wire format, for a `CodecRegistry` to be built over. Pairs the
 * intermediate tree type with the symbol a `FabricPrimitive` binds its JSON
 * codec under.
 */
export const JSON_FORMAT: WireFormat<JsonCodecValue> = Object.freeze({
  codecSymbol: JSON_CODEC,
});
