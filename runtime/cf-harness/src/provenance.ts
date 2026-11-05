// What caused a gateway request. The values travel as `x-cf-harness-*` headers
// and, condensed, inside the User-Agent.
//
// These headers reach the upstream provider along with the request, which bounds
// what a value may contain: no request content, and nothing that identifies a
// single run or person. `docs/features/gateway-request-provenance.md` states
// those bounds and the mechanisms that hold them.

/** What kind of thing invoked the harness. */
export type HarnessInvoker =
  | "cli"
  | "test"
  | "integration-test"
  | "ci"
  | "loom"
  | "service";

/** A coding agent whose session the harness can be running inside. */
export type HarnessAgent = "claude-code" | "codex";

export interface HarnessProvenance {
  invoker: HarnessInvoker;

  /** Stable per-process id, so the requests of one run can be grouped. */
  session: string;

  /** A label for the machine, stable across runs. */
  principal: string;

  /** The subcommand, passed explicitly by the caller. Never read from argv. */
  command?: string;

  /** Continuous-integration run, as `<system>:<job>:<run id>`. */
  ci?: string;

  /** The dispatch class a Loom run manifest asked for. */
  dispatch?: string;

  /**
   * The coding agent whose session the harness is running inside. Absent when
   * no coding agent is in the picture.
   */
  agent?: HarnessAgent;

  /** The service that launched the harness, from its `OTEL_SERVICE_NAME`. */
  service?: string;
}

const MAX_VALUE_LENGTH = 48;
const UNSAFE = /[^A-Za-z0-9._:-]+/g;

/**
 * Bound a value to a short run of characters that cannot break a header or
 * carry structure into one. Applied to everything, including values that should
 * already be safe.
 */
export function sanitize(value: string): string {
  const cleaned = value.replace(UNSAFE, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, MAX_VALUE_LENGTH);
}

/** An environment lookup that yields undefined rather than throwing. */
export type EnvReader = (name: string) => string | undefined;

const nonEmpty = (value: string | undefined): boolean =>
  value !== undefined && value !== "";

/** Reads the process environment, treating a denied permission as unset. */
export const processEnv: EnvReader = (name) => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

function detectInvoker(env: EnvReader): HarnessInvoker {
  if (env("CF_HARNESS_INTEGRATION") === "1") return "integration-test";
  if (env("ENV") === "test") return "test";
  if (env("GITHUB_ACTIONS") === "true" || env("CI") === "true") return "ci";
  // A service names itself for tracing, and every process it spawns inherits
  // the variable.
  if (nonEmpty(env("OTEL_SERVICE_NAME"))) return "service";
  return "cli";
}

/**
 * Which coding agent's session this is running inside, if any. Claude Code sets
 * `CLAUDECODE` on every process it spawns, and the Codex CLI sets
 * `CODEX_SANDBOX`. Only which variable was found is reported, never its value.
 */
function detectAgent(env: EnvReader): HarnessAgent | undefined {
  if (nonEmpty(env("CLAUDECODE"))) return "claude-code";
  if (nonEmpty(env("CODEX_SANDBOX"))) return "codex";
  return undefined;
}

function detectCi(env: EnvReader): string | undefined {
  const workflow = env("GITHUB_WORKFLOW");
  const runId = env("GITHUB_RUN_ID");
  if (workflow === undefined && runId === undefined) return undefined;
  const tail = `:${runId ?? ""}`;
  const room = MAX_VALUE_LENGTH - "github:".length - tail.length;
  return `github:${
    sanitize(workflow ?? "").slice(0, Math.max(0, room))
  }${tail}`;
}

/**
 * Where a machine's principal is kept between runs. `write()` creates the
 * principal only when there is none, so a writer that loses a race leaves the
 * winner's value in place.
 */
export interface PrincipalStore {
  read(): string | undefined;
  write(value: string): void;
}

/**
 * A principal stored in a file under the harness home. Reads and writes that
 * fail yield undefined rather than throwing.
 */
export function filePrincipalStore(harnessHome: string): PrincipalStore {
  const path = `${harnessHome}/principal`;
  return {
    read() {
      try {
        const value = Deno.readTextFileSync(path).trim();
        return value === "" ? undefined : value;
      } catch {
        return undefined;
      }
    },
    write(value) {
      try {
        // Matches the credential store, which shares this directory and
        // refuses to use one that any other account can read.
        Deno.mkdirSync(harnessHome, { recursive: true, mode: 0o700 });
        Deno.writeTextFileSync(path, `${value}\n`, { createNew: true });
      } catch {
        // An unwritable home, or another process that got there first.
      }
    },
  };
}

const randomLabel = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * The machine's principal: `CF_HARNESS_PRINCIPAL` when set, otherwise the
 * stored label, otherwise a fresh random label written to the store. A
 * principal that could not be stored is prefixed `unstable-`, marking one that
 * lasts for this process alone.
 *
 * `docs/features/gateway-request-provenance.md` states the invariant the label
 * holds.
 */
function detectPrincipal(env: EnvReader, store?: PrincipalStore): string {
  const declared = env("CF_HARNESS_PRINCIPAL");
  if (declared !== undefined && sanitize(declared) !== "") return declared;
  if (store === undefined) return `unstable-${randomLabel()}`;
  const stored = store.read();
  if (stored !== undefined) return stored;
  const created = randomLabel();
  store.write(created);
  // Reads back rather than returning `created`, so a process whose write lost
  // to another reports the principal that was kept.
  return store.read() ?? `unstable-${created}`;
}

export interface DetectProvenanceOptions {
  /** The parsed subcommand. Pass the resolved name, never raw arguments. */
  command?: string;

  env?: EnvReader;
  session?: string;
  principalStore?: PrincipalStore;
}

/**
 * Where the harness keeps its state: `CF_HARNESS_HOME`, or `.cf-harness` under
 * `HOME`. Undefined when neither is set.
 */
function defaultHarnessHome(env: EnvReader): string | undefined {
  const declared = env("CF_HARNESS_HOME");
  if (declared !== undefined && declared !== "") return declared;
  const home = env("HOME");
  return home !== undefined && home !== "" ? `${home}/.cf-harness` : undefined;
}

/** Work out what is invoking the harness in this process. */
export function detectProvenance(
  options: DetectProvenanceOptions = {},
): HarnessProvenance {
  const env = options.env ?? processEnv;
  const ci = detectCi(env);
  const home = defaultHarnessHome(env);
  const invoker = detectInvoker(env);
  const persists = invoker !== "test" && invoker !== "integration-test";
  const store = options.principalStore ??
    (home !== undefined && persists ? filePrincipalStore(home) : undefined);
  const service = env("OTEL_SERVICE_NAME");
  const agent = detectAgent(env);
  return {
    invoker,
    session: options.session ?? crypto.randomUUID(),
    principal: detectPrincipal(env, store),
    ...(options.command !== undefined ? { command: options.command } : {}),
    ...(ci !== undefined ? { ci } : {}),
    ...(nonEmpty(service) ? { service: service! } : {}),
    ...(agent !== undefined ? { agent } : {}),
  };
}

/**
 * One process reports one provenance, so it is resolved once and shared. The
 * command is set later, once the CLI has parsed it.
 */
let current: HarnessProvenance | undefined;

export function currentProvenance(): HarnessProvenance {
  current ??= detectProvenance();
  return current;
}

/** Replaces the provenance this process reports. */
export function setCurrentProvenance(
  provenance: HarnessProvenance | undefined,
): void {
  current = provenance;
}

/** Record the subcommand once the CLI has resolved which one is running. */
export function setProvenanceCommand(command: string): void {
  current = { ...currentProvenance(), command };
}

/** Folds a Loom run manifest into the process-wide provenance. */
export function recordProvenanceRunManifest(
  manifest: { source?: string; dispatchClass?: string } | undefined,
): void {
  current = withRunManifest(currentProvenance(), manifest);
}

/**
 * Takes the invoker and dispatch class from a Loom run manifest. The manifest's
 * other fields, its wish and instance identifiers among them, stay on the
 * machine.
 */
export function withRunManifest(
  provenance: HarnessProvenance,
  manifest: { source?: string; dispatchClass?: string } | undefined,
): HarnessProvenance {
  if (manifest?.source !== "loom") return provenance;
  return {
    ...provenance,
    invoker: "loom",
    ...(manifest.dispatchClass !== undefined
      ? { dispatch: manifest.dispatchClass }
      : {}),
  };
}

/** The fields that are set, in report order, each reduced to a safe value. */
export function provenanceEntries(
  provenance: HarnessProvenance,
): Array<[string, string]> {
  const fields: Array<[string, string | undefined]> = [
    ["principal", provenance.principal],
    ["invoker", provenance.invoker],
    ["session", provenance.session],
    ["service", provenance.service],
    ["agent", provenance.agent],
    ["command", provenance.command],
    ["ci", provenance.ci],
    ["dispatch", provenance.dispatch],
  ];
  return fields.flatMap(([name, value]) => {
    const bounded = value === undefined ? "" : sanitize(value);
    return bounded === "" ? [] : [[name, bounded] as [string, string]];
  });
}

/** The headers a request carries so the gateway can attribute it. */
export function provenanceHeaders(
  provenance: HarnessProvenance,
): Record<string, string> {
  return Object.fromEntries(
    provenanceEntries(provenance).map((
      [name, value],
    ) => [`x-cf-harness-${name}`, value]),
  );
}

/** The program named at the front of a User-Agent when none is given. */
const DEFAULT_PRODUCT = "cf-harness";

/**
 * The same values condensed into a User-Agent, which the gateway access log
 * records. The session is shortened to its first eight characters; the full
 * value is in the header.
 *
 * `product` names the program sending the request and opens the string, so a
 * reader can tell one sender's traffic from another's by user agent alone.
 */
export function provenanceUserAgent(
  provenance: HarnessProvenance,
  product: string = DEFAULT_PRODUCT,
): string {
  const parts = provenanceEntries(provenance).map(([name, value]) =>
    `${name}=${name === "session" ? value.slice(0, 8) : value}`
  );
  return `${sanitize(product)} (${parts.join("; ")})`;
}
