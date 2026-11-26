/**
 * The comparison of both paths, today's and the compiled one, as a standing
 * gate with two principals.
 *
 * Run from the repository root, after `cargo build --release` in
 * `base/pattern-compiler`:
 *
 * `deno run -A --no-check base/pattern-compiler/compare/both-paths.ts <results.jsonl> [--sets=hand,named,corpus] [--only=<part of a name>] [--ledger=<file>]`
 *
 * Each scenario runs on both paths under a serving loop with two principals,
 * A and B, that each hold a session (`both-paths-serving.ts`), and the runs
 * are compared after each start and each step (`both-paths-gate.ts`): which
 * events commit, what each principal reads at each member of each result,
 * the labels stored at each position, two derived checks, every error state
 * of the store, and what each step wrote. The sets of scenarios:
 *
 * - `hand`: the hand-written scenarios of `both-paths-scenarios.ts`, each
 *   with alice as A and bob as B, and again with the roles exchanged.
 * - `named`: the named scenarios of `both-paths-named.ts`, one for each
 *   construct that reads a value of a narrower scope, Z100's case, and the
 *   real Topics board.
 * - `corpus`: every module of `patterns/` whose main pattern the crate gives
 *   value code for, with the argument and the events `runner-corpus.ts`
 *   derives (`gateCorpusScenarios`). A module the harness cannot drive is
 *   skipped with its reason.
 *
 * The command prints one line for each scenario (equal, differing with the
 * count of each kind of finding the ledger does not cover, or skipped with
 * the reason) and a summary, writes each scenario's findings and the summary
 * as JSON lines to `<results.jsonl>`, and exits 0 only where no scenario has
 * a finding that no entry of the ledger (`both-paths-accepted.json`) covers
 * and no entry covers nothing. What the runtimes log goes nowhere unless
 * `BOTH_PATHS_VERBOSE` is set; the runtimes' banners go to standard error.
 *
 * `--one-principal` in front of the arguments runs the harness of one
 * principal with no serving loop and no session, `runBothPaths` below:
 * `<results.jsonl> [part of a name] [--corpus]`. The rest of this head
 * describes that harness.
 *
 * It runs one pattern on both paths with the same events, gestures and
 * principals, and compares what each path did
 * with each event: whether the handler's transaction committed, the message
 * of a refusal, what the result holds afterwards, and the claims stored at
 * each member of the result.
 *
 * Each path has a runtime of its own in the serving posture, over a storage
 * of its own, with no serving loop. Both runtimes start the pattern with
 * `Runtime.run` from the same program; the one of the compiled path has the
 * experimental option `compiledPatterns` and a compiler
 * (`runCompiledPatterns`). A scenario may start several patterns, and hand
 * a cell of one to another as its argument.
 *
 * - **A principal.** A serving loop stamps the transaction of a handler
 *   with the principal of the event. Here nothing does, so the harness
 *   stands in for the stamper on both runtimes alike: it replaces
 *   `Runtime.stampServerRun` of each with a function that, for the run of
 *   an event handler, sets the trust snapshot of the principal the step
 *   names and stamps the run as acting for it, as `SpaceServer` does for an
 *   event. A step that names no principal is stamped by no one, and its run
 *   acts for no one. This file is host code and says so: it holds no right
 *   a pattern has.
 * - **A gesture.** A step with `trustedUi` sends the event a renderer sends
 *   for a click on that surface and action, as a step of a pattern test
 *   does (`runtime/cli/lib/trusted-action-event.ts`).
 * - **The claims.** After each step the stored label envelope of the
 *   document behind each member of the result is read with
 *   `readStoredCfcMetadata`. What is compared as the claims is the
 *   integrity of each entry at or below the member that names a principal
 *   (an atom with a `kind`, which a schema's added integrity mints), and
 *   the writer claims, the UI contracts and the added integrity that the
 *   schema the envelope names declares there. Every other integrity atom of
 *   an entry is what the flow of the transaction stored, such as the atom
 *   that names the handler that transformed a value; it is compared apart,
 *   as `flow`. The identity of a module differs between the paths by
 *   construction (note 764 of `SPEC-NOTES.md`), so a writer claim is
 *   compared by the path of its binding.
 *
 * With `--corpus` in the place of the part of a name, or behind it, the
 * scenarios are those of `both-paths-corpus.ts`: one for each module of
 * `patterns/` that declares a write policy.
 */
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import type { Cell } from "../../../runtime/runner/src/cell.ts";
import { readStoredCfcMetadata } from "../../../runtime/runner/src/cfc/metadata.ts";
import { loadSchemaDocument } from "../../../runtime/runner/src/cfc/prepare.ts";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "../../../runtime/runner/src/cfc/ui-contract.ts";
import { PatternCompiler } from "../../../runtime/runner/src/compiled/compile.deno.ts";
import type { CompiledPiece } from "../../../runtime/runner/src/compiled/piece.ts";
import { runCompiledPatterns } from "../../../runtime/runner/src/compiled/run.ts";
import { stampWaveRunContext } from "../../../runtime/runner/src/executor/wave.ts";
import { resolveLocalProgram } from "../../../runtime/runner/src/harness/local-program.deno.ts";
import type { RuntimeProgram } from "../../../runtime/runner/src/harness/types.ts";
import { Runtime } from "../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../runtime/runner/src/storage/cache.deno.ts";
import { setCfcTrustSnapshot } from "../../../runtime/runner/src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../../../runtime/runner/src/storage/interface.ts";
import { corpusScenarios, gateCorpusScenarios } from "./both-paths-corpus.ts";
import {
  applyLedger,
  exitStatusOf,
  type Ledger,
  outcomeOf,
  runScenario,
  type ScenarioResult,
  staleEntries,
} from "./both-paths-gate.ts";
import { NAMED_SCENARIOS } from "./both-paths-named.ts";
import { SCENARIOS } from "./both-paths-scenarios.ts";
import type {
  CellsOf,
  GateScenario,
  GateStep,
  Roles,
} from "./both-paths-serving.ts";
import { normalize } from "./values.ts";

/** A pattern a scenario starts. */
export type ScenarioPiece = {
  /** The name the steps and the arguments of later pieces know it by. */
  name: string;
  /** The module, as a path from the repository root. */
  module: string;
  /** The export that is the pattern, where it is not the default. */
  mainExport?: string;
  /**
   * The argument, given the result cells of the pieces started before.
   * The default is the empty record.
   */
  argument?: (started: Record<string, Cell<unknown>>) => unknown;
  /**
   * The principal the transaction that starts the piece acts for, by a
   * name of the scenario. Without it the start acts for no one.
   */
  as?: string;
};

/** An event a scenario sends. */
export type ScenarioStep = {
  /** The piece whose stream takes the event: the first by default. */
  piece?: string;
  /** The member of the result that holds the stream. */
  stream: string;
  /** The payload. */
  event?: unknown;
  /** The surface and the action of the gesture, where the event is one. */
  trustedUi?: { surface: string; action: string };
  /** The principal the run acts for, by a name of the scenario. */
  as?: string;
};

/** One pattern or several, and the events sent to them. */
export type Scenario = {
  name: string;
  pieces: ScenarioPiece[];
  steps: ScenarioStep[];
  /**
   * Whether the confidentiality stored at each member of each result is
   * compared as well (`labels`).
   */
  labels?: true;
};

/** What a path stored for one member of a result. */
export type StoredClaims = {
  /** The integrity of each entry at or below the member, by its path. */
  integrity: Record<string, string[]>;
  /** The write policies the stored schema declares, by schema path. */
  policies: Record<string, string[]>;
};

/** What a path did with one step, or with the start. */
export type StepOutcome = {
  /** Whether the transaction committed. */
  committed: boolean;
  /** The first line of the error of a transaction that did not commit. */
  message?: string;
  /** What each piece's result holds afterwards, as text. */
  values: Record<string, string>;
  /** The claims stored, by piece and member (`piece.member`). */
  claims: Record<string, StoredClaims>;
  /**
   * The integrity stored that names no principal, by piece and member and
   * then by the path of its entry, where there is some.
   */
  flow: Record<string, Record<string, string[]>>;
  /**
   * The confidentiality stored, by piece and member and then by the path of
   * its entry, each clause as text, where the scenario compares it.
   */
  labels?: Record<string, Record<string, string[]>>;
};

/** What one path did with a scenario. */
export type PathOutcome = {
  /** Whether each piece ran as a compiled piece. */
  compiled: Record<string, boolean>;
  /** Why the compiler refused a program, where it did. */
  fellBack: string[];
  /** The start of each piece, in order. */
  starts: StepOutcome[];
  /** Each step, in order. */
  steps: StepOutcome[];
  /**
   * The refusals a compiled piece kept that are not the error of a
   * handler's own transaction.
   */
  otherRefusals: string[];
  /** The error that ended the run, where one did. */
  failure?: string;
};

/** One difference between the paths. */
export type Difference = {
  /** `start <n>`, `step <n>` or `run`. */
  at: string;
  /**
   * What differs: `committed`, `message`, `values`, `claims`, `flow`,
   * `labels` or `failure`.
   */
  what: string;
  today: unknown;
  compiled: unknown;
};

const repository = fromFileUrl(new URL("../../../", import.meta.url));

const text = (value: unknown): string =>
  JSON.stringify(
    value,
    (_name, member) =>
      isObjectNotArray(member)
        ? Object.fromEntries(
          Object.entries(member).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
        )
        : member,
  ) ?? "undefined";

/**
 * The first line of a message, with each identifier of an entity, of a
 * principal and of a hash replaced: the two paths name their documents
 * differently.
 */
const comparable = (message: string, names: Map<string, string>): string => {
  let line = message.split("\n")[0];
  for (const [did, name] of names) line = line.replaceAll(did, `<${name}>`);
  return line
    .replace(/of:[A-Za-z0-9_:-]+/g, "<entity>")
    .replace(/did:key:[A-Za-z0-9]+/g, "<principal>")
    .replace(/\bba[a-z0-9]{20,}\b/g, "<hash>")
    .slice(0, 300);
};

/** The policy members of an `ifc` record, each as one line. */
const policyLines = (ifc: Record<string, unknown>): string[] => {
  const bindingOf = (claim: unknown): string => {
    const named = isObjectNotArray(claim) &&
        isObjectNotArray(claim.__ctWriterIdentityOf)
      ? claim.__ctWriterIdentityOf.path
      : undefined;
    return Array.isArray(named) ? named.join(".") : text(claim);
  };
  const lines: string[] = [];
  if (ifc.writeAuthorizedBy !== undefined) {
    lines.push(`writeAuthorizedBy ${bindingOf(ifc.writeAuthorizedBy)}`);
  }
  if (Array.isArray(ifc.writePolicyAnyOf)) {
    lines.push(
      `writePolicyAnyOf ${
        ifc.writePolicyAnyOf.map((alternative) =>
          isObjectNotArray(alternative)
            ? `${bindingOf(alternative.writeAuthorizedBy)}${
              alternative.uiContract === undefined
                ? ""
                : ` with ${text(alternative.uiContract)}`
            }`
            : text(alternative)
        ).sort().join(" | ")
      }`,
    );
  }
  if (ifc.uiContract !== undefined) {
    lines.push(`uiContract ${text(ifc.uiContract)}`);
  }
  if (ifc.addIntegrity !== undefined) {
    lines.push(`addIntegrity ${text(ifc.addIntegrity)}`);
  }
  return lines;
};

/**
 * The write policies a schema declares at and below `path`, by the path of
 * the schema node from there, with `*` for the members of an array or of a
 * record. A `$ref` into `$defs` of the document a node is in is followed,
 * and with `load` one into another schema document (`cid:<hash>#/$defs/…`),
 * which `load` gives by its hash: today's path stores the definitions of a
 * type in documents of their own. `linesOf` gives the lines of one `ifc`
 * record, the write policies by default.
 */
export const policiesOf = (
  root: unknown,
  path: readonly string[],
  load?: (hash: string) => unknown,
  linesOf: (ifc: Record<string, unknown>) => string[] = policyLines,
): Record<string, string[]> => {
  const found: Record<string, string[]> = {};
  type Defs = Record<string, unknown>;
  const defsOf = (document: unknown): Defs =>
    isObjectNotArray(document) && isObjectNotArray(document.$defs)
      ? document.$defs
      : {};
  // A node that holds a `$ref` beside other members is the definition
  // with those members in the place of its own. `defs` are the
  // definitions of the document the node is in.
  const resolved = (node: unknown, defs: Defs): [unknown, Defs] => {
    for (let hops = 0; hops < 16; hops++) {
      if (!isObjectNotArray(node) || typeof node.$ref !== "string") break;
      const ref = node.$ref;
      let definition: unknown;
      let within = defs;
      if (ref.startsWith("#/$defs/")) {
        definition = defs[ref.slice("#/$defs/".length)];
      } else if (ref.startsWith("cid:") && load !== undefined) {
        const [hash, pointer = ""] = ref.slice("cid:".length).split("#");
        const document = load(hash);
        within = defsOf(document);
        definition = pointer.startsWith("/$defs/")
          ? within[pointer.slice("/$defs/".length)]
          : document;
      }
      if (definition === undefined) return [node, defs];
      const { $ref: _, ...beside } = node;
      node = isObjectNotArray(definition)
        ? { ...definition, ...beside }
        : definition;
      defs = within;
    }
    return [node, defs];
  };
  const walk = (
    given: unknown,
    within: Defs,
    at: string,
    depth: number,
  ): void => {
    const [node, defs] = resolved(given, within);
    if (!isObjectNotArray(node) || depth > 12) return;
    // A reference that names no definition that was found is not read.
    if (typeof node.$ref === "string") return;
    if (isObjectNotArray(node.ifc)) {
      const lines = linesOf(node.ifc);
      if (lines.length > 0) found[at] = lines;
    }
    if (isObjectNotArray(node.properties)) {
      for (const [name, member] of Object.entries(node.properties)) {
        walk(member, defs, `${at}/${name}`, depth + 1);
      }
    }
    walk(node.items, defs, `${at}/*`, depth + 1);
    walk(node.additionalProperties, defs, `${at}/*`, depth + 1);
    for (const key of ["anyOf", "oneOf"] as const) {
      const branches = node[key];
      if (Array.isArray(branches)) {
        for (const branch of branches) walk(branch, defs, at, depth + 1);
      }
    }
  };
  let [node, defs] = resolved(root, defsOf(root));
  for (const step of path) {
    if (!isObjectNotArray(node)) return found;
    const properties = isObjectNotArray(node.properties) ? node.properties : {};
    [node, defs] = resolved(
      Object.hasOwn(properties, step)
        ? properties[step]
        : node.items ?? node.additionalProperties,
      defs,
    );
  }
  walk(node, defs, "", 0);
  return found;
};

/**
 * Runs `scenario` on one path and returns what it did. `programs` holds
 * the program of each piece, and `principals` the identifier of each
 * principal of the scenario by its name. With `compiler` the path is the
 * compiled one.
 */
const runPath = async (
  scenario: Scenario,
  programs: Record<string, RuntimeProgram>,
  compiler: PatternCompiler | undefined,
  principals: Map<string, string>,
): Promise<PathOutcome> => {
  const signer = await Identity.fromPassphrase("both paths");
  const space = signer.did();
  const names = new Map(
    [...principals].map(([name, did]) => [did, name] as [string, string]),
  );
  names.set(space, "space");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcFlowLabels: "persist",
    servingPosture: true,
    ...(compiler === undefined
      ? {}
      : { experimental: { compiledPatterns: true } }),
  });
  const outcome: PathOutcome = {
    compiled: {},
    fellBack: [],
    starts: [],
    steps: [],
    otherRefusals: [],
  };
  const results: Record<string, Cell<unknown>> = {};
  // The pieces whose start did not commit.
  const notStarted = new Set<string>();
  const pieces: CompiledPiece[] = [];
  // The stand-in for the stamper of a serving loop: see the head of the
  // file.
  let acting: string | undefined;
  const actAs = (
    tx: IExtendedStorageTransaction,
    actionId: string,
    eventId?: string,
  ) => {
    setCfcTrustSnapshot(tx, runtime.trustSnapshotForPrincipal(acting as never));
    stampWaveRunContext(tx, {
      actionId,
      kind: "event-handler",
      ...(eventId === undefined ? {} : { eventId }),
      acting: { user: acting },
    } as never);
  };
  const stamp = runtime.stampServerRun.bind(runtime);
  runtime.stampServerRun = (tx, info) => {
    if (info.kind !== "event-handler" || acting === undefined) {
      stamp(tx, info);
      return;
    }
    actAs(tx, info.actionId, info.eventId);
  };
  const principalOf = (name: string | undefined): string | undefined => {
    if (name === undefined) return undefined;
    const principal = principals.get(name);
    if (principal === undefined) {
      throw new Error(`The scenario names no principal \`${name}\`.`);
    }
    return principal;
  };
  if (compiler !== undefined) {
    runCompiledPatterns(runtime, {
      compile: (given) => compiler.compile(given),
      started: (piece) => pieces.push(piece),
      fellBack: (_program, reason) =>
        outcome.fellBack.push(reason.split("\n").slice(0, 3).join(" | ")),
    });
  }
  // The refusals of the compiled pieces that no step has reported.
  let reported = 0;
  const refusalsSince = (): string[] => {
    const all = pieces.flatMap((piece) => [...piece.refusals]);
    const since = all.slice(reported);
    reported = all.length;
    return since.map((refusal) => comparable(refusal, names));
  };
  /**
   * The claims stored for the member `member` of `cell`, and the other
   * integrity stored there.
   */
  const claimsOf = (
    cell: Cell<unknown>,
    member: string,
  ): {
    claims: StoredClaims;
    flow: Record<string, string[]>;
    labels: Record<string, string[]>;
  } => {
    const claims: StoredClaims = { integrity: {}, policies: {} };
    const flow: Record<string, string[]> = {};
    const labels: Record<string, string[]> = {};
    const tx = runtime.edit();
    try {
      const link = (cell.key(member as never) as Cell<unknown>).withTx(tx)
        .resolveAsCell().getAsNormalizedFullLink();
      const metadata = readStoredCfcMetadata(tx, {
        space: link.space,
        id: link.id,
        scope: link.scope,
      });
      if (metadata === undefined) return { claims, flow, labels };
      const at = link.path.map(String);
      for (const entry of metadata.labelMap.entries) {
        const path = entry.path.map(String);
        if (at.some((step, index) => path[index] !== step)) continue;
        const key = `/${path.slice(at.length).join("/")}`;
        const clauses = entry.label.confidentiality ?? [];
        if (clauses.length > 0) {
          labels[key] = clauses.map((clause) => comparable(text(clause), names))
            .sort();
        }
        for (const atom of entry.label.integrity ?? []) {
          const into = isObjectNotArray(atom) && "kind" in atom
            ? claims.integrity
            : flow;
          into[key] = [...(into[key] ?? []), comparable(text(atom), names)]
            .sort();
        }
      }
      const schema = loadSchemaDocument(tx, link.space, metadata.schemaHash);
      claims.policies = policiesOf(schema, at, (hash) => {
        try {
          return loadSchemaDocument(tx, link.space, hash);
        } catch {
          return undefined;
        }
      });
    } catch (error) {
      claims.policies = {
        "": [`not read: ${(error as Error).message.split("\n")[0]}`],
      };
    } finally {
      tx.abort();
    }
    return { claims, flow, labels };
  };
  /** What every piece holds now, and the claims stored for it. */
  const held = async (): Promise<
    Pick<StepOutcome, "values" | "claims" | "flow" | "labels">
  > => {
    const values: Record<string, string> = {};
    const claims: Record<string, StoredClaims> = {};
    const flow: StepOutcome["flow"] = {};
    const labels: NonNullable<StepOutcome["labels"]> = {};
    for (const [name, result] of Object.entries(results)) {
      let value: unknown;
      try {
        value = await result.pull();
      } catch (error) {
        value = `not read: ${(error as Error).message.split("\n")[0]}`;
      }
      values[name] = text(normalize(value));
      if (!isObjectNotArray(value)) continue;
      for (const member of Object.keys(value).sort()) {
        if (member.startsWith("$")) continue;
        const stored = claimsOf(result, member);
        claims[`${name}.${member}`] = stored.claims;
        if (Object.keys(stored.flow).length > 0) {
          flow[`${name}.${member}`] = stored.flow;
        }
        if (Object.keys(stored.labels).length > 0) {
          labels[`${name}.${member}`] = stored.labels;
        }
      }
    }
    return { values, claims, flow, ...(scenario.labels ? { labels } : {}) };
  };
  try {
    for (const piece of scenario.pieces) {
      const pattern = await runtime.patternManager.compilePattern(
        programs[piece.name],
        { space },
      );
      const result = runtime.getCell<unknown>(
        space,
        `both paths ${piece.name}`,
      );
      const argument = piece.argument?.(results) ?? {};
      const before = pieces.length;
      const tx = runtime.edit();
      acting = principalOf(piece.as);
      if (acting !== undefined) actAs(tx, `both-paths:start:${piece.name}`);
      acting = undefined;
      runtime.run(tx, pattern, argument as never, result.withTx(tx));
      const { error } = await tx.commit().settled;
      await runtime.scheduler.idleWithPendingCommits();
      results[piece.name] = result;
      if (error !== undefined) notStarted.add(piece.name);
      outcome.compiled[piece.name] = pieces.length > before;
      outcome.starts.push({
        committed: error === undefined,
        ...(error === undefined
          ? {}
          : { message: comparable(`${error.name}: ${error.message}`, names) }),
        ...await held(),
      });
      for (const refusal of refusalsSince()) {
        outcome.otherRefusals.push(refusal);
      }
    }
    for (const step of scenario.steps) {
      const of = step.piece ?? scenario.pieces[0].name;
      // An event to a stream of a piece that does not exist waits for a
      // piece that never loads, so none is sent.
      if (notStarted.has(of)) {
        outcome.steps.push({
          committed: false,
          message: "not sent: the start of the piece did not commit",
          ...await held(),
        });
        continue;
      }
      const result = results[of];
      const payload = step.event;
      const sent = step.trustedUi === undefined ? payload : {
        type: "click",
        ...(isObjectNotArray(payload) ? payload : {}),
        provenance: reviewedActionProvenance("dom", step.trustedUi),
      };
      if (step.trustedUi !== undefined) markRendererTrustedEvent(sent);
      acting = principalOf(step.as);
      const link = (result.key(step.stream as never) as Cell<unknown>)
        .resolveAsCell().getAsNormalizedFullLink();
      let status:
        | ReturnType<IExtendedStorageTransaction["status"]>
        | undefined;
      runtime.scheduler.queueEvent(
        link,
        sent,
        false,
        (tx) => status = tx.status(),
      );
      await runtime.scheduler.idleWithPendingCommits();
      acting = undefined;
      const refusals = refusalsSince();
      const failed = status?.status === "error" ? status.error : undefined;
      const message = failed === undefined
        ? status === undefined
          ? "the transaction of the handler did not end"
          : undefined
        : comparable(`${failed.name}: ${failed.message}`, names);
      outcome.steps.push({
        committed: message === undefined,
        ...(message === undefined ? {} : { message }),
        ...await held(),
      });
      for (const refusal of refusals) outcome.otherRefusals.push(refusal);
    }
  } catch (error) {
    outcome.failure = comparable(
      error instanceof Error ? `${error.name}: ${error.message}` : `${error}`,
      names,
    );
  } finally {
    for (const piece of pieces) piece.stop();
    try {
      await runtime.scheduler.idleWithPendingCommits();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  }
  return outcome;
};

/** The principals a scenario can name. */
export const PRINCIPALS = ["alice", "bob"] as const;

/** What both paths did with a scenario, and where they differ. */
export type BothPaths = {
  scenario: string;
  today: PathOutcome;
  compiled: PathOutcome;
  differences: Difference[];
};

/** The differences between what the two paths did. */
export const differencesOf = (
  today: PathOutcome,
  compiled: PathOutcome,
): Difference[] => {
  const differences: Difference[] = [];
  const compare = (
    at: string,
    a: StepOutcome | undefined,
    b: StepOutcome | undefined,
  ) => {
    for (
      const what of [
        "committed",
        "message",
        "values",
        "claims",
        "flow",
        "labels",
      ] as const
    ) {
      if (text(a?.[what]) !== text(b?.[what])) {
        differences.push({
          at,
          what,
          today: a?.[what],
          compiled: b?.[what],
        });
      }
    }
  };
  if (today.failure !== compiled.failure) {
    differences.push({
      at: "run",
      what: "failure",
      today: today.failure,
      compiled: compiled.failure,
    });
  }
  const starts = Math.max(today.starts.length, compiled.starts.length);
  for (let n = 0; n < starts; n++) {
    compare(`start ${n}`, today.starts[n], compiled.starts[n]);
  }
  const steps = Math.max(today.steps.length, compiled.steps.length);
  for (let n = 0; n < steps; n++) {
    compare(`step ${n}`, today.steps[n], compiled.steps[n]);
  }
  return differences;
};

/** Runs `scenario` on both paths with `compiler`. */
export const runBothPaths = async (
  scenario: Scenario,
  compiler: PatternCompiler,
): Promise<BothPaths> => {
  const principals = new Map<string, string>();
  for (const name of PRINCIPALS) {
    principals.set(
      name,
      (await Identity.fromPassphrase(`both paths ${name}`)).did(),
    );
  }
  const programs: Record<string, RuntimeProgram> = {};
  const resolving = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: StorageManager.emulate({
      as: await Identity.fromPassphrase("both paths"),
    }),
  });
  try {
    for (const piece of scenario.pieces) {
      programs[piece.name] = await resolveLocalProgram(
        (resolver) => resolving.harness.resolve(resolver),
        {
          main: `${repository}${piece.module}`,
          root: repository,
          ...(piece.mainExport === undefined
            ? {}
            : { mainExport: piece.mainExport }),
        },
      );
    }
  } finally {
    await resolving.dispose();
  }
  const today = await runPath(scenario, programs, undefined, principals);
  const compiled = await runPath(scenario, programs, compiler, principals);
  return {
    scenario: scenario.name,
    today,
    compiled,
    differences: differencesOf(today, compiled),
  };
};

/**
 * The command of the harness with one principal and no serving loop:
 * `--one-principal` in front of its arguments.
 */
const runOnePrincipal = async (args: string[]) => {
  const [file, ...rest] = args;
  const corpus = rest.includes("--corpus");
  const part = rest.find((argument) => argument !== "--corpus");
  if (file === undefined) {
    console.error(
      "usage: both-paths.ts <results.jsonl> [part of a name] [--corpus]",
    );
    Deno.exit(2);
  }
  const compiler = new PatternCompiler();
  const { warn, error, log } = console;
  for (const scenario of corpus ? await corpusScenarios(part) : SCENARIOS) {
    if (part !== undefined && !scenario.name.includes(part)) continue;
    // What the runtimes log while a scenario runs is not the harness's
    // output, unless `BOTH_PATHS_VERBOSE` is set.
    if (Deno.env.get("BOTH_PATHS_VERBOSE") === undefined) {
      console.warn = console.error = console.log = () => {};
    }
    let outcome: BothPaths | { scenario: string; failure: string };
    try {
      outcome = await runBothPaths(scenario, compiler);
    } catch (caught) {
      outcome = {
        scenario: scenario.name,
        failure: caught instanceof Error ? caught.message : `${caught}`,
      };
    } finally {
      Object.assign(console, { warn, error, log });
    }
    await Deno.writeTextFile(file, `${JSON.stringify(outcome)}\n`, {
      append: true,
    });
    if (!("differences" in outcome)) {
      console.log(
        `${scenario.name}: failed: ${outcome.failure.split("\n")[0]}`,
      );
      continue;
    }
    const { differences } = outcome;
    console.log(
      `${scenario.name}: ${
        differences.length === 0 ? "equal" : `${differences.length} differences`
      } (compiled: ${text(outcome.compiled.compiled)})`,
    );
    for (const difference of differences) {
      console.log(
        `  ${difference.at} ${difference.what}\n    today:    ${
          text(difference.today)
        }\n    compiled: ${text(difference.compiled)}`,
      );
    }
    for (const refusal of outcome.compiled.otherRefusals) {
      console.log(`  compiled piece kept: ${refusal}`);
    }
  }
};

/** The hand-written scenarios as scenarios of the two-principal gate. */
export const gateScenarioOf = (scenario: Scenario): GateScenario => ({
  name: scenario.name,
  pieces: scenario.pieces.map((piece, index) => ({
    name: piece.name,
    module: piece.module,
    ...(piece.mainExport === undefined ? {} : { mainExport: piece.mainExport }),
    ...(piece.as === undefined ? {} : { as: piece.as }),
    ...(piece.argument === undefined ? {} : {
      argument: ({ at }: CellsOf) =>
        piece.argument!(
          Object.fromEntries(
            scenario.pieces.slice(0, index).map((before) => [
              before.name,
              at(before.name),
            ]),
          ),
        ),
    }),
  })),
  steps: scenario.steps.map((step) => ({
    ...(step.piece === undefined ? {} : { piece: step.piece }),
    stream: step.stream,
    ...(step.event === undefined
      ? {}
      : { event: step.event as GateStep["event"] }),
    ...(step.trustedUi === undefined ? {} : { trustedUi: step.trustedUi }),
    ...(step.as === undefined ? {} : { as: step.as }),
  })),
});

/** The ledger of accepted differences. */
export const LEDGER = new URL("./both-paths-accepted.json", import.meta.url);

/** A scenario of the gate, with the roles it is run with. */
type Planned = {
  scenario: GateScenario & { unsent?: number };
  name: string;
  roles: Roles;
  skipNotCompiled?: boolean;
};

/** The sets of scenarios a full run plans. */
export const ALL_SETS = ["hand", "named", "corpus"] as const;

/** What the command of the gate was asked for. */
export type GateArguments = {
  file: string;
  sets: string[];
  /** The parts of a name `--only` lists; a scenario holding one runs. */
  only?: string[];
  ledger?: string;
  /** Whether every set runs and no `--only` narrows them. */
  full: boolean;
};

/**
 * The arguments of the command of the gate, or the reason they are refused:
 * a set no one knows, or an empty part of `--only`.
 */
export const gateArguments = (
  args: readonly string[],
): GateArguments | { refused: string } => {
  const file = args.find((argument) => !argument.startsWith("--"));
  const option = (name: string) =>
    args.find((argument) => argument.startsWith(`--${name}=`))?.slice(
      name.length + 3,
    );
  if (file === undefined) return { refused: "no results file is named" };
  const sets = (option("sets") ?? ALL_SETS.join(",")).split(",");
  const unknown = sets.filter((set) =>
    !(ALL_SETS as readonly string[]).includes(set)
  );
  if (unknown.length > 0) {
    return { refused: `no set is named ${unknown.join(", ")}` };
  }
  const listed = option("only");
  const only = listed?.split(",").map((part) => part.trim());
  if (only !== undefined && only.some((part) => part === "")) {
    return { refused: "`--only` lists an empty part" };
  }
  const ledger = option("ledger");
  return {
    file,
    sets,
    ...(only === undefined ? {} : { only }),
    ...(ledger === undefined ? {} : { ledger }),
    full: only === undefined && ALL_SETS.every((set) => sets.includes(set)),
  };
};

/** The scenarios of the gate, of the sets named, holding a part of `only`. */
const plannedScenarios = async (
  sets: readonly string[],
  only: readonly string[] | undefined,
): Promise<Planned[]> => {
  const planned: Planned[] = [];
  const holds = (name: string) =>
    only === undefined || only.some((part) => name.includes(part));
  if (sets.includes("hand")) {
    for (const scenario of SCENARIOS.map(gateScenarioOf)) {
      if (!holds(scenario.name)) continue;
      planned.push({
        scenario,
        name: scenario.name,
        roles: { alice: "A", bob: "B" },
      });
      planned.push({
        scenario,
        name: `${scenario.name} (roles exchanged)`,
        roles: { alice: "B", bob: "A" },
      });
    }
  }
  if (sets.includes("named")) {
    for (const scenario of NAMED_SCENARIOS) {
      if (!holds(scenario.name)) continue;
      planned.push({
        scenario,
        name: scenario.name,
        roles: { alice: "A", bob: "B" },
      });
    }
  }
  if (sets.includes("corpus")) {
    for (const scenario of await gateCorpusScenarios()) {
      if (!holds(scenario.name)) continue;
      planned.push({
        scenario,
        name: scenario.name,
        roles: { alice: "A", bob: "B" },
        skipNotCompiled: true,
      });
    }
  }
  return planned;
};

/** One line of the report for a scenario. */
const lineOf = (result: ScenarioResult): string => {
  const { outcome } = result;
  const time = result.ms === undefined
    ? ""
    : ` (${(result.ms / 1000).toFixed(1)} s)`;
  if (outcome.status === "skipped") {
    return `${result.scenario}: skipped: ${outcome.reason}`;
  }
  const accepted =
    result.findings.filter((finding) => finding.acceptedBy !== undefined)
      .length;
  const unsent = result.unsent === undefined
    ? ""
    : `, ${result.unsent} events not sendable`;
  if (outcome.status === "equal") {
    return `${result.scenario}: equal${
      accepted === 0 ? "" : ` (${accepted} accepted)`
    }${unsent}${time}`;
  }
  return `${result.scenario}: differing: ${
    Object.entries(outcome.counts).map(([kind, n]) => `${kind} ${n}`).join(", ")
  }${accepted === 0 ? "" : ` (${accepted} accepted)`}${unsent}${time}`;
};

/** The command of the two-principal gate. */
const runGate = async (args: string[]): Promise<number> => {
  const parsed = gateArguments(args);
  if ("refused" in parsed) {
    console.error(
      `${parsed.refused}\nusage: both-paths.ts <results.jsonl> [--sets=hand,named,corpus] [--only=<part of a name>[,<part>...]] [--ledger=<file>]`,
    );
    return 2;
  }
  const { file, sets, only, full } = parsed;
  const ledgerFile = parsed.ledger ?? fromFileUrl(LEDGER);
  const ledger = JSON.parse(await Deno.readTextFile(ledgerFile)) as Ledger;
  const covered = ledger.entries.map(() => 0);
  const compiler = new PatternCompiler();
  const planned = await plannedScenarios(sets, only);
  await Deno.writeTextFile(file, "");
  const { warn, error, log, info, debug } = console;
  const results: ScenarioResult[] = [];
  const began = performance.now();
  for (const { scenario, name, roles, skipNotCompiled } of planned) {
    // What the runtimes log while a scenario runs is not the gate's output,
    // unless `BOTH_PATHS_VERBOSE` is set.
    if (Deno.env.get("BOTH_PATHS_VERBOSE") === undefined) {
      console.warn =
        console.error =
        console.log =
        console.info =
        console.debug =
          () => {};
    }
    let result: ScenarioResult;
    try {
      const { runs: _, ...ran } = await runScenario(
        { ...scenario, name },
        { roles, compiler, ...(skipNotCompiled ? { skipNotCompiled } : {}) },
      );
      result = ran;
    } catch (caught) {
      result = {
        scenario: name,
        outcome: { status: "differing", counts: { failure: 1 } },
        findings: [{
          scenario: name,
          at: "run",
          kind: "failure",
          position: "harness",
          today: caught instanceof Error
            ? `${caught.message.split("\n")[0]} ${
              Deno.env.get("BOTH_PATHS_VERBOSE") === undefined
                ? ""
                : caught.stack
            }`
            : String(caught),
        }],
      };
    } finally {
      Object.assign(console, { warn, error, log, info, debug });
    }
    if (scenario.unsent !== undefined) result.unsent = scenario.unsent;
    if (result.outcome.status !== "skipped") {
      applyLedger(ledger, result.findings, covered);
      result.outcome = outcomeOf(result.findings);
    }
    results.push(result);
    console.log(lineOf(result));
    await Deno.writeTextFile(file, `${JSON.stringify(result)}\n`, {
      append: true,
    });
  }
  const ran = results.filter(({ outcome }) => outcome.status !== "skipped")
    .map(({ scenario }) => scenario);
  const stale = staleEntries(ledger, covered, ran);
  const by = (status: string) =>
    results.filter(({ outcome }) => outcome.status === status);
  const kinds: Record<string, number> = {};
  for (const result of by("differing")) {
    const { counts } = result.outcome as { counts: Record<string, number> };
    for (const [kind, n] of Object.entries(counts)) {
      kinds[kind] = (kinds[kind] ?? 0) + n;
    }
  }
  const skippedReasons: Record<string, number> = {};
  for (const result of by("skipped")) {
    const reason = (result.outcome as { reason: string }).reason.split(":")[0];
    skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
  }
  const summary = {
    summary: true,
    scenarios: results.length,
    ran: ran.length,
    equal: by("equal").length,
    differing: by("differing").length,
    skipped: by("skipped").length,
    skippedReasons,
    unexplained: kinds,
    accepted: covered.reduce((sum, n) => sum + n, 0),
    staleEntries: stale,
    seconds: Math.round((performance.now() - began) / 1000),
  };
  await Deno.writeTextFile(file, `${JSON.stringify(summary)}\n`, {
    append: true,
  });
  console.log(
    `\n${summary.scenarios} scenarios: ${summary.equal} equal, ${summary.differing} differing, ${summary.skipped} skipped, in ${summary.seconds} s`,
  );
  for (const [reason, n] of Object.entries(skippedReasons)) {
    console.log(`  skipped ${n}: ${reason}`);
  }
  for (const [kind, n] of Object.entries(kinds)) {
    console.log(`  unexplained ${kind}: ${n}`);
  }
  for (const entry of stale) {
    console.log(
      `  a ledger entry covers nothing: ${entry.scenario} ${entry.step} ${entry.position} ${entry.kind}`,
    );
  }
  if (summary.ran === 0) console.log("  no scenario ran");
  if (
    full && ledger.fullRun !== undefined &&
    (summary.scenarios < ledger.fullRun.scenarios ||
      summary.ran < ledger.fullRun.ran)
  ) {
    console.log(
      `  a full run must plan ${ledger.fullRun.scenarios} scenarios and run ${ledger.fullRun.ran}; this one planned ${summary.scenarios} and ran ${summary.ran}`,
    );
  }
  return exitStatusOf(
    results.map(({ outcome }) => outcome),
    stale,
    full ? ledger.fullRun : undefined,
  );
};

if (import.meta.main) {
  if (Deno.args[0] === "--one-principal") {
    await runOnePrincipal(Deno.args.slice(1));
  } else {
    Deno.exit(await runGate(Deno.args));
  }
}
