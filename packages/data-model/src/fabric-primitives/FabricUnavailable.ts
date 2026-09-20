/**
 * The marker for data that is not available, and its two vocabularies: the
 * reasons it can give, and the kinds of error the `error` reason sorts into,
 * each as a runtime table beside the class; the message each kind falls back
 * to; and one prefab instance per transient reason. The codecs decode a state
 * naming a transient reason to the prefab rather than to a fresh instance, so
 * the two are the canonical instances of what they name, though nothing turns
 * on that: two instances with the same state are equal by content however
 * they were made.
 */

import type {
  FabricUnavailable as ApiFabricUnavailable,
  FabricUnavailableConstructor as ApiFabricUnavailableConstructor,
  UnavailableErrorKind,
  UnavailableReason,
} from "@/api.ts";
import type { MustBeTrue, Same } from "@commonfabric/utils/types";
import { isPlainObject } from "@commonfabric/utils/types";

import { BaseFabricPrimitive, VALUE_TAG } from "@/fabric-bases";
import { ProblematicValue } from "@/codec-common";
import { BaseNonterminalCodec } from "@/codec-interface/BaseNonterminalCodec.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import {
  JSON_CODEC,
  type LiveEnvironment,
  type NonterminalCodec,
  REALM_CODEC,
  type TerminalCodec,
} from "@/codec-interface/interface.ts";
import type { RealmCodecValue } from "@/codec-realm";
import type { FabricValue } from "@/interface.ts";
import { debugStr } from "@/value-debug";
import {
  FABRIC_PRIMITIVE_VALUE_TAGS,
  type FabricPrimitiveValueTag,
} from "./interface.ts";

/**
 * The reasons a `FabricUnavailable` can give, as a table keyed by itself, so
 * that a reason arriving as an untyped string can be checked against the set.
 * `UnavailableReason` in `api.ts` is the same set as a type; the agreement
 * guard beside this table stops compiling when the two part.
 */
export const UNAVAILABLE_REASONS = Object.freeze(
  {
    pending: "pending",
    syncing: "syncing",
    error: "error",
  } as const,
);

/** Whether the reasons table and the declared type name the same reasons. */
export type ReasonsAgree = MustBeTrue<
  Same<
    typeof UNAVAILABLE_REASONS[keyof typeof UNAVAILABLE_REASONS],
    UnavailableReason
  >
>;

/**
 * The kinds of error the `error` reason sorts into, as a table keyed by
 * itself, for the same purpose as `UNAVAILABLE_REASONS`. `UnavailableErrorKind`
 * in `api.ts` is the same set as a type, and the guard beside this table holds
 * the two together.
 */
export const UNAVAILABLE_ERROR_KINDS = Object.freeze(
  {
    general: "general",
    schemaMismatch: "schemaMismatch",
    invalidInput: "invalidInput",
    network: "network",
    decode: "decode",
    compile: "compile",
    provider: "provider",
    sync: "sync",
  } as const,
);

/** Whether the kinds table and the declared type name the same kinds. */
export type ErrorKindsAgree = MustBeTrue<
  Same<
    typeof UNAVAILABLE_ERROR_KINDS[keyof typeof UNAVAILABLE_ERROR_KINDS],
    UnavailableErrorKind
  >
>;

/**
 * The encoded state of a {@link FabricUnavailable}: the reason; for the
 * `error` reason the kind; and the message when one is stored. A field that
 * has nothing to say is absent rather than `null`, so that the state of a
 * transient reason is exactly the reason.
 */
type FabricUnavailableState = {
  reason: UnavailableReason;
  errorKind?: UnavailableErrorKind;
  errorMessage?: string;
};

/** The reasons that have a prefab instance: every reason but `error`. */
type TransientReason = Exclude<UnavailableReason, "error">;

/**
 * A marker standing in for data that is not available, saying why. It holds
 * no data of its own: the reason, and for the `error` reason the kind of
 * error and a message, are the whole of what it says, so it is a
 * `FabricPrimitive` rather than a container.
 *
 * The reasons split along one axis, which `isTransient()` reports: `pending`
 * and `syncing` say the data is on its way, and `error` says producing it
 * failed. Only the `error` reason carries a kind, and it always does; only
 * the `error` reason may carry a message, and `errorMessage` supplies one for
 * its kind when none was given. The constructor refuses the other pairings.
 * See Section 1.4.12 of the formal spec.
 */
export class FabricUnavailable extends BaseFabricPrimitive
  implements ApiFabricUnavailable {
  /** Why the data is unavailable. */
  readonly #reason: UnavailableReason;

  /** The kind of error, when the reason is `error`; `null` otherwise. */
  readonly #errorKind: UnavailableErrorKind | null;

  /**
   * The message as stored: `null` when none was given, and also when the one
   * given is the kind's default, which is stored as no message at all.
   */
  readonly #errorMessage: string | null;

  /**
   * Constructs an instance with the given reason, kind of error, and
   * message. Throws when `reason` is not one of the reasons; when it is
   * `error` and `errorKind` is not one of the kinds; or when it is a
   * transient reason and either `errorKind` or `errorMessage` is not `null`.
   */
  constructor(
    reason: UnavailableReason,
    errorKind: UnavailableErrorKind | null = null,
    errorMessage: string | null = null,
  ) {
    super();

    if (
      (typeof reason !== "string") ||
      !Object.hasOwn(UNAVAILABLE_REASONS, reason)
    ) {
      throw new Error(
        debugStr`Not an \`UnavailableReason\`: $quote${reason}`,
      );
    }

    let storedMessage: string | null = null;

    if (reason === UNAVAILABLE_REASONS.error) {
      if (
        (typeof errorKind !== "string") ||
        !Object.hasOwn(UNAVAILABLE_ERROR_KINDS, errorKind)
      ) {
        throw new Error(
          debugStr`Reason \`error\` requires an \`UnavailableErrorKind\`, not $quote${errorKind}.`,
        );
      }
      if ((errorMessage !== null) && (typeof errorMessage !== "string")) {
        throw new Error(
          debugStr`Not an \`errorMessage\`: $quote${errorMessage}`,
        );
      }
      // A message equal to the kind's default is stored as none.
      storedMessage =
        (errorMessage === FabricUnavailable.#DEFAULT_ERROR_MESSAGES[errorKind])
          ? null
          : errorMessage;
    } else if ((errorKind !== null) || (errorMessage !== null)) {
      throw new Error(
        debugStr`Reason $quote${reason} takes neither an \`errorKind\` nor an \`errorMessage\`.`,
      );
    }

    this.#reason = reason;
    this.#errorKind = errorKind;
    this.#errorMessage = storedMessage;
  }

  //
  // Instance members
  //

  /** @inheritDoc */
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return FABRIC_PRIMITIVE_VALUE_TAGS.FabricUnavailable;
  }

  /** @inheritDoc */
  get schemaType(): "FabricUnavailable" {
    return "FabricUnavailable";
  }

  /** Why the data is unavailable. */
  get reason(): UnavailableReason {
    return this.#reason;
  }

  /** The kind of error, when the reason is `error`; `null` otherwise. */
  get errorKind(): UnavailableErrorKind | null {
    return this.#errorKind;
  }

  /**
   * The message, when the reason is `error`: the one stored, or the kind's
   * default when none is. `null` for a transient reason.
   */
  get errorMessage(): string | null {
    const kind = this.#errorKind;

    return (kind === null)
      ? null
      : (this.#errorMessage ?? FabricUnavailable.#DEFAULT_ERROR_MESSAGES[kind]);
  }

  /**
   * The message as stored, with no default supplied: `null` for a transient
   * reason, and for an `error` whose message is its kind's default or was
   * never given. This is what the codecs and the hasher read.
   */
  get rawErrorMessage(): string | null {
    return this.#errorMessage;
  }

  /** Whether the reason is `pending`. */
  isPending(): boolean {
    return this.#reason === UNAVAILABLE_REASONS.pending;
  }

  /** Whether the reason is `syncing`. */
  isSyncing(): boolean {
    return this.#reason === UNAVAILABLE_REASONS.syncing;
  }

  /**
   * Whether the reason is `error`, narrowing `errorKind` and `errorMessage`
   * to the non-`null` values the `error` reason always carries.
   */
  isError(): this is {
    readonly errorKind: UnavailableErrorKind;
    readonly errorMessage: string;
  } {
    return this.#reason === UNAVAILABLE_REASONS.error;
  }

  /**
   * Whether the data is on its way rather than failed: `true` for the
   * `pending` and `syncing` reasons, `false` for `error` whatever its kind.
   */
  isTransient(): boolean {
    return this.#reason !== UNAVAILABLE_REASONS.error;
  }

  /**
   * The encoded state of `this`, which is what both codecs emit: the reason,
   * the kind when there is one, and the message when one is stored.
   */
  #state(): FabricUnavailableState {
    const reason = this.#reason;
    const errorKind = this.#errorKind;
    const errorMessage = this.#errorMessage;

    if (errorKind === null) {
      return { reason };
    } else if (errorMessage === null) {
      return { reason, errorKind };
    } else {
      return { reason, errorKind, errorMessage };
    }
  }

  //
  // Static members
  //

  /**
   * The message `errorMessage` returns for each kind when none was stored.
   * Presentation rather than state: none of these is ever encoded or hashed,
   * and a message given at construction that equals its kind's entry here is
   * stored as no message at all.
   */
  static #DEFAULT_ERROR_MESSAGES: Readonly<
    Record<UnavailableErrorKind, string>
  > = Object.freeze({
    general: "An error occurred.",
    schemaMismatch: "The value does not match its schema.",
    invalidInput: "An input is invalid.",
    network: "A network request failed.",
    decode: "A response could not be decoded.",
    compile: "Compilation failed.",
    provider: "A provider reported a failure.",
    sync: "Synchronization failed.",
  });

  static #jsonCodec = Object.freeze(
    new (class UnavailableCodec
      extends BaseNonterminalCodec<never, FabricUnavailableState> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.Unavailable, FabricUnavailable);
      }

      /** @inheritDoc */
      encode(
        value: FabricUnavailable,
        _env: LiveEnvironment,
      ): FabricUnavailableState {
        return value.#state();
      }

      /** @inheritDoc */
      canDecode(state: FabricValue): state is FabricUnavailableState {
        return FabricUnavailable.#isState(state);
      }

      /**
       * @inheritDoc
       *
       * A kind or a message paired with a transient reason, or an `error`
       * reason without a kind, is a state this class never writes, and is
       * reported rather than refused by {@link #canDecode}: the constructor
       * is what decides the pairing, and it is asked once.
       */
      decode(
        typeTag: string,
        state: FabricUnavailableState,
        _env: LiveEnvironment,
      ): FabricValue {
        try {
          return FabricUnavailable.#instanceForState(state);
        } catch (e) {
          return new ProblematicValue(
            typeTag,
            state,
            `Unavailable: ${(e instanceof Error) ? e.message : String(e)}`,
          );
        }
      }
    })(),
  );

  static #realmCodec = Object.freeze(
    new (class UnavailableCodec extends BaseTerminalCodec<RealmCodecValue> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.Unavailable, FabricUnavailable);
      }

      /** @inheritDoc */
      encode(value: FabricUnavailable, _env: LiveEnvironment): RealmCodecValue {
        return value.#state();
      }

      /** @inheritDoc */
      canDecode(state: RealmCodecValue): state is FabricUnavailableState {
        return FabricUnavailable.#isState(state);
      }

      /**
       * @inheritDoc
       *
       * As on the JSON side, fields that do not belong with their reason are
       * reported here rather than refused by {@link #canDecode}.
       */
      decode(
        typeTag: string,
        state: FabricUnavailableState,
        _env: LiveEnvironment,
      ): FabricValue {
        try {
          return FabricUnavailable.#instanceForState(state);
        } catch (e) {
          return new ProblematicValue(
            typeTag,
            state,
            (e instanceof Error) ? e.message : String(e),
          );
        }
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [JSON_CODEC](): NonterminalCodec {
    return this.#jsonCodec;
  }

  /**
   * The codec for instances of this class in the realm-crossing format.
   *
   * Terminal, where JSON's is nonterminal, and the state is the same record
   * either way. As with `FabricRegExp`, a record of strings sits in both
   * domains at once, and terminal is what this format has to gain by: the walk
   * hands the record to the transport rather than descending into fields
   * whose shape it already knows.
   */
  static get [REALM_CODEC](): TerminalCodec<RealmCodecValue> {
    return this.#realmCodec;
  }

  /**
   * Helper for both codecs' `canDecode()`, which reports whether `state` has
   * the shape of a {@link FabricUnavailableState}: a plain object whose own
   * `reason` is one of the reasons, whose own `errorKind`, if
   * present at all, is one of the kinds, and whose own `errorMessage`, if
   * present at all, is a string. Every field is read as an own property, so
   * nothing inherited stands in for one. Presence is the test for the optional
   * fields rather than a comparison against `undefined`, because the realm
   * format carries `undefined` faithfully, and a field sent that way is a
   * malformation rather than an absence. Whether the fields present belong with
   * the reason is the constructor's to decide.
   */
  static #isState(state: unknown): state is FabricUnavailableState {
    if (!isPlainObject(state) || !Object.hasOwn(state, "reason")) {
      return false;
    }

    const { reason, errorKind, errorMessage } = state as {
      reason: unknown;
      errorKind?: unknown;
      errorMessage?: unknown;
    };

    if (
      (typeof reason !== "string") ||
      !Object.hasOwn(UNAVAILABLE_REASONS, reason)
    ) {
      return false;
    }

    if (
      Object.hasOwn(state, "errorKind") &&
      ((typeof errorKind !== "string") ||
        !Object.hasOwn(UNAVAILABLE_ERROR_KINDS, errorKind))
    ) {
      return false;
    }

    return !Object.hasOwn(state, "errorMessage") ||
      (typeof errorMessage === "string");
  }

  /** Helper for `#instanceForState()`, which reports whether `reason` is transient. */
  static #isTransientReason(
    reason: UnavailableReason,
  ): reason is TransientReason {
    return reason !== UNAVAILABLE_REASONS.error;
  }

  /**
   * Helper for `#instanceForState()`, which returns the prefab instance for
   * a transient reason. The `switch` is exhaustive with no default, so a
   * transient reason added without a prefab stops this file compiling.
   */
  static #prefabFor(reason: TransientReason): FabricUnavailable {
    switch (reason) {
      case UNAVAILABLE_REASONS.pending: {
        return UNAVAILABLE_PENDING;
      }

      case UNAVAILABLE_REASONS.syncing: {
        return UNAVAILABLE_SYNCING;
      }
    }
  }

  /**
   * Helper for both codecs' `decode()`, which returns the instance a decoded
   * state stands for: the prefab for a state that is a transient reason alone, and a fresh instance otherwise. Throws as
   * the constructor does when the fields present do not belong with the reason.
   * The optional fields are read as own properties, as `#isState()`
   * tested them, so a field that is only inherited is absent here too.
   */
  static #instanceForState(
    state: FabricUnavailableState,
  ): FabricUnavailable {
    const { reason } = state;
    const errorKind = Object.hasOwn(state, "errorKind")
      ? state.errorKind
      : undefined;
    const errorMessage = Object.hasOwn(state, "errorMessage")
      ? state.errorMessage
      : undefined;

    if (
      FabricUnavailable.#isTransientReason(reason) &&
      (errorKind === undefined) && (errorMessage === undefined)
    ) {
      return FabricUnavailable.#prefabFor(reason);
    }

    return new FabricUnavailable(
      reason,
      errorKind ?? null,
      errorMessage ?? null,
    );
  }
}

/** The instance for reason `pending`. */
export const UNAVAILABLE_PENDING = new FabricUnavailable(
  UNAVAILABLE_REASONS.pending,
);

/** The instance for reason `syncing`. */
export const UNAVAILABLE_SYNCING = new FabricUnavailable(
  UNAVAILABLE_REASONS.syncing,
);

// Compile-time check that the exported `FabricUnavailable` constructor matches
// the `FabricUnavailableConstructor` declared in `@/api.ts`. This catches a
// declared member that is missing here or has the wrong type. It does NOT
// catch the other direction: `satisfies` is an assignability check, so a
// public member on this class that the declaration omits passes silently.
// Members added here need adding there by hand.
FabricUnavailable satisfies ApiFabricUnavailableConstructor;
