/**
 * The marker for data that is not available, and its two vocabularies: the
 * reasons it can give, and the kinds of error the `error` reason sorts into,
 * each as a runtime table beside the class; the message each kind falls back
 * to; and one message-free prefab per non-error reason. The codecs decode a
 * message-free non-error state to its prefab rather than to a fresh instance,
 * though nothing turns
 * on that: two instances with the same state are equal by content however
 * they were made.
 */

import type {
  FabricUnavailable as ApiFabricUnavailable,
  FabricUnavailableConstructor as ApiFabricUnavailableConstructor,
  UnavailableErrorKind,
  UnavailableReason,
} from "@/api.ts";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import type { MustBeTrue, Same } from "@commonfabric/js-values/types";
import { isPlainObject } from "@commonfabric/js-values/types";

import { BaseFabricPrimitive, VALUE_TAG } from "@/fabric-bases";
import { BLESSING_TOKEN } from "@/fabric-bases/blessing.ts";
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
    obsolete: "obsolete",
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
  message?: string;
};

/** The reasons that have a message-free prefab instance. */
type PrefabReason = Exclude<UnavailableReason, "error">;

/**
 * A marker standing in for data that is not available, saying why. It holds
 * no payload of its own: its reason and diagnostic fields are the whole of
 * what it says, so it is a `FabricPrimitive` rather than a container.
 *
 * The reasons split along one axis, which `isTransient()` reports: `pending`
 * and `syncing` say the data is on its way, `error` says producing it failed,
 * and `obsolete` says the output is no longer served. Only `error` carries
 * an error kind. Both terminal reasons may carry a `message`: error details
 * or migration guidance. Diagnostics confer no authority to act.
 * The constructor refuses the other pairings.
 * See Section 1.4.12 of `1-fabric-values.md`.
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
  readonly #message: string | null;

  /**
   * Constructs an instance with the given reason, kind of error, and
   * message. Throws when `reason` is not one of the reasons; when it is
   * `error` and `errorKind` is not one of the kinds; or when it is a
   * non-error reason and `errorKind` is not `null`; or when `message` is
   * non-string or belongs to a transient reason.
   */
  constructor(
    reason: UnavailableReason,
    errorKind: UnavailableErrorKind | null = null,
    message: string | null = null,
  ) {
    super(BLESSING_TOKEN, FabricUnavailable);

    if (
      (typeof reason !== "string") ||
      !Object.hasOwn(UNAVAILABLE_REASONS, reason)
    ) {
      throw new Error(
        debugStr`Not an \`UnavailableReason\`: $quote${reason}`,
      );
    }

    let storedMessage: string | null = null;

    if ((message !== null) && (typeof message !== "string")) {
      throw new Error(debugStr`Not a \`message\`: $quote${message}`);
    }

    if (reason === UNAVAILABLE_REASONS.error) {
      if (
        (typeof errorKind !== "string") ||
        !Object.hasOwn(UNAVAILABLE_ERROR_KINDS, errorKind)
      ) {
        throw new Error(
          debugStr`Reason \`error\` requires an \`UnavailableErrorKind\`, not $quote${errorKind}.`,
        );
      }
      // A message equal to the kind's default is stored as none.
      storedMessage =
        (message === FabricUnavailable.#DEFAULT_ERROR_MESSAGES[errorKind])
          ? null
          : message;
    } else if (errorKind !== null) {
      throw new Error(
        debugStr`Reason $quote${reason} takes no \`errorKind\`.`,
      );
    } else if (reason === UNAVAILABLE_REASONS.obsolete) {
      storedMessage = message;
    } else if (message !== null) {
      throw new Error(debugStr`Reason $quote${reason} takes no \`message\`.`);
    }

    this.#reason = reason;
    this.#errorKind = errorKind;
    this.#message = storedMessage;
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
   * Diagnostic text for a terminal reason: error details or migration guidance.
   * An error with no stored message supplies its kind's default. `null` for
   * transient reasons and an obsolete output with no guidance.
   */
  get message(): string | null {
    const kind = this.#errorKind;

    return (kind === null)
      ? this.#message
      : (this.#message ?? FabricUnavailable.#DEFAULT_ERROR_MESSAGES[kind]);
  }

  /**
   * The message as stored, with no default supplied: `null` for transient
   * reasons, an obsolete output with no guidance, and an error whose message
   * is its kind's default or was never given. Codecs and the hasher read this.
   */
  get rawMessage(): string | null {
    return this.#message;
  }

  /** Whether the reason is `pending`. */
  isPending(): boolean {
    return this.#reason === UNAVAILABLE_REASONS.pending;
  }

  /** Whether the reason is `syncing`. */
  isSyncing(): boolean {
    return this.#reason === UNAVAILABLE_REASONS.syncing;
  }

  /** Whether the output is no longer served. */
  isObsolete(): boolean {
    return this.#reason === UNAVAILABLE_REASONS.obsolete;
  }

  /**
   * Whether the reason is `error`, narrowing `errorKind` and `message`
   * to the non-`null` values the `error` reason always carries.
   */
  isError(): this is {
    readonly errorKind: UnavailableErrorKind;
    readonly message: string;
  } {
    return this.#reason === UNAVAILABLE_REASONS.error;
  }

  /**
   * Whether the data is on its way: `true` for `pending` and `syncing`,
   * `false` for `error` and `obsolete`.
   */
  isTransient(): boolean {
    return this.#reason === UNAVAILABLE_REASONS.pending ||
      this.#reason === UNAVAILABLE_REASONS.syncing;
  }

  /**
   * The encoded state of `this`, which is what both codecs emit: the reason,
   * the kind when there is one, and the message when one is stored, as a
   * frozen record.
   */
  #state(): FabricUnavailableState {
    const reason = this.#reason;
    const errorKind = this.#errorKind;
    const message = this.#message;

    if (errorKind === null) {
      return Object.freeze(message === null ? { reason } : { reason, message });
    } else if (message === null) {
      return Object.freeze({ reason, errorKind });
    } else {
      return Object.freeze({ reason, errorKind, message });
    }
  }

  //
  // Static members
  //

  static {
    Object.freeze(this);
    Object.freeze(this.prototype);
  }

  /**
   * The message `message` returns for each kind when none was stored.
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
        mutable = false,
      ): FabricValue {
        try {
          return FabricUnavailable.#instanceForState(state);
        } catch (e) {
          return ProblematicValue.make(
            typeTag,
            state,
            `Unavailable: ${describeFailure(e)}`,
            mutable,
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
        mutable = false,
      ): FabricValue {
        try {
          return FabricUnavailable.#instanceForState(state);
        } catch (e) {
          return ProblematicValue.make(
            typeTag,
            state,
            describeFailure(e),
            mutable,
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
   * present at all, is one of the kinds, and whose own `message`, if
   * present at all, is a string. Every field
   * is read as an own property, so
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

    const { reason, errorKind, message } = state as {
      reason: unknown;
      errorKind?: unknown;
      message?: unknown;
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

    return !Object.hasOwn(state, "message") || (typeof message === "string");
  }

  /** Whether the reason has a message-free prefab. */
  static #isPrefabReason(
    reason: UnavailableReason,
  ): reason is PrefabReason {
    return reason !== UNAVAILABLE_REASONS.error;
  }

  /**
   * Helper for `#instanceForState()`, which returns the prefab instance for
   * a non-error reason. The `switch` is exhaustive with no default, so a
   * prefab reason added without an instance stops this file compiling.
   */
  static #prefabFor(reason: PrefabReason): FabricUnavailable {
    switch (reason) {
      case UNAVAILABLE_REASONS.pending: {
        return UNAVAILABLE_PENDING;
      }

      case UNAVAILABLE_REASONS.syncing: {
        return UNAVAILABLE_SYNCING;
      }

      case UNAVAILABLE_REASONS.obsolete: {
        return UNAVAILABLE_OBSOLETE;
      }
    }
  }

  /**
   * Helper for both codecs' `decode()`, which returns the instance a decoded
   * state stands for: the prefab for a non-error reason alone, and a fresh
   * instance otherwise. Throws as
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
    const message = Object.hasOwn(state, "message") ? state.message : undefined;

    if (
      FabricUnavailable.#isPrefabReason(reason) &&
      (errorKind === undefined) && (message === undefined)
    ) {
      return FabricUnavailable.#prefabFor(reason);
    }

    return new FabricUnavailable(
      reason,
      errorKind ?? null,
      message ?? null,
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

/** The message-free instance for reason `obsolete`. */
export const UNAVAILABLE_OBSOLETE = new FabricUnavailable(
  UNAVAILABLE_REASONS.obsolete,
);

// Compile-time check that the exported `FabricUnavailable` constructor matches
// the `FabricUnavailableConstructor` declared in `@/api.ts`. This catches a
// declared member that is missing here or has the wrong type. It does NOT
// catch the other direction: `satisfies` is an assignability check, so a
// public member on this class that the declaration omits passes silently.
// Members added here need adding there by hand.
FabricUnavailable satisfies ApiFabricUnavailableConstructor;
