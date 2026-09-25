/**
 * Decides confidentiality fit at sink boundaries. The committed and
 * host-observed paths share every policy input; only grant consumption differs.
 */

import { type CfcAtom, cfcAtom } from "@commonfabric/api/cfc";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CfcConfClause } from "./clause.ts";
import {
  type CfcGrantConsumptionContext,
  evaluateExchangeRules,
  type ModulePolicyResolutionFailure,
  type RuleFiring,
} from "./exchange-eval.ts";
import { createTxCfcGrantResolver } from "./grants.ts";
import { atomsOutsideCeiling } from "./observation.ts";
import { createTxCfcModulePolicyResolver } from "./policy-resolver.ts";
import {
  type CfcRefusalDetail,
  type ConsumedAtomSource,
  describeRefusalInputs,
  renderCfcAtom,
} from "./refusal-detail.ts";
import { sinkClassOf } from "./sink-inventory.ts";
import { createTrustResolver } from "./trust.ts";
import type { CfcPolicyEvaluationMode, IFCLabel } from "./types.ts";

/** The transaction-global label and origin facts a sink decision consumes. */
export type ConsumedSinkLabel = {
  readonly confidentiality: readonly CfcConfClause[];
  readonly integrity: readonly CfcAtom[];
  readonly modulePolicySpaces: ReadonlyMap<
    string,
    ReadonlySet<MemorySpace>
  >;
  readonly sources: readonly ConsumedAtomSource[];
};

/** A policy-evaluation failure which prevents an enforcing sink decision. */
export type CfcSinkDecisionFailure = {
  readonly kind: "exhausted" | "resolution-unavailable";
  readonly reason: string;
  readonly resolutionFailures: readonly ModulePolicyResolutionFailure[];
  readonly grantResolutionUnavailable: boolean;
};

/** The complete decision made for one sink and confidentiality ceiling. */
export type CfcSinkDecision = {
  readonly status:
    | "fit"
    | "refused"
    | "exhausted"
    | "resolution-unavailable";
  readonly mode: CfcPolicyEvaluationMode;
  readonly grantConsumption: CfcGrantConsumptionContext;
  readonly rawLabel: IFCLabel;
  readonly evaluatedLabel: IFCLabel;
  readonly effectiveLabel: IFCLabel;
  readonly firings: readonly RuleFiring[];
  readonly offending: readonly CfcConfClause[];
  readonly refusal?: CfcRefusalDetail;
  readonly failure?: CfcSinkDecisionFailure;
};

/** Stable identity of a selected module-policy artifact. */
export const modulePolicyArtifactKey = (reference: unknown): string => {
  const candidate = reference as {
    moduleIdentity: string;
    symbol: string;
    policyDigest: string;
  };
  return `${candidate.moduleIdentity}\0${candidate.symbol}\0${candidate.policyDigest}`;
};

/** Runs exchange with the transaction's trust, grant, and policy snapshot. */
export const evaluateGatedConfidentiality = (
  tx: IExtendedStorageTransaction,
  confidentiality: readonly CfcConfClause[],
  integrity: readonly CfcAtom[],
  boundary: readonly CfcAtom[],
  consumption: CfcGrantConsumptionContext,
  destinationSpace?:
    | MemorySpace
    | ((reference: unknown) => MemorySpace | undefined),
): {
  readonly confidentiality: readonly CfcConfClause[];
  readonly exhausted: boolean;
  readonly firings: readonly RuleFiring[];
  readonly resolutionFailures: readonly ModulePolicyResolutionFailure[];
  readonly grantResolutionUnavailable: boolean;
} => {
  const state = tx.getCfcState();
  const grantAvailability = { unavailable: false };
  const result = evaluateExchangeRules(
    { confidentiality: [...confidentiality] },
    state.policySnapshot,
    {
      integrity,
      boundary,
      trustResolver: createTrustResolver(state.trustConfig),
      actingPrincipal: state.trustSnapshot?.actingPrincipal,
      grantResolver: createTxCfcGrantResolver(tx, {
        availability: grantAvailability,
      }),
      grantConsumption: consumption,
      modulePolicyResolver: createTxCfcModulePolicyResolver(
        tx,
        (reference) => {
          const space = typeof destinationSpace === "function"
            ? destinationSpace(reference)
            : destinationSpace;
          if (typeof destinationSpace === "function" && space === undefined) {
            return undefined;
          }
          return tx.resolveCfcPolicyManifest(reference, space);
        },
      ),
    },
  );
  return {
    confidentiality: result.exhausted
      ? confidentiality
      : result.label.confidentiality ?? [],
    exhausted: result.exhausted,
    firings: result.firings,
    resolutionFailures: result.resolutionFailures,
    grantResolutionUnavailable: grantAvailability.unavailable,
  };
};

/** Builds the refusal detail for a sink-ceiling misfit. */
const sinkCeilingRefusal = (
  sink: string,
  offending: readonly unknown[],
  sources: readonly ConsumedAtomSource[],
): CfcRefusalDetail => {
  const offendingAtoms = offending.map(renderCfcAtom);
  return {
    gate: "sink-ceiling",
    sink,
    offendingAtoms,
    ...describeRefusalInputs(offending, sources),
    reason: `sink-request confidentiality exceeds ceiling for ${sink}: ` +
      offendingAtoms.join(", "),
  };
};

/** Records module-policy failures for an observe-mode evaluation site. */
export const noteModulePolicyResolutionFailures = (
  tx: IExtendedStorageTransaction,
  site: string,
  failures: readonly ModulePolicyResolutionFailure[],
): void => {
  for (const failure of failures) {
    const reference = isObjectOrArray(failure.reference)
      ? failure.reference
      : undefined;
    const digest = typeof reference?.policyDigest === "string"
      ? ` digest ${reference.policyDigest}`
      : "";
    tx.noteCfcDiagnostic(
      `policy-evaluation(observe): module policy ${failure.reason}${digest} at ${site}`,
    );
  }
};

/** Records observe-mode differences without changing the decision label. */
const noteObserveDiagnostics = (
  tx: IExtendedStorageTransaction,
  sink: string,
  rawOffending: readonly CfcConfClause[],
  rewrittenOffending: readonly CfcConfClause[] | undefined,
  outcome: ReturnType<typeof evaluateGatedConfidentiality>,
): void => {
  noteModulePolicyResolutionFailures(
    tx,
    `sink-request ${sink}`,
    outcome.resolutionFailures,
  );
  if (outcome.exhausted) {
    tx.noteCfcDiagnostic(
      `policy-evaluation(observe): fuel exhausted for sink-request ${sink}`,
    );
  } else if (
    rewrittenOffending !== undefined &&
    (rawOffending.length > 0) !== (rewrittenOffending.length > 0)
  ) {
    tx.noteCfcDiagnostic(
      `policy-evaluation(observe): rewrite would change sink-request ` +
        `ceiling for ${sink} from ${
          rawOffending.length > 0 ? "reject" : "fit"
        } to ${
          rewrittenOffending.length > 0 ? "reject" : "fit"
        } (${outcome.firings.length} firings)`,
    );
  }
};

/**
 * Decides one sink fit from a collected label. The caller chooses whether
 * single-use grants may be consumed; every other decision input is shared.
 */
export const decideSinkFit = (
  tx: IExtendedStorageTransaction,
  consumed: ConsumedSinkLabel,
  attributedSources: readonly ConsumedAtomSource[],
  sink: string,
  ceiling: readonly CfcConfClause[],
  grantConsumption: CfcGrantConsumptionContext,
): CfcSinkDecision => {
  const mode = tx.getCfcState().policyEvaluationMode;
  const rawLabel: IFCLabel = {
    confidentiality: [...consumed.confidentiality],
    integrity: [...consumed.integrity],
  };
  const rawOffending = atomsOutsideCeiling(
    consumed.confidentiality,
    ceiling,
  );
  let evaluatedLabel = rawLabel;
  let effectiveLabel = rawLabel;
  let firings: readonly RuleFiring[] = [];
  if (mode !== "off") {
    const outcome = evaluateGatedConfidentiality(
      tx,
      consumed.confidentiality,
      consumed.integrity,
      [
        cfcAtom.boundaryContext("sink", sink),
        cfcAtom.boundaryContext("sinkClass", sinkClassOf(sink)),
      ],
      grantConsumption,
      (reference) => {
        const spaces = [
          ...(consumed.modulePolicySpaces.get(
            modulePolicyArtifactKey(reference),
          ) ?? []),
        ].sort();
        if (spaces.length === 0) return undefined;
        tx.enableMultiSpaceWrites?.(spaces);
        for (const space of spaces) {
          if (tx.resolveCfcPolicyManifest(reference, space) === undefined) {
            return undefined;
          }
        }
        return spaces[0];
      },
    );
    evaluatedLabel = {
      confidentiality: [...outcome.confidentiality],
      integrity: [...consumed.integrity],
    };
    firings = outcome.firings;
    const rewrittenOffending = outcome.exhausted
      ? undefined
      : atomsOutsideCeiling(outcome.confidentiality, ceiling);
    if (mode === "observe") {
      noteObserveDiagnostics(
        tx,
        sink,
        rawOffending,
        rewrittenOffending,
        outcome,
      );
    } else {
      effectiveLabel = evaluatedLabel;
      if (outcome.exhausted) {
        const reason =
          `cfc policy evaluation exhausted fuel for sink-request ${sink}`;
        return {
          status: "exhausted",
          mode,
          grantConsumption,
          rawLabel,
          evaluatedLabel,
          effectiveLabel,
          firings,
          offending: [],
          failure: {
            kind: "exhausted",
            reason,
            resolutionFailures: [],
            grantResolutionUnavailable: false,
          },
        };
      }
      if (
        outcome.resolutionFailures.length > 0 ||
        outcome.grantResolutionUnavailable
      ) {
        const reason =
          `cfc policy evaluation unavailable for sink-request ${sink}`;
        return {
          status: "resolution-unavailable",
          mode,
          grantConsumption,
          rawLabel,
          evaluatedLabel,
          effectiveLabel,
          firings,
          offending: [],
          failure: {
            kind: "resolution-unavailable",
            reason,
            resolutionFailures: outcome.resolutionFailures,
            grantResolutionUnavailable: outcome.grantResolutionUnavailable,
          },
        };
      }
    }
  }
  const offending = atomsOutsideCeiling(
    effectiveLabel.confidentiality ?? [],
    ceiling,
  );
  const refusal = offending.length === 0
    ? undefined
    : sinkCeilingRefusal(sink, offending, attributedSources);
  return {
    status: refusal === undefined ? "fit" : "refused",
    mode,
    grantConsumption,
    rawLabel,
    evaluatedLabel,
    effectiveLabel,
    firings,
    offending,
    ...(refusal === undefined ? {} : { refusal }),
  };
};
