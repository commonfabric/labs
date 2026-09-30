/**
 * How a value the fabric holds is written for a reader.
 *
 * Two verbs write one, and they want the same form: `get` reads a cell and
 * `wish` reads what a named entry point resolved to. So the form is here
 * rather than at either of them, and the one thing they differ about — whether
 * a piece's rendering is written out or stood in for — is a parameter.
 */

import { UI } from "@commonfabric/runner";

import { escapeControlCharactersInJson } from "./place.ts";

/**
 * What stands in a rendered value's place where it was elided.
 *
 * It names the flag that reads it, because the elision is a default rather
 * than a bound: `--select '$UI'` projects that key and the read hands back
 * what it holds. `cf piece inspect` stands the same node in for the same
 * reason, so a reader who has met one meets the other in the same shape.
 */
const ELIDED_UI = "<elided — `get --select '$UI'` reads it>";

/** How much of a value a rendering writes out. */
export interface ValueRendering {
  /**
   * Write a piece's `$UI` node out rather than standing in for it. It is
   * elided by default because a rendering is a vnode tree — hundreds of lines
   * of it, data URIs included — and it is the piece's picture of itself rather
   * than state an operator debugs at this layer.
   */
  readonly ui?: boolean;
}

/**
 * Returns `value` as the reader sees it: indented JSON, with what cannot be
 * written that way said instead.
 *
 * `JSON.stringify` returns no string for several different reasons and says
 * which for none of them, so this tells them apart before it is asked. A
 * value that is `undefined` is what the fabric holds nothing at, and the word
 * says so. A registry-interned symbol is a value a cell does hold and JSON
 * has no form for, and the word there would say the cell was empty when it is
 * not, so what comes back names the kind instead.
 *
 * A `bigint` is a value a cell holds too, and the writer throws on one rather
 * than declining it, so it is given a form on the way past: `{ $bigint: "…" }`
 * with the number as its decimal string, which is what `cf cell get` writes
 * for the same value (`safeStringify`, `render.ts`). One question answered
 * twice ought to be answered the same way, and a test compares the two rather
 * than restating the spelling.
 *
 * Where the two surfaces still differ they differ on purpose, and this is the
 * one that is right: `cf cell get` writes `null` both for a value that is
 * `undefined` and for a symbol, and `null` is a value a cell can hold. What
 * a cell holds nothing at is nothing, and the word above says that instead.
 *
 * The bound is on nesting rather than on a kind, and it is what a caller cannot
 * see. An `undefined` or an interned symbol under a key loses the key, which
 * reads as a key the fabric does not hold; either of them at an array index,
 * and an array's hole, is written `null`, which reads as a value the fabric
 * holds. Every one of those is a value a cell takes and hands back, and a read
 * produces them without being asked: a property a schema does not require reads
 * as `undefined` where the data underneath does not match it
 * (`schema-view.ts`). A function and a unique symbol are not bounds here,
 * because neither survives to be read out of a cell. The fabric's
 * value-admission test refuses both on the way in
 * (`assertValidFabricValueLayer`,
 * `packages/data-model/src/types/validation.ts`), and its codec has no form for
 * either at the commit that would store one (`BaseEncodeAct`), so the raw write
 * that skips the first still meets the second.
 *
 * What the writer leaves for this one to do is the class a terminal acts on.
 * It escapes every C0 character a value held and passes `DEL` and C1 through,
 * so those are finished here, in JSON's own spelling rather than the glyphs a
 * message gets — the two conventions and the reason they differ are with
 * `escapeControlCharactersInJson` (`place.ts`).
 */
export function renderValue(
  value: unknown,
  rendering: ValueRendering = {},
): string {
  if (value === undefined) return "undefined";
  const json = JSON.stringify(
    value,
    (key, held) =>
      key === UI && rendering.ui !== true
        ? ELIDED_UI
        : typeof held === "bigint"
        ? { $bigint: held.toString() }
        : held,
    2,
  );
  return json === undefined
    ? `The value is a ${typeof value}, which JSON has no way to write.`
    : escapeControlCharactersInJson(json);
}

/**
 * The name of `value`'s class, for prose naming what a value is rather than
 * writing it out.
 *
 * Read off the prototype rather than the value, as the fabric's own refusals
 * read it: an own `constructor` property is ordinary data, so a value could
 * otherwise choose the name it is named under. A class that will not say what
 * it is called — a class expression with no name — is named for what it is
 * instead.
 */
export function classOf(value: object): string {
  const named = Object.getPrototypeOf(value)?.constructor?.name;
  return typeof named === "string" && named !== "" ? named : "fabric value";
}
