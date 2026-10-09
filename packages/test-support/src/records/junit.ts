/**
 * JUnit ingestion: turns the XML that `deno test --junit-path` (or the
 * pattern-unit synthesizer) writes into test records. Deno emits container
 * testcases — one per describe level and one per test or step that runs
 * steps, in framework-named testsuites, with overlapping times and
 * aggregated failures. A container is a case some other case's name is
 * inside, and it is recorded only where it says something the cases inside
 * it do not.
 * Classnames carry a usable source file only on file-level suites, as a
 * path relative to the test process's working directory; the caller maps
 * that to a repository path with `filePrefix`. For everything else the
 * file comes from `fileByName`, the map the registration preload captured
 * while the tests were registering.
 */

import { type TestIdentity, type TestRecord } from "./schema.ts";
import {
  enclosingNames,
  fileForName,
  MACHINERY_MODULE_SUFFIXES,
} from "./registration.ts";

/** One parsed `<testcase>`. */
export interface JUnitCase {
  suite: string;
  name: string;
  classname?: string;
  timeSeconds?: number;
  outcome: "pass" | "fail" | "skip";

  /** The `message` of the case's failure, where it failed and gave one. */
  failure?: string;
}

export class JUnitParseError extends Error {}

interface Tag {
  kind: "open" | "close" | "selfclose";
  name: string;
  attributes: Record<string, string>;
}

const NAME_CHARS = /[^\s=/>]/;

function decodeEntities(text: string): string {
  return text.replace(
    /&(amp|lt|gt|quot|apos|#x[0-9A-Fa-f]+|#[0-9]+);/g,
    (whole, entity: string) => {
      switch (entity) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default: {
          const code = entity.startsWith("#x")
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
          if (!Number.isFinite(code)) return whole;
          return String.fromCodePoint(code);
        }
      }
    },
  );
}

/**
 * Scans the XML for tags, ignoring text content, comments, CDATA sections,
 * and processing instructions. Quoted attribute values may contain ">".
 */
function* scanTags(xml: string): Generator<Tag> {
  let i = 0;
  while (i < xml.length) {
    const open = xml.indexOf("<", i);
    if (open < 0) return;
    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open);
      if (end < 0) {
        throw new JUnitParseError("unterminated processing instruction");
      }
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open);
      if (end < 0) throw new JUnitParseError("unterminated comment");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open);
      if (end < 0) throw new JUnitParseError("unterminated CDATA section");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<!", open)) {
      const end = xml.indexOf(">", open);
      if (end < 0) throw new JUnitParseError("unterminated declaration");
      i = end + 1;
      continue;
    }
    if (xml.startsWith("</", open)) {
      const end = xml.indexOf(">", open);
      if (end < 0) throw new JUnitParseError("unterminated closing tag");
      yield {
        kind: "close",
        name: xml.slice(open + 2, end).trim(),
        attributes: {},
      };
      i = end + 1;
      continue;
    }
    let j = open + 1;
    let name = "";
    while (j < xml.length && NAME_CHARS.test(xml[j]!)) {
      name += xml[j]!;
      j++;
    }
    if (name.length === 0) {
      throw new JUnitParseError(`tag with no name at offset ${open}`);
    }
    const attributes: Record<string, string> = {};
    for (;;) {
      while (j < xml.length && /\s/.test(xml[j]!)) j++;
      if (j >= xml.length) throw new JUnitParseError("unterminated tag");
      if (xml.startsWith("/>", j)) {
        yield { kind: "selfclose", name, attributes };
        i = j + 2;
        break;
      }
      if (xml[j] === ">") {
        yield { kind: "open", name, attributes };
        i = j + 1;
        break;
      }
      let attr = "";
      while (j < xml.length && NAME_CHARS.test(xml[j]!)) {
        attr += xml[j]!;
        j++;
      }
      while (j < xml.length && /\s/.test(xml[j]!)) j++;
      if (xml[j] !== "=") {
        throw new JUnitParseError(`attribute ${attr} of ${name} has no value`);
      }
      j++;
      while (j < xml.length && /\s/.test(xml[j]!)) j++;
      const quote = xml[j];
      if (quote !== '"' && quote !== "'") {
        throw new JUnitParseError(`unquoted value for ${attr} of ${name}`);
      }
      j++;
      const end = xml.indexOf(quote, j);
      if (end < 0) {
        throw new JUnitParseError(`unterminated value for ${attr} of ${name}`);
      }
      attributes[attr] = decodeEntities(xml.slice(j, end));
      j = end + 1;
    }
  }
}

/** Parses every testcase in a JUnit document, containers included. */
export function parseJUnit(xml: string): JUnitCase[] {
  const cases: JUnitCase[] = [];
  let suite = "";
  let current: JUnitCase | undefined;
  for (const tag of scanTags(xml)) {
    switch (tag.name) {
      case "testsuite":
        if (tag.kind !== "close") suite = tag.attributes.name ?? "";
        break;
      case "testcase": {
        if (tag.kind === "close") {
          if (current !== undefined) cases.push(current);
          current = undefined;
          break;
        }
        const name = tag.attributes.name;
        if (name === undefined) {
          throw new JUnitParseError("testcase with no name");
        }
        const parsed: JUnitCase = { suite, name, outcome: "pass" };
        if (tag.attributes.classname !== undefined) {
          parsed.classname = tag.attributes.classname;
        }
        if (tag.attributes.time !== undefined) {
          const seconds = Number(tag.attributes.time);
          // A negative duration is not a duration; the record schema
          // rejects one, so the case falls back to zero here instead of
          // producing a record every reader drops.
          if (Number.isFinite(seconds) && seconds >= 0) {
            parsed.timeSeconds = seconds;
          }
        }
        if (tag.kind === "selfclose") {
          cases.push(parsed);
        } else {
          current = parsed;
        }
        break;
      }
      case "failure":
      case "error":
        if (tag.kind !== "close" && current !== undefined) {
          current.outcome = "fail";
          const message = tag.attributes.message;
          if (message !== undefined) current.failure = message;
        }
        break;
      case "skipped":
        if (tag.kind !== "close" && current !== undefined) {
          current.outcome = "skip";
        }
        break;
      default:
        break;
    }
  }
  return cases;
}

/**
 * The failure message Deno gives a case whose only failure is that steps
 * beneath it failed. Those steps are cases of their own and carry the
 * failures themselves. A message worded any other way counts as the
 * case's own failure, so a change to Deno's wording records a failure
 * twice rather than losing one.
 */
const FAILED_STEPS = /^\d+ test steps? failed$/;

/**
 * Whether a case failed for a reason of its own rather than only because
 * something beneath it failed: a `Deno.test` body that threw after its
 * steps passed, a describe whose `afterAll` threw, a test that finished
 * while a step was still running. A failure with no message is counted as
 * the case's own.
 */
function failedOnItsOwn(testcase: JUnitCase): boolean {
  return testcase.outcome === "fail" &&
    !FAILED_STEPS.test(testcase.failure ?? "");
}

/**
 * The cases a report's records are made from. Every leaf is one. A
 * container, which is a case some other case's name is inside, is one
 * where it failed on its own account. It is also one where the caller
 * knows its name as an identity and the report gives that name to no other
 * case, with its outcome on its own account: a pass where it failed only
 * through the cases inside it. Either way it takes the time it spent
 * outside the cases directly inside it. Any other container is left out,
 * since what it reports is what the cases inside it report.
 *
 * Two cases with the same full name are both leaves where neither holds
 * anything — that is a collision for the reader side to surface. The rule
 * spans suites because Deno scatters one bdd hierarchy across three of
 * them, which carries an accepted edge: a bare `Deno.test` whose name
 * equals another file's top-level describe title is left out with the
 * container when it passes. Those two would collide as one identity
 * anyway, and the collision report is where that name clash surfaces.
 */
export function recordedCases(
  cases: readonly JUnitCase[],
  known: (name: string) => boolean = () => false,
): JUnitCase[] {
  const counts = new Map<string, number>();
  for (const { name } of cases) counts.set(name, (counts.get(name) ?? 0) + 1);
  // The seconds the cases directly inside each container took between them.
  const inside = new Map<string, number>();
  for (const testcase of cases) {
    const outer = enclosingNames(testcase.name).findLast((name) =>
      counts.has(name)
    );
    if (outer === undefined) continue;
    inside.set(outer, (inside.get(outer) ?? 0) + (testcase.timeSeconds ?? 0));
  }
  return cases.flatMap((testcase): JUnitCase[] => {
    const held = inside.get(testcase.name);
    if (held === undefined) return [testcase];
    const failed = failedOnItsOwn(testcase);
    if (
      !failed &&
      (counts.get(testcase.name) !== 1 || !known(testcase.name))
    ) {
      return [];
    }
    const own: JUnitCase = {
      ...testcase,
      timeSeconds: Math.max(0, (testcase.timeSeconds ?? 0) - held),
    };
    if (!failed) {
      own.outcome = testcase.outcome === "skip" ? "skip" : "pass";
      delete own.failure;
    }
    return [own];
  });
}

const SOURCE_SUFFIX = /\.(ts|tsx|js|jsx|mts|mjs)$/;

/**
 * Whether a classname is a plain relative source path — not a URL, not
 * absolute, not climbing out of the working directory — and so can be
 * joined onto a repository prefix. A `..` anywhere in the path climbs, and
 * a `.` segment past the leading one denormalizes the joined path, so both
 * disqualify wherever they appear.
 */
export function isRelativeSourcePath(classname: string): boolean {
  if (classname.includes("://") || classname.startsWith("ext:")) return false;
  if (classname.startsWith("/")) return false;
  if (classname.includes("\\")) return false;
  const segments = classname.split("/");
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === "..") return false;
    if (segments[i] === "." && i > 0) return false;
    if (segments[i] === "") return false;
  }
  return SOURCE_SUFFIX.test(classname);
}

export interface IngestJUnitOptions {
  kind: string;
  scope: string;

  /**
   * Repository path of the test process's working directory, "" when it ran
   * at the repository root. Joined onto relative classnames to produce
   * repository-relative file metadata; without it, files are not recorded.
   */
  filePrefix?: string;

  /**
   * The test file each `Deno.test` belongs to, as the registration
   * preload captured it. It is repository-relative already, so it needs
   * no prefix, and it overrides what the report's own classnames say —
   * which is what the wrapper the preload installs costs them.
   */
  fileByName?: ReadonlyMap<string, string>;

  /**
   * Whether the caller already knows a test, recorded from a file, as an
   * identity. A container it knows is recorded whenever it reports, rather
   * than only when it fails on its own account, so that its history holds
   * its passes too.
   */
  known?: (test: TestIdentity, file: string | undefined) => boolean;
}

/**
 * The repository path a case's classname names, or undefined when it
 * names something that is not a test file: a runtime-internal module, a
 * remote one, or the registration wrapper that displaces the file while
 * it is installed.
 */
function classnameFile(
  testcase: JUnitCase,
  filePrefix: string | undefined,
): string | undefined {
  if (filePrefix === undefined || testcase.classname === undefined) {
    return undefined;
  }
  if (!isRelativeSourcePath(testcase.classname)) return undefined;
  const cleaned = testcase.classname.replace(/^\.\//, "");
  if (MACHINERY_MODULE_SUFFIXES.some((tail) => cleaned.endsWith(tail))) {
    return undefined;
  }
  return filePrefix.length > 0
    ? `${filePrefix.replace(/\/$/, "")}/${cleaned}`
    : cleaned;
}

/** Turns a JUnit document into records of the given kind and scope. */
export function ingestJUnit(
  xml: string,
  options: IngestJUnitOptions,
): TestRecord[] {
  const cases = parseJUnit(xml);
  // Deno names a case's class after the module that registered the test,
  // so a container carries the file of every leaf beneath it and the
  // report joins itself. The preload's map is laid over that, because it
  // is what remains once the preload has wrapped `Deno.test` and every
  // classname names the preload instead.
  const files = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const testcase of cases) {
    const file = classnameFile(testcase, options.filePrefix);
    if (file === undefined) continue;
    const known = files.get(testcase.name);
    // Two files reporting one name are one identity, and which of them a
    // leaf came from is not a question this report can answer. Attributing
    // it to whichever was read last would be a guess presented as a fact,
    // so the name carries no file at all and the collision is what the
    // report tool surfaces.
    if (known !== undefined && known !== file) ambiguous.add(testcase.name);
    else files.set(testcase.name, file);
  }
  for (const name of ambiguous) files.delete(name);
  for (const [name, file] of options.fileByName ?? []) files.set(name, file);
  const identity = (name: string): TestIdentity => ({
    k: options.kind,
    s: options.scope,
    n: name,
  });
  const { known } = options;
  const leaves = recordedCases(
    cases,
    known === undefined
      ? undefined
      : (name) => known(identity(name), fileForName(name, files)),
  );
  return leaves.map((leaf) => {
    const record: TestRecord = {
      line: "record",
      test: identity(leaf.name),
      outcome: leaf.outcome,
      durationMs: Math.round((leaf.timeSeconds ?? 0) * 1000),
    };
    const file = fileForName(leaf.name, files);
    if (file !== undefined) record.file = file;
    return record;
  });
}
