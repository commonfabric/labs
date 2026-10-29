import type { JSONValue } from "@commonfabric/api";
import { debugStr, isDeepFrozen } from "@commonfabric/data-model";
import { LRUCache } from "@commonfabric/utils/cache";

import type { AnyCell } from "./cell.ts";
import { createRef, type EntityId } from "./create-ref.ts";

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
 * apart by value, and one that is an object by identity. An object cause must
 * be deep-frozen, as the builder leaves every cause it assigns, and so names
 * the same id for as long as it lives.
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
   *
   * @throws Error if `partialCause` is an object that is not deep-frozen.
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
   * own, so `1`, `"1"` and `true` share no key. Throws for an object that is
   * not deep-frozen.
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
          throw new Error(
            debugStr`Partial cause is not deep-frozen: $quote${partialCause}`,
          );
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
