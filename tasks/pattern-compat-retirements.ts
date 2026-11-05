import type { BaselineRetirement } from "./pattern-compat-lib.ts";

/**
 * Exact historical contracts deliberately excluded from rollout proofs.
 *
 * Never delete the corresponding baseline JSON. A retirement is permitted
 * only after the stored population has been migrated, expired, or explicitly
 * approved for a wipe, with the decision recorded in live documentation.
 */
export const PATTERN_BASELINE_RETIREMENTS: readonly BaselineRetirement[] = [
  {
    pattern: "apps/deep-research/deep-research.tsx",
    baseline: "20260729T022742Z-6PInVAlNOHThJNGH",
    reason:
      "Pre-launch Factory@1 schema-authority migration normalized Common Fabric Default optionality; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "apps/deep-research/deep-research.tsx",
    baseline: "20260729T230006Z-iBQX-llGuoFgYm69",
    reason:
      "Pre-launch Factory@1 schema-authority migration normalized Common Fabric Default optionality; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "apps/deep-research/deep-research.tsx",
    baseline: "20260910T175045Z-DQ5ptyKQrjMZX41L",
    reason:
      "Pre-launch Factory@1 schema-authority migration changed the captured context and message bindings; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern:
      "examples/array-in-cell-with-remove-editable/array-in-cell-with-remove-editable.tsx",
    baseline: "20260729T022742Z--kRTqpCBkByWzcff",
    reason:
      "Pre-launch Factory@1 handler migration; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "product/lobby/main.tsx",
    baseline: "20260729T022742Z-GhLFnf8OCmke_Jje",
    reason:
      "Pre-launch FactoryInput normalization changed the trusted writer identity; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "system/notes/note.tsx",
    baseline: "20260729T022742Z-6XD3xNCqAXQG3JgM",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "system/notes/note.tsx",
    baseline: "20260813T162832Z-GFSMvyzQ-Yxqugmf",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "system/notes/note.tsx",
    baseline: "20260813T163905Z-zqmv7qgvTzGuEEY5",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "system/notes/note.tsx",
    baseline: "20260817T073231Z-r-8BY2Mq4VO8Z-gh",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "system/notes/note.tsx",
    baseline: "20261025T215336Z-_Z8Q3ckWQTbl1hfA",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration replaced the stored tool callable contracts; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "system/common-fabric/common-fabric.tsx",
    baseline: "20260729T022742Z-33-wy7gTBm_BLP4I",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "system/common-fabric/common-fabric.tsx",
    baseline: "20260730T215848Z-gI9SlVAQGk94saSd",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "system/common-fabric/common-fabric.tsx",
    baseline: "20260921T210751Z-cSRMacADHy4VrtfI",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration replaced the wildcard tool contract; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "system/knowledge-graph/knowledge-graph.tsx",
    baseline: "20260923T184039Z-rq8KAA-ICBTFDbI6",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration replaced the stored graph tool callable contracts; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "system/suggestion-history/suggestion-history.tsx",
    baseline: "20260729T022742Z-IsxNGAP5BITr9Pv1",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "system/suggestion-history/suggestion-history.tsx",
    baseline: "20261016T070456Z-OzfPLhbKZffp_sMt",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration replaced the stored search callable contract; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "system/summary-index/summary-index.tsx",
    baseline: "20260729T022742Z-_lCRVDAIzW-JJzkF",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration; owner-approved data wipe is recorded in the factory shipping spec.",
  },
  {
    pattern: "system/summary-index/summary-index.tsx",
    baseline: "20261104T063436Z-iOaAer4TmJxn_1__",
    reason:
      "Pre-launch patternTool-to-Factory@1 migration replaced the stored search callable contract; owner-approved data wipe is recorded in the factory shipping spec.",
  },
];
