import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";
import type {
  HoldRecord,
  LoanRecord,
} from "./library-checkout-system.pattern.ts";

const expectLoans = (entries: LoanRecord[]): LoanRecord[] =>
  entries.map((entry) => ({ ...entry }));

const expectHolds = (entries: HoldRecord[]): HoldRecord[] =>
  entries.map((entry) => ({ ...entry }));

export const libraryCheckoutSystemScenario: PatternIntegrationScenario = {
  name: "library checkout manages loans, holds, and availability",
  module: new URL(
    "./library-checkout-system.pattern.ts",
    import.meta.url,
  ),
  exportName: "libraryCheckoutSystem",
  steps: [
    {
      expect: [
        {
          path: "availabilitySignals",
          value: [
            "atlas-of-dawn|limited|2|0",
            "modular-thoughts|on-hold|0|1",
            "synthesis-primer|available|2|0",
          ],
        },
        {
          path: "loanEntries",
          value: expectLoans([
            {
              sequence: 1,
              itemId: "atlas-of-dawn",
              memberId: "member-alba",
            },
            {
              sequence: 2,
              itemId: "modular-thoughts",
              memberId: "member-luis",
            },
          ]),
        },
        {
          path: "holdEntries",
          value: expectHolds([
            {
              sequence: 1,
              itemId: "modular-thoughts",
              memberId: "member-jade",
            },
          ]),
        },
        { path: "availableTitleCount", value: 2 },
        { path: "activeLoanCount", value: 2 },
        { path: "pendingHoldCount", value: 1 },
        {
          path: "availabilitySummary",
          value: "2/3 titles open · 2 active loans · 1 hold queued",
        },
        {
          path: "lastChangeLabel",
          value: "No circulation changes yet",
        },
      ],
    },
    {
      events: [
        {
          stream: "checkout",
          payload: { itemId: "Synthesis Primer", memberId: "Lina Rivers" },
        },
      ],
      expect: [
        {
          path: "availabilitySignals",
          value: [
            "atlas-of-dawn|limited|2|0",
            "modular-thoughts|on-hold|0|1",
            "synthesis-primer|limited|1|0",
          ],
        },
        {
          path: "loanEntries",
          value: expectLoans([
            {
              sequence: 1,
              itemId: "atlas-of-dawn",
              memberId: "member-alba",
            },
            {
              sequence: 2,
              itemId: "modular-thoughts",
              memberId: "member-luis",
            },
            {
              sequence: 3,
              itemId: "synthesis-primer",
              memberId: "member-lina-rivers",
            },
          ]),
        },
        { path: "activeLoanCount", value: 3 },
        {
          path: "availabilitySummary",
          value: "2/3 titles open · 3 active loans · 1 hold queued",
        },
        {
          path: "lastChangeLabel",
          value: "member-lina-rivers checked out Synthesis Primer (#1)",
        },
      ],
    },
    {
      events: [
        {
          stream: "returnLoan",
          payload: { itemId: "MODULAR THOUGHTS", memberId: "Member-Luis" },
        },
      ],
      expect: [
        {
          path: "availabilitySignals",
          value: [
            "atlas-of-dawn|limited|2|0",
            "modular-thoughts|unavailable|0|0",
            "synthesis-primer|limited|1|0",
          ],
        },
        {
          path: "loanEntries",
          value: expectLoans([
            {
              sequence: 1,
              itemId: "atlas-of-dawn",
              memberId: "member-alba",
            },
            {
              sequence: 2,
              itemId: "synthesis-primer",
              memberId: "member-lina-rivers",
            },
            {
              sequence: 3,
              itemId: "modular-thoughts",
              memberId: "member-jade",
            },
          ]),
        },
        { path: "holdEntries", value: expectHolds([]) },
        { path: "pendingHoldCount", value: 0 },
        {
          path: "availabilitySummary",
          value: "2/3 titles open · 3 active loans · 0 holds queued",
        },
        {
          path: "lastChangeLabel",
          value: "member-jade checked out Modular Thoughts via hold (#3)",
        },
      ],
    },
    {
      events: [
        {
          stream: "placeHold",
          payload: { itemId: "synthesis-primer", memberId: "Otto" },
        },
      ],
      expect: [
        {
          path: "availabilitySignals",
          value: [
            "atlas-of-dawn|limited|2|0",
            "modular-thoughts|unavailable|0|0",
            "synthesis-primer|limited|1|1",
          ],
        },
        {
          path: "holdEntries",
          value: expectHolds([
            {
              sequence: 1,
              itemId: "synthesis-primer",
              memberId: "member-otto",
            },
          ]),
        },
        { path: "pendingHoldCount", value: 1 },
        {
          path: "availabilitySummary",
          value: "2/3 titles open · 3 active loans · 1 hold queued",
        },
        {
          path: "lastChangeLabel",
          value: "member-otto placed hold on Synthesis Primer (#4)",
        },
      ],
    },
    {
      events: [
        {
          stream: "checkout",
          payload: { itemId: "synthesis-primer", memberId: "member-otto" },
        },
      ],
      expect: [
        {
          path: "availabilitySignals",
          value: [
            "atlas-of-dawn|limited|2|0",
            "modular-thoughts|unavailable|0|0",
            "synthesis-primer|unavailable|0|0",
          ],
        },
        {
          path: "loanEntries",
          value: expectLoans([
            {
              sequence: 1,
              itemId: "atlas-of-dawn",
              memberId: "member-alba",
            },
            {
              sequence: 2,
              itemId: "synthesis-primer",
              memberId: "member-lina-rivers",
            },
            {
              sequence: 3,
              itemId: "modular-thoughts",
              memberId: "member-jade",
            },
            {
              sequence: 4,
              itemId: "synthesis-primer",
              memberId: "member-otto",
            },
          ]),
        },
        { path: "holdEntries", value: expectHolds([]) },
        { path: "availableTitleCount", value: 1 },
        { path: "activeLoanCount", value: 4 },
        { path: "pendingHoldCount", value: 0 },
        {
          path: "availabilitySummary",
          value: "1/3 titles open · 4 active loans · 0 holds queued",
        },
        {
          path: "lastChangeLabel",
          value: "member-otto checked out Synthesis Primer (#5)",
        },
      ],
    },
  ],
};

export const scenarios = [libraryCheckoutSystemScenario];

describe("library-checkout-system", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
