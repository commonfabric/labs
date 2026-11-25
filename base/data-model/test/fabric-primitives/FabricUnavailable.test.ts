/**
 * The unavailable-data marker as a `FabricPrimitive`: a reason, and for the
 * `error` reason a kind and a message, with prefab instances for the two
 * transient reasons.
 *
 * The pairing of the error members with the reason is what most of this
 * checks, on the constructor and on each codec's decoding: a state carrying a
 * kind or a message with a transient reason, or lacking the kind `error`
 * requires, is a state this class never writes, and is reported as a
 * `ProblematicValue` rather than built, and so is a state holding a key no
 * field is named for. The message's default is checked from both sides:
 * `message` supplies it and `rawMessage` does not. A message given to the
 * constructor equal to the default is stored as none, where a decoded one is
 * kept as it arrived. The prefabs are checked by identity where a decode is
 * meant to yield one, and by content where equality is the question.
 */

import { expect } from "@std/expect";

import {
  FabricInstance,
  FabricPrimitive,
  hashStringOf,
  shallowFabricFromConvertibleJsValue,
  type UnavailableErrorKind,
  type UnavailableReason,
  type UnavailableState,
  valueEqual,
} from "@";
import {
  BaseTerminalCodec,
  CODEC_TYPE_TAGS,
  JSON_CODEC,
  NULL_LIVE_ENVIRONMENT,
  ProblematicValue,
  REALM_CODEC,
  UnknownValue,
} from "@/codec-common";
import {
  jsonFromFabricValue,
  newDefaultJsonCodecEngine,
  newDefaultRealmCodecEngine,
  realmFromFabricValue,
} from "@/codecs.ts";
import type { RealmCodecValue, RealmEncodedValue } from "@/codec-realm";
import {
  FabricUnavailable,
  UNAVAILABLE_ERROR_KINDS,
  UNAVAILABLE_PENDING,
  UNAVAILABLE_REASONS,
  UNAVAILABLE_SYNCING,
} from "@/fabric-primitives";
import { describe, it } from "@commonfabric/test-support/test";

/**
 * One instance per reason, each built afresh, keyed by reason. The return
 * type closes the set: a reason added to the type without a row here stops
 * this file compiling.
 */
function instancesByReason(): Record<UnavailableReason, FabricUnavailable> {
  return {
    pending: new FabricUnavailable("pending"),
    syncing: new FabricUnavailable("syncing"),
    error: new FabricUnavailable("error", "general", "boom"),
  };
}

/**
 * One `error` instance per kind, each given no message, keyed by kind. The
 * return type closes the set as `instancesByReason()`'s does.
 */
function errorsByKind(): Record<UnavailableErrorKind, FabricUnavailable> {
  return {
    general: new FabricUnavailable("error", "general"),
    schemaMismatch: new FabricUnavailable("error", "schemaMismatch"),
    invalidInput: new FabricUnavailable("error", "invalidInput"),
    network: new FabricUnavailable("error", "network"),
    decode: new FabricUnavailable("error", "decode"),
    compile: new FabricUnavailable("error", "compile"),
    provider: new FabricUnavailable("error", "provider"),
    sync: new FabricUnavailable("error", "sync"),
  };
}

/** The reasons that have a prefab: every reason but `error`. */
type TransientReason = Exclude<UnavailableReason, "error">;

/**
 * The prefab for each transient reason. The `satisfies` closes the set: a
 * transient reason added to the type without a row here stops this file
 * compiling, and the list below is derived from these keys.
 */
const PREFABS = {
  pending: UNAVAILABLE_PENDING,
  syncing: UNAVAILABLE_SYNCING,
} satisfies Record<TransientReason, FabricUnavailable>;

/** The transient reasons, as the keys of `PREFABS`. */
const TRANSIENT_REASONS = Object.keys(PREFABS) as readonly TransientReason[];

/** The default message of the kind `network`. */
const NETWORK_DEFAULT_MESSAGE = new FabricUnavailable("error", "network")
  .message;

/** A state holding a key no field is named for, beside a well-formed error. */
const STATE_WITH_UNREAD_KEY = Object.freeze({
  reason: "error",
  errorKind: "network",
  errorMessage: "boom",
});

/** A state whose message is the default of its kind. */
const STATE_WITH_DEFAULT_MESSAGE = Object.freeze({
  reason: "error",
  errorKind: "network",
  message: NETWORK_DEFAULT_MESSAGE,
});

/**
 * Returns the realm form of a value tagged `Unavailable@1` over a copy of
 * `state`, built by hand so that it can carry a state this class never writes.
 */
function realmFormOf(state: object): RealmEncodedValue {
  const marker = realmFromFabricValue(null)[0];
  const tagged = [marker, CODEC_TYPE_TAGS.Unavailable, { ...state }];

  return [marker, tagged as RealmCodecValue];
}

describe("FabricUnavailable", () => {
  describe("class identity", () => {
    // Supertype checks, which fit no single member and are not construction
    // mechanics, so they get a block of their own.

    it("is an instance of `FabricPrimitive`", () => {
      expect(new FabricUnavailable("pending") instanceof FabricPrimitive)
        .toBe(true);
    });

    it("is not a `FabricInstance` (it's a `FabricPrimitive`)", () => {
      expect(new FabricUnavailable("pending") instanceof FabricInstance)
        .toBe(false);
    });
  });

  describe("constructor()", () => {
    it("produces an always-frozen instance", () => {
      expect(Object.isFrozen(new FabricUnavailable("syncing"))).toBe(true);
    });

    it("defaults `errorKind` and `message` to `null`", () => {
      const instance = new FabricUnavailable("pending");
      expect(instance.errorKind).toBe(null);
      expect(instance.message).toBe(null);
    });

    it("accepts explicit `null`s for a transient reason", () => {
      expect(new FabricUnavailable("syncing", null, null).reason)
        .toBe("syncing");
    });

    it("accepts reason `error` with a kind and no message", () => {
      const instance = new FabricUnavailable("error", "network");
      expect(instance.errorKind).toBe("network");
      expect(instance.rawMessage).toBe(null);
    });

    it("throws given a reason outside the set", () => {
      expect(() =>
        new FabricUnavailable("gone" as unknown as UnavailableReason)
      ).toThrow(/Not an `UnavailableReason`: `"gone"`/);
    });

    it("throws given a reason that is not a string", () => {
      expect(() => new FabricUnavailable(1 as unknown as UnavailableReason))
        .toThrow(/Not an `UnavailableReason`/);
    });

    it("throws given a non-string reason that coerces to a valid one", () => {
      // An array or an object with a `toString()` reads as a key when looked
      // up in the table, so the table lookup alone would admit it. The
      // message renders the value as it is, not as it coerces.
      expect(() =>
        new FabricUnavailable(["pending"] as unknown as UnavailableReason)
      ).toThrow(/Not an `UnavailableReason`: `\["pending"\]`/);
    });

    it("throws given reason `error` and no kind", () => {
      expect(() => new FabricUnavailable("error"))
        .toThrow(/requires an `UnavailableErrorKind`, not `null`/);
      expect(() => new FabricUnavailable("error", null, "boom"))
        .toThrow(/requires an `UnavailableErrorKind`/);
    });

    it("throws given reason `error` and a kind outside the set", () => {
      expect(() =>
        new FabricUnavailable(
          "error",
          "gone" as unknown as UnavailableErrorKind,
        )
      ).toThrow(/requires an `UnavailableErrorKind`, not `"gone"`/);
      expect(() =>
        new FabricUnavailable(
          "error",
          ["network"] as unknown as UnavailableErrorKind,
        )
      ).toThrow(/requires an `UnavailableErrorKind`, not `\["network"\]`/);
    });

    it("throws given reason `error` and a message that is not a string", () => {
      expect(() =>
        new FabricUnavailable("error", "general", 1 as unknown as string)
      ).toThrow(/Not a `message`: `1`/);
    });

    it("throws given a kind or a message with a transient reason", () => {
      for (const reason of TRANSIENT_REASONS) {
        expect(() => new FabricUnavailable(reason, "general"))
          .toThrow(/takes neither an `errorKind` nor a `message`/);
        expect(() => new FabricUnavailable(reason, null, "boom"))
          .toThrow(/takes neither an `errorKind` nor a `message`/);
      }
    });
  });

  describe("instance members", () => {
    describe(".schemaType", () => {
      it("is `FabricUnavailable`", () => {
        expect(new FabricUnavailable("pending").schemaType).toBe(
          "FabricUnavailable",
        );
      });
    });

    describe(".state", () => {
      it("is a frozen record holding exactly the fields there are to say", () => {
        const cases: [FabricUnavailable, object][] = [
          [UNAVAILABLE_PENDING, { reason: "pending" }],
          [
            new FabricUnavailable("error", "network"),
            { reason: "error", errorKind: "network" },
          ],
          [
            new FabricUnavailable("error", "network", "boom"),
            { reason: "error", errorKind: "network", message: "boom" },
          ],
        ];

        for (const [instance, expected] of cases) {
          expect(instance.state).toStrictEqual(expected);
          expect(Object.isFrozen(instance.state)).toBe(true);
        }
      });

      it("omits the message of an error given its kind's default", () => {
        const given = new FabricUnavailable("error", "decode");
        const explicit = new FabricUnavailable(
          "error",
          "decode",
          given.message,
        );
        expect(explicit.state).toStrictEqual({
          reason: "error",
          errorKind: "decode",
        });
      });

      it("is the record both codecs encode", () => {
        const instance = new FabricUnavailable("error", "network", "boom");
        const env = NULL_LIVE_ENVIRONMENT;
        expect(FabricUnavailable[JSON_CODEC].encode(instance, env))
          .toBe(instance.state);
        expect(FabricUnavailable[REALM_CODEC].encode(instance, env))
          .toBe(instance.state);
      });
    });

    describe(".reason", () => {
      it("is the reason given at construction", () => {
        for (const [reason, instance] of Object.entries(instancesByReason())) {
          expect(instance.reason).toBe(reason);
        }
      });
    });

    describe(".errorKind", () => {
      it("is the kind given at construction, for every kind", () => {
        for (const [kind, instance] of Object.entries(errorsByKind())) {
          expect(instance.errorKind).toBe(kind);
        }
      });

      it("is `null` for a transient reason", () => {
        for (const prefab of Object.values(PREFABS)) {
          expect(prefab.errorKind).toBe(null);
        }
      });
    });

    describe(".message", () => {
      it("is the message given with reason `error`", () => {
        expect(new FabricUnavailable("error", "general", "boom").message)
          .toBe("boom");
      });

      it("is a non-empty string for every kind when none was given", () => {
        for (const [kind, instance] of Object.entries(errorsByKind())) {
          expect([kind, typeof instance.message]).toEqual([
            kind,
            "string",
          ]);
          expect(instance.message!.length).toBeGreaterThan(0);
        }
      });

      it("differs between kinds when none was given", () => {
        const messages = Object.values(errorsByKind())
          .map((instance) => instance.message);
        expect(new Set(messages).size).toBe(messages.length);
      });

      it("is `null` for a transient reason", () => {
        for (const prefab of Object.values(PREFABS)) {
          expect(prefab.message).toBe(null);
        }
      });
    });

    describe(".rawMessage", () => {
      it("is the message given with reason `error`", () => {
        expect(
          new FabricUnavailable("error", "general", "boom").rawMessage,
        ).toBe("boom");
      });

      it("is `null` when none was given, for every kind", () => {
        for (const [kind, instance] of Object.entries(errorsByKind())) {
          expect([kind, instance.rawMessage]).toEqual([kind, null]);
        }
      });

      it("is `null` when the message given is the kind's default", () => {
        for (const [kind, instance] of Object.entries(errorsByKind())) {
          const explicit = new FabricUnavailable(
            "error",
            kind as UnavailableErrorKind,
            instance.message,
          );
          expect([kind, explicit.rawMessage]).toEqual([kind, null]);
          expect(explicit.message).toBe(instance.message);
        }
      });

      it("is `null` for a transient reason", () => {
        for (const prefab of Object.values(PREFABS)) {
          expect(prefab.rawMessage).toBe(null);
        }
      });
    });

    describe("the reason predicates", () => {
      // Each predicate is checked against every reason rather than only the
      // one it names, so a predicate that returned `true` too widely is seen.

      const predicates = {
        pending: (u: FabricUnavailable) => u.isPending(),
        syncing: (u: FabricUnavailable) => u.isSyncing(),
        error: (u: FabricUnavailable) => u.isError(),
      } satisfies Record<UnavailableReason, (u: FabricUnavailable) => boolean>;

      for (const [name, predicate] of Object.entries(predicates)) {
        it(
          `\`is${name[0]!.toUpperCase()}${
            name.slice(1)
          }()\` returns \`true\` for reason \`${name}\` and \`false\` for every other`,
          () => {
            for (
              const [reason, instance] of Object.entries(instancesByReason())
            ) {
              expect([reason, predicate(instance)]).toEqual([
                reason,
                reason === name,
              ]);
            }
          },
        );
      }
    });

    describe("isError()", () => {
      // The narrowing is a compile-time fact, pinned here the way
      // `api.test.ts` pins one: an assignment that must type-check inside
      // the guard, and a `@ts-expect-error` on the same assignment outside
      // it, which becomes unused, and fails the check, if the narrowing ever
      // reaches there on its own.

      it("narrows `errorKind` and `message` to non-`null` when it returns `true`", () => {
        const instance: FabricUnavailable = new FabricUnavailable(
          "error",
          "network",
        );
        // @ts-expect-error `errorKind` is `UnavailableErrorKind | null` before
        // the guard.
        const unnarrowedKind: UnavailableErrorKind = instance.errorKind;
        expect(unnarrowedKind).toBe("network");

        if (instance.isError()) {
          const kind: UnavailableErrorKind = instance.errorKind;
          const message: string = instance.message;
          expect(kind).toBe("network");
          expect(message.length).toBeGreaterThan(0);
        } else {
          throw new Error("Expected `isError()` to return `true`.");
        }
      });
    });

    describe("isTransient()", () => {
      it("returns `true` for `pending` and `syncing`", () => {
        for (const reason of TRANSIENT_REASONS) {
          expect(new FabricUnavailable(reason).isTransient()).toBe(true);
        }
      });

      it("returns `false` for `error`, whatever its kind", () => {
        for (const [kind, instance] of Object.entries(errorsByKind())) {
          expect([kind, instance.isTransient()]).toEqual([kind, false]);
        }
      });
    });
  });

  describe("static members", () => {
    describe("[JSON_CODEC]", () => {
      const codec = FabricUnavailable[JSON_CODEC];
      const expectedTag = CODEC_TYPE_TAGS.Unavailable;
      const env = NULL_LIVE_ENVIRONMENT;

      describe("recognizedTypeTag", () => {
        it("is the `Unavailable` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("canEncode()", () => {
        it("claims a `FabricUnavailable`, rejecting other values", () => {
          expect(codec.canEncode(UNAVAILABLE_PENDING)).toBe(true);
          expect(codec.canEncode({ reason: "pending" })).toBe(false);
        });
      });

      describe("encode()", () => {
        it("encodes a transient reason to a record holding the reason alone", () => {
          expect(codec.encode(UNAVAILABLE_SYNCING, env))
            .toStrictEqual({ reason: "syncing" });
        });

        it("encodes an error with its kind and message", () => {
          expect(
            codec.encode(
              new FabricUnavailable("error", "network", "boom"),
              env,
            ),
          ).toStrictEqual({
            reason: "error",
            errorKind: "network",
            message: "boom",
          });
        });

        it("omits the message of an error given none", () => {
          expect(codec.encode(new FabricUnavailable("error", "network"), env))
            .toStrictEqual({ reason: "error", errorKind: "network" });
        });

        it("omits the message of an error given its kind's default", () => {
          const given = new FabricUnavailable("error", "decode");
          const explicit = new FabricUnavailable(
            "error",
            "decode",
            given.message,
          );
          expect(codec.encode(explicit, env))
            .toStrictEqual({ reason: "error", errorKind: "decode" });
        });

        it("returns a frozen record for each shape of state", () => {
          const shapes = [
            UNAVAILABLE_SYNCING,
            new FabricUnavailable("error", "network"),
            new FabricUnavailable("error", "network", "boom"),
          ];
          for (const value of shapes) {
            expect(Object.isFrozen(codec.encode(value, env))).toBe(true);
          }
        });
      });

      describe("canDecode()", () => {
        it("returns `true` for a record holding a known reason", () => {
          expect(codec.canDecode({ reason: "pending" })).toBe(true);
          expect(codec.canDecode({ reason: "error", errorKind: "general" }))
            .toBe(true);
          expect(
            codec.canDecode({
              reason: "error",
              errorKind: "general",
              message: "x",
            }),
          ).toBe(true);
        });

        it("returns `false` for state that is not a plain object", () => {
          expect(codec.canDecode("pending")).toBe(false);
          expect(codec.canDecode(["pending"])).toBe(false);
          expect(codec.canDecode(null)).toBe(false);
        });

        it("returns `false` for a reason outside the set", () => {
          expect(codec.canDecode({ reason: "gone" })).toBe(false);
          expect(codec.canDecode({ reason: "schemaMismatch" })).toBe(false);
          expect(codec.canDecode({ reason: "constructor" })).toBe(false);
          expect(codec.canDecode({})).toBe(false);
        });

        it("returns `false` for a reason that is inherited rather than own", () => {
          // Read as an own property, so a `reason` reachable only through the
          // prototype chain does not stand in for one.
          const polluted = Object.prototype as { reason?: unknown };
          polluted.reason = "pending";
          try {
            expect(codec.canDecode({})).toBe(false);
          } finally {
            delete polluted.reason;
          }
        });

        it("returns `false` for a kind that is present and not one of the kinds", () => {
          expect(codec.canDecode({ reason: "error", errorKind: "gone" }))
            .toBe(false);
          expect(codec.canDecode({ reason: "error", errorKind: 1 }))
            .toBe(false);
          expect(codec.canDecode({ reason: "error", errorKind: undefined }))
            .toBe(false);
          expect(codec.canDecode({ reason: "error", errorKind: "constructor" }))
            .toBe(false);
        });

        it("returns `false` for a message that is present and not a string", () => {
          expect(
            codec.canDecode({
              reason: "error",
              errorKind: "general",
              message: 1,
            }),
          ).toBe(false);
          expect(
            codec.canDecode({
              reason: "error",
              errorKind: "general",
              message: undefined,
            }),
          ).toBe(false);
          expect(codec.canDecode({ reason: "pending", message: null }))
            .toBe(false);
        });
        it("returns `false` for a record holding a key it does not read", () => {
          expect(codec.canDecode(STATE_WITH_UNREAD_KEY)).toBe(false);
          expect(codec.canDecode({ reason: "pending", extra: "x" }))
            .toBe(false);
        });
      });

      describe("decode()", () => {
        for (const [reason, prefab] of Object.entries(PREFABS)) {
          it(`decodes reason \`${reason}\` to its prefab instance`, () => {
            expect(codec.decode(expectedTag, { reason }, env)).toBe(prefab);
          });
        }

        it("decodes an error to a fresh instance carrying the kind and message", () => {
          const decoded = codec.decode(
            expectedTag,
            { reason: "error", errorKind: "compile", message: "boom" },
            env,
          ) as unknown as FabricUnavailable;

          expect(decoded).toBeInstanceOf(FabricUnavailable);
          expect(decoded.reason).toBe("error");
          expect(decoded.errorKind).toBe("compile");
          expect(decoded.rawMessage).toBe("boom");
        });

        it("decodes an error given no message to one whose message is the kind's default", () => {
          const decoded = codec.decode(
            expectedTag,
            { reason: "error", errorKind: "compile" },
            env,
          ) as unknown as FabricUnavailable;

          expect(decoded.rawMessage).toBe(null);
          expect(decoded.message)
            .toBe(new FabricUnavailable("error", "compile").message);
        });

        it("ignores an error field that is inherited rather than own", () => {
          // `canDecode()` treats an inherited field as absent, and the decode
          // reads the same way, so the two cannot disagree about a state.
          const polluted = Object.prototype as {
            errorKind?: unknown;
            message?: unknown;
          };
          polluted.errorKind = "general";
          polluted.message = "boom";
          try {
            expect(codec.canDecode({ reason: "pending" })).toBe(true);
            expect(codec.decode(expectedTag, { reason: "pending" }, env))
              .toBe(UNAVAILABLE_PENDING);
            const decoded = codec.decode(
              expectedTag,
              { reason: "error", errorKind: "sync" },
              env,
            ) as unknown as FabricUnavailable;
            expect(decoded.rawMessage).toBe(null);
          } finally {
            delete polluted.errorKind;
            delete polluted.message;
          }
        });

        it("keeps a message equal to its kind's default", () => {
          const decoded = codec.decode(
            expectedTag,
            STATE_WITH_DEFAULT_MESSAGE,
            env,
          ) as unknown as FabricUnavailable;

          expect(decoded.state).toStrictEqual(STATE_WITH_DEFAULT_MESSAGE);
          expect(decoded.rawMessage).toBe(NETWORK_DEFAULT_MESSAGE);
        });

        it("decodes reason `error` without a kind to a `ProblematicValue`", () => {
          expect(codec.decode(expectedTag, { reason: "error" }, env))
            .toBeInstanceOf(ProblematicValue);
          expect(
            codec.decode(
              expectedTag,
              { reason: "error", message: "boom" },
              env,
            ),
          ).toBeInstanceOf(ProblematicValue);
        });

        it("decodes a kind or a message with a transient reason to a `ProblematicValue`", () => {
          expect(
            codec.decode(
              expectedTag,
              { reason: "pending", errorKind: "general" },
              env,
            ),
          ).toBeInstanceOf(ProblematicValue);
          expect(
            codec.decode(
              expectedTag,
              { reason: "syncing", message: "boom" },
              env,
            ),
          ).toBeInstanceOf(ProblematicValue);
        });
      });

      describe("round trip encode-decode", () => {
        it("round-trips each reason", () => {
          for (const original of Object.values(instancesByReason())) {
            const decoded = codec.decode(
              expectedTag,
              codec.encode(original, env),
              env,
            ) as unknown as FabricUnavailable;

            expect(decoded).toBeInstanceOf(FabricUnavailable);
            expect(decoded.reason).toBe(original.reason);
            expect(decoded.errorKind).toBe(original.errorKind);
            expect(decoded.rawMessage).toBe(original.rawMessage);
          }
        });

        it("round-trips each kind", () => {
          for (const original of Object.values(errorsByKind())) {
            const decoded = codec.decode(
              expectedTag,
              codec.encode(original, env),
              env,
            ) as unknown as FabricUnavailable;

            expect(decoded.errorKind).toBe(original.errorKind);
            expect(decoded.message).toBe(original.message);
          }
        });
      });
    });

    describe("[JSON_CODEC] under an engine", () => {
      const env = NULL_LIVE_ENVIRONMENT;

      it("decodes a state holding a key it does not read to a `ProblematicValue` preserving the state", () => {
        const text = jsonFromFabricValue(
          new UnknownValue(CODEC_TYPE_TAGS.Unavailable, STATE_WITH_UNREAD_KEY),
        );
        const decoded = newDefaultJsonCodecEngine({ lenient: true })
          .decode(text, env);

        expect(decoded).toBeInstanceOf(ProblematicValue);
        expect((decoded as ProblematicValue).wireTypeTag)
          .toBe(CODEC_TYPE_TAGS.Unavailable);
        expect((decoded as ProblematicValue).state)
          .toStrictEqual(STATE_WITH_UNREAD_KEY);
        expect(() => newDefaultJsonCodecEngine().decode(text, env)).toThrow();
      });

      it("decodes a message equal to its kind's default to a value that re-encodes and hashes as it arrived", () => {
        const arrived = new UnknownValue(
          CODEC_TYPE_TAGS.Unavailable,
          STATE_WITH_DEFAULT_MESSAGE,
        );
        const text = jsonFromFabricValue(arrived);
        const decoded = newDefaultJsonCodecEngine().decode(text, env);

        // An instance constructed with the same text stores no message, so
        // it is a different state: it hashes differently, and is unequal.
        const constructed = new FabricUnavailable(
          "error",
          "network",
          NETWORK_DEFAULT_MESSAGE,
        );

        expect(decoded).toBeInstanceOf(FabricUnavailable);
        expect(jsonFromFabricValue(decoded)).toBe(text);
        expect(hashStringOf(decoded)).toBe(hashStringOf(arrived));
        expect(hashStringOf(decoded)).not.toBe(hashStringOf(constructed));
        expect(valueEqual(decoded, constructed)).toBe(false);
      });
    });

    describe("[REALM_CODEC]", () => {
      const codec = FabricUnavailable[REALM_CODEC];
      const expectedTag = CODEC_TYPE_TAGS.Unavailable;
      const env = NULL_LIVE_ENVIRONMENT;

      it("is terminal", () => {
        expect(codec instanceof BaseTerminalCodec).toBe(true);
      });

      describe("recognizedTypeTag", () => {
        it("is the `Unavailable` wire type tag", () => {
          expect(codec.recognizedTypeTag).toBe(expectedTag);
        });
      });

      describe("encode()", () => {
        it("encodes to the same record the JSON codec emits", () => {
          const originals = [
            ...Object.values(instancesByReason()),
            ...Object.values(errorsByKind()),
          ];
          for (const original of originals) {
            expect(codec.encode(original, env))
              .toStrictEqual(
                FabricUnavailable[JSON_CODEC].encode(original, env),
              );
          }
        });

        it("returns a frozen record for each shape of state", () => {
          const shapes = [
            UNAVAILABLE_SYNCING,
            new FabricUnavailable("error", "network"),
            new FabricUnavailable("error", "network", "boom"),
          ];
          for (const value of shapes) {
            expect(Object.isFrozen(codec.encode(value, env))).toBe(true);
          }
        });
      });

      describe("canDecode()", () => {
        it("returns `true` for a record holding a known reason", () => {
          expect(codec.canDecode({ reason: "error", errorKind: "sync" }))
            .toBe(true);
        });

        it("returns `false` for a kind or a message that is present holding `undefined`", () => {
          // This format carries `undefined` faithfully, so a peer can send
          // one on purpose, and it is a malformation rather than an absence.
          expect(codec.canDecode({ reason: "error", errorKind: undefined }))
            .toBe(false);
          expect(
            codec.canDecode({
              reason: "error",
              errorKind: "sync",
              message: undefined,
            }),
          ).toBe(false);
        });

        it("returns `false` for state that is not a plain object", () => {
          expect(codec.canDecode("pending")).toBe(false);
          expect(codec.canDecode(undefined)).toBe(false);
        });
        it("returns `false` for a record holding a key it does not read", () => {
          expect(codec.canDecode(STATE_WITH_UNREAD_KEY)).toBe(false);
          expect(codec.canDecode({ reason: "pending", extra: "x" }))
            .toBe(false);
        });
      });

      describe("decode()", () => {
        for (const [reason, prefab] of Object.entries(PREFABS)) {
          it(`decodes reason \`${reason}\` to its prefab instance`, () => {
            expect(codec.decode(expectedTag, { reason }, env)).toBe(prefab);
          });
        }

        it("decodes an error to a fresh instance carrying the kind and message", () => {
          const decoded = codec.decode(
            expectedTag,
            { reason: "error", errorKind: "provider", message: "boom" },
            env,
          ) as unknown as FabricUnavailable;

          expect(decoded).toBeInstanceOf(FabricUnavailable);
          expect(decoded.errorKind).toBe("provider");
          expect(decoded.rawMessage).toBe("boom");
        });

        it("decodes a kind with a transient reason to a `ProblematicValue`", () => {
          expect(
            codec.decode(
              expectedTag,
              { reason: "syncing", errorKind: "general" },
              env,
            ),
          ).toBeInstanceOf(ProblematicValue);
        });

        it("keeps a message equal to its kind's default", () => {
          const decoded = codec.decode(
            expectedTag,
            STATE_WITH_DEFAULT_MESSAGE,
            env,
          ) as unknown as FabricUnavailable;

          expect(decoded.state).toStrictEqual(STATE_WITH_DEFAULT_MESSAGE);
          expect(decoded.rawMessage).toBe(NETWORK_DEFAULT_MESSAGE);
        });
      });

      describe("round trip encode-decode", () => {
        it("encodes each shape of state as exactly `.state`, and decodes it back", () => {
          const defaultMessage = new FabricUnavailable("error", "decode")
            .message;
          const cases: [FabricUnavailable, object][] = [
            [UNAVAILABLE_PENDING, { reason: "pending" }],
            [UNAVAILABLE_SYNCING, { reason: "syncing" }],
            [
              new FabricUnavailable("error", "decode", defaultMessage),
              { reason: "error", errorKind: "decode" },
            ],
            [
              new FabricUnavailable("error", "network", "boom"),
              { reason: "error", errorKind: "network", message: "boom" },
            ],
          ];

          for (const [original, expected] of cases) {
            const encoded = codec.encode(original, env);
            expect(encoded).toBe(original.state);
            expect(encoded).toStrictEqual(expected);

            const decoded = codec.decode(
              expectedTag,
              encoded as UnavailableState,
              env,
            ) as unknown as FabricUnavailable;
            expect(decoded.state).toStrictEqual(original.state);
            expect(decoded.message).toBe(original.message);
          }
        });
      });
    });

    describe("[REALM_CODEC] under an engine", () => {
      const env = NULL_LIVE_ENVIRONMENT;

      it("decodes a state holding a key it does not read to a `ProblematicValue` preserving the state", () => {
        const decoded = newDefaultRealmCodecEngine({ lenient: true })
          .decode(realmFormOf(STATE_WITH_UNREAD_KEY), env);

        expect(decoded).toBeInstanceOf(ProblematicValue);
        expect((decoded as ProblematicValue).wireTypeTag)
          .toBe(CODEC_TYPE_TAGS.Unavailable);
        expect((decoded as ProblematicValue).state)
          .toStrictEqual(STATE_WITH_UNREAD_KEY);
        expect(() =>
          newDefaultRealmCodecEngine().decode(
            realmFormOf(STATE_WITH_UNREAD_KEY),
            env,
          )
        ).toThrow();
      });

      it("decodes a message equal to its kind's default to a value that re-encodes and hashes as it arrived", () => {
        const decoded = newDefaultRealmCodecEngine()
          .decode(realmFormOf(STATE_WITH_DEFAULT_MESSAGE), env);

        expect(decoded).toBeInstanceOf(FabricUnavailable);
        expect(realmFromFabricValue(decoded)[1])
          .toStrictEqual(realmFormOf(STATE_WITH_DEFAULT_MESSAGE)[1]);
        expect(hashStringOf(decoded)).toBe(
          hashStringOf(
            new UnknownValue(
              CODEC_TYPE_TAGS.Unavailable,
              STATE_WITH_DEFAULT_MESSAGE,
            ),
          ),
        );
        expect(hashStringOf(decoded)).not.toBe(
          hashStringOf(
            new FabricUnavailable("error", "network", NETWORK_DEFAULT_MESSAGE),
          ),
        );
      });
    });
  });

  describe("the prefab instances", () => {
    // Exercised as module-level exports rather than as members of the class,
    // so they live directly under the class `describe()`.

    for (const [reason, prefab] of Object.entries(PREFABS)) {
      it(`\`${reason}\` has that reason and no error members`, () => {
        expect(prefab.reason).toBe(reason);
        expect(prefab.errorKind).toBe(null);
        expect(prefab.message).toBe(null);
      });

      it(`\`${reason}\` is equal by content to a fresh instance with that reason`, () => {
        expect(
          valueEqual(
            prefab,
            new FabricUnavailable(reason as UnavailableReason),
          ),
        ).toBe(true);
      });
    }

    it("are two distinct instances", () => {
      expect(new Set(Object.values(PREFABS)).size).toBe(2);
    });
  });

  describe("UNAVAILABLE_REASONS", () => {
    it("keys each reason by itself", () => {
      for (const [key, value] of Object.entries(UNAVAILABLE_REASONS)) {
        expect(value).toBe(key);
      }
    });

    it("is frozen", () => {
      expect(Object.isFrozen(UNAVAILABLE_REASONS)).toBe(true);
    });
  });

  describe("UNAVAILABLE_ERROR_KINDS", () => {
    it("keys each kind by itself", () => {
      for (const [key, value] of Object.entries(UNAVAILABLE_ERROR_KINDS)) {
        expect(value).toBe(key);
      }
    });

    it("is frozen", () => {
      expect(Object.isFrozen(UNAVAILABLE_ERROR_KINDS)).toBe(true);
    });
  });

  describe("`shallowFabricFromConvertibleJsValue()` integration", () => {
    // Exercises the free `shallowFabricFromConvertibleJsValue()` rather than a
    // member of the class, so it lives directly under the class `describe()`.

    it("passes through unchanged even with `freeze=false`", () => {
      const unavailable = new FabricUnavailable("error", "general", "boom");
      expect(shallowFabricFromConvertibleJsValue(unavailable, false))
        .toBe(unavailable);
    });
  });
});
