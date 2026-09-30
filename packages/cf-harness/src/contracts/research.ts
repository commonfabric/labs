/**
 * Defines the serializable implementation-kit, provenance, syntax, and CFC
 * contracts carried by bounded Common Fabric research.
 */

import type { JSONSchema } from "@commonfabric/api";
import type { IFCLabel } from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { TrustedPatternRecord } from "./trusted-pattern.ts";

/** Discriminator for a persisted Common Fabric research run. */
export const HARNESS_RESEARCH_RUN_TYPE = "cf-harness.research-run" as const;

/** Whether the evidence was sufficient to hand the caller an actionable kit. */
export type HarnessResearchStatus = "complete" | "incomplete";

/** Scope of one research call, independent of the implementation direction. */
export type HarnessResearchPurpose = "orient" | "answer";

/** The implementation direction supported by the inspected evidence. */
export type HarnessResearchRecommendationKind =
  | "direct-run"
  | "compose"
  | "author"
  | "focused-api";

/** One exact range the research loop read from a trusted source. */
export interface HarnessResearchSourceRead {
  /** Stable id the final kit uses to cite this read. */
  sourceId: string;

  /** Which trusted source surface supplied the bytes. */
  kind: "documentation" | "pattern-metadata" | "pattern-source";

  /** Human-readable address of the document, record, or program file. */
  location: string;

  /** Document context supplied beside the exact text window. */
  documentTitle?: string;

  /** Ancestor headings that determine which environment the snippet describes. */
  headingPath?: readonly string[];

  /** First character included in this read. */
  offset: number;

  /** Character position immediately after the last included character. */
  end: number;

  /** Total characters in the addressed section or file. */
  totalChars: number;

  /** SHA-256 digest of exactly the characters included in this read. */
  digest: string;

  /** Integrity classes carried by a documentation section. */
  integrity?: readonly string[];

  /** Exact existing CFC label carried by this source, when one is available. */
  cfcLabel?: IFCLabel;
}

/** Existing source surface whose CFC label metadata was unavailable. */
export type HarnessResearchMissingLabelSource =
  | "pattern-index-metadata"
  | "pattern-index-source"
  | "handle-description"
  | "prior-research";

/** One precise gap in the CFC metadata available to a research run. */
export interface HarnessResearchMissingLabel {
  /** Source surface that supplied bytes or metadata without a CFC label. */
  source: HarnessResearchMissingLabelSource;

  /** Stable description of the exact observation whose label was unavailable. */
  detail: string;
}

/**
 * CFC metadata carried through a research result. Coverage describes label
 * availability only and is independent of whether the implementation kit is
 * complete.
 */
export interface HarnessResearchCfcProjection {
  version: 1;

  /** Join of every known label on inputs and sources that influenced the run. */
  sourceLabel: IFCLabel;

  /** Confidentiality that the derived kit carries into later model context. */
  outputLabel: IFCLabel;

  /** Whether every influencing source exposed existing CFC metadata. */
  coverage: "complete" | "incomplete";

  /** Exact observations whose existing CFC metadata was unavailable. */
  missingLabels: readonly HarnessResearchMissingLabel[];
}

/** Host-confirmed metadata for a pattern inspected during research. */
export interface HarnessResearchPatternRecord extends TrustedPatternRecord {
  /** Declared argument schema returned by the index. */
  argumentSchema?: JSONSchema;

  /** Declared result schema returned by the index. */
  resultSchema?: JSONSchema;

  /** Program entry path, when source inspection succeeded. */
  main?: string;

  /** Program entry export, when the program declares one. */
  mainExport?: string;

  /** Authored source paths in the indexed program. */
  files?: readonly string[];

  /** Additional authored module roots folded into the program identity. */
  sourceRoots?: readonly string[];

  /** Files stored uninterpreted and folded into the program identity. */
  dataFiles?: readonly string[];

  /** Direct composition dependencies confirmed from record and source. */
  dependencies?: readonly string[];

  /** Whether the fetched source computes to {@link patternId}. */
  sourceIdentityVerified?: true;

  /** How the host established, or deferred, source identity verification. */
  identityVerification?: {
    /** Whether this process verified the identity or needs the full compiler. */
    status: "verified" | "deferred";

    /** Identity path used or required. */
    method: "light-entry-identity" | "full-fabric-compiler";

    /** Specific reason full-compiler verification is required. */
    detail?: string;
  };
}

/** One handle contract inspected without reading the value behind it. */
export interface HarnessResearchHandleRecord {
  /** General handle token the caller may pass to a pattern. */
  token: string;

  /** Safe shape-only description returned by `describe_handle`. */
  description: unknown;
}

/** One input the recommended implementation expects to receive. */
export interface HarnessResearchInputBinding {
  /** Argument name or role in the recommended pattern invocation. */
  name: string;

  /** Existing general handle token to bind there. */
  token: string;

  /** Why this handle fits the argument. */
  purpose: string;
}

/** A host-admitted rule and the exact reads that support it. */
export interface HarnessResearchRule {
  /** Concise implementation rule or API fact. */
  rule: string;

  /** Read ids supporting the rule. */
  sourceIds: readonly string[];
}

/** One TypeScript parser diagnostic from a pattern-source example. */
export interface HarnessResearchSyntaxDiagnostic {
  /** TypeScript diagnostic code. */
  code: number;

  /** Diagnostic text with nested messages flattened. */
  message: string;

  /** One-based source line, when TypeScript located the error. */
  line?: number;

  /** One-based source column, when TypeScript located the error. */
  column?: number;
}

/**
 * Cheap parser check over a complete pattern-source example. This establishes
 * syntax only; it does not resolve imports, type-check, compile, or execute.
 */
export interface HarnessResearchSyntaxCheck {
  /** Whether TypeScript reported a parser error. */
  status: "valid" | "invalid" | "unavailable";

  /** Fixed bound on what this check establishes. */
  scope: "syntax-only";

  /** Exact parser diagnostics, in TypeScript's reported order. */
  diagnostics: readonly HarnessResearchSyntaxDiagnostic[];

  /** Why the host could not run the check. */
  detail?: string;
}

/** Complete example content and the evidence supporting its illustrated APIs. */
interface ResearchExampleContent {
  /** Complete example, never a clipped prefix. */
  content: string;

  /** Exact opened reads supporting every API used, comments included. */
  sourceIds: readonly string[];
}

/** Practical invocation or parser-checked source for the recommendation. */
export type HarnessResearchExample =
  & ResearchExampleContent
  & (
    | {
      /** JSON input for the pattern execution tool. */
      kind: "run-pattern-input";

      /** Syntax diagnostics apply only to TypeScript/TSX examples. */
      syntax?: never;
    }
    | {
      /** Authored TypeScript/TSX example. */
      kind: "pattern-source";

      /** Host parser result for the complete source. */
      syntax: HarnessResearchSyntaxCheck;
    }
  );

/** Structured implementation guidance returned by the `research` tool. */
export interface HarnessResearchKit {
  /** Unscoped saved format, interpreted by the research read boundary. */
  purpose?: never;

  /** Whether all required contracts and inputs were found. */
  status: HarnessResearchStatus;

  /** The task or focused follow-up this kit answers. */
  task: string;

  /** Concise evidence-backed implementation direction. */
  summary: string;

  /** Recommended reuse boundary. */
  recommendation: {
    /** Whether to run, compose, or author. */
    kind: HarnessResearchRecommendationKind;

    /** Why the inspected evidence supports that choice. */
    rationale: string;
  };

  /** Existing handles the recommendation consumes. */
  inputs: readonly HarnessResearchInputBinding[];

  /** Host-confirmed patterns selected for direct use or composition. */
  patterns: readonly HarnessResearchPatternRecord[];

  /** Ordered implementation instructions. */
  steps: readonly string[];

  /** Copyable invocation or complete source when the evidence supports one. */
  example?: HarnessResearchExample;

  /** API and authoring rules established by exact trusted reads. */
  rules: readonly HarnessResearchRule[];

  /** Checks the implementer should perform after applying the kit. */
  verification: readonly string[];

  /** Exact trusted reads the kit admitted. */
  sources: readonly HarnessResearchSourceRead[];

  /** Required evidence, input, or contract the loop could not establish. */
  missing: readonly string[];
}

/** Indexed candidate whose applicability still requires inspection. */
export interface HarnessResearchLead {
  /** Exact host-returned metadata, without source verification. */
  pattern: HarnessResearchPatternRecord;

  /** Specific applicability question a subsequent call should resolve. */
  question: string;
}

/** Findings shared by orientation and a focused answer. */
interface HarnessResearchFindings {
  /** Whether this call established the facts its scope asks for. */
  status: HarnessResearchStatus;

  /** Task or decision investigated by this call. */
  task: string;

  /** Short answer bounded by the cited evidence and observed inventory. */
  summary: string;

  /** Current external handles successfully described in this call. */
  inputs: readonly HarnessResearchInputBinding[];

  /** Host-inspected records selected as reusable parts of the goal. */
  patterns: readonly HarnessResearchPatternRecord[];

  /** Claims supported by exact current reads. */
  rules: readonly HarnessResearchRule[];

  /** Exact evidence supporting these findings. */
  sources: readonly HarnessResearchSourceRead[];

  /** Unresolved facts needed to answer this call's question. */
  missing: readonly string[];

  /** Optional code or invocation illustrating the supported findings. */
  example?: HarnessResearchExample;
}

/** Starting guidance grounded in available data, inspected pieces, and documentation. */
export interface HarnessResearchOrientation extends HarnessResearchFindings {
  /** Orientation establishes a useful approach to the user goal. */
  purpose: "orient";

  /** Host-returned candidates, explicitly separate from confirmed patterns. */
  leads: readonly HarnessResearchLead[];

  /** Current general handle inventory, independent of which handles were described. */
  availableHandleTokens: readonly string[];

  /** Decision-specific follow-ups worth asking only if needed. */
  questions: readonly string[];
}

/** Cited response to a question within the user goal. */
export interface HarnessResearchAnswer extends HarnessResearchFindings {
  /** Answer scope establishes a decision rather than implementing a task. */
  purpose: "answer";
}

/** Admitted research result, including the saved implementation-kit format. */
export type HarnessResearchResult =
  | HarnessResearchOrientation
  | HarnessResearchAnswer
  | HarnessResearchKit;

/** Durable summary retained for resume, delegation, and authored provenance. */
export interface HarnessResearchRunSummary {
  /** Research-run discriminator. */
  type: typeof HARNESS_RESEARCH_RUN_TYPE;

  /** Unique id derived from the harness run and tool output. */
  researchRunId: string;

  /** Tool output that owns the full artifact record. */
  outputId: string;

  /** Orientation, answer, or saved implementation kit handed to the caller. */
  kit: HarnessResearchResult;

  /** Every pattern whose record the host confirmed during the run. */
  confirmedPatterns: readonly HarnessResearchPatternRecord[];

  /** Every safe handle description inspected during the run. */
  describedHandles: readonly HarnessResearchHandleRecord[];

  /**
   * Known CFC labels and explicit metadata gaps carried by the derived kit.
   * Absent only on a summary restored from before this projection existed.
   */
  cfc?: HarnessResearchCfcProjection;

  /** Time the host completed the research run. */
  completedAt: string;

  /** Findings from an earlier root task; its handle bindings are historical. */
  historical?: true;
}

/** Discriminator value of a {@link HarnessResearchHandleValue}. */
export const HARNESS_RESEARCH_HANDLE_TYPE = "cf-harness.research-handle";

/**
 * What a research handle holds: the admitted kit, the records the host
 * confirmed while producing it, and the label the kit carries. The `research`
 * tool mints one into the run's handle table the moment a kit is admitted, and
 * `describe_handle` reads it back, which is how a run — this one, or a child
 * handed the token — reads what research found rather than researching again.
 * The private transcript and the raw research record stay in the artifact and
 * are no part of it.
 */
export interface HarnessResearchHandleValue {
  /** Research-handle discriminator. */
  type: typeof HARNESS_RESEARCH_HANDLE_TYPE;

  /** The research run the findings came from. */
  researchRunId: string;

  /** The admitted kit, as the research tool returned it. */
  kit: HarnessResearchResult;

  /** Every pattern whose record the host confirmed during the run. */
  confirmedPatterns: readonly HarnessResearchPatternRecord[];

  /**
   * Every handle the run described, with the description it got. A token
   * here is a binding the kit may name; whether a reader still holds it is
   * the reader's table's business, and `describe_handle` says so per token.
   */
  describedHandles: readonly HarnessResearchHandleRecord[];

  /** Known CFC labels and explicit metadata gaps carried by the kit. */
  cfc: HarnessResearchCfcProjection;
}

/**
 * Whether `value` has the shape of a research handle's content: the
 * discriminator, a kit with its findings fields, records that each carry
 * their identity, and a CFC projection with both labels. A persisted referent
 * that fails this is read as holding nothing rather than crashing its reader.
 */
export const isHarnessResearchHandleValue = (
  value: unknown,
): value is HarnessResearchHandleValue =>
  isObjectNotArray(value) &&
  value.type === HARNESS_RESEARCH_HANDLE_TYPE &&
  typeof value.researchRunId === "string" &&
  isResearchKitShape(value.kit) &&
  Array.isArray(value.confirmedPatterns) &&
  value.confirmedPatterns.every((record) =>
    isObjectNotArray(record) && typeof record.patternId === "string"
  ) &&
  Array.isArray(value.describedHandles) &&
  value.describedHandles.every((record) =>
    isObjectNotArray(record) && typeof record.token === "string"
  ) &&
  isObjectNotArray(value.cfc) &&
  value.cfc.version === 1 &&
  isObjectNotArray(value.cfc.sourceLabel) &&
  isObjectNotArray(value.cfc.outputLabel) &&
  Array.isArray(value.cfc.missingLabels);

/** The findings fields every admitted kit carries, as types alone. */
const isResearchKitShape = (kit: unknown): boolean =>
  isObjectNotArray(kit) &&
  typeof kit.status === "string" &&
  typeof kit.task === "string" &&
  typeof kit.summary === "string" &&
  Array.isArray(kit.inputs) &&
  Array.isArray(kit.patterns) &&
  Array.isArray(kit.rules) &&
  Array.isArray(kit.sources) &&
  Array.isArray(kit.missing);
