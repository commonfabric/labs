/**
 * The shapes a report's fields must have, shared by the board, which refuses
 * a report that breaks them, and the triage client, which checks them again
 * before it puts a value in a Topic or prints it. Each known field is an
 * identifier or a version, never prose, so a value that passes can carry no
 * Markdown, link or line break.
 */

/** A report id: exactly 32 lowercase hex characters. */
export const REPORT_ID = /^[0-9a-f]{32}$/;

/** A report name, such as `quiet-heron-41`. */
export const REPORT_NAME = /^[a-z]+-[a-z]+-[0-9]{1,6}$/;

/** A cause, stop, connector or probe: an identifier. */
export const FIELD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A release: a commit hash, or a version such as `2026.11.18`. */
export const RELEASE =
  /^(?:[0-9a-f]{7,40}|v?[0-9]{1,6}(?:\.[0-9]{1,6}){1,3}(?:[-+][A-Za-z0-9.]{1,32})?)$/;

/** A Topic's address: `top/<n>`, or a piece id such as `of:fid1:…`. */
export const TOPIC_ADDRESS =
  /^(?:top\/[1-9][0-9]{0,8}|of:[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_-]{1,128})$/;

/** Text that looks like a link: a URL scheme, `www.`, or a script scheme. */
const LINK =
  /[A-Za-z][A-Za-z0-9+.-]*:\/\/|\bwww\.|^\s*(?:javascript|data|vbscript|file|mailto):/i;

/** The kinds a report may be. */
export const REPORT_KINDS: readonly string[] = ["broke", "wish"];

/** The most characters a report's `words` may hold. */
export const MAX_WORDS = 4000;

/** The longest a report's name may be. */
export const MAX_NAME = 64;

/** The most characters `structured` may hold, written as JSON. */
export const MAX_STRUCTURED = 64 * 1024;

/** The most entries `structured.commands` may hold. */
export const MAX_COMMANDS = 200;

/** The most entries `structured.failingProbes` may hold. */
export const MAX_PROBES = 50;

/** A refusal: a stable code and a reason. */
export interface Refusal {
  code: string;
  reason: string;
}

/** `value` when it is a string matching `shape`, else `undefined`. */
export function checked(value: unknown, shape: RegExp): string | undefined {
  return typeof value === "string" && shape.test(value) ? value : undefined;
}

/** Whether `value` is a string matching `shape`. */
export function matches(value: unknown, shape: RegExp): boolean {
  return checked(value, shape) !== undefined;
}

/** Whether `value`, or any key or string inside it, looks like a link. */
function holdsLink(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (typeof value === "string") return LINK.test(value);
  if (Array.isArray(value)) {
    return value.some((item) => holdsLink(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([key, item]) =>
      LINK.test(key) || holdsLink(item, depth + 1)
    );
  }
  return false;
}

/** The fields of a plain object, or `undefined` for anything else. */
function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

/**
 * Why a report's `structured` part is refused, or `undefined` when it is
 * accepted. Fields not named here are kept unchecked, beyond holding no link
 * and fitting the size limit.
 */
export function structuredRefusal(structured: unknown): Refusal | undefined {
  const fields = fieldsOf(structured);
  if (
    fields === undefined || typeof fields.source !== "string" ||
    !fields.source.trim()
  ) {
    return { code: "missing-source", reason: "structured.source is required" };
  }
  if (!matches(fields.source, FIELD)) {
    return { code: "bad-source", reason: "structured.source is malformed" };
  }
  if ((JSON.stringify(structured) ?? "").length > MAX_STRUCTURED) {
    return {
      code: "structured-too-large",
      reason: `structured must be at most ${MAX_STRUCTURED} characters as JSON`,
    };
  }
  if (holdsLink(structured)) {
    return {
      code: "link-in-structured",
      reason: "structured must not hold a link",
    };
  }
  if (fields.want !== undefined) {
    const want = fieldsOf(fields.want);
    if (
      want === undefined ||
      (want.cause !== undefined && !matches(want.cause, FIELD)) ||
      (want.stop !== undefined && !matches(want.stop, FIELD))
    ) {
      return {
        code: "bad-want",
        reason: "want.cause or want.stop is malformed",
      };
    }
  }
  if (fields.cfs !== undefined) {
    const cfs = fieldsOf(fields.cfs);
    if (
      cfs === undefined ||
      (cfs.release !== undefined && !matches(cfs.release, RELEASE))
    ) {
      return { code: "bad-release", reason: "cfs.release is malformed" };
    }
  }
  if (fields.commands !== undefined) {
    if (!Array.isArray(fields.commands)) {
      return { code: "bad-commands", reason: "commands must be a list" };
    }
    if (fields.commands.length > MAX_COMMANDS) {
      return {
        code: "too-many-commands",
        reason: `commands may hold at most ${MAX_COMMANDS} entries`,
      };
    }
  }
  if (fields.failingProbes !== undefined) {
    const probes = fields.failingProbes;
    if (!Array.isArray(probes)) {
      return { code: "bad-probe", reason: "failingProbes must be a list" };
    }
    if (probes.length > MAX_PROBES) {
      return {
        code: "too-many-probes",
        reason: `failingProbes may hold at most ${MAX_PROBES} entries`,
      };
    }
    for (const entry of probes) {
      const probe = fieldsOf(entry);
      if (
        probe === undefined || !matches(probe.connector, FIELD) ||
        !matches(probe.probe, FIELD)
      ) {
        return { code: "bad-probe", reason: "a failing probe is malformed" };
      }
    }
  }
  return undefined;
}

/** An `addReport` request as a refusal reads it: any field may be missing
 * or of the wrong type. */
export interface AddReportRequest {
  agentName?: unknown;
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  words?: unknown;
  structured?: unknown;
}

/**
 * Why `addReport` refuses `event` on a board already holding reports with
 * the ids `taken`, as a code and a reason, or `undefined` when it accepts it.
 */
export function addReportRefusal(
  event: AddReportRequest,
  taken: readonly string[],
): Refusal | undefined {
  const name = typeof event.name === "string" ? event.name.trim() : "";
  const structured = event.structured;
  if (typeof event.agentName !== "string" || !event.agentName.trim()) {
    return { code: "unsigned", reason: "agentName must be non-blank" };
  }
  const id = checked(event.id, REPORT_ID);
  if (id === undefined) {
    return {
      code: "bad-id",
      reason: "id must be 32 lowercase hex characters",
    };
  }
  if (!name) return { code: "missing-name", reason: "name is required" };
  if (name.length > MAX_NAME) {
    return {
      code: "name-too-long",
      reason: `name must be at most ${MAX_NAME} characters`,
    };
  }
  if (!REPORT_NAME.test(name)) {
    return {
      code: "bad-name",
      reason: "name must look like quiet-heron-41",
    };
  }
  if (typeof event.kind !== "string" || !event.kind) {
    return { code: "missing-kind", reason: "kind is required" };
  }
  if (!REPORT_KINDS.includes(event.kind)) {
    return { code: "bad-kind", reason: "kind must be broke or wish" };
  }
  const structuredRefused = structuredRefusal(structured);
  if (structuredRefused) return structuredRefused;
  if (event.words !== undefined && typeof event.words !== "string") {
    return { code: "bad-words", reason: "words must be a string" };
  }
  if ((event.words ?? "").length > MAX_WORDS) {
    return {
      code: "words-too-long",
      reason: `words must be at most ${MAX_WORDS} characters`,
    };
  }
  if (taken.includes(id)) {
    return {
      code: "duplicate-id",
      reason: `a report with id ${id} is already on the board`,
    };
  }
  return undefined;
}
