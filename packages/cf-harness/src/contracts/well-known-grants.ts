/**
 * The record of a well-known grant: a handle token the harness seeded into
 * the run for a reference every run on this console is entitled to hold.
 * `src/well-known-grants.ts` documents the posture and does the minting;
 * this contract is what run state persists.
 */

/**
 * The fixed well-known references, whose model-facing descriptions the
 * harness authors in full. Connector names come from the Loom instance's
 * connection identities and are validated before reaching model context.
 */
export type HarnessWellKnownGrantName = "piece-registry";

/**
 * Every fixed name, as a value. The harness describes each of these and the
 * console refuses to name a connector grant after one, and both read this
 * list — so adding a fixed grant is one edit here and the two consumers
 * follow, rather than a union that type-checks while a hand-written set
 * beside it stays one name short.
 */
export const HARNESS_WELL_KNOWN_GRANT_NAMES:
  readonly HarnessWellKnownGrantName[] = ["piece-registry"];

/** Which loom connector handle a connector grant names. */
export interface HarnessConnectorGrantSource {
  /** The loom connection the handle belongs to. */
  connection: string;

  /** An additional store on a connection, when Loom declares one. */
  companionKey?: string;

  /** The loom piece that carries the handle. */
  piece: string;
}

/** One connector handle to grant, as the console was configured with it. */
export interface HarnessConnectorGrantSpec {
  /**
   * Connection identity: `connection` or `connection#companionKey`.
   * Records without separate class metadata use their class as the name.
   */
  name: string;

  /** All declared column classifications, in contract order. */
  cfcClasses?: string[];

  /** Singular classification on persisted grants without `cfcClasses`. */
  cfcClass?: string;

  /**
   * Physical rows at injection, including metadata and history; absent if unknown.
   */
  rowCount?: number;

  /**
   * Account identity from the receipt; absent when the receipt did not record it.
   */
  viewer?:
    | {
      /** An authenticated connection. */
      identity: "account";

      /** Provider's viewer identifier, which may be opaque. */
      sourceId?: string;

      /** Login address; `null` means this account has no address. */
      email?: string | null;

      /** Provider's display label for the account. */
      label?: string;

      /** Why the provider identity is unavailable or withheld, when stated. */
      reason?: string;
    }
    | {
      /** A source with no account. */
      identity: "none";

      /** Receipt reason for the absence. */
      reason: string;
    }
    | {
      /** The receipt could not establish an identity. */
      identity: "unknown";

      /** Receipt reason for the unavailable identity. */
      reason?: string;
    };

  /** Newest record observation, distinct from content time; absent if unknown. */
  observation?:
    | {
      /** ISO8601 time when Loom observed the newest record. */
      newestAt: string;

      /** Absence reasons accompany only missing timestamps. */
      reason?: never;
    }
    | {
      /** No observation time was returned. */
      newestAt: null;

      /** `no-rows` means empty; other reasons mean the time could not be read. */
      reason: string;
    };

  /** The reference to mint, as an LLM-friendly link string. */
  ref: string;

  /** The loom handle behind it, for run state and the launch report. */
  source: HarnessConnectorGrantSource;
}

/**
 * One granted reference, as recorded in run state. A grant is one of two
 * kinds and `source` is what tells them apart, so the two are written as a
 * union: a fixed grant's name is one this module's own table describes, and a
 * connector grant carries the loom handle its name was read from. A record
 * with a free-chosen name and no source is a grant nothing can describe, and
 * the union is what stops one being constructed.
 */
export type HarnessWellKnownGrant =
  | {
    /** Which fixed reference this is. */
    name: HarnessWellKnownGrantName;

    /** The token the model holds. */
    token: string;

    /** The canonical reference behind it; never model-facing. */
    ref: string;

    source?: undefined;
  }
  | (HarnessConnectorGrantSpec & {
    /** The token the model holds. */
    token: string;
  });
