import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  CFC_ATOM_TYPE,
  CFC_CONCEPT_KIND,
  cfcAtom,
} from "@commonfabric/api/cfc";
import { isObjectOrArray } from "@commonfabric/utils/types";

import {
  type CfcConfClause,
  type CfcOrClause,
  clauseAlternatives,
  clausesEqual,
  normalizeClause,
} from "../src/cfc/clause.ts";
import { evaluateExchangeRules } from "../src/cfc/exchange-eval.ts";
import { uniqueCfcAtoms } from "../src/cfc/observation.ts";
import { buildCfcPolicySnapshot } from "../src/cfc/policy.ts";
import {
  dischargeMaterialRiskAtoms,
  INJECTION_SAFE_ATOM,
} from "../src/cfc/schema-sanitization.ts";
import {
  MATERIAL_RISK_DISCHARGE_KINDS,
  MATERIAL_RISK_DISCHARGE_POLICY,
  STANDARD_PROMPT_CAVEAT_POLICY,
} from "../src/cfc/standard-profile.ts";

// Epic B6 (docs/history/plans/cfc-future-work-implementation.md §3): the §10.1
// standard prompt-caveat profile as PolicyRecords. The goldens prove the
// material-risk discharge rule reproduces the retired `filterMaterialRiskAtoms`
// strip byte-for-byte; the remaining tests exercise the tier upgrades,
// display discharge, the InjectionSafe/PROMPT_INFLUENCE boundary, and the
// value-stage re-binding blind spot.

const PROFILE = buildCfcPolicySnapshot(STANDARD_PROMPT_CAVEAT_POLICY)!;
// The sanitizer's path-local material-risk discharge (guarded by bare
// InjectionSafe) — the goldens exercise THIS set, not the deployment profile
// (which no longer carries bare-InjectionSafe material-risk drop; see B6
// review, cubic P1 on #4567).
const MATERIAL_RISK_PROFILE = buildCfcPolicySnapshot(
  MATERIAL_RISK_DISCHARGE_POLICY,
)!;

const caveat = (kind: string, source: string = "of:hostile") =>
  cfcAtom.caveat(kind, source);

// The retired strip, kept here as the golden ORACLE: this is exactly what
// `filterMaterialRiskAtoms` computed before B6 deleted it.
const materialKinds = new Set(MATERIAL_RISK_DISCHARGE_KINDS);
const isMaterialRisk = (atom: unknown): boolean => {
  if (typeof atom === "string") return materialKinds.has(atom);
  return isObjectOrArray(atom) &&
    (atom as { type?: unknown }).type === CFC_ATOM_TYPE.Caveat &&
    typeof (atom as { kind?: unknown }).kind === "string" &&
    materialKinds.has((atom as { kind: string }).kind);
};
const legacyStrip = (atoms: readonly CfcConfClause[]): CfcConfClause[] =>
  uniqueCfcAtoms(
    atoms
      .map((clause) => {
        if (
          !isObjectOrArray(clause) ||
          !Array.isArray((clause as { anyOf?: unknown }).anyOf)
        ) {
          return isMaterialRisk(clause) ? undefined : clause;
        }
        const kept = (clause as { anyOf: unknown[] }).anyOf.filter(
          (alternative) => !isMaterialRisk(alternative),
        );
        return kept.length === 0
          ? undefined
          : normalizeClause({ anyOf: kept } as CfcOrClause);
      })
      .filter((clause) => clause !== undefined),
  );

// The sanitizer runs this path with path-local, bare-InjectionSafe
// material-risk discharge. Calling its exported entry point includes short
// alias normalization.
const dischargeViaProfile = (
  atoms: readonly CfcConfClause[],
): CfcConfClause[] => dischargeMaterialRiskAtoms(atoms);

const clauseSetsEqual = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length &&
  a.every((clause) =>
    b.some((other) =>
      clausesEqual(clause as CfcConfClause, other as CfcConfClause)
    )
  ) &&
  b.every((clause) =>
    a.some((other) =>
      clausesEqual(clause as CfcConfClause, other as CfcConfClause)
    )
  );

describe("CFC standard prompt-caveat profile (B6)", () => {
  describe("material-risk discharge reproduces the retired strip (goldens)", () => {
    const influence = caveat(CFC_CONCEPT_KIND.PromptInfluence);
    const secret = { type: CFC_ATOM_TYPE.User, subject: "did:key:alice" };
    const scenarios: Array<[string, CfcConfClause[]]> = [
      ["bare unscreened risk", [caveat(
        CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
      )]],
      ["bare-string alias", [caveat("prompt-injection-risk-value-screened")]],
      ["bare-string alias atom", ["prompt-injection-risk-unscreened"]],
      ["bare-string risk atom beside retained secret", [
        "prompt-injection-risk-unscreened",
        secret,
      ]],
      ["bare-string risk atom hidden as an OR-clause alternative", [
        { anyOf: ["prompt-injection-risk-ingress-screened", secret] },
      ]],
      ["OR-clause of only bare-string risk atoms", [
        {
          anyOf: [
            "prompt-injection-risk-unscreened",
            "prompt-injection-risk-value-screened",
          ],
        },
      ]],
      ["non-risk bare string is retained", ["some-other-marker", secret]],
      ["risk beside retained influence + secret", [
        caveat(CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened),
        influence,
        secret,
      ]],
      ["risk hidden as an OR-clause alternative", [
        {
          anyOf: [
            caveat(CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened),
            secret,
          ],
        },
      ]],
      ["OR-clause entirely material-risk", [
        {
          anyOf: [
            caveat(CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened),
            caveat(CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened),
          ],
        },
      ]],
      ["no material risk at all", [influence, secret]],
      ["empty", []],
      ["all three canonical tiers together", [
        caveat(CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened),
        caveat(CFC_CONCEPT_KIND.PromptInjectionRiskIngressScreened),
        caveat(CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened),
        secret,
      ]],
    ];

    for (const [name, input] of scenarios) {
      it(name, () => {
        const oracle = legacyStrip(input);
        const ruled = dischargeViaProfile(input);
        expect(clauseSetsEqual(ruled, oracle)).toBe(true);
      });
    }

    it("retains retired unsuffixed identifiers", () => {
      const retiredUri = caveat(
        "https://commonfabric.org/cfc/concepts/prompt-injection-risk",
      );
      const retiredAlias = "prompt-injection-risk";
      expect(dischargeViaProfile([retiredUri, retiredAlias])).toEqual([
        retiredUri,
        retiredAlias,
      ]);
    });

    it("does not discharge material risk WITHOUT InjectionSafe", () => {
      const input = [caveat(CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened)];
      const result = evaluateExchangeRules(
        { confidentiality: input },
        MATERIAL_RISK_PROFILE,
        { integrity: [] },
      );
      expect(result.label.confidentiality).toEqual(input);
    });

    it("the DEPLOYMENT profile never discharges material risk via bare InjectionSafe (cross-value hole)", () => {
      // The bare-InjectionSafe material-risk discharge is sanitizer-only. At a
      // boundary the integrity pool is the whole consumed label's join, so a
      // benign InjectionSafe from one value must NOT clear a material-risk
      // caveat on another. The deployment profile therefore carries no such
      // rule (cubic P1 on #4567): the caveat survives.
      const input = [caveat(CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened)];
      const result = evaluateExchangeRules(
        { confidentiality: input },
        PROFILE,
        { integrity: [INJECTION_SAFE_ATOM] },
      );
      expect(result.label.confidentiality).toEqual(input);
    });
  });

  describe("tier upgrades (add-alternative)", () => {
    it("unscreened → ingress-screened on matching ingress evidence", () => {
      const source = "of:src";
      const result = evaluateExchangeRules(
        {
          confidentiality: [caveat(
            CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
            source,
          )],
        },
        PROFILE,
        {
          integrity: [cfcAtom.caveatScreened({
            kind: CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
            source,
            stage: "ingress",
            detector: cfcAtom.builtin("detector"),
            verdict: "pass",
          })],
        },
      );
      const clause = result.label.confidentiality![0];
      const alternatives = clauseAlternatives(clause as CfcConfClause);
      // Lower tier remains; higher tier added as an alternative.
      expect(alternatives).toContainEqual(
        caveat(CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened, source),
      );
      expect(alternatives).toContainEqual(
        caveat(CFC_CONCEPT_KIND.PromptInjectionRiskIngressScreened, source),
      );
    });

    it("does not upgrade on a verdict other than pass", () => {
      const source = "of:src";
      const result = evaluateExchangeRules(
        {
          confidentiality: [caveat(
            CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
            source,
          )],
        },
        PROFILE,
        {
          integrity: [cfcAtom.caveatScreened({
            kind: CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
            source,
            stage: "ingress",
            detector: cfcAtom.builtin("detector"),
            verdict: "suspect",
          })],
        },
      );
      expect(result.label.confidentiality).toEqual([
        caveat(CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened, source),
      ]);
    });

    it("does not upgrade on a source mismatch (§10.1 same-source guard)", () => {
      const result = evaluateExchangeRules(
        {
          confidentiality: [caveat(
            CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
            "of:a",
          )],
        },
        PROFILE,
        {
          integrity: [cfcAtom.caveatScreened({
            kind: CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
            source: "of:b",
            stage: "ingress",
            detector: cfcAtom.builtin("detector"),
            verdict: "pass",
          })],
        },
      );
      expect(result.label.confidentiality).toEqual([
        caveat(CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened, "of:a"),
      ]);
    });
  });

  describe("value-stage screening + re-binding blind spot", () => {
    const source = "of:src";
    const valueScreened = caveat(
      CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened,
      source,
    );
    const freshValueEvidence = cfcAtom.caveatScreened({
      kind: CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened,
      source,
      stage: "value",
      detector: cfcAtom.builtin("detector"),
      verdict: "pass",
      valueRef: { "/": "value-doc" },
    });

    it("discharges a value-screened caveat WITH fresh value-stage evidence", () => {
      const result = evaluateExchangeRules(
        { confidentiality: [valueScreened] },
        PROFILE,
        { integrity: [freshValueEvidence] },
      );
      expect(result.label.confidentiality).toEqual([]);
    });

    it("does NOT discharge a value-screened caveat once evidence is gone (post-transform)", () => {
      // After a non-exactCopyOf transform the value-bound CaveatScreened atom
      // drops from the value's integrity (§15.4 propagation), so the tier
      // alternative persists but has no discharging evidence — the rule stops
      // matching. This is the §10.1 re-binding blind spot: the stale marker
      // cannot fire on its own.
      const result = evaluateExchangeRules(
        { confidentiality: [valueScreened] },
        PROFILE,
        { integrity: [] },
      );
      expect(result.label.confidentiality).toEqual([valueScreened]);
    });

    it("does not discharge value-screened via an INGRESS-stage screening atom", () => {
      // Only value-stage evidence carries the binding; an ingress verdict for
      // the same source must not release the value tier.
      const result = evaluateExchangeRules(
        { confidentiality: [valueScreened] },
        PROFILE,
        {
          integrity: [cfcAtom.caveatScreened({
            kind: CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened,
            source,
            stage: "ingress",
            detector: cfcAtom.builtin("detector"),
            verdict: "pass",
          })],
        },
      );
      expect(result.label.confidentiality).toEqual([valueScreened]);
    });
  });

  describe("influence-caveat discipline", () => {
    const source = "of:src";
    const influence = caveat(CFC_CONCEPT_KIND.PromptInfluence, source);

    it("InjectionSafe alone never clears PROMPT_INFLUENCE (§10.1)", () => {
      const result = evaluateExchangeRules(
        { confidentiality: [influence] },
        PROFILE,
        { integrity: [INJECTION_SAFE_ATOM] },
      );
      expect(result.label.confidentiality).toEqual([influence]);
    });

    const renderedFor = (sink: string) =>
      cfcAtom.disclosureRendered({
        kind: CFC_CONCEPT_KIND.PromptInfluence,
        source,
        sink,
        renderRef: { seq: 1, rootRef: { "/": "root" } },
        snapshotDigest: "sha256:snap",
      });

    it("releases PROMPT_INFLUENCE at a display sink via a rendered disclosure for THAT sink", () => {
      const result = evaluateExchangeRules(
        { confidentiality: [influence] },
        PROFILE,
        {
          integrity: [renderedFor("chat")],
          boundary: [
            cfcAtom.boundaryContext("sinkClass", "display"),
            cfcAtom.boundaryContext("sink", "chat"),
          ],
        },
      );
      expect(result.label.confidentiality).toEqual([]);
    });

    it("does NOT release when the disclosure is for a DIFFERENT sink (cross-sink hole)", () => {
      // A disclosure rendered for "chat" must not clear the influence caveat
      // egressing to "sendMail", even though both are display-class (cubic P1
      // on #4567). The sink binding correlates the evidence to the release
      // site.
      const result = evaluateExchangeRules(
        { confidentiality: [influence] },
        PROFILE,
        {
          integrity: [renderedFor("chat")],
          boundary: [
            cfcAtom.boundaryContext("sinkClass", "display"),
            cfcAtom.boundaryContext("sink", "sendMail"),
          ],
        },
      );
      expect(result.label.confidentiality).toEqual([influence]);
    });

    it("does not release a rendered disclosure without the display boundary context", () => {
      const result = evaluateExchangeRules(
        { confidentiality: [influence] },
        PROFILE,
        {
          integrity: [renderedFor("chat")],
          // No BoundaryContext — the site is not known to be a display sink.
        },
      );
      expect(result.label.confidentiality).toEqual([influence]);
    });

    it("requires acknowledgment (not a mere rendered disclosure) for routing fields", () => {
      const routingBoundary = [
        cfcAtom.boundaryContext("fieldRole", "routing"),
        cfcAtom.boundaryContext("sink", "sendMail"),
      ];
      // A rendered disclosure is NOT enough for a routing-sensitive field.
      const rendered = evaluateExchangeRules(
        { confidentiality: [influence] },
        PROFILE,
        {
          integrity: [renderedFor("sendMail")],
          boundary: routingBoundary,
        },
      );
      expect(rendered.label.confidentiality).toEqual([influence]);
      // Explicit acknowledgment FOR THAT SINK discharges it.
      const acknowledged = evaluateExchangeRules(
        { confidentiality: [influence] },
        PROFILE,
        {
          integrity: [cfcAtom.disclosureAcknowledged({
            user: "did:key:alice",
            kind: CFC_CONCEPT_KIND.PromptInfluence,
            source,
            sink: "sendMail",
            renderRef: { seq: 1, rootRef: { "/": "root" } },
            snapshotDigest: "sha256:snap",
          })],
          boundary: routingBoundary,
        },
      );
      expect(acknowledged.label.confidentiality).toEqual([]);
      // An acknowledgment WITHOUT a sink cannot discharge (fail-closed): the
      // rule's sink binding has nothing to unify against.
      const unsinked = evaluateExchangeRules(
        { confidentiality: [influence] },
        PROFILE,
        {
          integrity: [cfcAtom.disclosureAcknowledged({
            user: "did:key:alice",
            kind: CFC_CONCEPT_KIND.PromptInfluence,
            source,
            renderRef: { seq: 1, rootRef: { "/": "root" } },
            snapshotDigest: "sha256:snap",
          })],
          boundary: routingBoundary,
        },
      );
      expect(unsinked.label.confidentiality).toEqual([influence]);
    });
  });

  describe("profile shape", () => {
    it("validates + freezes as a policy snapshot", () => {
      expect(Object.isFrozen(PROFILE)).toBe(true);
      expect(PROFILE.records).toHaveLength(1);
      expect(PROFILE.records[0].id).toBe(
        "cfc:standard-prompt-caveat-profile",
      );
    });
  });
});
