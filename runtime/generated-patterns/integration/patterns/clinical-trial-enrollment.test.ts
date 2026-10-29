import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";
import type {
  EnrollmentCriteria,
  TrialCandidate,
} from "./clinical-trial-enrollment.pattern.ts";

export const clinicalTrialEnrollmentScenario: PatternIntegrationScenario<
  {
    participants?: TrialCandidate[];
    criteria?: Partial<EnrollmentCriteria>;
  }
> = {
  name: "eligibility responds to screening toggles",
  module: new URL(
    "./clinical-trial-enrollment.pattern.ts",
    import.meta.url,
  ),
  exportName: "clinicalTrialEnrollment",
  steps: [
    {
      expect: [
        { path: "eligibleIds", value: ["P-001", "P-004"] },
        {
          path: "eligibleSummary",
          value: "2 of 4 participants eligible",
        },
        {
          path: "ineligibleReport",
          value: [
            {
              id: "P-002",
              reasons: [
                "condition mismatch",
                "consent pending",
              ],
            },
            {
              id: "P-003",
              reasons: [
                "below minimum age",
                "biomarker below threshold",
                "previous therapy excluded",
              ],
            },
          ],
        },
        {
          path: "siteSummary",
          value: [
            { site: "East Facility", eligible: 1, total: 1, eligibleRatio: 1 },
            {
              site: "North Campus",
              eligible: 1,
              total: 2,
              eligibleRatio: 0.5,
            },
            { site: "West Clinic", eligible: 0, total: 1, eligibleRatio: 0 },
          ],
        },
      ],
    },
    {
      events: [
        {
          stream: "updateCriteria",
          payload: {
            minAge: 25,
            minBiomarkerScore: 55,
            allowPriorTherapy: true,
          },
        },
      ],
      expect: [
        {
          path: "eligibleIds",
          value: ["P-001", "P-003", "P-004"],
        },
        {
          path: "eligibleSummary",
          value: "3 of 4 participants eligible",
        },
        {
          path: "ineligibleReport",
          value: [
            {
              id: "P-002",
              reasons: [
                "condition mismatch",
                "consent pending",
              ],
            },
          ],
        },
        {
          path: "siteSummary",
          value: [
            { site: "East Facility", eligible: 1, total: 1, eligibleRatio: 1 },
            {
              site: "North Campus",
              eligible: 1,
              total: 2,
              eligibleRatio: 0.5,
            },
            { site: "West Clinic", eligible: 1, total: 1, eligibleRatio: 1 },
          ],
        },
      ],
    },
    {
      events: [
        {
          stream: "updateCriteria",
          payload: {
            requireConsent: false,
            allowedSites: ["north campus", "west clinic"],
          },
        },
      ],
      expect: [
        {
          path: "eligibleIds",
          value: ["P-001", "P-003"],
        },
        {
          path: "eligibleSummary",
          value: "2 of 4 participants eligible",
        },
        {
          path: "ineligibleReport",
          value: [
            { id: "P-002", reasons: ["condition mismatch"] },
            { id: "P-004", reasons: ["site not approved"] },
          ],
        },
        {
          path: "siteSummary",
          value: [
            { site: "East Facility", eligible: 0, total: 1, eligibleRatio: 0 },
            {
              site: "North Campus",
              eligible: 1,
              total: 2,
              eligibleRatio: 0.5,
            },
            { site: "West Clinic", eligible: 1, total: 1, eligibleRatio: 1 },
          ],
        },
      ],
    },
    {
      events: [
        {
          stream: "recordScreening",
          payload: { id: "P-003", biomarkerScore: 40 },
        },
      ],
      expect: [
        {
          path: "eligibleIds",
          value: ["P-001"],
        },
        {
          path: "eligibleSummary",
          value: "1 of 4 participants eligible",
        },
        {
          path: "ineligibleReport",
          value: [
            { id: "P-002", reasons: ["condition mismatch"] },
            { id: "P-003", reasons: ["biomarker below threshold"] },
            { id: "P-004", reasons: ["site not approved"] },
          ],
        },
        {
          path: "siteSummary",
          value: [
            { site: "East Facility", eligible: 0, total: 1, eligibleRatio: 0 },
            {
              site: "North Campus",
              eligible: 1,
              total: 2,
              eligibleRatio: 0.5,
            },
            { site: "West Clinic", eligible: 0, total: 1, eligibleRatio: 0 },
          ],
        },
      ],
    },
    {
      events: [
        {
          stream: "updateCriteria",
          payload: {
            minBiomarkerScore: 35,
            allowedSites: [
              "east facility",
              "north campus",
              "west clinic",
            ],
          },
        },
      ],
      expect: [
        {
          path: "eligibleIds",
          value: ["P-001", "P-003", "P-004"],
        },
        {
          path: "eligibleSummary",
          value: "3 of 4 participants eligible",
        },
        {
          path: "ineligibleReport",
          value: [
            { id: "P-002", reasons: ["condition mismatch"] },
          ],
        },
        {
          path: "siteSummary",
          value: [
            { site: "East Facility", eligible: 1, total: 1, eligibleRatio: 1 },
            {
              site: "North Campus",
              eligible: 1,
              total: 2,
              eligibleRatio: 0.5,
            },
            { site: "West Clinic", eligible: 1, total: 1, eligibleRatio: 1 },
          ],
        },
        {
          path: "criteria.allowedSites",
          value: ["East Facility", "North Campus", "West Clinic"],
        },
        { path: "criteria.minBiomarkerScore", value: 35 },
      ],
    },
  ],
};

export const scenarios = [clinicalTrialEnrollmentScenario];

describe("clinical-trial-enrollment", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
