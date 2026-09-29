/**
 * What a CFC gate says when it turns something away.
 *
 * Two gates deny: the write gate in `prepare.ts`, which stops a commit, and
 * the render gate in the reconciler, which swaps blocked content for a
 * placeholder. Each calls this where it decides, so the decision is visible
 * there rather than at the scheduler or the renderer, whose output is where
 * its effect shows.
 *
 * `summary` is a fixed sentence naming the kind of decision, and carries
 * nothing assembled from a reason, a label, a value, or a path. `inputs` is
 * the labels, the ceiling, and the dials behind the decision. A render
 * denial's inputs name the confidentiality label of content the viewer was not
 * cleared to see, and a label gives away the thing it protects, so the summary
 * goes to warning level and the inputs only to debug and to a denial listener.
 * A listener is registered only by a diagnostic tool the user asked for, such
 * as `cf test --cfc-denials`, and is told of every denial, repeats included.
 * Passing `inputs` as a function keeps a gate from building them where nothing
 * takes them.
 *
 * Both gates re-decide whenever their inputs change — the reconciler on each
 * update to a blocked cell, the write gate on each retried commit. So a
 * summary is announced once and the repeats are its count: `code` is the
 * message key, and `commonfabric.logger["cfc"].countsByKey` carries the
 * per-kind totals.
 */

import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("cfc");
const announced = new Set<string>();
const listeners = new Set<CfcDenialListener>();

/** Every kind of decision a gate reports, each also its message key. */
export const CFC_DENIAL_CODES = [
  "write-policy-gate",
  "write-prepare-crashed",
  "write-unprepared",
  "write-prepared-digest-mismatch",
  "render-confidentiality-ceiling",
  "render-text-integrity",
  "render-literal-text-integrity",
] as const;

/** One kind of decision a gate reports. */
export type CfcDenialCode = typeof CFC_DENIAL_CODES[number];

/** Indicates whether `key` names a kind of denial. */
export const isCfcDenialCode = (key: string): key is CfcDenialCode =>
  (CFC_DENIAL_CODES as readonly string[]).includes(key);

/** One denial, as {@link reportCfcDenial} was told of it. */
export type CfcDenial = {
  /** The kind of decision, which is also its message key. */
  readonly code: CfcDenialCode;

  /** A fixed sentence naming the kind of decision. */
  readonly summary: string;

  /** The labels, the ceiling, and the dials behind the decision. */
  readonly inputs: Record<string, unknown>;
};

/**
 * Something told of every denial. Its `inputs` can name a confidentiality
 * label that the party the gate turned away was not cleared to see, so only a
 * diagnostic tool the user asked for registers one. It is called from inside
 * the gate, so it must not throw.
 */
export type CfcDenialListener = (denial: CfcDenial) => void;

/** Say that a gate blocked something. */
export const reportCfcDenial = (
  code: CfcDenialCode,
  summary: string,
  inputs: () => Record<string, unknown>,
): void => {
  if (!announced.has(code)) {
    announced.add(code);
    logger.warn(code, summary);
  }
  // The inputs are built at most once, and only where something takes them.
  let built: Record<string, unknown> | undefined;
  const builtInputs = () => built ??= inputs();
  for (const listener of listeners) {
    listener({ code, summary, inputs: builtInputs() });
  }
  logger.debug(code, () => [summary, builtInputs()]);
};

/**
 * Tells `listener` of every denial from now on, until the returned function
 * is called.
 */
export const addCfcDenialListener = (
  listener: CfcDenialListener,
): () => void => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Forget which codes have been announced; the next of each announces again. */
export const resetCfcDenialAnnouncements = (): void => announced.clear();
