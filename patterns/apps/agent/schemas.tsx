/// <cts-enable />

/**
 * Shared types for the Agent pattern.
 *
 * IMPORTANT: Do NOT add [UI] to these entity types. Including [UI] in types
 * that are used as references causes the runtime to deeply traverse and
 * instantiate UI trees for every referenced piece. Only pattern Output
 * interfaces should declare [UI].
 */

import { NAME, type Stream } from "commonfabric";

// ===== Core Types =====

export type AgentStatus = "idle" | "running" | "error";

/**
 * An agent piece's core data shape (without reactive wrappers).
 * Used for type-safe access to agent properties from other patterns.
 */
export interface AgentPiece {
  [NAME]?: string;
  agentName?: string;
  directive?: string;
  learned?: string;
  enabled?: boolean;
  status?: AgentStatus;
  lastRun?: string;
  lastRunSummary?: string;
  isAgent?: boolean;
  // Handlers for external invocation
  setDirective?: Stream<{ value: string }>;
  setLearned?: Stream<{ value: string }>;
  appendLearned?: Stream<{ entry: string }>;
  markRunning?: Stream<void>;
  markIdle?: Stream<{ summary: string; learned?: string }>;
  markError?: Stream<{ summary: string }>;
}
