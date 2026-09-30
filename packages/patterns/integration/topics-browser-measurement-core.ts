/**
 * The decisions behind `topics-browser-measurement.ts` that need no browser:
 * locating a lift in its authored source, reading a lift's compiled text from
 * an emitted module, deciding whether a lift's module ran, requiring that the
 * board runs the program compiled from the sources read, without coverage
 * instrumentation, and with each lift's preview equal to its compiled text,
 * reading timing deltas and the worker's run count, and ending a sampling after
 * its operation. Its only imports are the TypeScript parser and a pure
 * Markdown helper, so a plain `deno test` exercises all of it.
 */

import ts from "typescript";
import { backtickQuote } from "@commonfabric/utils/markdown";

/** A position in authored source: line 1-based, column 0-based. */
export interface SourcePosition {
  /** Authored line, 1-based. */
  readonly line: number;

  /** Authored column, 0-based. */
  readonly col: number;
}

/** A lift measured separately, named by its binding. */
export interface TopicsLift {
  /** Binding name of the module-scope `lift()` declaration. */
  readonly name: string;

  /** Declaring module, relative to the program root. */
  readonly module: string;

  /** Whether the lift produces the board's pivot or reads it per topic. */
  readonly role: "producer" | "consumer";
}

/** A named lift located in the sources the board was deployed from. */
export interface TopicsLiftSite extends TopicsLift {
  /** `/<module>:<line>:<col>`, which is how a run's `src` ends. */
  readonly site: string;
}

/** A located lift together with its text as the board's compiler emits it. */
export interface CompiledTopicsLift extends TopicsLiftSite {
  /** The lift's compiled function, whose `toString()` a preview begins. */
  readonly compiledText: string;
}

/** One timing key's samples accumulated over an operation. */
export interface TimingRow {
  /**
   * `<logger>/<key>`, with each all-digit segment written as `*` so that
   * per-batch and per-mount keys add up to one row.
   */
  readonly key: string;

  /** Samples recorded over the operation. */
  readonly count: number;

  /** Their summed duration. */
  readonly totalMs: number;
}

/** One thread's timing statistics as `[count, totalTime]` by `<logger>/<key>`. */
export type TimingSnapshot = Readonly<
  Record<string, readonly [count: number, totalTime: number]>
>;

/**
 * The key under which the worker's `scheduler` logger reports the span
 * `runSchedulerAction` times around each action run, beside that span's
 * `…/run/action` and `…/run/commit` children.
 */
export const WORKER_RUN_TIMING_KEY = "scheduler/scheduler/run";

/**
 * How many characters of an implementation's `toString()` the runner keeps as
 * the preview a graph snapshot reports.
 */
export const PREVIEW_LENGTH = 200;

/** The call pattern coverage instrumentation writes before each statement. */
export const COVERAGE_HIT_CALL = "__cfPatternCoverage?.hit(";

/** Matches a run's `src`: the module identity, then `/<path>:<line>:<col>`. */
const SRC_PATTERN = /^cf:module\/([^/]+)(\/.+:\d+:\d+)$/;

/**
 * Returns where the first argument of `name`'s `const <name> = lift(...)`
 * declaration starts in `text`. Where the declaration is written
 * `lift(<function>)`, that argument is the function, and its position is the
 * one the transformer records for a hoisted builder and the runtime reports in
 * each run's `src`. Where it is written `lift(<schema>, <function>)`, the
 * first argument is the schema, so the position returned is the schema's and
 * not the one the runs carry. `text` is parsed as TSX, so declaration-shaped
 * text in a string, a comment, a template literal, or a regular expression is
 * not a declaration, and a comment between the call's parenthesis and the
 * first argument is not part of it.
 *
 * @throws If `text` holds no such declaration or more than one; `source` names
 *   the text in the message.
 */
export function locateLift(
  text: string,
  name: string,
  source = "the source",
): SourcePosition {
  const parsed = parse(text, source, ts.ScriptKind.TSX);
  const found = liftArguments(
    parsed,
    name,
    (callee) => ts.isIdentifier(callee) && callee.text === "lift",
  );
  if (found.length !== 1) {
    throw new Error(
      `Expected one \`const ${name} = lift(<function>)\` declaration in ` +
        `${source}, found ${found.length}`,
    );
  }
  const { line, character } = parsed.getLineAndCharacterOfPosition(
    found[0].getStart(parsed),
  );
  return { line: line + 1, col: character };
}

/**
 * Returns the function the compiled module `js` passes to the lift declared as
 * `const <name> = (0, <alias>.lift)(<function>, ...)`, the form the compiler
 * emits for an authored `const <name> = lift(<function>)`. The text is what the
 * function's `toString()` returns, so a running action's preview is its first
 * {@link PREVIEW_LENGTH} characters. `js` is parsed as JavaScript, so a
 * bracket, a declaration, or a `/` inside a string, a template literal, a
 * regular expression, or a comment is read as part of that literal or comment.
 *
 * @throws If `js` holds no such declaration or more than one; `source` names
 *   the module in the message.
 */
export function compiledLiftText(
  js: string,
  name: string,
  source = "the compiled module",
): string {
  const parsed = parse(js, source, ts.ScriptKind.JS);
  const found = liftArguments(parsed, name, isCompiledLiftCallee);
  if (found.length !== 1) {
    throw new Error(
      `Expected one compiled \`const ${name} = (0, <alias>.lift)(<function>` +
        `, ...)\` declaration in ${source}, found ${found.length}`,
    );
  }
  return js.slice(found[0].getStart(parsed), found[0].getEnd());
}

/** Splits a run's `src` into module identity and site, if it has that form. */
export function parseSrc(
  src: string,
): { identity: string; site: string } | undefined {
  const match = SRC_PATTERN.exec(src);
  return match ? { identity: match[1], site: match[2] } : undefined;
}

/**
 * Returns, by site, whether each lift's module ran according to `srcs`, the
 * `src` values of actions seen around an operation.
 *
 * A lift's module has not started when no `src` names `/<module>`. The lift is
 * then reported `false` only if no `src` names its module's file under any
 * other path either, so a lift that ran where its site was not resolved fails
 * rather than reading as zero runs. A `src` naming `/<module>` under another
 * root fails whether or not `/<module>` runs, since that copy's runs would be
 * counted as another lift's.
 *
 * @throws If a `src` names the module's file as described above, including in
 *   a form {@link parseSrc} does not accept; if the module runs as more than
 *   one version; or if it runs and holds no action at the lift's site.
 */
export function liftRunningStates(
  lifts: readonly TopicsLiftSite[],
  srcs: Iterable<string>,
): Map<string, boolean> {
  const sites = new Set<string>();
  const identitiesByModule = new Map<string, Set<string>>();
  const unparsed: string[] = [];
  for (const src of srcs) {
    const parsed = parseSrc(src);
    if (parsed === undefined) {
      unparsed.push(src);
      continue;
    }
    sites.add(parsed.site);
    const module = moduleOf(parsed.site);
    const identities = identitiesByModule.get(module) ?? new Set();
    identities.add(parsed.identity);
    identitiesByModule.set(module, identities);
  }
  const modules = [...identitiesByModule.keys()];
  const states = new Map<string, boolean>();
  for (const lift of lifts) {
    const expected = `/${lift.module}`;
    const file = `/${lift.module.split("/").at(-1)}`;
    const copies = [
      ...modules.filter((module) =>
        module !== expected && module.endsWith(expected)
      ),
      ...unparsed.filter((src) => src.includes(expected)),
    ];
    if (copies.length > 0) {
      throw new Error(
        `\`${lift.name}\` was resolved in \`${expected}\`, but that module ` +
          `also runs as ${copies.map((path) => `\`${path}\``).join(", ")}`,
      );
    }
    const identities = identitiesByModule.get(expected);
    if (identities === undefined) {
      const namings = [
        ...modules.filter((module) => module.endsWith(file)),
        ...unparsed.filter((src) => src.includes(file)),
      ];
      if (namings.length > 0) {
        throw new Error(
          `\`${lift.name}\` was resolved in \`${expected}\`, which has not ` +
            `started, but its file runs as ${
              namings.map((path) => `\`${path}\``).join(", ")
            }`,
        );
      }
      states.set(lift.site, false);
      continue;
    }
    if (identities.size > 1) {
      throw new Error(
        `\`${expected}\` runs as ${identities.size} module versions, so ` +
          `\`${lift.name}\` cannot be attributed by position`,
      );
    }
    if (!sites.has(lift.site)) {
      throw new Error(
        `\`${lift.name}\` resolves to \`${lift.site}\`, but no action of ` +
          `the running \`${expected}\` is at that position: the lift built ` +
          `no action the operation saw, or its declaration is not where the ` +
          `runtime records the lift's position`,
      );
    }
    states.set(lift.site, true);
  }
  return states;
}

/**
 * Fails a sample taken on a board running a Topics module other than the one
 * compiled from the sources read. `identities` holds the content identity of
 * each compiled Topics module by `/<module>`; `srcs` are the `src` values of
 * actions seen around the operation, of which one in the form
 * {@link parseSrc} accepts names the identity its module runs under, and one
 * of any other form is skipped. A module no `src` names is not checked, since
 * nothing ran from it.
 *
 * @throws If `identities` lacks a lift's module, or a `src` naming a module in
 *   `identities` carries another identity.
 */
export function requireSameProgram(
  lifts: readonly TopicsLift[],
  identities: ReadonlyMap<string, string>,
  srcs: Iterable<string>,
): void {
  const running = new Map<string, Set<string>>();
  for (const src of srcs) {
    const parsed = parseSrc(src);
    if (parsed === undefined) continue;
    const module = moduleOf(parsed.site);
    const seen = running.get(module) ?? new Set();
    seen.add(parsed.identity);
    running.set(module, seen);
  }
  for (const lift of lifts) {
    if (!identities.has(`/${lift.module}`)) {
      throw new Error(
        `The program compiled from the sources read has no module ` +
          `\`/${lift.module}\``,
      );
    }
  }
  for (const [module, compiled] of identities) {
    for (const identity of running.get(module) ?? []) {
      if (identity !== compiled) {
        throw new Error(
          `\`${module}\` runs under identity \`${identity}\`, but the ` +
            `sources read compile it to identity \`${compiled}\`: the board ` +
            `does not run the program the sources read`,
        );
      }
    }
  }
}

/**
 * Fails a sample taken on a page whose worker holds a pattern coverage
 * collector. Coverage instrumentation writes a hit call before each statement
 * of every lift, so no preview could equal the uninstrumented compiled text.
 *
 * @throws If `collecting` is true.
 */
export function requireNoCoverageCollector(collecting: boolean): void {
  if (collecting) {
    throw new Error(
      "The page's worker collects pattern coverage, whose instrumentation " +
        "rewrites every lift's code: measure on a page without coverage",
    );
  }
}

/**
 * Fails a sample whose running implementations carry pattern coverage
 * instrumentation. `previews` are the implementation previews the graph
 * reports, which is what a lift's compiled text is compared against, so this
 * reads the instrumentation off the running code rather than off the page's
 * collector.
 *
 * @throws If a preview holds {@link COVERAGE_HIT_CALL}.
 */
export function requireUninstrumentedPreviews(
  previews: Iterable<string>,
): void {
  for (const preview of previews) {
    if (preview.includes(COVERAGE_HIT_CALL)) {
      throw new Error(
        "A running implementation holds pattern coverage instrumentation, " +
          `which rewrites every lift's code: \`${preview.split("\n")[0]}\``,
      );
    }
  }
}

/**
 * Returns, by site, the preview of the implementation running at each running
 * lift's site, after requiring that every preview found there equals the first
 * {@link PREVIEW_LENGTH} characters of the lift's compiled text. `actions` are
 * graph snapshots' previews by `src`; `running` is {@link liftRunningStates}'s
 * result.
 *
 * @throws If a running lift's site holds no action with a preview in any of
 *   `actions`, which happens when the lift's only actions ran and were removed
 *   between snapshots, or if a preview there differs from the compiled text;
 *   that message names the lift and quotes both texts from their first
 *   difference.
 */
export function confirmLiftImplementations(
  lifts: readonly CompiledTopicsLift[],
  actions: readonly Readonly<Record<string, readonly string[]>>[],
  running: ReadonlyMap<string, boolean>,
): Map<string, string> {
  const previews = new Map<string, Set<string>>();
  for (const snapshot of actions) {
    for (const [src, found] of Object.entries(snapshot)) {
      const site = parseSrc(src)?.site;
      if (site === undefined) continue;
      const atSite = previews.get(site) ?? new Set();
      for (const preview of found) atSite.add(preview);
      previews.set(site, atSite);
    }
  }
  const confirmed = new Map<string, string>();
  for (const lift of lifts) {
    if (running.get(lift.site) !== true) continue;
    const atSite = [...(previews.get(lift.site) ?? [])];
    if (atSite.length === 0) {
      throw new Error(
        `\`${lift.name}\` resolves to \`${lift.site}\`, but no action in a ` +
          `graph snapshot there shows its implementation to confirm it by`,
      );
    }
    const expected = lift.compiledText.slice(0, PREVIEW_LENGTH);
    const other = atSite.find((preview) => preview !== expected);
    if (other !== undefined) {
      const at = firstDifference(other, expected);
      throw new Error(
        `\`${lift.name}\` at \`${lift.site}\` runs an implementation that ` +
          `differs from its compiled text at character ${at}: running ` +
          `${backtickQuote(JSON.stringify(other.slice(at, at + 40)))}, ` +
          `compiled ${
            backtickQuote(JSON.stringify(expected.slice(at, at + 40)))
          }`,
      );
    }
    confirmed.set(lift.site, expected);
  }
  return confirmed;
}

/**
 * Fails a sample whose runs cannot be attributed to lifts by position. `srcs`
 * are the source locations of the runs that carried a read sample and a source
 * location to carry; a run whose marker had none is counted by the caller and
 * left out of `srcs`. `running` is {@link liftRunningStates}'s result. Every
 * sample is taken on a page showing the board, so a producer lift's module that
 * is not running means the positions read say nothing about the runs, not that
 * the producer ran nothing.
 *
 * @throws If `srcs` is not empty and none of them is in the form
 *   {@link parseSrc} accepts, or if a producer lift is not running.
 */
export function requireAttributableRuns(
  lifts: readonly TopicsLiftSite[],
  running: ReadonlyMap<string, boolean>,
  srcs: readonly string[],
): void {
  if (srcs.length > 0 && srcs.every((src) => parseSrc(src) === undefined)) {
    throw new Error(
      `Runs with a read sample carried no source location to attribute them ` +
        `by: ${srcs.map((src) => `\`${src}\``).join(", ")}`,
    );
  }
  for (const lift of lifts) {
    if (lift.role === "producer" && running.get(lift.site) !== true) {
      throw new Error(
        `\`${lift.name}\`'s module \`/${lift.module}\` is not running, but a ` +
          `sample is taken on a page showing the board`,
      );
    }
  }
}

/** What a measured sample's runs may be attributed to lifts by. */
export interface SampledLifts {
  /** Whether each lift's module ran, by site. */
  readonly running: ReadonlyMap<string, boolean>;

  /** Each running lift's confirmed implementation preview, by site. */
  readonly implementations: ReadonlyMap<string, string>;
}

/**
 * Decides what a measured sample's runs may be attributed to, and fails the
 * sample when they may not be attributed at all. `actions` are the graph
 * snapshots' implementation previews by `src`, taken before and after the
 * operation; `runSrcs` are the source locations of the runs that carried a
 * read sample and a source location to carry.
 *
 * The checks the attribution rests on all run here, over the `src` values of
 * the snapshots and of the runs together: the board runs the program the
 * sources read compile to, each lift's module runs as one version and holds an
 * action at the lift's position, the runs carry positions to attribute them
 * by, no running implementation is instrumented for coverage, and each running
 * lift's implementation is the one its compiled text names.
 *
 * @throws Whatever {@link requireSameProgram}, {@link liftRunningStates},
 *   {@link requireAttributableRuns}, {@link requireUninstrumentedPreviews}, or
 *   {@link confirmLiftImplementations} throws, each message naming its cause.
 */
export function confirmSampledLifts(
  lifts: readonly CompiledTopicsLift[],
  identities: ReadonlyMap<string, string>,
  actions: readonly Readonly<Record<string, readonly string[]>>[],
  runSrcs: readonly string[],
): SampledLifts {
  const srcs = [
    ...actions.flatMap((snapshot) => Object.keys(snapshot)),
    ...runSrcs,
  ];
  requireSameProgram(lifts, identities, srcs);
  const running = liftRunningStates(lifts, srcs);
  requireAttributableRuns(lifts, running, runSrcs);
  requireUninstrumentedPreviews(
    actions.flatMap((snapshot) => Object.values(snapshot).flat()),
  );
  return {
    running,
    implementations: confirmLiftImplementations(lifts, actions, running),
  };
}

/**
 * Returns the timing recorded between two snapshots of one thread, joining
 * keys that differ only in an all-digit segment and dropping keys whose last
 * segment is in `exclude`, slowest total first.
 */
export function timingDelta(
  before: TimingSnapshot,
  after: TimingSnapshot,
  exclude: ReadonlySet<string> = new Set(),
): TimingRow[] {
  const rows = new Map<string, { count: number; totalMs: number }>();
  for (const [key, [count, totalTime]] of Object.entries(after)) {
    const [countBefore, totalBefore] = before[key] ?? [0, 0];
    const segments = key.split("/");
    if (count <= countBefore || exclude.has(segments.at(-1)!)) continue;
    const joined = segments.map((segment) =>
      /^\d+$/.test(segment) ? "*" : segment
    ).join("/");
    const row = rows.get(joined) ?? { count: 0, totalMs: 0 };
    row.count += count - countBefore;
    row.totalMs += totalTime - totalBefore;
    rows.set(joined, row);
  }
  return [...rows.entries()]
    .map(([key, row]) => ({ key, ...row }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/**
 * Returns how many action runs the worker's scheduler timed between two
 * snapshots of its timing, under {@link WORKER_RUN_TIMING_KEY}. Runs that
 * overlap share that span's one timer, and only the first to end is recorded,
 * so the count is a lower bound; a run completing at all records at least one.
 *
 * @throws If `after` has no such key, which would make every count zero.
 */
export function workerRunCount(
  before: TimingSnapshot,
  after: TimingSnapshot,
): number {
  const counted = after[WORKER_RUN_TIMING_KEY];
  if (counted === undefined) {
    throw new Error(
      `The worker's timing has no \`${WORKER_RUN_TIMING_KEY}\` key to count ` +
        `runs by`,
    );
  }
  return counted[0] - (before[WORKER_RUN_TIMING_KEY]?.[0] ?? 0);
}

/**
 * Runs `run`, then `stop` whether or not `run` succeeded, and returns both
 * results.
 *
 * @throws `run`'s error when only `run` fails, `stop`'s error when only `stop`
 *   fails, and an `AggregateError` holding `run`'s error and then `stop`'s
 *   when both fail.
 */
export async function runThenStop<T, S>(
  run: () => Promise<T>,
  stop: () => Promise<S>,
): Promise<{ value: T; stopped: S }> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await run() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  let stopped: S;
  try {
    stopped = await stop();
  } catch (stopError) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, stopError],
        "The operation failed, and stopping its sampling failed after it",
      );
    }
    throw stopError;
  }
  if (!outcome.ok) throw outcome.error;
  return { value: outcome.value, stopped };
}

/** Helper for the decisions above, which returns a site's module path. */
function moduleOf(site: string): string {
  return site.replace(/:\d+:\d+$/, "");
}

/**
 * Helper for {@link confirmLiftImplementations}, which returns the index of
 * the first character where `a` and `b` differ, or the shorter one's length.
 */
function firstDifference(a: string, b: string): number {
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  return at;
}

//
// Parsing
//

/**
 * Helper for the lookups above, which parses `text` as `kind` under `source`'s
 * name. The parser recovers from a syntax error rather than throwing, so text
 * that does not parse as a whole module yields the declarations it could read;
 * a declaration lost that way is reported as one not found.
 */
function parse(
  text: string,
  source: string,
  kind: ts.ScriptKind,
): ts.SourceFile {
  return ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true, kind);
}

/**
 * Helper for the lookups above, which returns the first argument of every
 * `const <name> = <callee>(...)` declaration in `parsed` whose callee
 * `isLift` accepts, in source order. A declaration whose call has no argument
 * is not one of them.
 */
function liftArguments(
  parsed: ts.SourceFile,
  name: string,
  isLift: (callee: ts.Expression) => boolean,
): ts.Expression[] {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === name && node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      isLift(node.initializer.expression) &&
      node.initializer.arguments.length > 0
    ) {
      found.push(node.initializer.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return found;
}

/**
 * Helper for {@link compiledLiftText}, which returns whether `callee` is the
 * `(0, <alias>.lift)` the compiler emits where the authored source calls an
 * imported `lift`. The comma expression's left operand has to be the literal
 * `0`, so a call that evaluates anything else before reading the same property
 * is not one of these.
 */
function isCompiledLiftCallee(callee: ts.Expression): boolean {
  if (!ts.isParenthesizedExpression(callee)) return false;
  const comma = callee.expression;
  return ts.isBinaryExpression(comma) &&
    comma.operatorToken.kind === ts.SyntaxKind.CommaToken &&
    ts.isNumericLiteral(comma.left) && comma.left.text === "0" &&
    ts.isPropertyAccessExpression(comma.right) &&
    ts.isIdentifier(comma.right.expression) &&
    comma.right.name.text === "lift";
}
