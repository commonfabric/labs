import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const documentSignatureWorkflowScenario: PatternIntegrationScenario = {
  name: "document signature workflow fills outstanding summary and status",
  module: new URL(
    "./document-signature-workflow.pattern.ts",
    import.meta.url,
  ),
  exportName: "documentSignatureWorkflow",
  steps: [
    {
      expect: [
        {
          path: "statusLine",
          value:
            "Master Services Agreement: next Noah Chen (Account Executive); 2 outstanding",
        },
        { path: "counts.total", value: 3 },
        { path: "counts.completed", value: 1 },
        { path: "counts.outstanding", value: 2 },
        { path: "completionPercent", value: 33 },
        { path: "nextSigner.name", value: "Noah Chen" },
        { path: "nextSigner.order", value: 2 },
        { path: "orderedSigners.0.status", value: "signed" },
        { path: "orderedSigners.0.signedAt", value: "2024-07-01" },
        { path: "orderedSigners.1.status", value: "pending" },
        { path: "orderedSigners.1.signedAt", value: null },
        {
          path: "outstandingSummary",
          value:
            "2. Noah Chen (Account Executive) - pending | 3. Ravi Patel (Client CFO) - pending",
        },
        {
          path: "progressLabel",
          value: "33% complete for Master Services Agreement",
        },
        {
          path: "activityLog.0",
          value: "Signature packet prepared for Master Services Agreement",
        },
      ],
    },
    {
      events: [
        {
          stream: "markSigned",
          payload: { id: "signer-sales", signedAt: "2024-07-04" },
        },
      ],
      expect: [
        { path: "orderedSigners.1.status", value: "signed" },
        { path: "orderedSigners.1.signedAt", value: "2024-07-04" },
        { path: "counts.completed", value: 2 },
        { path: "counts.outstanding", value: 1 },
        { path: "completionPercent", value: 67 },
        { path: "nextSigner.name", value: "Ravi Patel" },
        { path: "nextSigner.order", value: 3 },
        {
          path: "statusLine",
          value:
            "Master Services Agreement: next Ravi Patel (Client CFO); 1 outstanding",
        },
        {
          path: "outstandingSummary",
          value: "3. Ravi Patel (Client CFO) - pending",
        },
        {
          path: "progressLabel",
          value: "67% complete for Master Services Agreement",
        },
        {
          path: "activityLog.1",
          value: "Noah Chen (Account Executive) signed on 2024-07-04",
        },
      ],
    },
    {
      events: [
        {
          stream: "markDeclined",
          payload: {
            id: "signer-client",
            reason: "Missing witness initials ",
          },
        },
      ],
      expect: [
        { path: "orderedSigners.2.status", value: "declined" },
        { path: "orderedSigners.2.signedAt", value: null },
        { path: "counts.completed", value: 2 },
        { path: "counts.outstanding", value: 1 },
        { path: "completionPercent", value: 67 },
        { path: "nextSigner", value: null },
        {
          path: "statusLine",
          value: "Master Services Agreement: 1 outstanding signatures",
        },
        {
          path: "outstandingSummary",
          value: "3. Ravi Patel (Client CFO) - declined",
        },
        {
          path: "activityLog.2",
          value: "Ravi Patel (Client CFO) declined (Missing witness initials)",
        },
      ],
    },
    {
      events: [
        { stream: "resetSigner", payload: { id: "signer-client" } },
        { stream: "markSigned", payload: { id: "signer-client" } },
      ],
      expect: [
        { path: "orderedSigners.2.status", value: "signed" },
        { path: "orderedSigners.2.signedAt", value: "2024-07-03" },
        { path: "counts.completed", value: 3 },
        { path: "counts.outstanding", value: 0 },
        { path: "completionPercent", value: 100 },
        { path: "nextSigner", value: null },
        {
          path: "statusLine",
          value: "Master Services Agreement: all signatures collected",
        },
        {
          path: "outstandingSummary",
          value: "All signers completed",
        },
        {
          path: "progressLabel",
          value: "100% complete for Master Services Agreement",
        },
        {
          path: "activityLog.3",
          value: "Ravi Patel reset to pending",
        },
        {
          path: "activityLog.4",
          value: "Ravi Patel (Client CFO) signed on 2024-07-03",
        },
      ],
    },
  ],
};

export const scenarios = [documentSignatureWorkflowScenario];

describe("document-signature-workflow", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
