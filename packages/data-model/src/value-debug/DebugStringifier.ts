import { isPlainObject, isUnsafeObjectKey } from "@commonfabric/utils/types";

// Imported from its own module rather than the `codec-common` barrel,
// deliberately. The barrel loads every codec, the codecs load the
// `fabric-bases` barrel, and that barrel loads `value-debug` so as to install
// the debug renderers. Going through the barrel would therefore cause a
// circular load-time dependency. `codecOf.ts` itself is a leaf.
import { codecOf } from "@/codec-common/codecOf.ts";
import { isCodecTypeTag } from "@/codec-common/isCodecTypeTag.ts";
import { REALM_CODEC } from "@/codec-interface/interface.ts";
import { NULL_LIVE_ENVIRONMENT } from "@/codec-interface/NullLiveEnvironment.ts";
import type { RealmCodecValue } from "@/codec-realm";
import {
  type FabricPlainObject,
  FabricPrimitive,
  type FabricValue,
} from "@/interface.ts";

import { classNameOf } from "./classNameOf.ts";
import type { ConversionLimits } from "./ConversionLimits.ts";
import { DebugConverter } from "./DebugConverter.ts";

/**
 * Matches the empty position just past each line break, so that splitting a
 * string on it yields the string's lines with their line breaks kept.
 */
const AFTER_LINE_BREAK_REGEX = /(?<=\r\n|\r(?!\n)|\n)/;

/**
 * What a `FabricPrimitive`'s codec hands back to be rendered: the
 * realm-crossing encoding of a terminal codec, or the expansion of a
 * nonterminal one into other `FabricValue`s.
 */
type PrimitiveState = RealmCodecValue | FabricValue;

/**
 * One of the conversion's single-key tagged forms, taken apart: the tag,
 * less its leading slash, and the payload under it.
 */
type TaggedForm = { readonly tag: string; readonly payload: FabricValue };

/**
 * The payload of the conversion's string-length form: the length of the
 * whole string, and the excerpt of it that was carried.
 */
type PartialString = { readonly length: number; readonly excerpt: string };

/**
 * Helper class for rendering the result of `toStructuredDebugValue()` as a
 * debug string, for a human to read. The rendering follows JSON syntax where
 * that suffices and departs from it where it does not; the details are the
 * renderer's to change, and the case files under
 * `test/value-debug/value-debug-cases/` are what records them.
 */
export class DebugStringifier {
  readonly #limits: ConversionLimits;
  readonly #replacer: undefined | ((value: any) => any);
  readonly #singleIndent: string | undefined;
  readonly #spacer: string;
  readonly #colon: string;

  /**
   * Constructs an instance which renders using `indent` spaces per nesting
   * level when given, and on a single line when not. A value which turns up
   * unconverted while rendering is converted within `limits`, consulting
   * `replacer` when given, and what the rendering lays out itself,
   * unconverted, is bounded by `limits`.
   */
  constructor(
    limits: ConversionLimits,
    replacer?: (value: any) => any,
    indent?: number,
  ) {
    this.#limits = limits;
    this.#replacer = replacer;
    this.#singleIndent = (indent === undefined)
      ? undefined
      : " ".repeat(indent);
    this.#spacer = this.#isCompact ? "" : " ";
    this.#colon = `:${this.#spacer}`;
  }

  //
  // Instance members
  //

  /** Renders the given value. */
  render(value: FabricValue): string {
    return this.#renderSubvalue(value, "");
  }

  /** Whether this instance renders on a single line, with no indentation. */
  get #isCompact(): boolean {
    return this.#singleIndent === undefined;
  }

  /**
   * Renders an array, whose closing bracket (when the rendering is multi-line)
   * is indented by `indent`.
   */
  #renderArray(value: readonly FabricValue[], indent: string): string {
    // The length form the conversion leaves at the end of a truncated array is
    // an element like any other, so a run of holes ends at it.
    const parts = this.#renderElements(
      value,
      indent,
      (v, i) => this.#renderSubvalue(v, i),
    );
    return this.#renderContainer("[", "]", parts, indent);
  }

  /**
   * Renders a container from its already-rendered parts, given the opening and
   * closing bracket text and the indentation of the closing bracket.
   */
  #renderContainer(
    open: string,
    close: string,
    parts: string[],
    indent: string,
  ): string {
    if (parts.length === 0) {
      return `${open}${close}`;
    } else if (this.#isCompact) {
      return `${open}${parts.join(",")}${close}`;
    }

    const inner = this.#innerIndent(indent);
    return `${open}\n${inner}${parts.join(`,\n${inner}`)}\n${indent}${close}`;
  }

  /**
   * Renders the elements of an array, one part per element or run of holes,
   * for a container whose closing bracket is indented by `indent`, each
   * element rendered by `render`. A hole renders as `void`, and a run of holes
   * as a single `void` times the length of the run.
   */
  #renderElements<T>(
    value: readonly T[],
    indent: string,
    render: (value: T, indent: string) => string,
  ): string[] {
    const inner = this.#innerIndent(indent);
    const parts: string[] = [];
    const pushHoles = (count: number): void => {
      if (count === 1) {
        parts.push("void");
      } else if (count > 1) {
        parts.push(`void${this.#spacer}*${this.#spacer}${count}`);
      }
    };

    // `forEach()` skips a hole, so a gap between one index it passes and the
    // next is a run of holes.
    let nextIndex = 0;
    value.forEach((element, index) => {
      pushHoles(index - nextIndex);
      parts.push(render(element, inner));
      nextIndex = index + 1;
    });
    pushHoles(value.length - nextIndex);

    return parts;
  }

  /**
   * Renders a `FabricPrimitive` as `/TypeName(<state>)`, where the type name
   * is that of its codec type tag and the state is its realm-crossing
   * encoding, in the same form a class instance's properties take. When the
   * codec cannot be found, the class name stands in for the type name and the
   * state is elided.
   */
  #renderFabricPrimitive(value: FabricPrimitive, indent: string): string {
    let tag: string;
    let state: PrimitiveState;

    try {
      // A `FabricPrimitive` binds no `[CODEC]`, so its realm codec supplies
      // the tag and the state. That codec is the one whose terminals are the
      // richest -- a `bigint` stays a `bigint`, bytes stay bytes -- which is
      // what makes it the one to render. TODO(danfuzz): Replace `REALM_CODEC`
      // with `DEBUG_CODEC` once the latter exists.
      const codec = codecOf<RealmCodecValue>(value, REALM_CODEC);
      tag = codec.tagForValue(value);
      state = codec.encode(value, NULL_LIVE_ENVIRONMENT);
    } catch {
      // Never let the debug renderer throw; fall back to the class name, with
      // the state elided.
      return DebugStringifier.#renderElidedInstance(classNameOf(value));
    }

    const typeName = DebugStringifier.#typeNameOf(tag);
    const open = `${DebugStringifier.#renderTypeName(typeName)}(`;

    if (isPlainObject(state)) {
      const parts = this.#renderRealmProperties(state, indent, 0);
      return this.#renderContainer(open, ")", parts, indent);
    } else {
      return `${open}${this.#renderRealmState(state, indent, 0)})`;
    }
  }

  /**
   * Renders the properties of a plain object within a realm-crossing encoding,
   * one part per property, given the nesting depth of the object within the
   * encoding.
   */
  #renderRealmProperties(
    value: { readonly [key: string]: PrimitiveState },
    indent: string,
    depth: number,
  ): string[] {
    return this.#renderEntries(
      Object.entries(value),
      undefined,
      indent,
      (v, i) => this.#renderRealmState(v, i, depth + 1),
    );
  }

  /**
   * Renders a realm-crossing encoding, or a piece of one, which is at the
   * indicated nesting depth within the encoding. The encoding's own terminal,
   * an `ArrayBuffer`, is rendered as `buf [...]`; its containers are walked as
   * they stand, within the limits; and anything else takes the ordinary path
   * through the conversion. A container at the maximum nesting depth is
   * elided, and an array with more elements than the maximum array length has
   * the elements at indices below that limit rendered and then its length.
   */
  #renderRealmState(
    value: PrimitiveState,
    indent: string,
    depth: number,
  ): string {
    if (value instanceof ArrayBuffer) {
      return this.#renderBuffer(value);
    }

    const isArray = Array.isArray(value);
    if (!(isArray || isPlainObject(value))) {
      const converted = new DebugConverter(
        value,
        this.#limits,
        this.#replacer,
      ).convert();
      return this.#renderSubvalue(converted, indent);
    } else if (depth >= this.#limits.maxDepth) {
      return "...";
    } else if (isArray) {
      const maxLength = this.#limits.maxArrayLength;
      const parts = this.#renderElements(
        value.slice(0, maxLength),
        indent,
        (v, i) => this.#renderRealmState(v, i, depth + 1),
      );
      if (value.length > maxLength) {
        parts.push(this.#renderElision("length", value.length));
      }
      return this.#renderContainer("[", "]", parts, indent);
    } else {
      const parts = this.#renderRealmProperties(value, indent, depth);
      return this.#renderContainer("{", "}", parts, indent);
    }
  }

  /**
   * Renders a class instance which the conversion carried under its class
   * name, or a `FabricInstance` carried under its type name, as
   * `/Name(<props>)` when its payload is a plain object of properties and as
   * `/Name(...)` when the conversion had nothing to show for it, the name
   * rendered as `#renderTypeName()` renders it. Any other payload -- a
   * `toString()` form, what `toJSON()` returned, or an encoding that is not a
   * plain object -- is rendered as it stands inside the parentheses.
   */
  #renderInstance(
    className: string,
    payload: FabricValue,
    indent: string,
  ): string {
    const open = `${DebugStringifier.#renderTypeName(className)}(`;

    if (payload === "/...") {
      return `${open}...)`;
    } else if (isPlainObject(payload)) {
      const tagged = DebugStringifier.#taggedFormOf(
        payload,
      );

      if (tagged !== undefined) {
        // A marker form, rendered as what it stands for rather than spread as
        // properties.
        return `${open}${this.#renderTaggedForm(tagged, indent)})`;
      } else {
        const parts = this.#renderConvertedProperties(
          payload,
          indent,
        );
        return this.#renderContainer(open, ")", parts, indent);
      }
    } else {
      // The payload sits where the parenthesis opens, so it takes the
      // indentation of the parenthesis itself.
      return `${open}${this.#renderSubvalue(payload, indent)})`;
    }
  }

  /**
   * Renders a plain object, whose closing brace (when the rendering is
   * multi-line) is indented by `indent`.
   */
  #renderPlainObject(value: FabricPlainObject, indent: string): string {
    const tagged = DebugStringifier.#taggedFormOf(value);

    if (tagged !== undefined) {
      return this.#renderTaggedForm(tagged, indent);
    } else {
      const parts = this.#renderConvertedProperties(value, indent);
      return this.#renderContainer("{", "}", parts, indent);
    }
  }

  /**
   * Renders the properties of a plain object which came through the
   * conversion, one part per property, for a container whose closing bracket
   * is indented by `indent`. A key is rendered as the original value's key,
   * the slash the conversion prefixes to a key that starts with one and to an
   * unsafe key coming back off here, and a final `/...` property is the
   * property-count form, rendered as the count it carries.
   */
  #renderConvertedProperties(
    value: FabricPlainObject,
    indent: string,
  ): string[] {
    const entries = Object.entries(value);
    const last = entries.at(-1);
    const count = (last?.[0] === "/...")
      ? DebugStringifier.#countOf(last[1])
      : undefined;

    if (count !== undefined) {
      entries.pop();
    }

    return this.#renderEntries(
      entries.map(([key, subvalue]) => [
        (key[0] === "/") ? key.slice(1) : key,
        subvalue,
      ]),
      count,
      indent,
      (v, i) => this.#renderSubvalue(v, i),
    );
  }

  /**
   * Renders the entries of an object, one part per entry, for a container
   * whose closing bracket is indented by `indent`, each value rendered by
   * `render`. When there are more entries than the maximum property count,
   * the first that many are rendered. A final part says the count of the
   * whole: `count` when given, which is for an object already cut short, or
   * the number of entries when that is what exceeded the maximum.
   */
  #renderEntries<T>(
    entries: readonly (readonly [key: string, value: T])[],
    count: number | undefined,
    indent: string,
    render: (value: T, indent: string) => string,
  ): string[] {
    const inner = this.#innerIndent(indent);
    const maxProperties = this.#limits.maxProperties;

    if (entries.length > maxProperties) {
      count = entries.length;
      entries = entries.slice(0, maxProperties);
    }

    const parts = entries.map(([key, subvalue]) => {
      const rendered = render(subvalue, inner);
      return `${DebugStringifier.#renderKey(key)}${this.#colon}${rendered}`;
    });

    if (count !== undefined) {
      parts.push(this.#renderElision("count", count));
    }

    return parts;
  }

  /**
   * Renders the given value, whose closing bracket (when the value is a
   * container and the rendering is multi-line) is indented by `indent`.
   */
  #renderSubvalue(value: FabricValue, indent: string): string {
    switch (typeof value) {
      case "bigint": {
        return `${value}n`;
      }

      case "boolean":
      case "undefined": {
        return String(value);
      }

      case "number": {
        // `String(-0)` is `0`, so negative zero is the one number that needs
        // special handling.
        return Object.is(value, -0) ? "-0" : String(value);
      }

      case "string": {
        return this.#renderString(value, indent);
      }

      case "symbol": {
        // The conversion represents a unique symbol as a tagged object, so
        // only an interned symbol arrives here.
        return `@${DebugStringifier.#renderKey(Symbol.keyFor(value) ?? "")}`;
      }

      case "object": {
        if (value === null) {
          return "null";
        } else if (Array.isArray(value)) {
          return this.#renderArray(value, indent);
        } else if (value instanceof FabricPrimitive) {
          return this.#renderFabricPrimitive(value, indent);
        } else {
          // The conversion represents every other non-plain object as a plain
          // one, so what is left is a plain object.
          return this.#renderPlainObject(value as FabricPlainObject, indent);
        }
      }

      // deno-coverage-ignore-start
      // This will only happen if JS introduces a new type.
      default: {
        throw new Error(`Shouldn't happen: unknown type \`${typeof value}\``);
      }
        // deno-coverage-ignore-stop
    }
  }

  /**
   * Renders one of the conversion's single-key tagged forms, as what it
   * stands for, with a container's closing bracket (when there is one and
   * the rendering is multi-line) indented by `indent`.
   */
  #renderTaggedForm(tagged: TaggedForm, indent: string): string {
    const { tag, payload } = tagged;

    if (isCodecTypeTag(tag)) {
      // A `FabricInstance`, carried as its encoding under its codec type tag,
      // laid out the way a class instance is.
      return this.#renderInstance(
        DebugStringifier.#typeNameOf(tag),
        payload,
        indent,
      );
    }

    switch (tag) {
      case "circle": {
        // A reference back to an enclosing object.
        return "<circle>";
      }

      case "uniqueSymbol": {
        // A unique (uninterned) symbol, whose payload is its description.
        return (payload === undefined)
          ? "Symbol()"
          : `Symbol(${JSON.stringify(payload)})`;
      }

      case "function": {
        // A function, whose payload names it, or is `/unconvertible` when
        // even that failed; the latter falls through to render as it is.
        const name = (typeof payload === "string")
          ? payload.match(/^(?<name>.*)\(\.\.\.\)$/)?.groups?.name
          : undefined;
        if (name === "<anonymous>") {
          return `(...)${this.#spacer}=>${this.#spacer}{...}`;
        } else if (name !== undefined) {
          return `function ${name}(...)${this.#spacer}{...}`;
        }
        return this.#renderInstance(tag, payload, indent);
      }

      case "unconvertible": {
        // A value the conversion could not read, whose payload is the
        // error's message.
        return this.#renderInstance(tag, payload, indent);
      }

      case "...": {
        // The elision marker: the array-length form when its payload is an
        // object holding a `length`, and otherwise the depth-limit form,
        // whose payload -- what kind of value was elided -- is left out of
        // the rendering.
        const length = DebugStringifier.#lengthOf(payload);
        return (length === undefined)
          ? "..."
          : this.#renderElision("length", length);
      }

      case "partialString": {
        // The excerpt of a string too long to carry whole, followed by the
        // length of the whole. A payload not of that shape falls through to
        // render as it is.
        const partial = DebugStringifier.#partialStringOf(payload);
        if (partial !== undefined) {
          return this.#renderPartialString(partial, indent);
        }
        // deno-coverage-ignore-start
        // The conversion is the form's only producer and shapes it no other
        // way, so this fallthrough is a prophylactic no test can reach.
        return this.#renderInstance(tag, payload, indent);
      }
      // deno-coverage-ignore-stop

      default: {
        // A class instance, carried under its class name.
        return this.#renderInstance(tag, payload, indent);
      }
    }
  }

  /** Returns the indentation for the contents of a container indented by `indent`. */
  #innerIndent(indent: string): string {
    return this.#isCompact ? indent : `${indent}${this.#singleIndent}`;
  }

  /**
   * Renders an `ArrayBuffer` as `buf [...]`, the space being the spacer, with
   * its bytes in hexadecimal and a space after every fourth byte in either
   * mode. A buffer with more bytes than the maximum buffer length has that
   * many rendered, and after them, set off by a space in either mode, its
   * length.
   */
  #renderBuffer(buffer: ArrayBuffer): string {
    const length = buffer.byteLength;
    const cut = Math.min(length, this.#limits.maxBufferLength);
    const hex = [...new Uint8Array(buffer, 0, cut)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .replace(/.{8}(?=.)/g, "$& ");
    const elision = (cut < length)
      ? ` ${this.#renderElision("length", length)}`
      : "";
    return `buf${this.#spacer}[${hex}${elision}]`;
  }

  /**
   * Renders the note which stands for what a limit cut: an ellipsis, then
   * the actual measure under `label`, which names what was measured.
   */
  #renderElision(label: string, measure: number): string {
    return `...${this.#spacer}${label}${this.#colon}${measure}`;
  }

  /**
   * Renders the string-length form: the excerpt as `#renderString()` renders
   * it, followed by the length of the whole. The length follows on the same
   * line, or when the rendering is multi-line, on a line of its own, indented
   * by the inner indentation of `indent`.
   */
  #renderPartialString(partial: PartialString, indent: string): string {
    const rendered = this.#renderString(partial.excerpt, indent);
    const separator = this.#isCompact
      ? this.#spacer
      : `\n${this.#innerIndent(indent)}`;
    const length = this.#renderElision("length", partial.length);

    return `${rendered}${this.#spacer}+${separator}${length}`;
  }

  /**
   * Renders a string. When the rendering is multi-line and the string holds a
   * line break, each of its lines renders quoted on a line of its own, every
   * line but the last followed by ` +` and every line but the first indented
   * by the inner indentation of `indent`. Otherwise the string renders whole,
   * quoted.
   */
  #renderString(value: string, indent: string): string {
    const lines = DebugStringifier.#linesOf(value);

    if (this.#isCompact || (lines.length === 1)) {
      return JSON.stringify(value);
    }

    const inner = this.#innerIndent(indent);
    return lines.map((line) => JSON.stringify(line)).join(` +\n${inner}`);
  }

  //
  // Static members
  //

  /**
   * Renders the elided form of a `FabricPrimitive` whose state cannot be had,
   * given its class name. The slash suggests a known encodable type rather
   * than an instance of some random class.
   */
  static #renderElidedInstance(name: string): string {
    return `${DebugStringifier.#renderTypeName(name)}(...)`;
  }

  /**
   * Returns the type name of a codec type tag: the tag less its encoding
   * version, which a rendering leaves out.
   */
  static #typeNameOf(tag: string): string {
    return tag.replace(/@.*$/, "");
  }

  /**
   * Renders a key -- an object property name, a symbol's key, or a type name
   * -- bare when it is a valid identifier, and as a quoted string otherwise.
   * The identifier check is the ASCII one.
   */
  static #renderKey(key: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
  }

  /**
   * Renders the type name a tagged form opens with: a slash, then the name as
   * `#renderKey()` renders it. The `<anonymous>` marker, which stands for a
   * class with no name, stays bare.
   */
  static #renderTypeName(name: string): string {
    const rendered = (name === "<anonymous>")
      ? name
      : DebugStringifier.#renderKey(name);
    return `/${rendered}`;
  }

  /**
   * Returns the `count` of the given value when it is a plain object whose
   * `count` is a number, which is the payload shape of the property-count
   * form, and `undefined` when it is not.
   */
  static #countOf(value: FabricValue): number | undefined {
    return DebugStringifier.#measureOf(value, "count");
  }

  /**
   * Returns the `length` of the given value when it is a plain object whose
   * `length` is a number, which is the payload shape of the array-length
   * form, and `undefined` when it is not.
   */
  static #lengthOf(value: FabricValue): number | undefined {
    return DebugStringifier.#measureOf(value, "length");
  }

  /**
   * Returns the property `name` of the given value when it is a plain object
   * whose property so named is a number, and `undefined` when it is not.
   */
  static #measureOf(value: FabricValue, name: string): number | undefined {
    if (!isPlainObject(value)) {
      return undefined;
    }

    const measure = value[name];
    return (typeof measure === "number") ? measure : undefined;
  }

  /**
   * Returns the lines of the given string, each with its line break kept. A
   * string ending in a line break has no empty line after it, and the empty
   * string is one empty line.
   */
  static #linesOf(value: string): string[] {
    const lines = value.split(AFTER_LINE_BREAK_REGEX);

    if ((lines.length > 1) && (lines.at(-1) === "")) {
      lines.pop();
    }

    return lines;
  }

  /**
   * Returns the length and excerpt of the given value when it is the payload
   * shape of the string-length form, a plain object whose `length` is a
   * number and whose `excerpt` is a string, and `undefined` when it is not.
   */
  static #partialStringOf(value: FabricValue): PartialString | undefined {
    // deno-coverage-ignore-start
    // The conversion shapes the form no other way; see the `partialString`
    // arm of `#renderTaggedForm()`.
    if (!isPlainObject(value)) {
      return undefined;
    }
    // deno-coverage-ignore-stop

    const { length, excerpt } = value;
    return ((typeof length === "number") && (typeof excerpt === "string"))
      ? { length, excerpt }
      : undefined;
  }

  /**
   * Returns the tag and payload of the given plain object when it is one of the
   * conversion's single-key tagged forms, and `undefined` when it is not. No key
   * of an original value can arrive in such a form, because the conversion
   * escapes a key with a leading slash and an unsafe key alike, by prefixing a
   * slash; the second-character check rules out the one and the unsafe-key
   * check the other.
   */
  static #taggedFormOf(value: FabricPlainObject): TaggedForm | undefined {
    const keys = Object.keys(value);
    const onlyKey = (keys.length === 1) ? keys[0] : undefined;

    if (
      (onlyKey === undefined) || (onlyKey[0] !== "/") || (onlyKey[1] === "/") ||
      isUnsafeObjectKey(onlyKey.slice(1))
    ) {
      return undefined;
    }

    return { tag: onlyKey.slice(1), payload: value[onlyKey] };
  }
}
