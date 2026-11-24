import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

export const userPermissionMatrixScenario: PatternIntegrationScenario<
  { permissions?: unknown; roles?: unknown }
> = {
  name: "user permission matrix toggles stay in sync",
  module: new URL("./user-permission-matrix.pattern.ts", import.meta.url),
  exportName: "userPermissionMatrix",
  steps: [
    {
      expect: [
        { path: "matrix.admin.grants.manageUsers", value: true },
        { path: "matrix.editor.grants.manageUsers", value: false },
        { path: "matrix.viewer.grants.viewReports", value: true },
        {
          path: "summaries.0.summary",
          value: "Administrator: 4/4 permissions",
        },
        { path: "summaries.1.summary", value: "Editor: 3/4 permissions" },
        { path: "summaries.2.summary", value: "Viewer: 1/4 permissions" },
        {
          path: "status",
          value: "8 grants across 3 roles and 4 permissions",
        },
        { path: "lastChange", value: "No changes yet" },
        { path: "history", value: [] },
      ],
    },
    {
      events: [
        {
          stream: "togglePermission",
          payload: { role: "editor", permission: "manageUsers" },
        },
      ],
      expect: [
        { path: "matrix.editor.grants.manageUsers", value: true },
        { path: "summaries.1.enabledCount", value: 4 },
        { path: "summaries.1.summary", value: "Editor: 4/4 permissions" },
        {
          path: "status",
          value: "9 grants across 3 roles and 4 permissions",
        },
        {
          path: "lastChange",
          value: "Granted Manage Users for Editor",
        },
        {
          path: "history.0",
          value: "Granted Manage Users for Editor",
        },
      ],
    },
    {
      events: [
        {
          stream: "togglePermission",
          payload: {
            role: "Administrator",
            permission: "Publish Content",
            grant: false,
          },
        },
      ],
      expect: [
        { path: "matrix.admin.grants.publishContent", value: false },
        { path: "summaries.0.enabledCount", value: 3 },
        { path: "summaries.0.missing.0", value: "publishContent" },
        {
          path: "status",
          value: "8 grants across 3 roles and 4 permissions",
        },
        {
          path: "lastChange",
          value: "Revoked Publish Content for Administrator",
        },
        {
          path: "history.1",
          value: "Revoked Publish Content for Administrator",
        },
      ],
    },
  ],
};

export const scenarios = [userPermissionMatrixScenario];

describe("user-permission-matrix", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
