import type { JSONValue } from "@commonfabric/api";
import { isDeepFrozen } from "@commonfabric/data-model";
import { LRUCache } from "@commonfabric/utils/cache";
import { isPlainObject } from "@commonfabric/utils/types";

import { isReactive } from "./builder/types.ts";
import { type AnyCell, isCell } from "./cell.ts";
import { createRef, type EntityId } from "./create-ref.ts";
import { encodableFormOf } from "./encodable-form.ts";
import { isCellResultForDereferencing } from "./query-result-proxy.ts";

/**
 * How many ids an instance keeps unless told otherwise. A piece asks for the id of each cell it
 * owns many times over while it starts, and seldom after, so the bound is
 * sized for the pieces starting at one time rather than for every piece a
 * runtime ever ran.
 */
const ID_LIMIT = 65_536;

/**
 * The ids of derived internal cells: the cells a pattern owns on a result
 * cell, each named by a partial cause. An id is the hash of the result
 * cell's entity and the partial cause, so it is a function of the two, and
 * an instance keeps the ids it has hashed most recently: a piece's start
 * asks for the id of each cell it owns once per node that binds it and once
 * more per action whose scheduler summary lists it.
 *
 * A partial cause that is a string, a number, a boolean or `null` is told
 * apart by value. A deep-frozen object is told apart by identity: such an
 * object names the same id for as long as it lives. Any other object or
 * array made of JSON values is told apart by its content, read when it is
 * asked about, so a cause that changes names the id of what it holds at the
 * time. An id is hashed on every call for a partial cause holding anything
 * else, a cell or a function among them.
 */
export class DerivedInternalCellIds {
  #ids: LRUCache<string, EntityId>;
  #causeNumbers = new WeakMap<object, number>();
  #nextCauseNumber = 0;
  #mintRecorder:
    | ((resultId: string, partialCause: JSONValue) => void)
    | undefined;

  /** Constructs an instance which keeps at most `capacity` ids. */
  constructor(capacity: number = ID_LIMIT) {
    this.#ids = new LRUCache<string, EntityId>({ capacity });
  }

  /**
   * The observer of every id this instance mints, by the result cell's id
   * and the partial cause, which a test counts.
   */
  get accessForTestingOnly(): {
    mintRecorder:
      | ((resultId: string, partialCause: JSONValue) => void)
      | undefined;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get mintRecorder() {
        return outerThis.#mintRecorder;
      },
      set mintRecorder(value) {
        outerThis.#mintRecorder = value;
      },
    };
  }

  /**
   * Returns the id of the derived internal cell `partialCause` names on
   * `resultCell`. The id carries no entity kind: the caller applies one when
   * it writes the id as a URI.
   */
  idFor(resultCell: AnyCell<unknown>, partialCause: JSONValue): EntityId {
    const resultId = resultCell.getAsNormalizedFullLink().id;
    const cause = this.#causeKey(partialCause);
    if (cause === undefined) return this.#mint(resultCell, partialCause);
    // A cause key holds no line break, so the first one ends it.
    const key = `${cause}\n${resultId}`;
    let id = this.#ids.get(key);
    if (id === undefined) {
      id = this.#mint(resultCell, partialCause);
      this.#ids.put(key, id);
    }
    return id;
  }

  /** Hashes the id `partialCause` names on `resultCell`. */
  #mint(resultCell: AnyCell<unknown>, partialCause: JSONValue): EntityId {
    this.#mintRecorder?.(
      resultCell.getAsNormalizedFullLink().id,
      partialCause,
    );
    return createRef(
      {},
      {
        parent: resultCell.entityId ?? resultCell,
        type: "internal",
        cause: partialCause,
      },
    );
  }

  /**
   * The key component standing for `partialCause`, or `undefined` for a
   * value this instance keeps no id for. Each kind of value has a tag of its
   * own, so `1`, `"1"` and `true` share no key.
   */
  #causeKey(partialCause: JSONValue): string | undefined {
    switch (typeof partialCause) {
      case "string":
        return `s${JSON.stringify(partialCause)}`;
      case "number":
        return `n${Object.is(partialCause, -0) ? "-0" : partialCause}`;
      case "boolean":
        return `b${partialCause}`;
      case "object": {
        if (partialCause === null) return "l";
        if (!isDeepFrozen(partialCause)) {
          const content = jsonContentKey(partialCause, new Set());
          return content === undefined ? undefined : `c${content}`;
        }
        let number = this.#causeNumbers.get(partialCause);
        if (number === undefined) {
          number = this.#nextCauseNumber++;
          this.#causeNumbers.set(partialCause, number);
        }
        return `o${number}`;
      }
      default:
        return undefined;
    }
  }
}

/**
 * The sentinel `encodableFormOf()` returns for a value carrying no encodable
 * form, which is every plain JSON value.
 */
const NO_ENCODABLE_FORM = Symbol("noEncodableForm");

/**
 * Helper for `DerivedInternalCellIds`, which returns a key standing for the
 * content of `value`, a partial cause or part of one, or `undefined` where
 * `value` holds anything but JSON data. Two causes get one key only where
 * `createRef()` derives one id from them, so the key follows what that
 * derivation reads: a string, a number (with `-0` and `NaN` kept apart from
 * what `JSON.stringify()` makes of them), a boolean, `null`, a hole or an
 * `undefined` in an array, the items of a plain array in order, and the
 * entries of a plain object by key, so that two objects equal but for key
 * order share a key as they share a hash. An object reached a second time
 * within one cause derives as `null`, so `seen` holds the objects reached so
 * far and a repeat is keyed as `null` is; the entries are read in the order
 * the derivation reads them, which is what decides which occurrence is the
 * repeat, and sorted by key only once read. A value other than JSON data is
 * refused rather than keyed: a cell, a reactive, a query result, a function,
 * a class instance, a value carrying an encodable form, or a record holding
 * a `/` key, which is how a link or an entity reference is written.
 */
function jsonContentKey(
  value: unknown,
  seen: Set<object>,
): string | undefined {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Object.is(value, -0) ? "-0" : String(value);
    case "boolean":
      return value ? "t" : "f";
    case "undefined":
      return "u";
    case "object": {
      if (value === null) return "l";
      if (seen.has(value)) return "l";
      if (standsForAnotherValue(value)) return undefined;
      seen.add(value);
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let index = 0; index < value.length; index++) {
          if (!(index in value)) {
            items.push("h");
            continue;
          }
          const item = jsonContentKey(value[index], seen);
          if (item === undefined) return undefined;
          items.push(item);
        }
        return `[${items.join(",")}]`;
      }
      if (!isPlainObject(value) || Object.hasOwn(value, "/")) {
        return undefined;
      }
      const entries: [string, string][] = [];
      for (const [key, member] of Object.entries(value)) {
        const content = jsonContentKey(member, seen);
        if (content === undefined) return undefined;
        entries.push([JSON.stringify(key), content]);
      }
      entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return `{${
        entries.map(([key, content]) => `${key}:${content}`).join(",")
      }}`;
    }
    default:
      return undefined;
  }
}

/**
 * Helper for {@link jsonContentKey}, which indicates whether `createRef()`
 * derives `value` from something other than its own entries: a value
 * carrying an encodable form, a reactive, a query result, or a cell. Stated
 * without a type guard, so that the caller's value keeps its type on the
 * other branch.
 */
function standsForAnotherValue(value: object): boolean {
  return encodableFormOf(value, NO_ENCODABLE_FORM) !== NO_ENCODABLE_FORM ||
    isReactive(value) || isCellResultForDereferencing(value) || isCell(value);
}
