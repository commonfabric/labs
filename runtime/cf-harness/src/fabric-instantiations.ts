/**
 * Which patterns the fabric session's runtime materialized while a
 * `run_pattern` invocation ran, and under which identity. `run_pattern` reads
 * these to decide whether the piece it just created can be opened by any
 * runtime other than this one: a piece stamped with a session-synthetic
 * `keyless:` identity loads only here, and a fresh runtime asked for it dies
 * naming an identity it cannot resolve.
 *
 * The runtime's instantiation observer is a constructor option and a single
 * consumer holds it, so the recorder is created where the session's
 * `PiecesController` is built and handed in there. Invocations scope their
 * reads by sequence number, the same way the error and episode buffers do:
 * `sequence()` before the piece starts, `since()` after the settle barrier.
 * The buffer is bounded and drops oldest first, so an invocation reading after
 * heavy churn may miss records, which under-reports rather than misattributes.
 */

import type { PatternInstantiation } from "@commonfabric/runner";
import { PatternManager } from "@commonfabric/runner";
import type { NormalizedFullLink } from "@commonfabric/runner/shared";
import { comparableEntityHash } from "./fabric-observations.ts";

export interface FabricInstantiationRecord {
  sequence: number;

  /**
   * The pattern pointer stamped onto the materialized root. A `keyless:`
   * prefix marks a session-synthetic pointer no other runtime can load.
   */
  identity: string;

  symbol: string;

  /**
   * Comparable entity hash of the result cell the pattern materialized onto,
   * which is what an invocation matches its own piece and result against.
   */
  cell: string;

  /**
   * The link to that same result cell, for an invocation that needs to READ
   * what the pattern produced rather than only identify it. A hash answers
   * which cell; this answers what is in it.
   */
  link: NormalizedFullLink;
}

export interface FabricPatternInstantiations {
  /** Monotonic position; capture before starting a piece. */
  sequence(): number;

  /** Instantiations recorded after `since`, oldest first. */
  since(since: number): readonly FabricInstantiationRecord[];

  /**
   * The KEYLESS instantiations recorded after `since`, oldest first. Held
   * apart from the general buffer so ordinary record eviction cannot erase
   * the evidence a guard exists to see: a run that materializes many durable
   * roots after one session-only root would otherwise roll the keyless
   * record out of `since` and fail open.
   */
  keylessSince(since: number): readonly FabricInstantiationRecord[];
}

/**
 * The observer a runtime is constructed with, paired with the read side an
 * invocation queries. Both halves address the same buffers.
 */
export interface FabricInstantiationRecorder {
  observe: (instantiation: PatternInstantiation) => void;
  instantiations: FabricPatternInstantiations;
}

const BUFFER_LIMIT = 128;

export const createFabricInstantiationRecorder =
  (): FabricInstantiationRecorder => {
    let sequence = 0;
    const records: FabricInstantiationRecord[] = [];
    const keyless: FabricInstantiationRecord[] = [];
    return {
      observe: (instantiation) => {
        // A record that cannot be attributed to an entity can never be
        // matched against a piece, so it is not recorded — and nothing here
        // may throw, because the runner calls the observer inline while it
        // stages the pattern's setup.
        const cell = comparableEntityHash(instantiation.cell?.id);
        if (cell === undefined) {
          return;
        }
        const record = {
          sequence: ++sequence,
          identity: instantiation.identity,
          symbol: instantiation.symbol,
          cell,
          link: instantiation.cell,
        };
        records.push(record);
        if (records.length > BUFFER_LIMIT) {
          records.shift();
        }
        // Keyless records are rare — a session-only root is the defect one
        // per run at most in practice — so this buffer's bound protects
        // memory against pathology without ever evicting the evidence a
        // single invocation's window needs: only a NEWER keyless record
        // evicts from here, and sequence is monotonic, so whatever evicts
        // in-window evidence sits in that same window itself. Eviction can
        // change which keyless record a window names, never whether it
        // names one.
        if (PatternManager.isKeylessPatternIdentity(record.identity)) {
          keyless.push(record);
          if (keyless.length > BUFFER_LIMIT) {
            keyless.shift();
          }
        }
      },
      instantiations: {
        sequence: () => sequence,
        since: (since) => records.filter((record) => record.sequence > since),
        keylessSince: (since) =>
          keyless.filter((record) => record.sequence > since),
      },
    };
  };

/**
 * The first record among `records` that materialized a keyless pattern, or
 * `undefined` when none did.
 *
 * In a RENDERING runtime a keyless instantiation is not on its own a defect:
 * re-running a piece's root re-creates its derived sub-pieces under the same
 * structural hash, so the browser shell mints benign keyless pointers for
 * them on every visit. The harness session renders nothing — the shapes that
 * mint those never instantiate here — so a keyless record inside one
 * `run_pattern` window means the created piece's own graph carries a durably
 * stamped session-only pattern (the shape a factory takes when it returns a
 * derived wrapper as its whole result), which a fresh runtime asked to open
 * the piece cannot resolve. Verified live both ways: a composed index
 * pattern of that shape records exactly one keyless instantiation here and
 * strands the browser, while plain-object factories — computed() fields,
 * sub-patterns in result position, `.map()` over sub-pattern instances —
 * record none.
 */
export const keylessInstantiation = (
  records: readonly FabricInstantiationRecord[],
): FabricInstantiationRecord | undefined =>
  records.find((record) =>
    PatternManager.isKeylessPatternIdentity(record.identity)
  );
