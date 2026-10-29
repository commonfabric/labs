/** Connector-owned pattern trees and their stable Toolshed route prefixes. */
export const CONNECTOR_PATTERN_SOURCES = [
  {
    directory: "connectors/agents/debug-view",
    keyPrefix: "agent-sessions-debug",
  },
  {
    directory: "connectors/github/activity-view",
    keyPrefix: "github-activity",
  },
] as const;
