/**
 * The server-execution posture a browser-tier Topics measurement ran under, so
 * that every sample says either which mode produced it or that the deployment
 * declared none, as `docs/plans/topics-computation-cost.md` asks of a run
 * labeled by mode. A sample never leaves the question open, and never answers
 * it with a guess.
 *
 * The posture is read from the deployment under measurement rather than from
 * the environment the benchmark process was started with: a benchmark that
 * labeled its samples from its own `EXPERIMENTAL_SERVER_EXECUTION` would
 * label whatever it was told, including a deployment that resolved something
 * else. Two halves are read, and a run whose halves disagree is refused rather
 * than labeled, because a client and a server on opposite postures exercise
 * neither of them.
 *
 * Neither half is the worker's own report. The runtime client's protocol
 * carries no request that reads a worker's resolved flags back, so the closest
 * available statement of what the page ran is the shell it was served: the
 * shell declares its posture from the build define, and the worker refuses to
 * initialize when its resolved posture disagrees with that declaration, so a
 * page that loaded at all ran the posture its shell declared.
 *
 * The shell's half itself has two possible statements, and they are not
 * interchangeable. The bundle served to the browser is the artifact the run
 * loads, so it states this run's posture. `/api/meta` states the posture of
 * the shell its own toolshed serves, which is the same artifact only when the
 * shell came from that toolshed — the two URLs are separate parameters
 * because they can denote separate deployments. So the bundle is read
 * whenever it can be, both statements are compared when both exist, and a
 * disagreement refuses rather than picking one. Meta alone settles the
 * question only for a shell served by the toolshed that reported it.
 *
 * Reading a deployment has three outcomes, and no path labels a run from an
 * assumption. Where both halves are stated and agree, the posture is that
 * mode, carrying which statement the shell's half came from. Where both are
 * stated and disagree, reading refuses: a client and a server on opposite
 * postures exercise neither. Where the deployment states the shell's half
 * nowhere, the posture is `undeclared` — a recorded fact about the deployment
 * rather than a guess at what its shell runs, and never the first-party
 * default, which is a constant compiled into this process rather than
 * something the deployment said.
 *
 * Whether `undeclared` is acceptable belongs to the caller, because it is a
 * property of what a measurement is for. A benchmark comparing two postures
 * needs a declared one and reads through
 * {@link readDeclaredTopicsBrowserPosture}, which refuses the rest. A test
 * exercising the measurement helpers does not care what posture it ran under,
 * reads through {@link readTopicsBrowserPosture}, and carries whatever it
 * finds into its samples. A shell built without posture defines declares
 * nothing and is not thereby misconfigured.
 */

/** Names the posture a browser-tier sample was taken under. */
export type TopicsBrowserMode =
  | "server-execution-on"
  | "server-execution-off";

/** Where the served shell's posture was read from. */
export type ClientPostureSource =
  /**
   * `shellServerExecutionDefine` alone, which the toolshed reports of its own
   * shell. Only used where the shell is that toolshed's, and no bundle could
   * be read to check it against.
   */
  | "meta"
  /** The build define baked into the served shell's bundle, alone. */
  | "bundle"
  /** Both, agreeing — the shell's own script and the toolshed's report. */
  | "meta and bundle";

/** A deployment whose two halves both state a posture, and agree on it. */
export interface DeclaredTopicsBrowserPosture {
  /** That the deployment states the posture its shell runs. */
  readonly declared: true;

  /** The mode both halves agree on, which labels every sample of the run. */
  readonly mode: TopicsBrowserMode;

  /** Whether the toolshed reports serving with server execution on. */
  readonly served: boolean;

  /** Whether the shell the toolshed serves resolved server execution on. */
  readonly client: boolean;

  /** Which statement of the shell's posture `client` was read from. */
  readonly clientFrom: ClientPostureSource;
}

/**
 * A deployment that states nowhere what posture its shell runs. The toolshed
 * still reports what it serves at; nothing reports what the page ran, so this
 * carries no mode and a sample taken under it is not a measurement of either
 * posture.
 */
export interface UndeclaredTopicsBrowserPosture {
  /** That the deployment states nothing about the posture its shell runs. */
  readonly declared: false;

  /** Whether the toolshed reports serving with server execution on. */
  readonly served: boolean;

  /** What was read, and why neither statement settled the shell's half. */
  readonly reason: string;
}

/** What reading a deployment's posture came to. */
export type TopicsBrowserPosture =
  | DeclaredTopicsBrowserPosture
  | UndeclaredTopicsBrowserPosture;

/**
 * What `/api/meta` says about a deployment's posture. Both fields arrive as
 * JSON from a server this process does not control, so each is `unknown` and
 * checked rather than trusted, and each may arrive as `null`.
 */
export interface PostureMeta {
  /** The flags the deployment serves at, as it resolved them. */
  readonly experimental?: { readonly serverExecution?: unknown };

  /**
   * The raw `EXPERIMENTAL_SERVER_EXECUTION` the shell this toolshed serves
   * baked as its build define. `null` covers four situations the field does
   * not tell apart: the value was unset at build time and the shell follows
   * the first-party default, the toolshed runs from source and serves no
   * built shell, and the build marker was unreadable or malformed — the last
   * two being the failure posture `readBuildInfoFrom` gives the whole marker.
   */
  readonly shellServerExecutionDefine?: unknown;
}

/** What every {@link ServedBundle} says about where the shell came from. */
interface ServedFrom {
  /**
   * Whether the shell was sought from the toolshed's own origin. When it was
   * not, the two are separate deployments and `/api/meta` describes a shell
   * the browser is not loading, so its define is no evidence about this run.
   *
   * A match takes one origin to be one deployment, which is the bound on what
   * this establishes: a shell proxied from another host under the toolshed's
   * origin, or served from a different path of it, reads as the toolshed's
   * own, and `/api/meta` would then be trusted for a shell it does not
   * describe. Anything finer would be guessing at a deployment's topology
   * from two URLs.
   *
   * One path consults this: the one where `/api/meta` states a define and the
   * served bundle states none, whether because it could not be read or
   * because it carries none. A wrong match there trusts the toolshed's report
   * for a shell it does not describe. Every other path ignores this flag — a
   * bundle stating a define answers for itself whoever served it, a bundle
   * disagreeing with the toolshed refuses, and where neither states one the
   * posture is undeclared either way.
   */
  readonly servedByToolshed: boolean;
}

/** The served shell's entry script, or why it was not read. */
export type ServedBundle =
  /** The script's text, as fetched from the shell being served. */
  | (ServedFrom & { readonly kind: "read"; readonly source: string })
  /** No script could be read, with what the attempt came to. */
  | (ServedFrom & { readonly kind: "unreachable"; readonly reason: string });

/**
 * Matches the build define in a served shell's bundle. The bundler emits the
 * define as the live arm of a conditional on its own presence, so the baked
 * value is the quoted string in that arm.
 */
const BAKED_DEFINE =
  /EXPERIMENTAL_SERVER_EXECUTION_DEFINE\s*=\s*true\s*\?\s*"([^"]*)"/;

/**
 * Returns what `meta` and the served shell's `bundle` say about the posture
 * the deployment runs: the mode where both halves state one and agree, and an
 * undeclared posture where the shell's half is stated nowhere.
 *
 * The shell's half is settled from the define baked into a bundle that was
 * read, from the `shellServerExecutionDefine` the toolshed reports, or from
 * both where both state one and agree. Meta is used alone only when the
 * bundle carries `servedByToolshed`, since otherwise it describes a shell
 * this run does not load. A shell built without posture defines states
 * neither, which is an ordinary configuration rather than a fault.
 *
 * @throws Error when the toolshed reports no resolved `serverExecution`, when
 * a statement of the posture is not a boolean spelling, when the toolshed's
 * report and the served bundle disagree, or when the shell's half and the
 * served half disagree.
 */
export function topicsBrowserPostureOf(
  meta: PostureMeta,
  bundle: ServedBundle = {
    kind: "unreachable",
    reason: "none was fetched",
    servedByToolshed: true,
  },
): TopicsBrowserPosture {
  const served = meta.experimental?.serverExecution;
  if (typeof served !== "boolean") {
    throw new Error(
      "The toolshed reports no resolved `serverExecution`, so it says " +
        `nothing about the posture it serves at: ${JSON.stringify(served)}`,
    );
  }
  const stated = clientPosture(meta, bundle);
  if (stated.kind === "unstated") {
    return { declared: false, served, reason: stated.reason };
  }
  const { client, clientFrom } = stated;
  if (client !== served) {
    throw new Error(
      `The toolshed serves \`serverExecution=${served}\` while the shell it ` +
        `serves runs \`${client}\` (read from the ${clientFrom}). A client ` +
        "and a server on opposite postures exercise neither, so the run has " +
        "no mode to be labeled with.",
    );
  }
  return {
    declared: true,
    mode: served ? "server-execution-on" : "server-execution-off",
    served,
    client,
    clientFrom,
  };
}

/**
 * Helper for {@link topicsBrowserPostureOf}, which returns what states the
 * posture the served shell runs, or why nothing does.
 *
 * Two statements are available and neither substitutes for the other. The
 * bundle is the script the browser loads, so it states this run's posture.
 * `/api/meta` states the posture of the shell its own toolshed serves, which
 * is this run's shell only when that toolshed served it.
 *
 * Each combination of the two yields:
 *
 * - both state a define and they differ: throws.
 * - both state a define and they agree: stated, from `meta and bundle`.
 * - only the bundle states one: stated, from `bundle`, whichever host served
 *   the shell — the artifact the browser loads answers for itself.
 * - only `/api/meta` states one, and the toolshed served the shell: stated,
 *   from `meta`.
 * - only `/api/meta` states one, and another host served the shell: unstated,
 *   that define describing a shell this run did not load.
 * - neither states one: unstated.
 *
 * The bundle states nothing in two ways — it could not be read, or it was
 * read and carries no define — which change no outcome above and are told
 * apart only in the `reason` an unstated result carries.
 *
 * @throws Error when a statement it reads is neither `true` nor `false`, and
 * when the two statements disagree.
 */
function clientPosture(
  meta: PostureMeta,
  bundle: ServedBundle,
):
  | { kind: "stated"; client: boolean; clientFrom: ClientPostureSource }
  | { kind: "unstated"; reason: string } {
  const reported = meta.shellServerExecutionDefine;
  const fromMeta = reported === undefined || reported === null
    ? undefined
    : booleanNamed(reported, "meta");
  const baked = bundle.kind === "read"
    ? BAKED_DEFINE.exec(bundle.source)
    : null;
  const fromBundle = baked === null
    ? undefined
    : booleanNamed(baked[1], "bundle");

  if (fromMeta !== undefined && fromBundle !== undefined) {
    if (fromMeta !== fromBundle) {
      throw new Error(
        `The toolshed reports its shell baked \`${fromMeta}\` while the shell ` +
          `actually served carries \`${fromBundle}\`. The two describe ` +
          "different artifacts, so neither states what this run loaded.",
      );
    }
    return {
      kind: "stated",
      client: fromBundle,
      clientFrom: "meta and bundle",
    };
  }
  if (fromBundle !== undefined) {
    return { kind: "stated", client: fromBundle, clientFrom: "bundle" };
  }
  if (fromMeta !== undefined && bundle.servedByToolshed) {
    return { kind: "stated", client: fromMeta, clientFrom: "meta" };
  }
  const shell = bundle.kind === "unreachable"
    ? `no served shell could be read (${bundle.reason})`
    : "the served shell's entry script carries no define";
  return {
    kind: "unstated",
    reason: fromMeta === undefined
      ? `the toolshed names no baked define and ${shell}`
      : "the toolshed names a baked define for its own shell, but another " +
        `deployment serves the shell this run loads, and ${shell}`,
  };
}

/**
 * Helper for {@link clientPosture}, which returns `value` as the boolean its
 * spelling names.
 *
 * @throws Error when it spells neither `true` nor `false`.
 */
function booleanNamed(value: unknown, from: ClientPostureSource): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(
    `The shell's posture from the ${from} spells neither \`true\` nor ` +
      `\`false\`: ${JSON.stringify(value)}`,
  );
}

/**
 * Returns what the deployment at `apiUrl`, serving the shell at
 * `frontendUrl`, says about the posture it runs, by reading `/api/meta` and
 * the served shell's entry script. Both are read every time: the toolshed's
 * report describes its own shell, so where `frontendUrl` is a separate
 * deployment only the bundle describes what the browser loads. A deployment
 * that states its shell's posture in neither place reads as undeclared; a
 * caller that needs a declared one uses
 * {@link readDeclaredTopicsBrowserPosture} instead.
 *
 * @throws Error when `/api/meta` cannot be read, and as
 * {@link topicsBrowserPostureOf} does.
 */
export async function readTopicsBrowserPosture(
  apiUrl: string | URL,
  frontendUrl: string | URL,
): Promise<TopicsBrowserPosture> {
  const response = await fetch(new URL("api/meta", apiUrl));
  if (!response.ok) {
    throw new Error(
      `Reading the deployment's posture from \`/api/meta\` failed with ` +
        `${response.status}.`,
    );
  }
  const meta: PostureMeta = await response.json();
  // The shell is fetched even when `/api/meta` names a define, because that
  // define describes the shell the toolshed itself serves. Where `frontendUrl`
  // is a separate deployment, the browser loads a different artifact, and
  // reading meta alone would label this run from that other one.
  const script = new URL("scripts/index.js", frontendUrl);
  const servedByToolshed = new URL("api/meta", apiUrl).origin === script.origin;
  const bundle = await fetch(script);
  return topicsBrowserPostureOf(
    meta,
    bundle.ok
      ? { kind: "read", source: await bundle.text(), servedByToolshed }
      : {
        kind: "unreachable",
        reason: `\`${script}\` gave ${bundle.status}`,
        servedByToolshed,
      },
  );
}

/**
 * Returns the posture the deployment at `apiUrl`, serving the shell at
 * `frontendUrl`, declares, for a measurement that compares postures and so
 * cannot proceed without knowing which one it is taking. `purpose` names that
 * measurement in the refusal.
 *
 * @throws Error as {@link readTopicsBrowserPosture} does, and when the
 * deployment declares no posture.
 */
export async function readDeclaredTopicsBrowserPosture(
  apiUrl: string | URL,
  frontendUrl: string | URL,
  purpose: string,
): Promise<DeclaredTopicsBrowserPosture> {
  const posture = await readTopicsBrowserPosture(apiUrl, frontendUrl);
  if (!posture.declared) {
    throw new Error(
      `${purpose} compares server-execution postures, so it needs a ` +
        "deployment that declares which one it runs, and this one does not: " +
        `${posture.reason}. Build the shell with ` +
        "`EXPERIMENTAL_SERVER_EXECUTION` set to the posture being measured.",
    );
  }
  return posture;
}
