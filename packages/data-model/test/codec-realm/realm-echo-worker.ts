/**
 * The far side of the boundary this format exists for. It decodes what
 * arrives and reports what it got, so that a test can assert on the value as
 * decoded in a *different realm* rather than in the one that encoded it.
 *
 * Not a `*.test.ts` file, so the runner does not pick it up as a suite.
 */

import type { RealmEncodedValue } from "@/codec-realm/index.ts";
import { fabricFromRealmValue } from "@/codecs.ts";
import { UNAVAILABLE_SYNCING } from "@/fabric-primitives/index.ts";

/** What the worker reports back about one decoded value. */
export type EchoReport = {
  /** Whether the decode succeeded. */
  ok: boolean;

  /** The constructor names of the decoded value's own properties, in order. */
  classes?: Record<string, string>;

  /** Assorted facts a structured clone would lose, gathered on this side. */
  facts?: Record<string, unknown>;

  /** The failure message, when `ok` is `false`. */
  error?: string;
};

/**
 * Facts about a decoded key pair, read structurally on the far side: which
 * state it arrived in, and what its two keys are there.
 */
function keyPairFacts(pair: unknown): Record<string, unknown> | undefined {
  if (pair === undefined) {
    return undefined;
  }

  const { algorithm, hasMaterial } = pair as {
    algorithm: string;
    hasMaterial: boolean;
  };

  if (hasMaterial) {
    const { publicKeyBytes, privateKeyBytes } = pair as {
      publicKeyBytes: { slice(): Uint8Array };
      privateKeyBytes: { slice(): Uint8Array };
    };
    return {
      algorithm,
      hasMaterial,
      publicKey: [...publicKeyBytes.slice()],
      privateKey: [...privateKeyBytes.slice()],
    };
  }

  const { publicKey, privateKey } =
    (pair as { cryptoKeyPair: CryptoKeyPair }).cryptoKeyPair;

  return {
    algorithm,
    hasMaterial,
    publicKeyClass: publicKey?.constructor?.name,
    privateKeyClass: privateKey?.constructor?.name,
    privateKeyType: privateKey?.type,
    privateKeyExtractable: privateKey?.extractable,
    privateKeyUsages: privateKey?.usages,
  };
}

self.onmessage = (ev: MessageEvent) => {
  try {
    const value = fabricFromRealmValue(ev.data as RealmEncodedValue) as Record<
      string,
      unknown
    >;
    const classes: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      classes[k] = (v === null) ? "null" : (v?.constructor?.name ?? typeof v);
    }
    self.postMessage(
      {
        ok: true,
        classes,
        facts: {
          bytes: (value.bytes as { slice(): Uint8Array } | undefined)
            ? [...(value.bytes as { slice(): Uint8Array }).slice()]
            : undefined,
          nsec: (value.nsec as { value: bigint } | undefined)?.value,
          // Content for every class that carries any, not just the two that
          // happened to be checked first: a class can arrive with the right
          // constructor and the wrong data, and only a value check sees it.
          days: (value.days as { value: bigint } | undefined)?.value,
          hashTag: (value.hash as { tag: string } | undefined)?.tag,
          hashBytes: (value.hash as { bytes: Uint8Array } | undefined)
            ? [...(value.hash as { bytes: Uint8Array }).bytes]
            : undefined,
          regexpParts: (value.regexp as
              | { flavor: string; source: string; flags: string }
              | undefined)
            ? [
              (value.regexp as { flavor: string }).flavor,
              (value.regexp as { source: string }).source,
              (value.regexp as { flags: string }).flags,
            ]
            : undefined,
          holeKeys: Array.isArray(value.sparse)
            ? Object.keys(value.sparse)
            : undefined,
          sparseLength: Array.isArray(value.sparse)
            ? value.sparse.length
            : undefined,
          slashy: (value.plain as Record<string, unknown>)?.["/slashy"],
          negZeroIsNegative: Object.is(value.negZero, -0),
          symbolIsInterned: (typeof value.sym === "symbol") &&
            (Symbol.keyFor(value.sym) === "interned"),
          big: value.big,
          nothingPresent: "nothing" in value,
          // A payload's own array, equal to a marker but not one. Section 1.1
          // requires the transport to keep two distinct-but-equal objects
          // distinct, and this is where that gets checked against the
          // transport actually in use rather than same-realm: had cloning
          // deduplicated it against the real marker, it would arrive here as
          // a decoded value instead of the array it went out as.
          lookalikeIsArray: Array.isArray(value.lookalike),
          lookalikeTag: Array.isArray(value.lookalike)
            ? value.lookalike[1]
            : undefined,
          keyPair: keyPairFacts(value.keyPair),
          unavailableParts: (value.unavailable as
              | {
                reason: string;
                errorKind: string | null;
                rawErrorMessage: string | null;
              }
              | undefined)
            ? [
              (value.unavailable as { reason: string }).reason,
              (value.unavailable as { errorKind: string | null }).errorKind,
              (value.unavailable as { rawErrorMessage: string | null })
                .rawErrorMessage,
            ]
            : undefined,
          prefabIsThatRealmsPrefab: value.prefab === UNAVAILABLE_SYNCING,
        },
      } satisfies EchoReport,
    );
  } catch (e) {
    self.postMessage(
      { ok: false, error: (e as Error).message } satisfies EchoReport,
    );
  }
};
