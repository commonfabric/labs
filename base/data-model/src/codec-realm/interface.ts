/**
 * What the realm-crossing format is made of: the transport type a value takes
 * on its way across, the shape a tag wears in it, and the descriptor a
 * registry is built over.
 *
 * These sit apart from the engine because they are what a caller names. A
 * caller holding an encoded value has its type from here; a caller assembling
 * a registry of its own passes the descriptor from here. The engine is the
 * thing that acts on them, and needs no mention to use either.
 */

import type { WireFormat } from "@/codec-interface/interface.ts";
import { REALM_CODEC } from "@/codec-interface/interface.ts";

/**
 * The transport form of this format: a value that structured cloning carries
 * across a realm boundary without loss, and so what `RealmCodecEngine.encode()`
 * returns and `decode()` accepts.
 *
 * Unlike JSON's `JsonCodecValue`, this is not an intermediate tree awaiting a
 * further reduction to what actually crosses. Cloning takes this shape
 * directly, so the tree _is_ the wire, and the engine's `Encoded` and
 * `SerializedForm` are the same type.
 *
 * The union names what this format emits, which is narrower than everything
 * cloning accepts. Five arms are worth calling out:
 *
 * * `bigint` and `undefined` appear directly, as do `-0`, `NaN` and `±Infinity`
 *   under `number`. Cloning carries each as itself.
 * * `ArrayBuffer` appears, because bytes cross as bytes. This is the whole
 *   point of a second format: JSON reaches only `string`, so bytes have to be
 *   written down as base64url text and rebuilt by a receiver that wants bytes
 *   back. The two forms are not interchangeable. Bytes travel as a bare
 *   `ArrayBuffer` rather than as a view onto one, that being what
 *   `postMessage()` can *transfer*, so a caller assembling a transfer list
 *   finds the transferable object in the tree rather than having to reach
 *   through a view and reason about its offset. A bare `Uint8Array` is
 *   therefore not a form this format emits, and `decodeValue()` refuses one.
 * * `CryptoKey` appears, because a key that cannot be exported can still be
 *   carried. Cloning preserves one whole, extractability and algorithm intact,
 *   where a format that writes bytes down can carry only a key whose material
 *   can be read. Like `ArrayBuffer`, it reaches the transport only inside a
 *   terminal codec's state, so the walk never descends into one.
 * * An array is both the tagged form and the outer envelope -- see {@link
 *   RealmTaggedValue} and {@link RealmEncodedValue}. Neither is distinguishable
 *   by shape from a payload's own arrays, and neither is meant to be: what
 *   marks them is the identity of the object in slot zero, which {@link
 *   RealmFormatMarker} explains.
 *
 * `symbol` is absent: cloning refuses one outright, so this format registers
 * the shared `SymbolCodec` and a symbol crosses under a tag like any other
 * value a transport cannot carry directly.
 */
export type RealmCodecValue =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | ArrayBuffer
  | CryptoKey
  | readonly RealmCodecValue[]
  | RealmTaggedValue
  | { readonly [key: string]: RealmCodecValue };

/**
 * Content of the marker object. Recognition never reads it -- identity does
 * all the work -- so within a decode it serves to be legible in a debugger.
 * `RealmCodecEngine.decode()` reads it once, at the outer envelope, to refuse a
 * payload written by a build this one does not understand.
 */
export const REALM_FORMAT_VERSION = "fvr1";

/**
 * The object whose identity marks this format's outer envelope and its tagged
 * forms.
 *
 * `RealmCodecEngine.encode()` mints one per call and puts it in slot zero of
 * the outer envelope and of every tagged form beneath it. A receiver takes it
 * from the outer envelope and recognizes the rest by `===` against it.
 *
 * That works because structured cloning preserves shared references: one object
 * referenced from many positions arrives as one object referenced from many
 * positions. It is the only property of the transport this format leans on
 * beyond carrying its types, and it is the whole of what makes either form
 * unmistakable.
 *
 * **It must be an object.** Recognition is `===`, which on a primitive is value
 * equality rather than identity, so a primitive in slot zero would be
 * reproducible by any payload that happened to hold the same one -- and the
 * argument below would evaporate. `decode()` refuses an outer envelope whose
 * slot zero is not a one-element array holding this version, which is that
 * requirement and the version check at once.
 *
 * **A payload cannot contain the marker**, and two facts together are what say
 * so.
 *
 * It is *younger than the value*: created after the value exists, so nothing
 * already assembled can hold a reference to it, whatever its author has seen of
 * some earlier encoding. That is why it is minted per call rather than per
 * engine -- a long-lived one could be embedded in a value by code that had
 * legitimately seen an earlier encoded tree, and the walk would carry it
 * through to a data position where the decoder would read it as a tagged form.
 *
 * And it is *confined*: it never leaves the engine until `encode()` returns. It
 * lives in a private field and in the tagged forms the walk is building,
 * neither of which anything outside can reach, and a nested `encode()` mints
 * and retires its own. Age alone would not settle it, because a value's
 * contents need not all exist when the walk starts -- a getter runs mid-walk,
 * after the marker exists. What closes that gap is that such a getter has
 * nowhere to read the marker from.
 *
 * It is a frozen array of one string, which is also a `FabricValue` this format
 * encodes by identity. That matters: a value holding some *earlier* call's
 * marker has to encode without complaint, being ordinary data, and a marker
 * shaped as something the walk refuses would make such a value unencodable.
 *
 * It is not a secret and not an authentication token. Whatever asks for an
 * encoding is trusted with the result, and whatever receives a payload is
 * trusted to read it; a hostile peer builds its own marker and forges freely,
 * exactly as it could send any tagged value it liked. What the marker rules out
 * is *confusion within a payload this engine encoded* -- which is the escaping
 * problem, and the whole of what it is for.
 */
export type RealmFormatMarker = readonly [typeof REALM_FORMAT_VERSION];

/**
 * The tagged form: `[marker, tag, state]`.
 *
 * Nothing about the shape distinguishes one of these from an array a payload
 * built for itself, and this type does not pretend otherwise -- structurally
 * it is an ordinary `RealmCodecValue` array, which is what it has to be for
 * cloning to carry it. The marker in slot zero is what decides, and only by
 * identity.
 *
 * Three slots rather than a container keyed by the tag, because an array is
 * the cheapest shape the transport carries: positional slots, no hash table,
 * and a tag string that is the codec's own interned constant rather than a
 * key built per tagged form.
 */
export type RealmTaggedValue = readonly [
  RealmFormatMarker,
  string,
  RealmCodecValue,
];

/**
 * What crosses: `[marker, encodedValue]`.
 *
 * The outer envelope exists to carry the marker, and carries the version with
 * it. A receiver reads slot zero to learn what to compare against, and
 * `RealmCodecEngine.decode()` refuses one whose marker is not this build's
 * before adopting it, so a payload written by a build this one does not
 * understand is refused rather than walked.
 */
export type RealmEncodedValue = readonly [RealmFormatMarker, RealmCodecValue];

/**
 * The realm-crossing wire format, for a `CodecRegistry` to be built over.
 * Pairs the transport type with the symbol a `FabricPrimitive` binds its realm
 * codec under.
 */
export const REALM_FORMAT: WireFormat<RealmCodecValue> = Object.freeze({
  codecSymbol: REALM_CODEC,
});
