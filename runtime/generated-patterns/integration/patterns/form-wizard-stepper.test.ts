import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

const wizardSteps = [
  {
    id: "profile",
    label: "Profile",
    fields: [
      { id: "name", label: "Full Name", required: true },
      { id: "email", label: "Email", required: true },
    ],
  },
  {
    id: "details",
    label: "Details",
    fields: [
      { id: "address", label: "Address", required: true },
      { id: "city", label: "City", required: true },
    ],
  },
  {
    id: "confirmation",
    label: "Confirmation",
    fields: [
      { id: "agreement", label: "Agreement", required: true },
    ],
  },
];

const initialFieldValues = {
  profile: { name: "Ada Lovelace", email: "" },
  details: { address: "", city: "" },
  confirmation: { agreement: "" },
};

export const formWizardStepperScenario: PatternIntegrationScenario<
  {
    steps?: Array<
      {
        id?: string;
        label?: string;
        fields?: Array<
          { id?: string; label?: string; required?: boolean }
        >;
      }
    >;
    currentStepIndex?: number;
    fieldValues?: Record<string, Record<string, string>>;
  }
> = {
  name: "form wizard blocks progress until steps valid",
  module: new URL(
    "./form-wizard-stepper.pattern.ts",
    import.meta.url,
  ),
  exportName: "formWizardStepper",
  argument: {
    steps: wizardSteps,
    currentStepIndex: 0,
    fieldValues: initialFieldValues,
  },
  steps: [
    {
      expect: [
        { path: "activeIndex", value: 0 },
        { path: "stepStates.0.status", value: "active" },
        { path: "stepStates.0.remaining", value: ["email"] },
        { path: "stepStates.1.status", value: "pending" },
        { path: "canAdvance", value: false },
        { path: "blockMessage", value: "" },
        { path: "progressSummary", value: "Profile (1 of 3)" },
      ],
    },
    {
      events: [{ stream: "advanceStep", payload: {} }],
      expect: [
        { path: "currentStepIndex", value: 0 },
        { path: "blockMessage", value: "Profile blocked: Email required" },
        { path: "stepStates.0.remaining", value: ["email"] },
        { path: "canAdvance", value: false },
      ],
    },
    {
      events: [{
        stream: "updateField",
        payload: {
          stepId: "profile",
          fieldId: "email",
          value: "ada@commontools.dev",
        },
      }],
      expect: [
        { path: "valuesView.profile.email", value: "ada@commontools.dev" },
        { path: "blockMessage", value: "" },
        { path: "stepStates.0.remaining", value: [] },
        { path: "canAdvance", value: true },
      ],
    },
    {
      events: [{ stream: "advanceStep", payload: {} }],
      expect: [
        { path: "currentStepIndex", value: 1 },
        { path: "activeIndex", value: 1 },
        { path: "stepStates.0.status", value: "complete" },
        { path: "stepStates.1.status", value: "active" },
        { path: "stepStates.1.remaining", value: ["address", "city"] },
        { path: "progressSummary", value: "Details (2 of 3)" },
        { path: "canAdvance", value: false },
      ],
    },
    {
      events: [{ stream: "advanceStep", payload: {} }],
      expect: [
        { path: "currentStepIndex", value: 1 },
        {
          path: "blockMessage",
          value: "Details blocked: Address, City required",
        },
        { path: "stepStates.1.remaining", value: ["address", "city"] },
      ],
    },
    {
      events: [{
        stream: "updateField",
        payload: {
          stepId: "details",
          fieldId: "address",
          value: "123 Analytical Way",
        },
      }],
      expect: [
        { path: "valuesView.details.address", value: "123 Analytical Way" },
        { path: "blockMessage", value: "" },
        { path: "stepStates.1.remaining", value: ["city"] },
        { path: "canAdvance", value: false },
      ],
    },
    {
      events: [{
        stream: "updateField",
        payload: {
          stepId: "details",
          fieldId: "city",
          value: "London",
        },
      }],
      expect: [
        { path: "valuesView.details.city", value: "London" },
        { path: "stepStates.1.remaining", value: [] },
        { path: "canAdvance", value: true },
      ],
    },
    {
      events: [{ stream: "advanceStep", payload: {} }],
      expect: [
        { path: "currentStepIndex", value: 2 },
        { path: "activeIndex", value: 2 },
        { path: "progressSummary", value: "Confirmation (3 of 3)" },
        { path: "stepStates.1.status", value: "complete" },
        { path: "stepStates.2.status", value: "active" },
        { path: "stepStates.2.remaining", value: ["agreement"] },
        { path: "canAdvance", value: false },
      ],
    },
    {
      events: [{ stream: "advanceStep", payload: {} }],
      expect: [
        { path: "currentStepIndex", value: 2 },
        {
          path: "blockMessage",
          value: "Confirmation blocked: Agreement required",
        },
        { path: "stepStates.2.remaining", value: ["agreement"] },
      ],
    },
    {
      events: [{
        stream: "updateField",
        payload: {
          stepId: "confirmation",
          fieldId: "agreement",
          value: "yes",
        },
      }],
      expect: [
        { path: "valuesView.confirmation.agreement", value: "yes" },
        { path: "blockMessage", value: "" },
        { path: "stepStates.2.remaining", value: [] },
        { path: "canAdvance", value: true },
      ],
    },
    {
      events: [{ stream: "advanceStep", payload: {} }],
      expect: [
        { path: "currentStepIndex", value: 2 },
        { path: "blockMessage", value: "" },
        { path: "canAdvance", value: true },
      ],
    },
    {
      events: [{ stream: "retreatStep", payload: {} }],
      expect: [
        { path: "currentStepIndex", value: 1 },
        { path: "activeIndex", value: 1 },
        { path: "progressSummary", value: "Details (2 of 3)" },
        { path: "canAdvance", value: true },
        { path: "blockMessage", value: "" },
      ],
    },
  ],
};

export const scenarios = [formWizardStepperScenario];

describe("form-wizard-stepper", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
