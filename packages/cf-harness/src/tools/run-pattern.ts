import type { JSONSchema } from "@commonfabric/api";
import {
  type Cell,
  cellWithScopedLinkRequiredsRelaxed,
  compileAndSavePattern,
  getPatternIdentityRef,
  PatternManager,
  type RuntimeProgram,
} from "@commonfabric/runner";
import {
  type CfcAddress,
  type CfcConfClause,
  type CfcDereferenceTrace,
  type CfcRefusalAttribution,
  type CfcRefusalDetail,
  type CfcRefusalGate,
  describeSinkReleaseRefusal,
  renderCfcAtom,
  selectReferencedCfcSchemaDefs,
  validateAgainstSchema,
} from "@commonfabric/runner/cfc";
import {
  createLLMFriendlyLink,
  FRAMEWORK_RESULT_KEYS,
  matchLLMFriendlyLink,
  type NormalizedFullLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner/shared";
import {
  PieceController,
  type PiecesController,
} from "@commonfabric/piece/ops";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import {
  HARNESS_POLICY_REFUSAL_SCHEMA,
  type HarnessPolicyRefusal,
  type HarnessReleaseBoundary,
  type HarnessReleaseDecision,
} from "../contracts/policy-refusal.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import { keylessInstantiation } from "../fabric-instantiations.ts";
import {
  comparableEntityHash,
  fabricRuntimeObservations,
} from "../fabric-observations.ts";
import { defineOwnEntry } from "../handle-table.ts";
import {
  dedupedObservedOutputs,
  type ObservedOutput,
  observedOutputCause,
  observedOutputsIn,
  type RunPatternOutputConcern,
} from "../run-pattern-output-concerns.ts";
import {
  addressSealedPositions,
  isSealedOpaqueLinkObject,
  parseStructuredResultSchema,
  validateAndSanitizeStructuredResult,
} from "../structured-result.ts";
import type {
  PatternIndexEventType,
  PatternIndexPublishRequest,
} from "../pattern-index/client.ts";
import { PatternIndexError } from "../pattern-index/client.ts";
import {
  classifyRenderedHtml,
  PATTERN_DISCOVERABILITY_REASONS,
  PATTERN_PUBLICATION_MESSAGES,
  type PatternPublicationReason,
  type PatternPublicationStatus,
  renderPatternUiToHtml,
  syntheticArgument,
} from "../pattern-index/publish-render-gate.ts";
import { openProbeRuntime } from "../pattern-index/probe-runtime.ts";
import {
  composedPatternIds,
  materializeComposedPatterns,
  PatternCompositionError,
  patternIndexDependencies,
  runtimeProgramFromIndex,
} from "../pattern-index/composition.ts";
import type { HarnessToolDefinition } from "./types.ts";
import {
  RUN_PATTERN_INPUT_SCHEMA,
  type RunPatternToolInput,
} from "../contracts/run-pattern.ts";

export type { RunPatternToolInput } from "../contracts/run-pattern.ts";

/** Upper bound on `sourceText`, enforced with a structured tool error. */
export const RUN_PATTERN_MAX_SOURCE_TEXT_BYTES = 256 * 1024;

export interface RunPatternToolSuccessOutput {
  outputId: string;
  status: "ok";

  /** Canonical LLM-friendly link to the piece's result cell. */
  resultRef: string;

  /**
   * What the release boundary decided about this call's own result: released,
   * observed, or withheld, with the sink and ceiling it was fitted against
   * and what the fit refused. Artifact-only, like `releaseObservation`: the
   * prompt loop strips it from the model-facing rendering and appends it to
   * the run's policy trace, where a decision a label drove sits beside the
   * decisions authority drove. Absent on a run that asked for no values,
   * since nothing was measured.
   */
  releaseDecision?: HarnessReleaseDecision;

  /**
   * What the release measurement refused, on a run the enforcement ladder did
   * not reject it on. Artifact-only, like the other fields the prompt loop
   * strips: the values went out, so the model has nothing to act on, while an
   * operator staging the ladder has the population that raising it would
   * start withholding. Absent, like `policyRefusal`, on a run that asked for
   * no values, since nothing was measured.
   */
  releaseObservation?: HarnessPolicyRefusal;

  /**
   * What the answer's own sink refused to release and which of this call's
   * inputs carried it, when the enforcement ladder withheld `value` over it.
   * The result stands in the space under its own labels and `resultRef`
   * names it: a reference discloses nothing, so what the refusal withholds
   * is the values alone. `valueError` states the same refusal as an
   * instruction.
   */
  policyRefusal?: HarnessPolicyRefusal;

  /**
   * The compiled pattern's result schema — the shape of whatever
   * `resultRef` names. Known here for free, since compilation produced it,
   * and recorded on the handle minted for `resultRef` so a later
   * `describe_handle` can answer what the reference is without reading it.
   * Stripped from the model-facing rendering by the prompt loop: the model
   * wrote the pattern this describes, and asks for the shape by token when
   * it wants it back. Always present: a compiled pattern carries a result
   * schema.
   */
  resultRefSchema: JSONSchema;

  /**
   * Piece id for the persisted tool-output artifact. A bare fabric
   * identifier the handle boundary never swaps, and the piece cell is the
   * result cell, so the prompt loop strips it from the model-facing
   * rendering; only `resultRef` reaches model context.
   */
  pieceId: string;

  /** Sanitized result value; present only when `resultSchema` was given. */
  value?: unknown;

  linkedStringCount?: number;

  /**
   * Why `value` is absent despite a `resultSchema`: the raw result did not
   * match the schema, or the space's policy refused to release it, in which
   * case `policyRefusal` carries the refusal as data.
   */
  valueError?: string;

  /**
   * Raw result value for the persisted tool-output artifact. Stripped from
   * the model-facing rendering by the prompt loop, so only the sanitized
   * `value` reaches model context.
   */
  rawValue?: unknown;

  /**
   * This run's queued contribution to the pattern index, when the run had one
   * to make. Absent when the run staged nothing at all — it
   * named a `patternId`, it gave no description, or the run has no index.
   */
  patternPublication?: RunPatternPublicationReport;

  /**
   * Text retained for the persisted artifact and stripped from the
   * model-facing rendering. The reason a release refusal stated, when
   * `policyRefusal` is present, since it names the labels and documents the
   * flow touched. And what the render gate's probe THREW, when one did —
   * never what it rendered — on the same terms as every other thrown message
   * this tool withholds: a computation over data the model cannot read can
   * carry that data in what it throws. And the text of every output
   * `outputConcerns` named, which a composed instance is the only holder of
   * and which the model is told the position of rather than the words. A run
   * with more than one carries them in that order, separated by a blank line.
   *
   * **The artifact root is not a confidentiality boundary.** `bash` does not
   * reserve it the way `read_file`, `write_file`, `edit_file` and
   * `view_image` do, and its stdout is model-facing, so a later turn — or a
   * delegated child sharing the workspace — can read this back. Two
   * reviewers walked that route independently and one reproduced it with a
   * planted marker; CT-2117 carries the structural fix. Thrown text is here
   * because it is the class this artifact already holds and cannot be
   * recovered any other way, and a composed instance's output text is here
   * for the same reason: that instance is not something the model can
   * address, so an operator reading the run back has nothing else to debug
   * from. Rendered DOM is NOT, because it can: the
   * synthetic instance is a deterministic function of the argument schema
   * and the index records the program, so the render is reproducible rather
   * than needing to be kept.
   */
  rawCauseMessage?: string;

  /**
   * What the outputs of the patterns this run materialized say about the
   * reads behind them: a reported failure, a declared pending read, or a
   * settled read with no rows. Pending counts and rows are placeholders;
   * reread the same piece before treating them as data. Present only when
   * there is something to say, and a disclosure rather than a refusal — the
   * run succeeded, and this is the reason to look.
   * `run-pattern-output-concerns.ts` carries why no text travels with one.
   */
  outputConcerns?: readonly RunPatternOutputConcern[];
}

/**
 * The contribution staged after publication policy and the render gate were
 * applied. The tool returns before the session flush sends it to the index,
 * so this report records intent at tool return, never an acknowledgment.
 *
 * Every field is pinned to a fixed set — a status, a reason and a boolean, with
 * `message` drawn from `PATTERN_PUBLICATION_MESSAGES` and never composed. See
 * `pattern-index/publish-render-gate.ts` for why nothing derived from the
 * rendered DOM may join them.
 */
export interface RunPatternPublicationReport {
  status: "queued";
  reason: PatternPublicationReason;
  message: string;

  /**
   * Whether the synthetic instance the probe was driven with covers the
   * pattern's whole argument schema. `false` where the schema declares no
   * shape, or where generating it hit a depth or node bound.
   */
  syntheticInputsComplete: boolean;
}

export interface RunPatternToolErrorOutput {
  outputId: string;
  status: "compile-error" | "error" | "cancelled";
  message: string;

  /**
   * The durable piece a post-persistence failure leaves behind, for the
   * persisted artifact's run-to-piece provenance. Stripped from the
   * model-facing rendering like the success output's `pieceId`.
   */
  pieceId?: string;

  /**
   * The failing computation's own message, retained for the persisted
   * artifact and stripped from the model-facing rendering: a computation
   * over data the model cannot read may carry that data in its thrown text.
   */
  rawCauseMessage?: string;

  /**
   * What the commit boundary refused and which of this call's own inputs
   * carried it, when a policy refusal is what stopped the run: the write was
   * rejected, so no result landed. A refusal at the answer's own sink is not
   * this — the result landed and its reference is returned — so it rides on
   * the success output instead.
   */
  policyRefusal?: HarnessPolicyRefusal;

  /**
   * What the commit boundary decided, on the error a refused commit produces.
   * Artifact-only on the same terms as the success output's, and the same
   * shape: a refusal the runner raised is a decision of the same kind as one
   * the harness measured.
   */
  releaseDecision?: HarnessReleaseDecision;
}

export type RunPatternToolOutput =
  | RunPatternToolSuccessOutput
  | RunPatternToolErrorOutput;

export const isRunPatternToolSuccessOutput = (
  output: unknown,
): output is RunPatternToolSuccessOutput =>
  isObjectOrArray(output) &&
  "status" in output && output.status === "ok" &&
  "resultRef" in output && typeof output.resultRef === "string" &&
  "resultRefSchema" in output;

/** The module every Common Fabric pattern imports the runtime from. */
export const RUNTIME_MODULE_SPECIFIER = "commonfabric";

/** The import line a pattern opens with, as the tool description states it. */
export const RUNTIME_MODULE_IMPORT_LINE =
  `import { Default, NAME, pattern, UI } from "${RUNTIME_MODULE_SPECIFIER}";`;

/**
 * Specifiers close enough to the runtime module that an author writing one
 * meant it. Each names the product rather than the module, which is how the
 * guess is arrived at, and none of them resolves — so a bare "could not
 * resolve" reads as a missing dependency instead of a wrong name.
 */
const RUNTIME_MODULE_ALIASES: readonly string[] = [
  "commontools",
  "common-tools",
  "@commontools",
];

/** Whether `specifier` is one of the aliases, or a subpath of a scoped one. */
const isRuntimeModuleAlias = (specifier: string): boolean =>
  RUNTIME_MODULE_ALIASES.some((alias) =>
    specifier === alias || specifier.startsWith(`${alias}/`)
  );

/**
 * The specifiers a compiler diagnostic said it could not resolve. The bundler
 * quotes each one it failed on, so the quoted text is the author's own
 * specifier rather than a path the harness reconstructed.
 */
const unresolvedSpecifiersIn = (diagnostic: string): readonly string[] =>
  [...diagnostic.matchAll(/could not resolve ["']([^"']+)["']/gi)]
    .map((match) => match[1]);

/**
 * A compile diagnostic, with the module name that does exist named where the
 * author guessed one that does not. The first failure is the cheapest place to
 * correct the guess: without this the author sees only that a name did not
 * resolve, and the next guess is another spelling of the same wrong name.
 */
export const withRuntimeModuleCorrection = (diagnostic: string): string => {
  const guessed = unresolvedSpecifiersIn(diagnostic).filter(
    isRuntimeModuleAlias,
  );
  if (guessed.length === 0) {
    return diagnostic;
  }
  return [
    diagnostic,
    `${guessed.map((specifier) => `"${specifier}"`).join(" and ")} ${
      guessed.length === 1 ? "does" : "do"
    } not exist. The Common Fabric runtime module is "${RUNTIME_MODULE_SPECIFIER}": ${RUNTIME_MODULE_IMPORT_LINE}`,
  ].join("\n\n");
};

export const runPatternToolDescriptor: HarnessToolDescriptor = {
  toolId: "run_pattern",
  title: "Run Pattern",
  description:
    `Compile and run a Common Fabric pattern in the configured space, returning a reference to its live result cell. Give it either your own sourceText or the patternId of a pattern search_patterns found. Source you write imports the runtime from "${RUNTIME_MODULE_SPECIFIER}" and from no other module — every pattern opens with a line of the form ${RUNTIME_MODULE_IMPORT_LINE} — and no package named after the product resolves. The run's confidentiality ceiling bounds cell reads. Shared db.query results retain complete labeled row sets and withhold the array, including its row count, when the ceiling does not admit every row. Declare query results per session (PerSession<> on the result type, or the query's { scope: "session" } option) to filter rows under the runtime's ceiling at the query boundary. Bound every query's rows with a LIMIT — a few hundred is a sensible ceiling for a view — because every result row is materialized as its own document in the space, so an unbounded query over a large store writes a document per row it returns, and a re-run writes again only the rows that changed, except that a labeled result keys its rows on position and so also rewrites the rows a change displaced, and re-keys every row when the query's projection or the handle's tables change; an aggregate returning one row per group — count(*), sum(), a GROUP BY — is bounded by its own shape and needs no LIMIT. A pattern composing another passes on what the composed one reports: expose its error branch and its row count under your own result and render them, or the run answers over figures derived from a read that failed, and the result carries an outputConcerns entry naming the output you did not read. A query over a served store may still be pending when this call answers. Pending counts and rows are placeholders, not data. Expose pending along with the error branch and counts; before reporting success or assigning a slug, pass the held resultRef as an inputs entry to a minimal unnamed reader pattern, with a resultSchema covering pending, error, and counts. This reads the existing piece; do not author a replacement page to wait for data. If a settled filtered result is empty, compare it with a count without the uncertain predicate and present both counts, naming the filter; an empty subset does not mean the source is empty. The piece stays out of the space's piece list; assign_slug names and lists it when it deserves a public address.`,
  effectClass: "side-effect",
  inputSchema: RUN_PATTERN_INPUT_SCHEMA,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["ok"] },
        resultRef: { type: "string" },
        resultRefSchema: {},
        pieceId: { type: "string" },
        value: {},
        linkedStringCount: { type: "integer", minimum: 0 },
        valueError: { type: "string" },
        policyRefusal: HARNESS_POLICY_REFUSAL_SCHEMA,
        rawValue: {},
        patternPublication: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["queued"],
            },
            reason: {
              type: "string",
              enum: [
                "ui-rendered",
                "no-ui",
                "recorded-automatically",
                "ui-default-tostring",
                "ui-rendered-empty",
                "probe-failed",
                "superseded",
              ],
            },
            message: { type: "string" },
            syntheticInputsComplete: { type: "boolean" },
          },
          required: [
            "status",
            "reason",
            "message",
            "syntheticInputsComplete",
          ],
          additionalProperties: false,
        },
        rawCauseMessage: { type: "string" },
        outputConcerns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              concern: {
                type: "string",
                enum: ["error-branch", "no-rows", "pending"],
              },
              key: { type: "string" },
              patternId: { type: "string" },
              message: { type: "string" },
            },
            required: ["concern", "key", "message"],
            additionalProperties: false,
          },
        },
      },
      required: [
        "outputId",
        "status",
        "resultRef",
        "resultRefSchema",
        "pieceId",
      ],
      additionalProperties: false,
    }, {
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: {
          type: "string",
          enum: ["compile-error", "error", "cancelled"],
        },
        message: { type: "string" },
        pieceId: { type: "string" },
        rawCauseMessage: { type: "string" },
        policyRefusal: HARNESS_POLICY_REFUSAL_SCHEMA,
      },
      required: ["outputId", "status", "message"],
      additionalProperties: false,
    }],
  } satisfies JSONSchema,
  tags: ["fabric", "pattern", "piece"],
};

/**
 * The `@link` object addressing one sealed position of a result: the result
 * cell's link extended by the sealed path. It rides as a whole object, which
 * the outbound swap mints from in one piece — the free-text scanner would
 * stop an address short at a property name's whitespace. Returns `undefined`
 * if the rendered reference does not name an entity. The shared renderer
 * preserves the sealed path's keys.
 */
export const sealedPositionLink = (
  resultLink: NormalizedFullLink,
  path: readonly (string | number)[],
  space: NormalizedFullLink["space"],
): { "@link": string } | undefined => {
  const segments = [...resultLink.path, ...path.map(String)];
  const ref = createLLMFriendlyLink({ ...resultLink, path: segments }, space);
  try {
    parseLLMFriendlyLink(ref, space);
  } catch {
    return undefined;
  }
  return { "@link": ref };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The entry path `compileAndSavePattern` wraps bare source under. Written out
 * here because the published program has to be the one the compile consumed,
 * down to the name its single file carries into the content hash.
 */
const RUN_PATTERN_SOURCE_MAIN = "/main.tsx";

/** What a call naming neither a source nor a published pattern is told. */
const RUN_PATTERN_NO_PROGRAM_MESSAGE =
  "run_pattern requires sourceText or patternId";

/**
 * What a refusal message says about the raw reason, which stays in the
 * artifact for the same cause the thrown text does: it names the labels and
 * the documents the flow touched.
 */
const RUN_PATTERN_REFUSAL_ARTIFACT_NOTE =
  "The refusal reason is retained in the run artifact and withheld here, " +
  "since it names the labels and documents involved";

/** The sink this tool's own answer is, as a refusal names it. */
const RUN_PATTERN_ANSWER_SINK = "run_pattern";

/**
 * What that sink admits: nothing. A model's context is outside every space,
 * so no confidentiality clause names an audience it belongs to, and an empty
 * ceiling — "public only", per `sink-inventory.ts` — is the one that says so.
 *
 * What crosses the sink is a VALUE. The result reference the tool returns is
 * an opaque handle: it names the result without carrying it, and holding it
 * discloses nothing (AH-CFC-18), so the ceiling is consulted only for a call
 * that asks for values through `resultSchema`, and what a refusal withholds
 * is those values and never the reference. The model composes work out of
 * names it cannot read; that is what lets it route data it never sees.
 *
 * Empty rather than absent, and the difference is the point. A sink absent
 * from the inventory goes ungated because a deployment has not decided about
 * it; this sink is not one a deployment declares, since the audience on the
 * far side of it is fixed by what the tool does rather than by where it runs.
 */
const RUN_PATTERN_ANSWER_CEILING: readonly CfcConfClause[] = [];

/** What a refusal the commit boundary described only in prose is told. */
const RUN_PATTERN_OPAQUE_REFUSAL_MESSAGE =
  "the pattern ran but the space's policy refused to commit its result: " +
  "flow enforcement rejected the write at the commit boundary, so the " +
  `result never landed. ${RUN_PATTERN_REFUSAL_ARTIFACT_NOTE}`;

/**
 * Where an agent-supplied input landed. A refusal names the reads that
 * carried the offending labels; turning one back into something the caller
 * can act on means finding the key whose value that read belongs to, and the
 * key is the only part of the answer the caller may be told.
 */
interface RunPatternInputAddress {
  readonly key: string;

  /**
   * The document the caller's link resolved to, through the canonical entity
   * seam, so a read spelled differently by another seam still compares.
   */
  readonly hash: string;

  readonly path: readonly string[];
}

/** Whether `path` starts with `prefix`. */
const pathHasPrefix = (
  path: readonly string[],
  prefix: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

/** Whether one path is a prefix of the other, either way round. */
const pathsComparable = (
  a: readonly string[],
  b: readonly string[],
): boolean => pathHasPrefix(a, b) || pathHasPrefix(b, a);

const inputAddressKey = (address: RunPatternInputAddress): string =>
  JSON.stringify([address.key, address.hash, address.path]);

/**
 * The addresses an input's value reaches, given the dereferences a read of
 * it performed: the address the caller's link named, and every address a
 * link on the way to the value led on to, transitively.
 *
 * A caller's link commonly names a document that holds the value by
 * reference rather than one that holds it — an operator-attached cell whose
 * field links to the cell that carries the label — so the document a
 * refused read names is one the caller's address never mentions. The
 * dereference traces the attribution read recorded are the route from the
 * one to the other, and following them is what places such a read.
 *
 * A trace's target is the address the resolution continued to, not the bare
 * far end of the link: a link above the input's address — the document root
 * is itself a link, say — lands its trace at the input's own position on the
 * far side. So a link at, below, or above the address leads to the target as
 * it stands, and only a link beside the address, on a sibling path, leads the
 * input nowhere. Every trace is a value dereference: the transaction that
 * records them only reads.
 */
const inputAddressesReached = (
  addresses: readonly RunPatternInputAddress[],
  traces: readonly CfcDereferenceTrace[],
): readonly RunPatternInputAddress[] => {
  const reached = [...addresses];
  const seen = new Set(reached.map(inputAddressKey));
  // A worklist: an address pushed here is visited in its turn, and the set
  // above is what bounds the walk — a cycle of links adds nothing twice.
  for (let index = 0; index < reached.length; index += 1) {
    const from = reached[index];
    for (const trace of traces) {
      const targetHash = comparableEntityHash(trace.target.id);
      if (
        targetHash === undefined ||
        comparableEntityHash(trace.source.id) !== from.hash
      ) {
        continue;
      }
      if (!pathsComparable(trace.source.path, from.path)) continue;
      const next = { key: from.key, hash: targetHash, path: trace.target.path };
      const key = inputAddressKey(next);
      if (!seen.has(key)) {
        seen.add(key);
        reached.push(next);
      }
    }
  }
  return reached;
};

/**
 * The keys of `inputs` a refused read belongs to, empty when none does.
 *
 * A read reaches an input two ways. It reads a document the caller's link
 * addressed or led on to, which the addresses the input reached match. Or it
 * reads the piece's argument document, where every input — link or plain
 * JSON — sits under its own key, so the first path segment is the key. Both
 * are matched, because one refusal commonly reports the same input through
 * both.
 *
 * Every match is returned. One document handed in under two keys is reached
 * by dropping either alias alone, and a remedy naming one of them would
 * leave the other carrying the label.
 */
const refusalReadInputKeys = (
  read: CfcAddress,
  addresses: readonly RunPatternInputAddress[],
  argumentHash: string | undefined,
  suppliedKeys: readonly string[],
): readonly string[] => {
  const readHash = comparableEntityHash(read.id);
  if (readHash === undefined) {
    return [];
  }
  const keys: string[] = [];
  for (const address of addresses) {
    if (
      address.hash === readHash && pathHasPrefix(read.path, address.path) &&
      !keys.includes(address.key)
    ) {
      keys.push(address.key);
    }
  }
  if (argumentHash !== undefined && readHash === argumentHash) {
    const first = read.path[0];
    if (
      first !== undefined && suppliedKeys.includes(first) &&
      !keys.includes(first)
    ) {
      keys.push(first);
    }
  }
  return keys;
};

/**
 * Whether a rendered label atom may be named to the model.
 *
 * A scalar atom — `"medical"`, `3`, `true` — is the word the data was tagged
 * with, and naming it is the whole point of the report. A structured atom is
 * a CFC atom object, and a `Caveat` among them carries the principal that
 * introduced it; `redactCaveatSourcesForDisplay` strips that principal from a
 * whole label view, and there is no seam that strips it from an atom already
 * rendered to a string. So a structured atom is counted rather than named.
 */
const namableRefusalAtom = (rendered: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(rendered);
    return !isObjectOrArray(parsed);
  } catch {
    return false;
  }
};

/**
 * Fold the boundary's refusal details into the one report the caller reads,
 * resolving each offending read to a key of this call's `inputs`.
 *
 * `attribution` is the harness's own question, stricter than the boundary's:
 * the boundary asks whether every offending atom reached a named READ, and
 * this asks whether every such read is an input the caller can drop. A read
 * the caller does not own leaves the answer at `partial` even when the
 * boundary called its own attribution complete, because dropping inputs
 * cannot reach it.
 */
export const runPatternPolicyRefusal = (
  refusals: readonly CfcRefusalDetail[],
  inputKeysFor: (read: CfcAddress) => readonly string[],
): HarnessPolicyRefusal | undefined =>
  nonEmpty(refusals) ? foldPolicyRefusals(refusals, inputKeysFor) : undefined;

/** Whether `items` has a first element, narrowing to the tuple that says so. */
const nonEmpty = <T>(items: readonly T[]): items is readonly [T, ...T[]] =>
  items.length > 0;

/** {@link runPatternPolicyRefusal} over at least one detail. */
const foldPolicyRefusals = (
  refusals: readonly [CfcRefusalDetail, ...CfcRefusalDetail[]],
  inputKeysFor: (read: CfcAddress) => readonly string[],
): HarnessPolicyRefusal => {
  const gates: CfcRefusalGate[] = [];
  const sinks: string[] = [];
  const offendingAtoms: string[] = [];
  const inputKeys: string[] = [];
  const seenAtoms = new Set<string>();
  const unattributed = new Set<string>();
  let withheldAtomCount = 0;
  let everyDetailComplete = true;
  for (const detail of refusals) {
    if (!gates.includes(detail.gate)) gates.push(detail.gate);
    if (detail.sink !== undefined && !sinks.includes(detail.sink)) {
      sinks.push(detail.sink);
    }
    if (detail.attribution !== "complete") everyDetailComplete = false;
    for (const atom of detail.offendingAtoms) {
      if (seenAtoms.has(atom)) continue;
      seenAtoms.add(atom);
      if (namableRefusalAtom(atom)) offendingAtoms.push(atom);
      else withheldAtomCount += 1;
    }
    for (const input of detail.inputs) {
      const keys = inputKeysFor(input.read);
      if (keys.length === 0) {
        // Counted by document, so one document read at three paths is one
        // input the caller cannot name rather than three.
        unattributed.add(comparableEntityHash(input.read.id) ?? "");
        continue;
      }
      for (const key of keys) {
        if (!inputKeys.includes(key)) inputKeys.push(key);
      }
    }
  }
  const attribution: CfcRefusalAttribution = inputKeys.length === 0
    ? "none"
    : everyDetailComplete && unattributed.size === 0
    ? "complete"
    : "partial";
  return {
    gates,
    sinks,
    offendingAtoms,
    ...(withheldAtomCount > 0 ? { withheldAtomCount } : {}),
    inputKeys,
    ...(unattributed.size > 0
      ? { unattributedInputCount: unattributed.size }
      : {}),
    attribution,
  };
};

const quoteAll = (values: readonly string[]): string =>
  values.map((value) => `"${value}"`).join(", ");

/**
 * The refusal stated as an instruction: what refused, which of the caller's
 * inputs carried what it refused, and whether dropping those inputs is the
 * whole remedy or only narrows the flow.
 */
export const policyRefusalMessage = (
  refusal: HarnessPolicyRefusal,
  boundaryRefused: HarnessReleaseBoundary,
): string => {
  const boundary = refusal.sinks.length > 0
    ? `the sink${refusal.sinks.length > 1 ? "s" : ""} ${
      quoteAll(refusal.sinks)
    }`
    : "the write it attempted";
  const atoms = refusal.offendingAtoms.length > 0
    ? ` (${refusal.offendingAtoms.join(", ")})`
    : "";
  const opening = boundaryRefused === "commit"
    ? `the pattern ran but the space's policy refused to commit its result: ` +
      `${boundary} does not admit the confidentiality${atoms} this run ` +
      `carries, so the result never landed`
    : `the pattern ran and its result is in the space, but the space's ` +
      `policy refused to release its values: ${boundary} does not admit ` +
      `the confidentiality${atoms} the result carries, so value is ` +
      `withheld here while resultRef still names the result, which can be ` +
      `passed on by reference`;
  const plural = refusal.inputKeys.length > 1;
  const keys = `input${plural ? "s" : ""} ${quoteAll(refusal.inputKeys)}`;
  const cleared = boundaryRefused === "commit"
    ? "proceeds"
    : "releases its values";
  const remedy = refusal.attribution === "complete"
    ? `Every label refused here came in through ${keys}, so the same run ` +
      `without ${plural ? "them" : "it"} ${cleared}`
    : refusal.attribution === "partial"
    ? `Some of what was refused came in through ${keys}; dropping ` +
      `${plural ? "them" : "it"} narrows the flow without necessarily ` +
      "clearing it, since reads this call does not own carry refused " +
      "labels too"
    : "No input of this call accounts for what was refused, so dropping an " +
      "input will not clear it";
  return `${opening}. ${remedy}. ${RUN_PATTERN_REFUSAL_ARTIFACT_NOTE}`;
};

/**
 * A raw result may hold values `JSON.stringify` cannot carry into the
 * tool-output artifact (a cycle through the reactive graph, say), so the
 * round trip both proves serializability and normalizes cells to their
 * serialized link form. Returns `undefined` when the value does not
 * serialize.
 */
export const asSerializableValue = (value: unknown): unknown => {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : JSON.parse(encoded);
  } catch {
    return undefined;
  }
};

/**
 * The reserved seal target, as `cfcOpaqueLinkForPath` mints it: the literal
 * `opaque:` scheme, then a percent-encoded handle id, then optionally `#` and
 * a JSON pointer that always opens with `/`. The handle-id charset is exactly
 * what `encodeURIComponent` can emit, which is what keeps this narrower than
 * "any string starting with `opaque:`" — a sentence, a path, or a quoted
 * phrase carrying that prefix has a space or a delimiter in it and does not
 * match.
 */
const RESERVED_OPAQUE_TARGET =
  /^opaque:[A-Za-z0-9\-_.!~*'()%]+(?:#\/[\s\S]*)?$/;

/**
 * Whether `value` is the reserved seal target string. The target is the seal:
 * the `@link` object is only the wrapper a sanitized result happens to put it
 * in, and a model that lifts the string out of that wrapper — or reads it out
 * of one whose other keys it also copied — is passing back the same redaction.
 */
const isSealedOpaqueTarget = (value: unknown): boolean =>
  typeof value === "string" && RESERVED_OPAQUE_TARGET.test(value);

/**
 * The path at which `value` carries a sealed opaque link, or `undefined` when
 * it carries none. `path` names the position `value` itself sits at, so a
 * caller starting from an input key gets back a path that points at the
 * offending position within that input. The search is exhaustive because a
 * sealed value reaches an input however the model composed it — nested inside
 * an object or an array it built around what a tool result handed back, and in
 * whatever form it lifted it out in.
 */
const sealedOpaqueLinkPath = (
  value: unknown,
  path: string,
): string | undefined => {
  if (isSealedOpaqueTarget(value)) {
    return path;
  }
  if (
    isSealedOpaqueLinkObject(value) ||
    (isObjectNotArray(value) && isSealedOpaqueTarget(value["@link"]))
  ) {
    return path;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = sealedOpaqueLinkPath(value[index], `${path}[${index}]`);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (isObjectNotArray(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const found = sealedOpaqueLinkPath(entry, `${path}.${key}`);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
};

/**
 * What the model is told when it passes back a value a structured result
 * sealed. The distinction the message has to carry is the whole of the fix: a
 * seal is a redaction, so it names nothing, and the reference the model was
 * given for that same data is what it should have passed instead.
 */
const sealedInputRefusal = (key: string, path: string): string =>
  `run_pattern input "${key}" ${
    path === key
      ? "is a sealed opaque link"
      : `carries a sealed opaque link at "${path}"`
  } — the reserved "opaque:..." target, whether as a bare string or as the "@link" of an object. A sealed value is a redaction, not an address: it marks a position an earlier result withheld, so it names nothing that can be read, and storing it would leave a dead literal where the pattern declared a live reference, with everything computed from it empty. Pass the reference you were given for that data instead — the whole cfh:a: handle token, or the LLM-friendly link it stands for — as the input's own string value.`;

/**
 * Awaits `work` unless `signal` aborts first. Resolution (not rejection)
 * signals the abort so the losing promise never surfaces as an unhandled
 * rejection; the signal is the only cancellation source — no timeout puts an
 * upper bound on `work` completing.
 */
const raceWithAbort = async (
  work: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<"completed" | "aborted"> => {
  if (signal === undefined) {
    await work;
    return "completed";
  }
  if (signal.aborted) {
    work.catch(() => {});
    return "aborted";
  }
  let onAbort!: () => void;
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      work.then(() => "completed" as const),
      aborted,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    work.catch(() => {});
  }
};

export const runPatternTool: HarnessToolDefinition<
  RunPatternToolInput,
  RunPatternToolOutput
> = {
  descriptor: runPatternToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("run_pattern");
    /**
     * What the release boundary decided, once it has decided. Declared here
     * so {@link errorOutput} can carry it: every exit below the fit is an
     * exit the boundary already decided at, and an exit that had to remember
     * to attach the decision is an exit that can forget to.
     */
    let releaseDecision: HarnessReleaseDecision | undefined = undefined;
    const errorOutput = (
      status: RunPatternToolErrorOutput["status"],
      message: string,
    ): RunPatternToolErrorOutput => ({
      outputId,
      status,
      message,
      ...(releaseDecision !== undefined ? { releaseDecision } : {}),
    });

    /**
     * `detail` is what the cancellation left behind that the caller would
     * otherwise have to discover by looking: a durable effect the run had
     * already made and does not undo. The cancelled output carries no fields
     * beyond `message`, so it is said there.
     */
    const cancelledOutput = (detail?: string): RunPatternToolErrorOutput =>
      errorOutput(
        "cancelled",
        detail === undefined
          ? "run_pattern was cancelled"
          : `run_pattern was cancelled; ${detail}`,
      );

    if (context.getFabricSession === undefined) {
      return errorOutput(
        "error",
        "run_pattern requires a fabric session; configure --fabric-api-url, --fabric-identity, and --fabric-space",
      );
    }
    const { sourceText, patternId } = input;
    if (sourceText !== undefined && patternId !== undefined) {
      return errorOutput(
        "error",
        "run_pattern takes sourceText or patternId, not both; pass your own source or the id of an indexed pattern",
      );
    }
    if (sourceText === undefined && patternId === undefined) {
      return errorOutput("error", RUN_PATTERN_NO_PROGRAM_MESSAGE);
    }
    // The run's index client and its ledger, held once: which of the index
    // paths below run is decided by the call and by whether the run has an
    // index at all, and both questions are settled here rather than at each of
    // them. A run configured for an index has both, so a `patternId` without
    // either is refused here rather than reaching a path that would drop what
    // it had to say.
    const getPatternIndexClient = context.getPatternIndexClient;
    const patternIndexLedger = context.patternIndexLedger;
    if (
      patternId !== undefined &&
      (getPatternIndexClient === undefined || patternIndexLedger === undefined)
    ) {
      return errorOutput(
        "error",
        "run_pattern patternId requires a pattern index; configure --pattern-index-url, or pass sourceText instead",
      );
    }
    if (sourceText !== undefined) {
      const sourceTextBytes = new TextEncoder().encode(sourceText).length;
      if (sourceTextBytes > RUN_PATTERN_MAX_SOURCE_TEXT_BYTES) {
        return errorOutput(
          "error",
          `run_pattern sourceText exceeds the ${
            RUN_PATTERN_MAX_SOURCE_TEXT_BYTES / 1024
          } KiB limit (${sourceTextBytes} bytes)`,
        );
      }
    }
    let parsedResultSchema;
    try {
      parsedResultSchema = parseStructuredResultSchema(input.resultSchema, {
        label: "run_pattern resultSchema",
      });
    } catch (error) {
      return errorOutput("error", errorMessage(error));
    }
    let session;
    try {
      session = await context.getFabricSession();
    } catch (error) {
      return errorOutput(
        "error",
        `fabric session unavailable: ${errorMessage(error)}`,
      );
    }
    const { pieces } = session;
    const space = pieces.getSpace();
    const signal = context.signal;
    if (signal?.aborted) {
      return cancelledOutput();
    }
    // Whole-string LLM-friendly links become live cell references; the
    // prompt loop has already resolved any handle tokens, so the strings
    // seen here carry canonical addresses. Non-link strings and non-strings
    // pass through as plain JSON. A link that resolves outside the session's
    // configured space is refused before anything is created: the session's
    // authority ends at its own space. So is a value carrying a sealed
    // opaque link anywhere within it, which is a redaction the model copied
    // back out of an earlier result rather than a reference to anything.
    let pieceInput: Record<string, unknown> | undefined;
    const liveCellInputs: Array<{ key: string; cell: Cell<unknown> }> = [];
    const plainInputs: Array<{ key: string; value: unknown }> = [];
    // Where each input landed, kept for the one path that needs it: a policy
    // refusal names the reads that carried the offending labels, and a read
    // is only actionable once it is back to the key the caller passed.
    const suppliedInputKeys: string[] = [];
    const inputAddresses: RunPatternInputAddress[] = [];
    if (input.inputs !== undefined) {
      const converted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input.inputs)) {
        suppliedInputKeys.push(key);
        const sealedPath = sealedOpaqueLinkPath(value, key);
        if (sealedPath !== undefined) {
          return errorOutput("error", sealedInputRefusal(key, sealedPath));
        }
        let entry = value;
        if (
          typeof value === "string" && matchLLMFriendlyLink.test(value.trim())
        ) {
          let link;
          try {
            link = parseLLMFriendlyLink(value, space);
          } catch {
            // Not a parseable link after all — keep the plain string.
          }
          if (link !== undefined) {
            if (link.space !== space) {
              return errorOutput(
                "error",
                `run_pattern input "${key}" reference targets another space; only references into the configured session space are allowed`,
              );
            }
            const linkHash = comparableEntityHash(link.id);
            if (linkHash !== undefined) {
              inputAddresses.push({ key, hash: linkHash, path: link.path });
            }
            const cell = pieces.runtime.getCellFromLink(link);
            liveCellInputs.push({ key, cell });
            entry = cell;
          }
        }
        if (entry === value) {
          plainInputs.push({ key, value });
        }
        defineOwnEntry(converted, key, entry);
      }
      pieceInput = converted;
    }
    // The indexed program is fetched here, on the trusted host side, and goes
    // straight into the compiler. Nothing read from the index is carried into
    // any output this tool returns.
    let program: RuntimeProgram;
    // What the index recorded the fetched pattern composes, when the run named
    // one. A published pattern's own imports are materialized on the same
    // terms as an authored source's.
    let recordedDependencies: readonly string[] = [];
    if (sourceText !== undefined) {
      program = {
        main: RUN_PATTERN_SOURCE_MAIN,
        files: [{ name: RUN_PATTERN_SOURCE_MAIN, contents: sourceText }],
      };
    } else if (patternId !== undefined && getPatternIndexClient !== undefined) {
      let indexed;
      try {
        const client = await getPatternIndexClient();
        indexed = await client.getPattern({
          patternId,
          includeSource: true,
        });
      } catch (error) {
        // `PatternIndexError.message` is stable by construction; the service
        // body it withheld can quote indexed source, so it goes only to the
        // artifact.
        return {
          ...errorOutput(
            "error",
            `pattern index lookup failed for "${patternId}": ${
              errorMessage(error)
            }`,
          ),
          ...(error instanceof PatternIndexError && error.detail !== undefined
            ? { rawCauseMessage: error.detail }
            : {}),
        };
      }
      if (indexed.program === undefined) {
        return errorOutput(
          "error",
          `the pattern index returned no program for "${patternId}"`,
        );
      }
      program = runtimeProgramFromIndex(indexed.program);
      recordedDependencies = indexed.dependencies;
    } else {
      // Unreachable: a call naming neither was refused above, and one naming
      // a `patternId` without an index with it. The pair's exclusivity is a
      // fact about those checks rather than about the input type, so the
      // branch is written out instead of asserted away.
      return errorOutput("error", RUN_PATTERN_NO_PROGRAM_MESSAGE);
    }
    // A `cf:pattern:` import resolves from the space's own source cache, and
    // for a pattern this space has never run there is nothing there to
    // resolve. Each one is fetched from the index and compiled into the space
    // first, host-side, so the compile below finds it — and so no part of what
    // was fetched reaches this tool's output, on the success path or on any of
    // the failure paths.
    try {
      await materializeComposedPatterns({
        runtime: pieces.runtime,
        space,
        patternIds: composedPatternIds(program, recordedDependencies),
        getClient: getPatternIndexClient,
      });
    } catch (error) {
      if (error instanceof PatternCompositionError) {
        return {
          ...errorOutput("error", error.message),
          ...(error.rawCauseMessage !== undefined
            ? { rawCauseMessage: error.rawCauseMessage }
            : {}),
        };
      }
      return {
        ...errorOutput(
          "error",
          "the published patterns this source composes could not be made available; the failure text is retained in the run artifact and withheld here, since it can quote source you did not author",
        ),
        rawCauseMessage: errorMessage(error),
      };
    }
    let pattern;
    try {
      pattern = await compileAndSavePattern(pieces.runtime, program, {
        space,
      });
    } catch (error) {
      // Compiler diagnostics are the model's feedback loop for source it
      // wrote, so the full message goes into the artifact; the prompt loop
      // scrubs bare fabric identifiers from the model-facing rendering. An
      // indexed pattern is source the model never saw and cannot correct, and
      // a diagnostic quotes the line it failed on, so there the artifact
      // keeps the diagnostic and the model gets the fact of the failure.
      return patternId === undefined
        ? errorOutput(
          "compile-error",
          withRuntimeModuleCorrection(errorMessage(error)),
        )
        : {
          ...errorOutput(
            "compile-error",
            `the indexed pattern "${patternId}" did not compile; the diagnostic is retained in the run artifact and withheld here, since it quotes source you did not author`,
          ),
          rawCauseMessage: errorMessage(error),
        };
    }
    // An input's value must match the compiled pattern's argument schema for
    // its key before any piece exists, so a mismatch is a model-correctable
    // error rather than a persisted broken piece. What supplies the value
    // does not change the question: a live cell is measured by what it
    // currently holds, and a plain JSON value by itself.
    const argumentSchema = pattern.argumentSchema;
    const argumentProperties = isObjectNotArray(argumentSchema) &&
        isObjectNotArray(argumentSchema.properties)
      ? argumentSchema.properties
      : undefined;
    // An input the compiled pattern declares no argument for is refused for
    // the same reason: the pattern would run with that argument undefined and
    // every field computed from it empty, which renders as a complete page
    // holding nothing. Only a pattern whose argument schema names its
    // properties is measured this way — one that admits further properties, or
    // that declares its argument through a `$ref` or a combinator, states no
    // closed set of names to measure against. `additionalProperties` admits
    // them both when it is `true` and when it is a schema: a schema there is an
    // index signature, which names what an undeclared key is allowed to hold
    // rather than forbidding one. A plain-function pattern compiles with no
    // argument schema at all — not even a boolean one — so the read is
    // guarded rather than assumed.
    const additionalArguments = isObjectNotArray(argumentSchema)
      ? (argumentSchema as { additionalProperties?: unknown })
        .additionalProperties
      : undefined;
    const admitsUndeclaredArguments = additionalArguments === true ||
      isObjectNotArray(additionalArguments);
    if (
      argumentProperties !== undefined && input.inputs !== undefined &&
      !admitsUndeclaredArguments
    ) {
      const declared = Object.keys(argumentProperties);
      const undeclared = Object.keys(input.inputs).filter(
        (key) => !Object.hasOwn(argumentProperties, key),
      );
      if (undeclared.length > 0) {
        return errorOutput(
          "error",
          `run_pattern inputs name ${
            undeclared.map((key) => `"${key}"`).join(", ")
          }, which the pattern's argument schema does not declare; it declares ${
            declared.length === 0
              ? "no inputs"
              : declared.map((key) => `"${key}"`).join(", ")
          }`,
        );
      }
    }
    // An `additionalProperties` schema is what the argument schema says an
    // undeclared key may hold, so an input admitted by it is measured against
    // it: admitting a key is a statement about its value, not an exemption
    // from having one checked. An `additionalProperties` of `true` states
    // nothing to measure against — the pattern declared its argument open, so
    // an undeclared key there is unconstrained by declaration rather than
    // unchecked by omission — and neither does a key the argument schema
    // declares no shape for at all.
    const undeclaredArgumentSchema = isObjectNotArray(additionalArguments)
      ? additionalArguments as JSONSchema
      : undefined;
    const argumentSchemaForKey = (key: string): JSONSchema | undefined =>
      argumentProperties !== undefined && Object.hasOwn(argumentProperties, key)
        ? argumentProperties[key] as JSONSchema
        : undeclaredArgumentSchema;
    const argumentMismatch = (
      key: string,
      value: unknown,
    ): RunPatternToolErrorOutput | undefined => {
      const propertySchema = argumentSchemaForKey(key);
      if (propertySchema === undefined) {
        return undefined;
      }
      const failure = validateAgainstSchema(
        propertySchema,
        value,
        argumentSchema,
      );
      return failure === undefined ? undefined : errorOutput(
        "error",
        `run_pattern input "${key}" does not match the pattern's argument schema: ${failure}`,
      );
    };
    // A property schema referring into the argument schema's `$defs` leaves
    // its root behind when it becomes a cell's whole schema, so the read
    // schema carries the referenced definitions along —
    // `selectReferencedCfcSchemaDefs` computes that closure from the argument
    // schema's map. Under an argument schema that declares none, a property
    // has no local definitions to carry.
    const argumentDefs = isObjectNotArray(argumentSchema) &&
        isObjectNotArray((argumentSchema as { $defs?: unknown }).$defs)
      ? (argumentSchema as { $defs: Record<string, JSONSchema> }).$defs
      : undefined;
    const readSchemaForKey = (key: string): JSONSchema | undefined => {
      const propertySchema = argumentSchemaForKey(key);
      if (propertySchema === undefined || !isObjectNotArray(propertySchema)) {
        return propertySchema;
      }
      // A position the argument declares `asCell` — `Cell<T>` and `SqliteDb`,
      // which is a cell variant — reads back as the handle rather than as the
      // value, and a handle is not what the rest of the schema describes. This
      // read is for the value the input holds, so it drops the handle
      // declaration and keeps the description of the contents. `asStream` is
      // the other half of that vocabulary and is left alone: no input reaches
      // this pre-flight declaring one, so what dropping it would read back is
      // unmeasured.
      const { asCell: _asCell, ...valueSchema } = propertySchema;
      const defs = selectReferencedCfcSchemaDefs(valueSchema, argumentDefs);
      return defs === undefined ? valueSchema : { ...valueSchema, $defs: defs };
    };
    for (const { key, cell } of liveCellInputs) {
      const readSchema = readSchemaForKey(key);
      if (readSchema === undefined) {
        continue;
      }
      // The read goes through the argument schema: a schema-less sync can
      // complete without data for a referent that needs schema-driven
      // materialization (a registry grant is one), and its `undefined` would
      // be measured here as the cell's value.
      const typedCell = cell.asSchema(readSchema);
      await typedCell.sync();
      const mismatch = argumentMismatch(key, typedCell.get());
      if (mismatch !== undefined) {
        return mismatch;
      }
    }
    for (const { key, value } of plainInputs) {
      const mismatch = argumentMismatch(key, value);
      if (mismatch !== undefined) {
        return mismatch;
      }
    }
    // Position in the runtime's observation stream before the piece exists,
    // so the post-settle read covers exactly this invocation's window.
    const observations = fabricRuntimeObservations(pieces.runtime);
    const observationStart = observations.sequence();
    // The same window over what the runtime materializes, for the check that
    // the created piece carries a pointer another runtime can load. A session
    // built without an instantiation recorder asks nothing.
    const instantiationStart = session.instantiations?.sequence() ?? 0;

    /**
     * Reports this invocation's outcome to the index, when the pattern came
     * from there. A cancelled run reports nothing: it neither succeeded nor
     * failed, and the index ranks on what a pattern did. The report goes to
     * the session's ledger, which sends it in call order without the run
     * awaiting it and holds the session's one wait for it — the run is over
     * long before the process is.
     */
    const recordOutcome = (eventType: PatternIndexEventType): void => {
      if (patternId !== undefined) {
        patternIndexLedger?.record(patternId, eventType);
      }
    };

    let piece: PieceController<unknown>;
    try {
      // Deliberately unregistered: no `pieces.add()` and no default-pattern
      // touch, so the piece never appears in the space's piece list. No
      // origin either: model-authored source starts detached under the piece
      // source-lifecycle spec, and run→piece provenance lives in the run's
      // persisted artifacts — run-state and the tool-output artifact record
      // the `pieceId`.
      const pieceCell = await pieces.runPersistent(
        pattern,
        pieceInput ?? {},
        undefined,
        { start: true },
      );
      piece = new PieceController(pieces, pieceCell);
    } catch (error) {
      recordOutcome("run_failed");
      // The pattern's own body runs inside this call, so what it throws can
      // quote the source it was written from. For source the model wrote
      // that is its feedback loop; for an indexed pattern it is source the
      // model never saw, so the artifact keeps the text and the model gets
      // the fact of the failure — the same division the compile path makes.
      return patternId === undefined
        ? errorOutput("error", errorMessage(error))
        : {
          ...errorOutput(
            "error",
            `the indexed pattern "${patternId}" failed while starting; the failure text is retained in the run artifact and withheld here, since it can quote source you did not author`,
          ),
          rawCauseMessage: errorMessage(error),
        };
    }
    recordOutcome("instantiated");
    // Stops the created piece without the usual `stopPiece` idle wait: an
    // abort path must not wait on the very scheduler the signal is escaping.
    const stopPiece = (cell: Cell<unknown>) => {
      try {
        pieces.runtime.runner.stop(cell);
      } catch {
        // Best-effort: whatever outcome the caller reached stands either way.
      }
    };
    const barrier = (async () => {
      await pieces.runtime.settled();
      await pieces.synced();
    })();
    if (await raceWithAbort(barrier, signal) === "aborted") {
      stopPiece(piece.getCell());
      return cancelledOutput();
    }
    const resultCell = await piece.result.getCell();
    // A piece whose graph was materialized under a session-synthetic pattern
    // pointer exists for this session and no other: a fresh runtime asked to
    // open it cannot resolve the pointer at all. This session renders
    // nothing, so any keyless instantiation in the window is that shape (see
    // `keylessInstantiation`). The run is reported as a failure rather than
    // handed back as a piece that dies on the first visit, and the pattern is
    // not contributed to the index below, since the same shape would strand
    // every later run that ran it.
    const strandedInstantiation = session.instantiations === undefined
      ? undefined
      : keylessInstantiation(
        session.instantiations.keylessSince(instantiationStart),
      );
    if (strandedInstantiation !== undefined) {
      recordOutcome("run_failed");
      return {
        ...errorOutput(
          "error",
          `the pattern ran, but the harness detected a session-only pattern pointer in the created piece's graph, so the run is reported as a failure. The detected pointer cannot be opened by another runtime. Return a durable result object directly`,
        ),
        pieceId: piece.id,
        rawCauseMessage:
          `pattern materialized under session-only identity ${strandedInstantiation.identity}#${strandedInstantiation.symbol} on entity ${strandedInstantiation.cell}`,
      };
    }
    const resultRef = createLLMFriendlyLink(
      resultCell.getAsNormalizedFullLink(),
      space,
    );
    /**
     * The report a policy refusal produces, whichever boundary stated it:
     * each offending read resolved to a key of this call's `inputs`.
     *
     * The caller's own addresses are extended by the dereferences the
     * attribution read below recorded, so a read of a document the caller's
     * link reaches through a link it holds is placed as readily as a read of
     * the document it names. The piece's argument document is where every
     * input reaches the pattern under its own key, so a refused read of it
     * names an input by its first path segment. Its address is resolved here
     * rather than kept from creation because only a refusal asks for it, and
     * an argument cell that will not resolve leaves the caller's own
     * addresses as the route from a clause back to an input key.
     */
    const describeRefusal = async (
      details: readonly [CfcRefusalDetail, ...CfcRefusalDetail[]],
    ): Promise<HarnessPolicyRefusal> => {
      let argumentHash: string | undefined;
      try {
        argumentHash = comparableEntityHash(
          (await piece.input.getCell()).getAsNormalizedFullLink().id,
        );
      } catch {
        argumentHash = undefined;
      }
      const reached = inputAddressesReached(inputAddresses, attributionTraces);
      return foldPolicyRefusals(
        details,
        (read) =>
          refusalReadInputKeys(
            read,
            reached,
            argumentHash,
            suppliedInputKeys,
          ),
      );
    };

    /**
     * What a refused commit reports: a failed run, since nothing landed.
     *
     * The refusal reason stays out of the model-facing message the same way
     * thrown text does: it names the documents and label atoms involved —
     * fabric identifiers and policy detail the model does not read — so the
     * artifact keeps it and the model gets the fact of the refusal.
     */
    const commitRefusalOutput = async (
      details: readonly CfcRefusalDetail[],
      rawCauseMessage: string,
    ) => {
      // The commit boundary's own decision, and not the release measurement
      // beside it: nothing landed, so what the ceiling would have admitted of
      // a result that does not exist is not a decision about this run.
      recordOutcome("run_failed");
      const policyRefusal = nonEmpty(details)
        ? await describeRefusal(details)
        : undefined;
      return {
        ...errorOutput(
          "error",
          policyRefusal === undefined
            ? RUN_PATTERN_OPAQUE_REFUSAL_MESSAGE
            : policyRefusalMessage(policyRefusal, "commit"),
        ),
        pieceId: piece.id,
        rawCauseMessage,
        ...(policyRefusal !== undefined ? { policyRefusal } : {}),
        // The commit boundary states no sink or ceiling of its own: the
        // runner refused at the pattern's own sink requests, which the
        // refusal names, rather than at a fit this tool performed. Stated
        // after the spread above, so it stands in place of the release
        // measurement's own decision where both exist: nothing landed, so
        // what the ceiling would have admitted of a result that does not
        // exist is not a decision about this run.
        releaseDecision: {
          reasonCode: "cfc_commit_refused",
          boundary: "commit",
          ...(policyRefusal !== undefined ? { refusal: policyRefusal } : {}),
        } satisfies HarnessReleaseDecision,
      };
    };

    // The result is read HERE, through a transaction, and the value below is
    // that read rather than a second one: a result the reactive graph
    // advances between two reads would otherwise let a later clean state
    // answer for an earlier labeled one. The read is host-side and discloses
    // nothing by itself. What the answer discloses is the VALUES a
    // `resultSchema` asks for, and those are an egress: they are read by a
    // model, outside every space the fabric labels. A pattern's own egresses
    // are sink requests the commit boundary gates, and this one records
    // none, so it is measured here, and only when values were asked for —
    // the transaction's consumed join, the result document and every
    // computed cell the result links to, against the ceiling a model's
    // context carries. The result reference goes out either way: it names
    // the result without carrying it, and a name is not a release
    // (AH-CFC-18). Nothing is committed.
    //
    // A second transaction reads the piece's argument document and the
    // caller's own live inputs, and only that transaction does. Every input
    // reaches the pattern through that document under its own key, so a
    // clause it carries names an input the caller can drop; a clause
    // reaching the answer by another route is reported as unattributed. The
    // dereferences that transaction records on the way are kept with it:
    // they are what place a read of a document the caller's link reaches
    // through a link rather than names. Whether a refusal comes from this
    // measurement or from the commit boundary, the attribution read is the
    // same, so it runs whether or not values were asked for.
    //
    // The ladder decides whether a recorded reason WITHHOLDS the values, not
    // whether they are measured: the measurement runs at every rung, so an
    // observe-stage rollout can size what turning the rung up would withhold,
    // which is what the sink gate beside it does with the same reason.
    const releaseGateRejects =
      pieces.runtime.cfcEnforcementMode !== "disabled" &&
      pieces.runtime.cfcEnforcementMode !== "observe";
    let releaseRefusal: CfcRefusalDetail | undefined;
    let attributionTraces: readonly CfcDereferenceTrace[] = [];
    let rawValue: unknown;
    const measureRelease = async () => {
      const releaseTx = pieces.runtime.edit();
      const inputsTx = pieces.runtime.edit();
      try {
        // The `required` relaxation is the piece controller's, so a scoped
        // link the session cannot materialize degrades its member rather
        // than voiding the whole read.
        const measuredResult = cellWithScopedLinkRequiredsRelaxed(
          resultCell.withTx(releaseTx),
        );
        await measuredResult.pull();
        rawValue = asSerializableValue(measuredResult.get());
        try {
          const measuredArgument = (await piece.input.getCell())
            .withTx(inputsTx);
          await measuredArgument.pull();
          asSerializableValue(measuredArgument.get());
        } catch {
          // An argument cell that will not resolve leaves the caller's own
          // addresses as the route from a clause back to an input key.
        }
        for (const { cell } of liveCellInputs) {
          const measuredInput = cell.withTx(inputsTx);
          await measuredInput.pull();
          asSerializableValue(measuredInput.get());
        }
        // Copied before the abort below, which clears them.
        attributionTraces = [...inputsTx.getCfcState().dereferenceTraces];
        return parsedResultSchema === undefined
          ? undefined
          : describeSinkReleaseRefusal(
            releaseTx,
            inputsTx,
            RUN_PATTERN_ANSWER_SINK,
            RUN_PATTERN_ANSWER_CEILING,
          );
      } finally {
        releaseTx.abort("run_pattern release measurement");
        inputsTx.abort("run_pattern release attribution");
      }
    };
    // Raced with the signal like every other wait this tool performs: the
    // reads resolve a graph, and a caller that gave up while they were in
    // flight is told it was cancelled rather than handed an answer it stopped
    // waiting for. The measurement abandons its own transactions whichever
    // way the race goes.
    const measuring = (async () => {
      releaseRefusal = await measureRelease();
    })();
    if (await raceWithAbort(measuring, signal) === "aborted") {
      stopPiece(piece.getCell());
      return cancelledOutput();
    }

    // The measurement is read HERE, before the exits below, because every
    // one of them is an exit the boundary already decided at: a run whose
    // result fails to settle after the fit still had the fit performed, and a
    // decision left behind at such an exit is the very decision the trace was
    // missing. What it found goes one of two ways. Where the ladder
    // rejects, the values are withheld and the refusal reaches the model as
    // data and as an instruction, with its reason kept for the artifact.
    // Where it does not, the values go out and the measurement is still an
    // answer about this run, which only the artifact can carry.
    const withheldRefusal = releaseGateRejects ? releaseRefusal : undefined;
    const withheld = withheldRefusal === undefined
      ? undefined
      : await describeRefusal([withheldRefusal]);
    const releaseObservation =
      releaseGateRejects || releaseRefusal === undefined
        ? undefined
        : await describeRefusal([releaseRefusal]);
    const measured = withheld ?? releaseObservation;
    /**
     * The same measurement said as a decision, which is what reaches the
     * run's policy trace. Present exactly where a measurement happened — a
     * call that asked for no values measured nothing, and a decision about a
     * boundary nothing crossed would be a record of an event that did not
     * occur.
     *
     * The ceiling is stated whichever way the decision went. A released
     * answer and a withheld one differ in what the same ceiling admitted, and
     * an operator reading only the refusals would be reading the ladder's
     * effect without its terms.
     */
    releaseDecision = parsedResultSchema === undefined ? undefined : {
      reasonCode: withheld !== undefined
        ? "cfc_release_withheld"
        : releaseObservation !== undefined
        ? "cfc_release_observed"
        : "cfc_release_allowed",
      boundary: "release",
      sink: RUN_PATTERN_ANSWER_SINK,
      ceiling: RUN_PATTERN_ANSWER_CEILING.map(renderCfcAtom),
      ...(measured !== undefined ? { refusal: measured } : {}),
    };

    let value: unknown;
    let linkedStringCount: number | undefined;
    let valueError: string | undefined;
    if (parsedResultSchema !== undefined) {
      try {
        // The raw result is what gets measured: the framework's own result
        // keys are named to the sanitizer as RESERVED rather than projected
        // out first. Projecting first would change the question the schema
        // answers — a value a branch refuses because of what it carries under
        // `$NAME` would reach that branch with the offending key already
        // gone — and would miss a `$NAME` the caller declared through a
        // `$ref` or a combinator rather than at the top level.
        const sanitized = validateAndSanitizeStructuredResult({
          schema: parsedResultSchema.schema,
          value: rawValue,
          opaqueHandleId: outputId,
          reservedKeys: FRAMEWORK_RESULT_KEYS,
        });
        // A position the schema could not release as text is fabric-backed
        // by construction — the result reference plus the sealed path is its
        // address — so it goes over as that address rather than as a dead
        // output-scoped link. The outbound swap renders each one as a handle
        // token, which describe_handle answers and a later run_pattern can
        // wire by reference. `linkedStringCount` still counts the string
        // positions withheld as text.
        const resultLink = resultCell.getAsNormalizedFullLink();
        value = addressSealedPositions(
          sanitized.value,
          sanitized.sealedPaths,
          (path) => sealedPositionLink(resultLink, path, space),
        );
        linkedStringCount = sanitized.linkedStringCount;
      } catch (error) {
        valueError = errorMessage(error);
      }
    }
    // A result that settled to nothing is not a success to report. When the
    // sanitized value failed its schema, or the raw result holds no fields of
    // its own beyond the framework keys, the runtime's observation window
    // says why: an action error attributed to this piece names the cause —
    // a CFC commit refusal arrives there as a terminal
    // `CfcCommitRefusalError` — and a non-settling episode names the other
    // observed shape, actions deferred past the convergence budget, which is
    // what a reactive cycle or a non-idempotent computation looks like from
    // here.
    const inertResultKeys = isObjectNotArray(rawValue)
      ? Object.keys(rawValue).filter((key) => !key.startsWith("$"))
      : undefined;
    const resultAbsent = rawValue === undefined || rawValue === null ||
      (inertResultKeys !== undefined && inertResultKeys.length === 0);
    if (valueError !== undefined || resultAbsent) {
      const pieceErrors = observations.errorsSince(observationStart, piece.id);
      // A policy refusal is named as what it is.
      const refusal = pieceErrors.find((record) =>
        record.name === "CfcCommitRefusalError"
      );
      if (refusal !== undefined) {
        return await commitRefusalOutput(
          refusal.refusals ?? [],
          refusal.message,
        );
      }
      if (pieceErrors.length > 0) {
        // The thrown text stays out of the model-facing message: a
        // computation over data the model cannot read may carry that data in
        // what it throws, so the artifact keeps the diagnostic and the model
        // gets the fact of the failure.
        recordOutcome("run_failed");
        return {
          ...errorOutput(
            "error",
            `the pattern ran but a computation attributed to the created piece failed while settling and the result never landed; the failure text is retained in the run artifact and withheld here, since a computation's thrown message can carry the data it read`,
          ),
          pieceId: piece.id,
          rawCauseMessage: pieceErrors[0].message,
        };
      }
      // A convergence-budget episode is claimed when a deferred action's
      // piece attribution matches this piece, or — for an action carrying no
      // observation identity — when its label names this pattern's module
      // identity. An unrelated piece churning during this invocation's
      // settle window is not evidence about this one. The identity match is
      // exact; the label match is as fine as labels resolve: another live
      // piece created from the same source shares the module identity, so
      // the message says "this pattern's module" rather than claiming the
      // episode as this piece's own. An episode lists at most its first ten
      // deferred actions, so a wide episode can omit this pattern and
      // under-report, which falls back to the plain ok-with-valueError
      // rather than misattributing.
      // The scheduler composes deferred-action ids as
      // `cf:module/<identity>:<symbol>:<instanceKey>` from the same entry
      // ref this meta stamp stores, so the label match is on that composed
      // prefix rather than a bare substring — a representation drift on
      // either side fails the settle-cause test that drives this path,
      // loudly.
      const patternIdentity = getPatternIdentityRef(resultCell)?.identity;
      const pieceHash = comparableEntityHash(piece.id);
      const ownEpisodes = observations.episodesSince(observationStart).filter(
        (episode) =>
          episode.deferredActions.some((entry) =>
            (pieceHash !== undefined && entry.pieceId === pieceHash) ||
            (patternIdentity !== undefined &&
              entry.label.includes(`cf:module/${patternIdentity}:`))
          ),
      );
      if (ownEpisodes.length > 0) {
        recordOutcome("run_failed");
        return {
          ...errorOutput(
            "error",
            `the pattern ran but its result never landed: while it settled, the scheduler deferred ${
              ownEpisodes[ownEpisodes.length - 1].deferredActionCount
            } action(s) of this piece or this pattern's module past its convergence budget. A reactive cycle or a non-idempotent computation produces this shape`,
          ),
          pieceId: piece.id,
        };
      }
    }
    // The run's exact captured result seeds the report alongside the
    // materialized results retained in the instantiation window. A composed
    // reader exposes its failure, pending state, and emptiness
    // as outputs, and a pattern composing it need not pass them on — which is
    // how a run answers `ok` over a result of zeros. The reads are
    // host-side and nothing they find travels as text, so they are not part
    // of the release measurement above and are taken on a transaction of
    // their own, abandoned like every other measurement here. Read after the
    // exits above rather than before them, so a run that reports a failure
    // pays for none of it: what these answer is only ever carried by a
    // success.
    //
    // Every instantiation in the window is read, the run's own root
    // included, so a failure the caller's own query reported is disclosed on
    // the same terms as a composed one. The recorder's buffer is what bounds
    // the work: a pattern materialized once per row of a list reports the
    // same output many times, and `dedupedObservedOutputs` states each once.
    const ownCellHash = comparableEntityHash(piece.id);
    const concernsTx = pieces.runtime.edit();
    const found: ObservedOutput[] = [
      ...observedOutputsIn(rawValue, pattern.resultSchema),
    ];
    const scan = (async () => {
      for (
        const record of session.instantiations?.since(instantiationStart) ?? []
      ) {
        try {
          const instance = pieces.runtime.getCellFromLink(record.link)
            .withTx(concernsTx);
          await instance.pull();
          // The `required` relaxation is the one the result read above uses,
          // so a scoped link this session cannot materialize degrades its
          // member rather than voiding the whole read. It is applied AFTER
          // the pull, because it decides what to relax by reading what the
          // cell holds, and before the pull it holds nothing.
          const materialized = cellWithScopedLinkRequiredsRelaxed(instance);
          found.push(...observedOutputsIn(
            asSerializableValue(materialized.get()),
            record.link.schema,
            record.cell === ownCellHash ? undefined : record.identity,
          ));
        } catch {
          // One instance that will not read back says nothing about the
          // others, and this report is a disclosure: what a failed read
          // costs is the reason to look at that one instance, so it is
          // dropped rather than taking the report down with it.
        }
      }
    })();
    // Raced with the signal like every other wait this tool performs: the
    // scan resolves a graph, and a caller that gave up while it was in flight
    // is told it was cancelled rather than handed an answer it stopped
    // waiting for. The transaction is abandoned whichever way the race goes.
    const scanned = await raceWithAbort(scan, signal);
    concernsTx.abort("run_pattern output-concern read");
    if (scanned === "aborted") {
      stopPiece(piece.getCell());
      return cancelledOutput();
    }
    const observedOutputs = dedupedObservedOutputs(found);
    // A result the caller's own `resultSchema` refused is reported as neither
    // outcome: the pattern ran and landed a result, and the schema it did not
    // match was written by whoever called the tool, so it is evidence about
    // the caller's contract rather than about the pattern. A release the
    // ceiling refused is evidence about policy, and the run succeeded under
    // it.
    if (valueError === undefined) {
      recordOutcome("run_succeeded");
    }
    /**
     * The render gate: what the pattern's own `$UI` does before the pattern
     * is contributed to the index.
     *
     * The render runs against a PROBE — a second, detached instance of the
     * same compiled pattern, built from a synthetic instance of the pattern's
     * own argument schema rather than from this run's inputs. The run's own
     * piece is never rendered, so no labeled data reaches the render through
     * the argument path. A pattern that reaches the space for itself is the
     * case that argument does not cover; `pattern-index/publish-render-gate.ts`
     * carries the whole of the reasoning, including what the verdict may say.
     *
     * The probe is unregistered like the run's own piece, and its `cause` is
     * left to default, so each check gets a piece with no state carried over
     * from an earlier one.
     *
     * A verdict never bears on the run: every path returns a verdict, and the
     * caller's only use for it is whether to publish.
     */
    const renderGateVerdict = async (): Promise<
      {
        status: PatternPublicationStatus;
        reason: PatternPublicationReason;
        syntheticInputsComplete: boolean;
        thrown?: string;
      } | "cancelled"
    > => {
      const synthetic = syntheticArgument(pattern.argumentSchema);
      const recorded = (reason: PatternPublicationReason, thrown?: string) => ({
        status: "recorded" as const,
        reason,
        syntheticInputsComplete: synthetic.complete,
        ...(thrown !== undefined ? { thrown } : {}),
      });
      const discoverable = (reason: PatternPublicationReason) => ({
        status: "discoverable" as const,
        reason,
        syntheticInputsComplete: synthetic.complete,
      });
      // The probe runs in an isolated, in-memory runtime — never the
      // session's space. `probe-runtime.ts` carries the whole reason; the
      // short version is that a probe in the live space persists its inputs
      // and its result graph there, `stop()` does not delete them, and the
      // orphan is reachable from the sandbox's Fabric mount.
      const probe = async () => {
        const opened = await (context.openProbeRuntime ?? openProbeRuntime)(
          session.identity,
          pieces.runtime.apiUrl,
          context.cfcEnforcementMode,
          {
            ...(pieces.runtime.cfcReadMaxConfidentiality !== undefined
              ? {
                cfcReadMaxConfidentiality:
                  pieces.runtime.cfcReadMaxConfidentiality,
              }
              : {}),
            ...(pieces.runtime.cfcReadOnExceed !== undefined
              ? { cfcReadOnExceed: pieces.runtime.cfcReadOnExceed }
              : {}),
          },
        );
        // No identity, no isolated runtime, and therefore no probe. Falling
        // back to the live space would re-enter the leak this exists to close
        // through the error path, so the gate abstains instead.
        if (opened === undefined) return recorded("probe-failed");
        try {
          return await runProbe(opened.pieces);
        } finally {
          // Owned here rather than by the caller, because cancellation can
          // return from the race while this is still opening, and a runtime
          // opened after the caller stopped waiting would never be closed by
          // anything the caller can still see.
          await opened.close().catch(() => {});
        }
      };
      const runProbe = async (probePieces: PiecesController) => {
        // A composed source needs its imports in the probe's space too, or
        // the compile below cannot resolve them. Same helper the live path
        // uses, pointed at the isolated runtime — which is why composed
        // patterns still get a verdict instead of degrading to "no verdict".
        const composed = composedPatternIds(program);
        if (composed.length > 0 && getPatternIndexClient !== undefined) {
          await materializeComposedPatterns({
            runtime: probePieces.runtime,
            space: probePieces.getSpace(),
            patternIds: composed,
            getClient: getPatternIndexClient,
          });
        }
        const probePattern = await compileAndSavePattern(
          probePieces.runtime,
          program,
          { space: probePieces.getSpace() },
        );
        const probeCell = await probePieces.runPersistent(
          probePattern,
          synthetic.value,
          undefined,
          { start: true },
        );
        await probePieces.runtime.settled();
        await probePieces.synced();
        const probeResult = await new PieceController(probePieces, probeCell)
          .result.getCell();
        const rendered = await renderPatternUiToHtml(
          probeResult,
          () => probePieces.runtime.idle(),
        );
        if (rendered === undefined) return discoverable("no-ui");
        // What the render means is decided by `classifyRenderedHtml`; what
        // that meaning costs is decided here. Only a default-`toString` is
        // positive evidence of a defect — the rest are absences, recorded
        // uncertified rather than condemned. The DOM itself is read and
        // discarded, and the runtime that produced it is discarded with it.
        const reason = classifyRenderedHtml(rendered.html, rendered.errors);
        return reason === "ui-rendered"
          ? discoverable(reason)
          : recorded(reason);
      };
      // One consultation of the signal, at the single exit. An abort reaches
      // this function three ways — the race interrupts it, an await it does
      // not interrupt throws, or it lands after a verdict — and all three
      // mean the same thing: the run was cancelled, so nothing is recorded.
      // Deciding that once is why there is no arm here that only one of the
      // three orderings can take.
      let outcome: Awaited<ReturnType<typeof probe>> = recorded("probe-failed");
      try {
        const work = (async () => {
          outcome = await probe();
        })();
        // Raced rather than awaited so a probe that never settles cannot hold
        // the run open; the value is not branched on, since the check below
        // covers every way the abort could have arrived.
        await raceWithAbort(work, signal);
      } catch (error) {
        // What a probe throws is the pattern's own text, which the artifact
        // keeps for the run's own failure paths and which has no reading here
        // beyond "no verdict". A defect in the GATE lands here too and reads
        // identically from outside, so its text goes to the artifact rather
        // than nowhere — a check that fails silently for its own reasons is
        // the failure this gate exists to remove.
        outcome = recorded("probe-failed", errorMessage(error));
      }
      return signal?.aborted === true ? "cancelled" : outcome;
    };
    // Source the model wrote and successfully ran is queued for the index.
    // Recording and being offered to search are separate: the default
    // requests a record, while deliberate corpus seeding may request immediate
    // discoverability. A render-gate failure always withholds discovery with
    // its own reason. A run naming a `patternId` records nothing: it ran what
    // the index already holds.
    const description = input.description?.trim();
    let publication: RunPatternPublicationReport | undefined;
    let probeThrown: string | undefined;
    // The engine hands the ledger over with the index client, in one spread,
    // so requiring it here is the same condition as requiring the client —
    // spelled twice because the type cannot say they arrive together. There is
    // deliberately no second publish path: one that skipped the ledger would
    // put back the per-iteration duplicates the ledger exists to prevent.
    if (
      patternId === undefined &&
      getPatternIndexClient !== undefined &&
      patternIndexLedger !== undefined &&
      context.patternIndexPublishEnabled === true &&
      description !== undefined && description !== ""
    ) {
      // The compile's own entry identity, which is the identity the index
      // stores a pattern under. Taken from the compiled artifact rather than
      // recomputed over the source, so it holds for a program the light
      // identity path does not model: a source composing `cf:pattern:`
      // imports folds each imported pattern's identity into the entry's.
      const entryIdentity = pieces.runtime.patternManager
        .getArtifactEntryRef(pattern)?.identity;
      // A keyless identity names a pattern only within the session that
      // minted it, so publishing under one would put an entry in the index
      // that no other runtime can ever load.
      if (
        entryIdentity === undefined ||
        PatternManager.isKeylessPatternIdentity(entryIdentity)
      ) {
        console.error(
          "run_pattern could not publish the pattern it ran: the compiled pattern carries no durable content-addressed entry identity",
        );
      } else {
        const verdict = await renderGateVerdict();
        // A cancelled gate is a cancelled run. Nothing is staged: an index
        // entry is a claim about a run that finished, and this one did not.
        if (verdict === "cancelled") {
          return cancelledOutput(
            `the pattern ran and created piece ${piece.id}, which is not undone; it was not contributed to the pattern index`,
          );
        }
        const publicationVerdict = verdict.status === "recorded" ||
            context.patternIndexPublishDiscoverable === true
          ? verdict
          : {
            ...verdict,
            status: "recorded" as const,
            reason: "recorded-automatically" as const,
          };
        publication = {
          status: "queued",
          reason: publicationVerdict.reason,
          message: PATTERN_PUBLICATION_MESSAGES[publicationVerdict.reason],
          syntheticInputsComplete: publicationVerdict.syntheticInputsComplete,
        };
        // What a probe THREW, and never what it rendered: the rendered DOM is
        // read, classified and discarded. The artifact root is readable
        // through `bash` (CT-2117), so the only defensible amount of rendered
        // content to put there is none; thrown text stays because it is the
        // class that root already holds and cannot be recovered any other way.
        probeThrown = verdict.thrown;
        {
          const request: PatternIndexPublishRequest = {
            patternId: entryIdentity,
            program: {
              main: program.main,
              files: program.files.map((file) => ({
                name: file.name,
                contents: file.contents,
              })),
            },
            description,
            hashtags: input.hashtags ?? [],
            // What the pattern was written to answer. The run's own task is
            // that request; a run carrying no task text has only the model's
            // description of what it wrote, which is the same claim in the
            // model's words.
            directQuery: context.taskText ?? description,
            argumentSchema: pattern.argumentSchema,
            resultSchema: pattern.resultSchema,
            dependencies: patternIndexDependencies(program.files),
            // Recording and surfacing are separate. Only an explicit seed
            // configuration asks search to offer a passing render immediately.
            ...(publicationVerdict.status === "recorded"
              ? {
                nonDiscoverable: {
                  reason:
                    PATTERN_DISCOVERABILITY_REASONS[publicationVerdict.reason],
                },
              }
              : { discoverable: true }),
          };
          patternIndexLedger.stage(request);
        }
      }
    }
    const outputConcerns = observedOutputs.map((one) => one.concern);
    const retainedCauses = [
      withheldRefusal?.reason,
      probeThrown,
      observedOutputCause(observedOutputs),
    ].filter(
      (text): text is string => text !== undefined,
    );
    return {
      outputId,
      status: "ok",
      resultRef,
      resultRefSchema: pattern.resultSchema,
      pieceId: piece.id,
      ...(withheld !== undefined
        ? {
          valueError: policyRefusalMessage(withheld, "release"),
          policyRefusal: withheld,
        }
        : {
          ...(value !== undefined ? { value } : {}),
          ...(linkedStringCount !== undefined ? { linkedStringCount } : {}),
          ...(valueError !== undefined ? { valueError } : {}),
        }),
      ...(rawValue !== undefined ? { rawValue } : {}),
      ...(releaseObservation !== undefined ? { releaseObservation } : {}),
      ...(releaseDecision !== undefined ? { releaseDecision } : {}),
      ...(publication !== undefined ? { patternPublication: publication } : {}),
      ...(outputConcerns.length > 0 ? { outputConcerns } : {}),
      ...(retainedCauses.length > 0
        ? { rawCauseMessage: retainedCauses.join("\n\n") }
        : {}),
    };
  },
};
