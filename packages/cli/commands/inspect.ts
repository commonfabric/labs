// `cf inspect` — offline autopsy of local memory v2 space DBs.
//
// Thin CLI surface over @commonfabric/state-inspector. Reads the durable SQLite
// store the server already wrote (no live runtime, no capture) and answers
// who/what/when + cross-space convergence questions. Data commands take --json;
// the HTML renderer rejects it.
//
// Space DBs are auto-discovered (no need to pass absolute paths): pass a DID,
// DID-prefix, a space NAME (resolved the same way the runtime derives it), or a
// file path as <space>. `cf inspect spaces` lists what's found.

import { Command, ValidationError } from "@cliffy/command";
import { Table } from "@cliffy/table";
import type { FabricValue } from "@commonfabric/data-model";
import {
  annotate,
  buildCrossSpaceLinkIndex,
  buildInspectorBundle,
  buildSpaceGraph,
  commitChurn,
  commitsPerMinute,
  contendedEntities,
  convergenceExact,
  convergenceScanExact,
  DEFAULT_SCAN_LIMIT,
  // Remote acquisition (`cf inspect --remote` / `pull`).
  defaultCacheDir,
  describeIdentity,
  describePiece,
  diffEntity,
  discoverSpaceDbs,
  entityConflicts,
  entityHistory,
  entityKinds,
  entityTimeline,
  escapeTerminalText,
  type ExactConvergenceResult,
  fetchSpaceDb,
  getValueAt,
  graphToDot,
  groupDiscoveredSpaces,
  type GroupedSpace,
  hotEntities,
  inspectOperationFields,
  isCompleteScan,
  isEntityKind,
  listCommits,
  listEntityModels,
  listRemoteSpaces,
  listScopes,
  listSqliteFiles,
  openSpace,
  openSpaces,
  parseScope,
  quickStats,
  type RemoteSpace,
  renderInspectorHtml,
  type RequestSigner,
  resolveSpace,
  rowLimit,
  type ScanExtent,
  type Scope,
  scopeOverlay,
  shortDid as shortDidLabel,
  type SpaceGraph,
  spaceParticipants,
  type SpaceRef,
  spaceTimeline,
  stringifyInspectorJson,
  subgraphAround,
  summarize,
  summarizeSpace,
  valueAsIdentity,
} from "@commonfabric/state-inspector";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { loadIdentity } from "../lib/identity.ts";
import { hasJsonArgument } from "../lib/json-output.ts";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
}

type OutputStringifier = (value: unknown) => string | undefined;

const prettyJson: OutputStringifier = (value) => JSON.stringify(value, null, 2);

function out(
  json: boolean,
  data: unknown,
  render: () => void,
  stringify: OutputStringifier = prettyJson,
): void {
  if (json) console.log(stringify(data));
  else render();
}

/**
 * Report a capped result on stderr, before any of it reaches stdout.
 *
 * A capped listing is a SUBSET that looks exactly like a complete one, so it
 * has to announce itself — and stderr is the one channel that reaches both
 * readers. A human sees it beside the table; a `--json` consumer sees it
 * without the parsed bytes on stdout changing shape, which is what an envelope
 * around the array would have cost every caller for a condition most runs
 * never hit. Silence on stderr means the result IS the whole set.
 *
 * A notice only reaches a reader who is looking. `--require-complete` is for
 * the caller who cannot afford to miss it — a script whose output is a backup
 * or a rollback payload — and turns the same condition into a nonzero exit with
 * nothing written to stdout at all.
 */
function noteIncompleteScan(
  extent: ScanExtent,
  what: string,
  requireComplete?: boolean,
): void {
  if (isCompleteScan(extent)) return;
  const reasons: string[] = [];
  if (extent.truncated) {
    reasons.push(
      `capped at --limit ${extent.limit} ${what}; the space holds ` +
        `${extent.total} entities in all — raise --limit for the rest`,
    );
  }
  if (extent.unreadable > 0) {
    // Named apart from the cap, because the remedy is different: a raised
    // limit does not recover an entity whose payload will not decode.
    reasons.push(
      `${extent.unreadable} of ${extent.total} entities could not be ` +
        `reconstructed and are absent from this result — raising --limit ` +
        `will not recover them`,
    );
  }
  if (requireComplete) {
    throw new Error(
      `${reasons.join("; ")}. --require-complete refuses a partial result.`,
    );
  }
  for (const reason of reasons) console.error(`NOTE: ${reason}.`);
}

/**
 * The cap a scan will apply, refusing anything an entity count could not reach.
 * A fractional `--limit` is a typo with a silent failure mode — entities are
 * counted one at a time, so a cap of 1.5 is a cap nothing ever equals — and a
 * negative one asks for a listing that cannot exist.
 */
function validatedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new ValidationError(
      `\`--limit\` must be a whole number of entities, not ${limit}.`,
    );
  }
  return limit;
}

/**
 * The row limit a listing will apply, refusing what its SQL used to refuse.
 *
 * Distinct from `validatedLimit`, which governs a reconstruction cap and takes
 * no negative: these listings were `LIMIT ?` clauses, where SQLite reads a
 * negative as UNLIMITED and answers a fractional or non-finite one with a
 * datatype mismatch. Any integer passes; everything else is the typo it looks
 * like, and rounding it silently is how a listing under-reports.
 */
function validatedRowLimit(limit: number): number {
  try {
    // `rowLimit` owns the RULE — which limits a row listing accepts, and why.
    // This owns only how a CLI user hears it: a ValidationError before the
    // space is opened, rather than the library's stack trace after.
    rowLimit(limit);
    return limit;
  } catch {
    throw new ValidationError(
      `\`--limit\` must be a whole number of rows, not ${limit}.`,
    );
  }
}

/** The flag that turns a capped result into a failure. Shared by every scan. */
const requireCompleteOption = [
  "--require-complete",
  "Exit nonzero instead of returning a capped result.",
] as const;

function splitPath(p?: string): string[] {
  return p ? p.split("/").filter(Boolean) : [];
}

interface PathOptions {
  path?: string;
  pathJson?: string;
  doc?: boolean;
}

/**
 * Parses one of the supported path options into exact string segments.
 *
 * @throws {ValidationError} When path options conflict or `pathJson` is not a
 * JSON array of strings.
 */
function parsePathOptions(options: PathOptions): string[] {
  if (options.path !== undefined && options.pathJson !== undefined) {
    throw new ValidationError(
      "Use either `--path` or `--path-json`, not both.",
    );
  }
  if (
    options.doc &&
    (options.path !== undefined || options.pathJson !== undefined)
  ) {
    throw new ValidationError(
      "Use `--doc` without `--path` or `--path-json`.",
    );
  }
  if (options.pathJson === undefined) return splitPath(options.path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(options.pathJson);
  } catch {
    throw new ValidationError(
      "`--path-json` must contain a JSON array of string segments.",
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((segment) => typeof segment === "string")
  ) {
    throw new ValidationError(
      "`--path-json` must contain a JSON array of string segments.",
    );
  }
  return parsed;
}

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_$@.:%+~-]+$/;

function stringifyPathSegments(segments: string[]): string {
  return JSON.stringify(segments).replace(
    /[^\x20-\x7E]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function formatChangePath(path: string, segments: string[]): string {
  if (segments.length === 0) return "(root)";
  return segments.every((segment) => SAFE_PATH_SEGMENT.test(segment))
    ? path
    : stringifyPathSegments(segments);
}

function formatSelectedPath(segments: string[], exact: boolean): string {
  return exact || !segments.every((segment) => SAFE_PATH_SEGMENT.test(segment))
    ? stringifyPathSegments(segments)
    : `/${segments.join("/")}`;
}

function summarizeChangeValue(
  value: FabricValue,
  isUndefined?: true,
  valueKind?: string,
): string {
  const summary = isUndefined ? "undefined" : summarize(value);
  return valueKind ? `${summary} [${valueKind}]` : summary;
}

// did:key:z6Mk…wQ2n  ->  z6Mk…wQ2n  (compact, still recognizable)
function shortDid(did: string): string {
  return shortDidLabel(did, 8, 4);
}

// A scope as a compact, human label: "space", "user z6Mk…", "session z6Mk…/abc".
function fmtScope(s: Scope): string {
  if (s.kind === "space") return "space";
  if (s.kind === "user") return `user ${shortDid(s.principal ?? "?")}`;
  if (s.kind === "session") {
    return `session ${shortDid(s.principal ?? "?")}/${
      (s.sessionId ?? "").slice(0, 8)
    }`;
  }
  return decodeURIComponent(s.raw).slice(0, 40);
}

// Session ids look like `session:did:key:<space>:<uuid>` (often %-encoded).
// Surface the short space DID + uuid head instead of a uniform truncation.
function fmtSession(s: string): string {
  const scope = parseScope(s);
  if (scope.kind === "session" && scope.principal) {
    return `${shortDidLabel(scope.principal)}/${
      (scope.sessionId ?? "").slice(0, 8)
    }`;
  }
  const decoded = decodeURIComponent(s);
  return decoded.length > 22 ? `${decoded.slice(0, 21)}…` : decoded;
}

//
// Remote acquisition (`cf inspect --remote`)
//
// The autopsy stays 100% offline; --remote only changes where the SQLite file
// comes from: instead of the local on-disk store, fetch a read-only snapshot
// from a toolshed dump endpoint into the local cache, then open it as usual.
//

interface RemoteOpts {
  remote?: string | boolean;
  identity?: string;
}

// Resolve the remote base URL from --remote (its value, or CF_API_URL when the
// flag is given bare). Returns null when not in remote mode.
function remoteBaseUrl(options: RemoteOpts): string | null {
  const r = options.remote;
  if (r === undefined || r === false) return null;
  if (r === true) {
    const env = Deno.env.get("CF_API_URL");
    if (!env) {
      throw new Error(
        "--remote needs a URL, e.g. --remote https://host (or set CF_API_URL).",
      );
    }
    return env;
  }
  return r;
}

// Build a CF1 first-party request signer from --identity / CF_IDENTITY. Returns
// undefined when no key is configured; the request then goes out unsigned and
// the server replies 401 (the dump endpoint has no unauthenticated mode) — we
// let it fail with the actionable "set CF_IDENTITY" message rather than block
// here, so the missing-key case is reported the same way as a bad key.
async function remoteSigner(
  options: RemoteOpts,
): Promise<RequestSigner | undefined> {
  const path = options.identity ?? Deno.env.get("CF_IDENTITY");
  if (!path) return undefined;
  const identity = await loadIdentity(path);
  return ({ url, method }) =>
    signFirstPartyHttpRequest({ url: new URL(url), method, signer: identity });
}

// Map a token (full DID, prefix, or substring) to a full space DID on a remote,
// via the remote listing — exact match wins, else unique substring. A full DID
// resolves exactly; a `did:key:z6Mk…` PREFIX resolves like any other prefix
// (mirroring local resolution) instead of being sent verbatim and 404ing.
async function resolveRemoteDid(
  token: string,
  base: string,
  sign: RequestSigner | undefined,
): Promise<string> {
  const spaces = await listRemoteSpaces(base, { sign });
  const exact = spaces.filter((s) => s.space === token);
  const matches = exact.length
    ? exact
    : spaces.filter((s) => s.space.includes(token));
  if (matches.length === 1) return matches[0].space;
  if (matches.length === 0) {
    throw new Error(
      `no remote space matches "${token}" (run: inspect spaces --remote).`,
    );
  }
  throw new Error(
    `"${token}" is ambiguous across ${matches.length} remote spaces; use a full DID.`,
  );
}

// Open a space by token: from the remote (fetch + cache) when --remote is set,
// otherwise from the local on-disk store.
async function openByToken(
  token: string,
  options: RemoteOpts,
): Promise<ReturnType<typeof openSpace>> {
  const base = remoteBaseUrl(options);
  // Local path: resolveSpace handles DID / prefix / path / space-name (#4398).
  if (!base) return openSpace(await resolveSpace(token));
  const sign = await remoteSigner(options);
  const did = await resolveRemoteDid(token, base, sign);
  return openSpace(await fetchSpaceDb(did, base, { sign }));
}

// Resolve --all / --spaces / --dir (and --remote) into open spaces; caller must
// close them.
async function resolveMultiSpaces(opts: {
  all?: boolean;
  spaces?: string;
  dir?: string;
  remote?: string | boolean;
  identity?: string;
}): Promise<SpaceRef[]> {
  const spaceTokens = opts.spaces?.split(",").map((token) => token.trim())
    .filter(Boolean);
  const selectorCount = Number(opts.all === true) +
    Number(opts.spaces !== undefined) + Number(opts.dir !== undefined);
  if (selectorCount > 1) {
    throw new ValidationError(
      "Use only one of `--all`, `--spaces`, or `--dir`.",
    );
  }
  if (selectorCount === 0) {
    throw new ValidationError(
      "Use one of `--all`, `--spaces`, or `--dir`.",
    );
  }
  if (opts.spaces !== undefined && spaceTokens?.length === 0) {
    throw new ValidationError(
      "`--spaces` must contain at least one space.",
    );
  }
  if (
    opts.dir !== undefined && opts.remote !== undefined && opts.remote !== false
  ) {
    throw new ValidationError("`--dir` cannot be used with `--remote`.");
  }
  const base = remoteBaseUrl(opts);
  if (base) {
    const sign = await remoteSigner(opts);
    let dids: string[];
    if (opts.all) {
      dids = (await listRemoteSpaces(base, { sign })).map((s) => s.space);
    } else if (spaceTokens) {
      dids = await Promise.all(
        spaceTokens.map((token) => resolveRemoteDid(token, base, sign)),
      );
    } else {
      throw new Error("with --remote, provide --all or --spaces <a,b,…>.");
    }
    const paths: string[] = [];
    for (const did of dids) paths.push(await fetchSpaceDb(did, base, { sign }));
    return openSpaces(paths);
  }
  if (opts.dir) return openSpaces(listSqliteFiles(opts.dir));
  if (opts.all) return openSpaces(discoverSpaceDbs().map((s) => s.path));
  if (spaceTokens) {
    const discovered = discoverSpaceDbs();
    const paths = await Promise.all(
      spaceTokens.map((token) => resolveSpace(token, discovered)),
    );
    return openSpaces(paths);
  }
  throw new Error("provide --all, --spaces <a,b,…>, or --dir <dir>");
}

function relTag(r: ExactConvergenceResult): string {
  return r.relationship === "cross-space-linked"
    ? "DRIFT"
    : r.relationship === "no-cross-space-link"
    ? "instance?"
    : "?";
}

export const inspect = new Command()
  .name("inspect")
  .description(
    "Offline autopsy of local memory v2 space DBs (state, history, convergence).",
  )
  .error((error, command) => {
    const args = command.getMainCommand().getRawArgs();
    if (hasJsonArgument(args)) {
      throw error;
    }
  })
  .globalOption("--json", "Output machine-readable JSON.")
  .globalOption(
    "--remote [url:string]",
    "Inspect a remote toolshed: fetch read-only space snapshots into a local " +
      "cache instead of reading on-disk DBs. Bare --remote uses CF_API_URL.",
  )
  .globalOption(
    "--identity <path:string>",
    "Identity keyfile used to sign --remote dump requests (default CF_IDENTITY).",
  )
  .action(function (options) {
    if (options.json) {
      throw new ValidationError(
        'Option "--json" requires an inspect data subcommand.',
      );
    }
    this.showHelp();
  })
  /* inspect spaces */
  .command(
    "spaces",
    "List space DBs: local on-disk by default, or a remote toolshed's with " +
      "--remote.",
  )
  .option("--dir <dir:string>", "Extra directory to search for *.sqlite files.")
  .action(async (options) => {
    // --remote: list the spaces the remote will dump (no per-space stats, since
    // those need the DB which we don't fetch just to list).
    const base = remoteBaseUrl(options);
    if (base) {
      const sign = await remoteSigner(options);
      const spaces = await listRemoteSpaces(base, { sign });
      out(!!options.json, { remote: base, spaces }, () => {
        if (spaces.length === 0) {
          console.log(`no spaces available at ${base}.`);
          return;
        }
        console.log(`${spaces.length} space(s) at ${base}:`);
        console.log(
          Table.from([
            ["DID", "SIZE", "MODIFIED"],
            ...spaces.map((s: RemoteSpace) => [
              s.space,
              humanSize(s.sizeBytes),
              new Date(s.mtimeMs).toISOString(),
            ]),
          ]).toString(),
        );
        console.log(
          "\ntip: `inspect summary <did> --remote` fetches + inspects one; " +
            "`inspect pull --all --remote` caches them all.",
        );
      });
      return;
    }

    const discovered = discoverSpaceDbs(
      options.dir ? { dirs: [options.dir] } : {},
    );
    const rows = discovered.map((s) => {
      const stats = quickStats(s.path);
      return {
        did: s.did,
        path: s.path,
        sizeBytes: s.sizeBytes,
        commits: stats?.commits ?? null,
        entities: stats?.entities ?? null,
        lastActivity: stats?.lastActivity ?? null,
      };
    });
    out(!!options.json, rows, () => {
      if (rows.length === 0) {
        console.log(
          "no space DBs found (set MEMORY_DIR, pass --dir, or run from a repo with cache/memory/…).",
        );
        return;
      }
      console.log(
        Table.from([
          ["DID", "SIZE", "COMMITS", "ENTITIES", "LAST ACTIVITY"],
          ...rows.map((r) => [
            r.did,
            humanSize(r.sizeBytes),
            String(r.commits ?? "?"),
            String(r.entities ?? "?"),
            r.lastActivity ?? "?",
          ]),
        ]).toString(),
      );
    });
  })
  /* inspect pull */
  .command(
    "pull [space:string]",
    "Download remote space snapshot(s) into the local cache for offline " +
      "inspection. Pass a space, or --all. Requires --remote.",
  )
  .option("--all", "Pull every space the remote exposes.")
  .option("--force", "Re-download even if a cached copy exists.")
  .action(async (options, space) => {
    const base = remoteBaseUrl(options);
    if (!base) {
      throw new Error("pull requires --remote <url> (or CF_API_URL).");
    }
    const sign = await remoteSigner(options);
    const cacheDir = defaultCacheDir(base);

    let dids: string[];
    if (options.all) {
      dids = (await listRemoteSpaces(base, { sign })).map((s) => s.space);
    } else if (space) {
      dids = [await resolveRemoteDid(space, base, sign)];
    } else {
      throw new Error("provide a <space> or --all.");
    }

    const pulled: { did: string; path: string }[] = [];
    for (const did of dids) {
      const path = await fetchSpaceDb(did, base, {
        sign,
        force: options.force,
      });
      pulled.push({ did, path });
    }
    out(!!options.json, { remote: base, cacheDir, pulled }, () => {
      console.log(`pulled ${pulled.length} space(s) into ${cacheDir}:`);
      for (const p of pulled) console.log(`  ${p.did}`);
      console.log(
        "\nnow inspect them offline, e.g. `inspect summary <did-prefix>`.",
      );
    });
  })
  /* inspect group */
  .command(
    "group",
    "Group discovered space DBs into per-user worlds (home → profiles → main).",
  )
  .option("--dir <dir:string>", "Extra directory to search for *.sqlite files.")
  .option(
    "--did <prefix:string>",
    "Expand one user's world fully (match the principal DID).",
  )
  .action((options) => {
    const discovered = discoverSpaceDbs(
      options.dir ? { dirs: [options.dir] } : {},
    );
    const result = groupDiscoveredSpaces(discovered);
    out(!!options.json, result, () => {
      if (result.groups.length === 0 && result.ungrouped.length === 0) {
        console.log("no space DBs found.");
        return;
      }
      const roleCounts = (g: { spaces: GroupedSpace[] }) => {
        const c = { home: 0, profile: 0, main: 0, unknown: 0, absent: 0 };
        for (const s of g.spaces) {
          c[s.role]++;
          if (!s.present) c.absent++;
        }
        return c;
      };
      const tag = (s: GroupedSpace) =>
        `${s.role.padEnd(7)} ${shortDid(s.did)}` +
        (s.present
          ? `  commits=${s.commits ?? 0} entities=${s.entities ?? 0}` +
            (s.empty ? "  (placeholder/empty)" : "")
          : "  (absent — referenced, no local DB)") +
        (s.evidence.length ? `  · ${s.evidence.join("; ")}` : "");

      // Focused view: expand the matching group(s) fully.
      if (options.did) {
        const matches = result.groups.filter((g) =>
          g.principal.includes(options.did!)
        );
        if (matches.length === 0) {
          console.log(`no group principal matches "${options.did}".`);
          return;
        }
        for (const g of matches) {
          console.log(
            `● user ${shortDid(g.principal)}` +
              (g.homePresent ? "" : "  (home absent/empty locally)"),
          );
          for (const s of g.spaces) console.log(`   ${tag(s)}`);
        }
        return;
      }

      // Default: one compact line per group, biggest first.
      console.log(
        `${result.groups.length} user group(s)` +
          (result.ungrouped.length
            ? `, ${result.ungrouped.length} ungrouped`
            : "") +
          `  —  use --did <prefix> to expand one`,
      );
      for (const g of result.groups) {
        const c = roleCounts(g);
        console.log(
          `● ${shortDid(g.principal)}  ` +
            `home=${g.homePresent ? "present" : "absent"}  ` +
            `profiles=${c.profile}  main=${c.main}` +
            (c.absent ? `  (+${c.absent} absent)` : ""),
        );
      }
    });
  })
  /* inspect identity */
  .command(
    "identity <did:string>",
    "One identity's whole world: its spaces + the scopes it owns in each.",
  )
  .option("--dir <dir:string>", "Extra directory to search for *.sqlite files.")
  .action((options, did) => {
    const discovered = discoverSpaceDbs(
      options.dir ? { dirs: [options.dir] } : {},
    );
    const w = describeIdentity(discovered, did);
    out(!!options.json, w, () => {
      console.log(
        `● identity ${shortDid(did)}` +
          (w.homePresent ? "" : "  (home absent/empty locally)"),
      );
      console.log(
        `  ${w.totals.presentSpaces}/${w.totals.spaces} spaces present · ` +
          `${w.totals.spacesWithScopedState} with per-user/session state · ` +
          `${w.totals.scopedEntities} scoped entities`,
      );
      for (const s of w.spaces) {
        const head = `  ${s.role.padEnd(7)} ${shortDid(s.did)}` +
          (s.present
            ? `  entities=${s.entities ?? 0}`
            : "  (absent — referenced, no local DB)");
        console.log(head);
        for (const sc of s.ownedScopes) {
          console.log(
            `      ${sc.kind === "session" ? "session" : "user"}${
              sc.kind === "session"
                ? ` /${(sc.sessionId ?? "").slice(0, 8)}`
                : ""
            }  entities=${sc.entities} revs=${sc.revisions}`,
          );
        }
      }
      if (w.totals.scopedEntities > 0) {
        console.log(
          "\ntip: `inspect value-at <space> <id> --as " + shortDid(did) +
            "…` reads a cell as this identity.",
        );
      }
    });
  })
  /* inspect summary */
  .command(
    "summary <space:string>",
    "Space overview: commits, sessions, hot ops.",
  )
  .action(async (options, space) => {
    const s = await openByToken(space, options);
    try {
      const sum = summarizeSpace(s);
      out(!!options.json, sum, () => {
        console.log(`space: ${sum.path}`);
        console.log(
          `commits: ${sum.commits}` +
            (sum.commitSeqRange
              ? ` (seq ${sum.commitSeqRange[0]}–${sum.commitSeqRange[1]})`
              : ""),
        );
        console.log(`sessions: ${sum.sessions}`);
        console.log(`entities: ${sum.entities}  revisions: ${sum.revisions}`);
        console.log(
          `ops: ${
            Object.entries(sum.ops).map(([k, v]) => `${k}=${v}`).join(" ")
          }`,
        );
        console.log(
          `branches: ${
            sum.branches.map((b) => `${b.name || "(default)"}@${b.head_seq}`)
              .join(" ")
          }`,
        );
        console.log(
          `scheduler basis: ${
            !sum.hasSchedulerBasisTable
              ? "absent (pre-migration store)"
              : sum.schedulerBasisRows > 0
              ? `${sum.schedulerBasisRows} rows`
              : "table present, empty"
          }`,
        );
      });
    } finally {
      s.close();
    }
  })
  /* inspect operations */
  .command(
    "operations <space:string> [entity:string]",
    "Collaborative field epochs, cursors, histories, and checkpoint health.",
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--scope <scope:string>", "Exact resolved scope key.")
  .option("--limit <limit:integer>", "Maximum fields (default 50).")
  .option(
    "--history-limit <limit:integer>",
    "Maximum submissions and integrated operations per field (default 100).",
  )
  .option(
    "--submission-after-seq <seq:integer>",
    "Return submitted history after this commit sequence.",
  )
  .action(async (options, space, entity) => {
    const s = await openByToken(space, options);
    try {
      const report = inspectOperationFields(s, {
        id: entity,
        branch: options.branch,
        scope: options.scope,
        fieldLimit: options.limit,
        historyLimit: options.historyLimit,
        submissionAfterSeq: options.submissionAfterSeq,
      });
      out(!!options.json, report, () => {
        if (!report.available) {
          console.log("operation tables are absent");
          return;
        }
        if (report.fields.length === 0) {
          console.log("no collaborative operation fields");
          return;
        }
        for (const field of report.fields) {
          console.log(
            `${field.active ? "active" : "inactive"}\t${field.address.id}` +
              `\t${field.address.scope}\t${field.address.pathPointer}` +
              `\t${field.codec}` +
              `\t${field.cursor.epoch}:${field.cursor.version}` +
              `\tretained=${field.retainedFrom.version}` +
              `\t${field.consistency.healthy ? "healthy" : "INCONSISTENT"}`,
          );
          console.log(
            `  submissions=${field.submissions.length}` +
              `${field.pagination.submissionsTruncated ? "+" : ""}` +
              ` integrated=${field.integrated.length}` +
              `${field.pagination.integratedTruncated ? "+" : ""}` +
              ` checkpoints=${field.checkpoints.length}`,
          );
        }
        if (report.fieldsTruncated) {
          console.log(`field list truncated at ${report.fieldLimit}`);
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect scopes */
  .command(
    "scopes <space:string>",
    "Per-identity scopes in a space: shared/space + per-user + per-session.",
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .action(async (options, space) => {
    const s = await openByToken(space, options);
    try {
      const scopes = listScopes(s, { branch: options.branch });
      out(!!options.json, scopes, () => {
        const space2 = scopes.find((x) => x.kind === "space");
        console.log(
          `${scopes.length} scope(s)` +
            (space2
              ? `  ·  shared 'space' has ${space2.entities} entities`
              : ""),
        );
        for (const sc of scopes) {
          console.log(
            `  ${
              fmtScope(sc).padEnd(34)
            } entities=${sc.entities}\trevs=${sc.revisions}`,
          );
        }
        if (scopes.some((x) => x.kind !== "space")) {
          console.log(
            "\ntip: `inspect value-at <space> <id> --as <DID>` reads as that identity;",
          );
          console.log(
            "     `inspect overlay <space> <id>` shows a cell across all scopes.",
          );
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect users */
  .command(
    "users <space:string>",
    "Identities that touched this space (committers + per-user/session scopes).",
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .action(async (options, space) => {
    const s = await openByToken(space, options);
    try {
      const ps = spaceParticipants(s, { branch: options.branch });
      out(!!options.json, ps, () => {
        if (ps.length === 0) {
          console.log("(no identifiable participants — bare/empty sessions)");
          return;
        }
        console.log(`${ps.length} identit${ps.length === 1 ? "y" : "ies"}:`);
        for (const p of ps) {
          console.log(
            `  ${p.isOwner ? "★" : "·"} ${shortDid(p.did)}` +
              `\tcommits=${p.commits} sessions=${p.sessions}` +
              (p.userEntities ? `  user-cells=${p.userEntities}` : "") +
              (p.sessionEntities
                ? `  session-cells=${p.sessionEntities}`
                : "") +
              (p.isOwner ? "  (owner — this is their home)" : ""),
          );
        }
        console.log(
          "\ntip: `inspect identity <DID>` opens a user's whole world " +
            "(home + profiles + the spaces they act in).",
        );
      });
    } finally {
      s.close();
    }
  })
  /* inspect commits */
  .command(
    "commits <space:string>",
    "Recent commits (who committed, ops, reads).",
  )
  .option("--session <prefix:string>", "Filter by session id prefix.")
  .option("--limit <n:number>", "Max rows.", { default: 50 })
  .action(async (options, space) => {
    const s = await openByToken(space, options);
    try {
      const rows = listCommits(s, {
        session: options.session,
        limit: options.limit,
      });
      out(!!options.json, rows, () => {
        for (const r of rows) {
          console.log(
            `#${r.seq}\t${
              fmtSession(r.session)
            }\tlocal=${r.localSeq}\tops=${r.ops}\treads=${r.reads}\t${r.createdAt}`,
          );
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect hot */
  .command(
    "hot <space:string>",
    "Entities ranked by write count (contention proxy).",
  )
  .option("--limit <n:number>", "Max rows; a negative returns every row.", {
    default: 20,
  })
  .option("--branch <branch:string>", "Branch (default: '').")
  .action(async (options, space) => {
    const limit = validatedRowLimit(options.limit);
    const s = await openByToken(space, options);
    try {
      const rows = hotEntities(s, { limit, branch: options.branch });
      out(!!options.json, rows, () => {
        for (const r of rows) {
          console.log(
            `${r.writes}\twrites\t${r.sessions} sessions\t${r.id}\t(${r.scope})`,
          );
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect churn */
  .command(
    "churn <space:string>",
    "Write rate over time: commits/revisions per bucket, and what drove the " +
      "busiest one. The storm-and-settle view `hot` cannot give.",
  )
  .option("--bucket <seconds:number>", "Bucket width in seconds.", {
    default: 60,
  })
  .option(
    "--since <time:string>",
    "Lower bound on commit time (inclusive). Also widens the curve to cover " +
      "the whole window asked for.",
  )
  .option(
    "--until <time:string>",
    "Upper bound on commit time (exclusive). This is the observation " +
      "boundary: pass the moment you stopped watching and the trailing quiet " +
      "buckets are reported, which is what shows a storm SETTLED rather than " +
      "merely ended at the last write.",
  )
  .option("--top <n:number>", "Entities to attribute the peak bucket to.", {
    default: 10,
  })
  .option("--branch <branch:string>", "Branch (default: '').")
  .action(async (options, space) => {
    const s = await openByToken(space, options);
    try {
      const report = commitChurn(s, {
        branch: options.branch,
        bucketSeconds: options.bucket,
        since: options.since,
        until: options.until,
        top: options.top,
      });
      out(!!options.json, report, () => {
        if (report.peak === null) {
          console.log("no timed commits in window");
        } else {
          const width = String(
            Math.max(...report.buckets.map((b) => b.commits)),
          ).length;
          for (const b of report.buckets) {
            const peak = b.startEpoch === report.peak.startEpoch
              ? " ←peak"
              : "";
            console.log(
              `${b.start}\t${String(b.commits).padStart(width)} commits\t` +
                `${b.revisions} revisions${peak}`,
            );
          }
          console.log(
            `\n${report.totals.commits} commits / ${report.totals.revisions} ` +
              `revisions over ${report.buckets.length} × ${report.bucketSeconds}s` +
              `\npeak ${report.peak.start}: ${
                commitsPerMinute(report.peak, report.bucketSeconds).toFixed(1)
              } commits/min` +
              // Where writing stopped, against where watching stopped. A curve
              // that merely ran out of data ends on its last write; one that
              // was observed through a quiet period ends after it. Only the
              // second is evidence of a settle, and they render identically
              // without both numbers.
              `\nlast commit ${report.lastCommit}, observed through ${report.to}`,
          );
          for (const e of report.peakEntities) {
            console.log(
              `  ${e.writes}\twrites\t${e.sessions} sessions\t${e.id}\t(${e.scope})`,
            );
          }
        }
        if (report.untimedCommits > 0) {
          console.log(
            `\nnote: ${report.untimedCommits} commit(s) have unparseable ` +
              `created_at and are absent from every bucket.`,
          );
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect conflicts */
  .command(
    "conflicts <space:string> [entity:string]",
    "Contested entities (≥2 writer sessions); with an entity: stale-read analysis.",
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option(
    "--limit <n:number>",
    "Max contested entities; a negative returns every one.",
    { default: 100 },
  )
  .action(async (options, space, entity) => {
    const limit = validatedRowLimit(options.limit);
    const s = await openByToken(space, options);
    try {
      if (entity) {
        const c = entityConflicts(s, entity, {
          branch: options.branch,
          scope: options.scope,
        });
        out(!!options.json, c, () => {
          console.log(
            `${c.id}\n${c.writers.length} writes by ${c.writerPrincipals} ` +
              `identit${
                c.writerPrincipals === 1 ? "y" : "ies"
              } / ${c.writerSessions} sessions` +
              (c.multiUser
                ? "  · MULTI-USER"
                : "  · single-user (multi-session)") +
              (c.interleaved ? "  · INTERLEAVED" : ""),
          );
          for (const w of c.writers) {
            console.log(
              `  seq=${w.seq}\t${w.op}\t${
                fmtSession(w.session)
              }\t${w.createdAt}`,
            );
          }
          if (c.staleReads.length) {
            console.log(
              `\n⚠ ANOMALOUS stale reads — the engine validates confirmed ` +
                `reads before committing, so a healthy store has none. Each ` +
                `here is a committed read the engine's own check would reject:`,
            );
            for (const sr of c.staleReads) {
              console.log(
                `  commit #${sr.readerCommitSeq} by ${
                  fmtSession(sr.readerSession)
                } ` +
                  `read @seq ${sr.readAtSeq} but missed ${sr.missedWriteOp} ` +
                  `@seq ${sr.missedWriteSeq} by ${
                    fmtSession(sr.missedWriteSession)
                  }` +
                  (sr.readerAlsoWrote
                    ? "  ⚠ then wrote (lost-update risk)"
                    : ""),
              );
            }
          } else {
            console.log("\n(no anomalous stale reads — store is consistent)");
          }
        });
        return;
      }
      const rows = contendedEntities(s, {
        branch: options.branch,
        scope: options.scope,
        limit,
      });
      out(!!options.json, rows, () => {
        if (rows.length === 0) {
          console.log(
            "(no contested entities — no cell written by ≥2 sessions)",
          );
          return;
        }
        const mu = rows.filter((r) => r.multiUser).length;
        console.log(
          `${rows.length} contested entit${rows.length === 1 ? "y" : "ies"} ` +
            `(written by ≥2 sessions)  ·  ${mu} MULTI-USER (≥2 identities):`,
        );
        for (const r of rows) {
          console.log(
            `  ${r.multiUser ? "★" : r.interleaved ? "⇄" : "·"} ${r.id}\t` +
              `${r.principals} users / ${r.sessions} sessions\t${r.writes} writes` +
              (r.multiUser ? "  MULTI-USER" : ""),
          );
        }
        console.log(
          "\ntip: `inspect conflicts <space> <entity>` for the writer timeline + stale reads.",
        );
      });
    } finally {
      s.close();
    }
  })
  /* inspect entities */
  .command(
    "entities <space:string>",
    "What's in the space: entities by kind, with lineage.",
  )
  .option(
    "--kind <kind:string>",
    `Filter: ${entityKinds.join(" | ")}. --limit then counts entities of ` +
      `this kind, not entities scanned to find them.`,
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .option(
    "--limit <n:number>",
    "Max entities to return; a capped result is noted on stderr.",
    { default: DEFAULT_SCAN_LIMIT },
  )
  .option(...requireCompleteOption)
  .action(async (options, space) => {
    const kind = options.kind;
    if (kind !== undefined && !isEntityKind(kind)) {
      throw new ValidationError(
        `Unknown --kind "${kind}". Expected one of: ${entityKinds.join(", ")}.`,
      );
    }
    const limit = validatedLimit(options.limit);
    const s = await openByToken(space, options);
    try {
      const listing = listEntityModels(s, {
        limit,
        branch: options.branch,
        kind,
      });
      const rows = listing.entities;
      noteIncompleteScan(
        listing.extent,
        kind ? `${kind} entities` : "entities",
        options.requireComplete,
      );
      out(!!options.json, rows, () => {
        if (rows.length === 0) {
          console.log("(no entities)");
          return;
        }
        // A compact comprehension legend, then the table.
        const counts = new Map<string, number>();
        for (const r of rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
        console.log(
          [...counts.entries()].map(([k, n]) => `${k}=${n}`).join("  "),
        );
        console.log(
          Table.from([
            ["KIND", "LABEL", "OWN", "REVS", "LINKS", "ID"],
            ...rows.map((r) => [
              r.kind,
              r.label.length > 34 ? `${r.label.slice(0, 33)}…` : r.label,
              r.owned ? "↳" : "",
              String(r.revisions ?? 0),
              String(r.links ?? 0),
              r.id,
            ]),
          ]).toString(),
        );
      });
    } finally {
      s.close();
    }
  })
  /* inspect piece */
  .command(
    "piece <space:string> <entity:string>",
    "A piece's pattern, input, result, and owned cells.",
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option("--code", "Include the full pattern TS source.")
  .action(async (options, space, entity) => {
    const s = await openByToken(space, options);
    try {
      const piece = describePiece(s, entity, {
        branch: options.branch,
        scope: options.scope,
        includeCode: !!options.code,
      });
      out(!!options.json, piece, () => {
        if ("error" in piece) {
          console.log(`(${piece.error})`);
          return;
        }
        console.log(`piece:   ${piece.name}  [${piece.regime}]`);
        console.log(`id:      ${piece.id}`);
        if (piece.pattern) {
          const p = piece.pattern;
          console.log(
            `pattern: ${p.filename ?? "(unresolved)"}` +
              (p.symbol ? ` · ${p.symbol}` : "") +
              (p.codeLines ? ` · ${p.codeLines} lines` : "") +
              (p.id ? `  ${p.id}` : ""),
          );
        }
        if (piece.input) {
          console.log(`input:   ${piece.input.summary}  ${piece.input.id}`);
        }
        console.log(`result:  {${piece.resultKeys.join(", ")}}`);
        if (piece.schemaKeys.length) {
          console.log(`schema:  {${piece.schemaKeys.join(", ")}}`);
        }
        if (piece.ownedCells.length) {
          console.log(`owned cells (${piece.ownedCells.length}):`);
          for (const c of piece.ownedCells) {
            console.log(
              `  ${c.kind.padEnd(10)} ${
                c.summary.length > 40 ? `${c.summary.slice(0, 39)}…` : c.summary
              }\t${c.id}`,
            );
          }
        }
        if (piece.pattern?.code) {
          console.log(
            `\n--- ${piece.pattern.filename} ---\n${piece.pattern.code}`,
          );
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect graph */
  .command(
    "graph <space:string>",
    "Entity graph: nodes (pieces/cells/streams/modules) + edges (pattern/argument/owns/link).",
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option("--root <entity:string>", "Restrict to one entity's neighborhood.")
  .option("--depth <n:number>", "Hops around --root.", { default: 2 })
  .option("--no-links", "Omit data-link edges (keep structural edges only).")
  .option("--dot", "Emit Graphviz DOT (pipe to: dot -Tsvg).", {
    conflicts: ["json"],
  })
  .option(
    "--limit <n:number>",
    "Max entities to reconstruct; a capped result is noted on stderr.",
    { default: DEFAULT_SCAN_LIMIT },
  )
  .option(...requireCompleteOption)
  .action(async (options, space) => {
    const limit = validatedLimit(options.limit);
    const s = await openByToken(space, options);
    try {
      let g: SpaceGraph = buildSpaceGraph(s, {
        branch: options.branch,
        scope: options.scope,
        limit,
        includeLinks: options.links !== false,
      });
      if (options.root) g = subgraphAround(g, options.root, options.depth);
      noteIncompleteScan(g.extent, "entities", options.requireComplete);
      if (options.dot) {
        console.log(graphToDot(g));
        return;
      }
      out(!!options.json, g, () => {
        console.log(`space: ${g.space}`);
        console.log(
          `nodes: ${g.nodes.length}  {${
            Object.entries(g.stats.nodesByKind)
              .map(([k, n]) => `${k}=${n}`).join(" ")
          }}`,
        );
        console.log(
          `edges: ${g.edges.length}  {${
            Object.entries(g.stats.edgesByKind)
              .filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(" ")
          }}` + (g.stats.externalEdges
            ? `  (${g.stats.externalEdges} cross-space)`
            : ""),
        );
        // Adjacency, grouped by source, pieces first (most informative).
        const labelOf = new Map(g.nodes.map((n) => [n.id, n]));
        const bySource = new Map<string, typeof g.edges>();
        for (const e of g.edges) {
          (bySource.get(e.from) ?? bySource.set(e.from, []).get(e.from)!).push(
            e,
          );
        }
        const order = [...bySource.keys()].sort((a, b) => {
          const ka = labelOf.get(a)?.kind === "piece" ? 0 : 1;
          const kb = labelOf.get(b)?.kind === "piece" ? 0 : 1;
          return ka - kb;
        });
        const arrow = (k: string) =>
          k === "pattern"
            ? "⟶pattern"
            : k === "argument"
            ? "⟶arg"
            : k === "owns"
            ? "⟶owns"
            : "·link";
        for (const src of order.slice(0, options.root ? 9999 : 40)) {
          const n = labelOf.get(src)!;
          console.log(`\n${n.kind} ${shortDid(src)}  ${n.label}`);
          for (const e of bySource.get(src)!) {
            const t = labelOf.get(e.to);
            // External targets carry the real id in `entityId` and the target
            // space in `space`; print the space DID (not the qualified node key).
            const desc = t
              ? (e.external
                ? `${shortDid(t.entityId)} (external)`
                : `${t.kind} ${t.label}`)
              : "?";
            console.log(
              `  ${arrow(e.kind).padEnd(9)} ${desc}${
                e.external ? ` @${shortDid(t?.space ?? "")} [cross-space]` : ""
              }${e.label ? `  (${e.label})` : ""}`,
            );
          }
        }
        if (!options.root && order.length > 40) {
          console.log(
            `\n… ${order.length - 40} more sources (use --root or --json)`,
          );
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect html */
  .command(
    "html <space:string>",
    "Emit a self-contained HTML inspector (open in a browser).",
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option("--out <file:string>", "Write to a file instead of stdout.")
  .option(
    "--app-url <url:string>",
    "Live shell base origin for deep links (e.g. https://host).",
  )
  .option(
    "--limit <n:number>",
    "Max entities to reconstruct; a capped result is noted on stderr.",
    { default: DEFAULT_SCAN_LIMIT },
  )
  .option(...requireCompleteOption)
  .action(async (options, space) => {
    const limit = validatedLimit(options.limit);
    if (options.json) {
      throw new ValidationError(
        'Option "--json" and the "html" command are mutually exclusive.',
      );
    }
    const s = await openByToken(space, options);
    try {
      const bundle = buildInspectorBundle(s, {
        branch: options.branch,
        scope: options.scope,
        generatedAt: new Date().toISOString(),
        liveBase: options.appUrl,
        limit,
      });
      noteIncompleteScan(bundle.extent, "entities", options.requireComplete);
      const html = renderInspectorHtml(bundle);
      if (options.out) {
        Deno.writeTextFileSync(options.out, html);
        const pieces = bundle.details.filter((d) => d.kind === "piece").length;
        console.error(
          `wrote ${options.out}  (${bundle.details.length} entities, ${pieces} pieces)`,
        );
      } else {
        console.log(html);
      }
    } finally {
      s.close();
    }
  })
  /* inspect history */
  .command(
    "history <space:string> <entity:string>",
    "Every write that touched an entity.",
  )
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--limit <n:number>", "Max rows.", { default: 200 })
  .action(async (options, space, entity) => {
    const s = await openByToken(space, options);
    try {
      const rows = entityHistory(s, {
        id: entity,
        scope: options.scope,
        branch: options.branch,
        limit: options.limit,
      });
      out(!!options.json, rows, () => {
        for (const r of rows) {
          console.log(
            `seq=${r.seq}\tcommit=${r.commitSeq}\t${r.op}\t${
              fmtSession(r.session)
            }\tlocal=${r.localSeq}\t${r.createdAt}`,
          );
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect value-at */
  .command(
    "value-at <space:string> <entity:string>",
    "Reconstructed value of an entity at a seq.",
  )
  .option(
    "--seq <n:number>",
    "Reconstruct as of this commit seq (default: latest).",
  )
  .option("--path <path:string>", "Navigate into value, e.g. value/count.")
  .option(
    "--path-json <segments:string>",
    'Navigate with an exact JSON string array, e.g. ["value","count"].',
  )
  .option("--scope <scope:string>", "Raw scope key (default: space).")
  .option(
    "--as <did:string>",
    "APPROXIMATE this identity's view: the most-specific stored scope that holds " +
      "the id (session⊕user⊕space). Not the runtime read — use `overlay` for ground truth.",
  )
  .option("--session <sid:string>", "With --as: a specific session id.")
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--doc", "Show the whole document, not just value.")
  .option(
    "--full-depth",
    "Do not truncate nested values or link schemas in annotated output.",
  )
  .action(async (options, space, entity) => {
    const path = parsePathOptions(options);
    if (options.as !== undefined && options.as.length === 0) {
      throw new ValidationError("`--as` must not be empty.");
    }
    if (options.session !== undefined && options.session.length === 0) {
      throw new ValidationError("`--session` must not be empty.");
    }
    if (options.as !== undefined && options.scope !== undefined) {
      throw new ValidationError(
        "Use either `--as` or `--scope`, not both.",
      );
    }
    if (options.as === undefined && options.session !== undefined) {
      throw new ValidationError("`--session` requires `--as`.");
    }
    const s = await openByToken(space, options);
    try {
      const fullDepth = options.fullDepth === true;
      const annotationDepth = fullDepth ? Number.POSITIVE_INFINITY : 8;
      const stringify = fullDepth ? stringifyInspectorJson : prettyJson;
      // --as composes the per-identity overlay; otherwise a single raw scope.
      if (options.as !== undefined) {
        const r = valueAsIdentity(s, {
          id: entity,
          identity: options.as,
          sessionId: options.session,
          branch: options.branch,
          atSeq: options.seq,
          path: options.doc ? undefined : path,
          doc: !!options.doc,
          annotationDepth,
        });
        out(!!options.json, r, () => {
          if (!r.exists) {
            console.log("(absent for this identity)");
            return;
          }
          if (!options.doc && !r.pathExists) {
            console.log("(entity present, but nothing at that path)");
            return;
          }
          console.log(
            `≈ approx. from scope: ${r.resolvedKind} ` +
              `(most-specific stored; NOT a runtime read — see \`overlay\`)` +
              (r.overrides ? "  (overrides a more-general scope)" : ""),
          );
          console.log(stringify(r.value));
        }, stringify);
        return;
      }
      const res = getValueAt(
        s,
        {
          id: entity,
          scope: options.scope,
          branch: options.branch,
          atSeq: options.seq,
        },
        path,
      );
      const shown = options.doc ? res.document : res.value;
      const pathExists = options.doc ? res.exists : res.pathExists;
      const annotated = annotate(shown, annotationDepth);
      out(
        !!options.json,
        { exists: res.exists, pathExists, value: annotated },
        () => {
          if (!res.exists) console.log("(absent at this seq)");
          else if (!pathExists) {
            console.log("(entity present, but nothing at that path)");
          } else console.log(stringify(annotated));
        },
        stringify,
      );
    } finally {
      s.close();
    }
  })
  /* inspect overlay */
  .command(
    "overlay <space:string> <entity:string>",
    "An entity's value across EVERY scope (per-user/session divergence).",
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .action(async (options, space, entity) => {
    const s = await openByToken(space, options);
    try {
      const o = scopeOverlay(s, entity, { branch: options.branch });
      out(!!options.json, o, () => {
        if (o.variants.length === 0) {
          console.log("(entity absent)");
          return;
        }
        console.log(
          `${entity}` +
            (o.overridden
              ? o.divergent
                ? `  —  ${o.variants.length} scopes, DIVERGENT`
                : `  —  ${o.variants.length} scopes, identical`
              : "  —  single scope"),
        );
        for (const v of o.variants) {
          const label = v.kind === "space"
            ? "space"
            : v.kind === "user"
            ? `user ${shortDid(v.principal ?? "?")}`
            : v.kind === "session"
            ? `session ${shortDid(v.principal ?? "?")}/${
              (v.sessionId ?? "").slice(0, 8)
            }`
            : v.scope;
          console.log(`  ${label.padEnd(34)} ${v.summary}`);
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect diff */
  .command(
    "diff <space:string> <entity:string>",
    "What changed in an entity between two seqs.",
  )
  .option("--from <n:number>", "From seq (default: entity's birth / seq 0).")
  .option("--to <n:number>", "To seq (default: latest).")
  .option("--path <path:string>", "Focus inside value, e.g. items/0/title.")
  .option(
    "--path-json <segments:string>",
    'Focus with an exact JSON string array, e.g. ["items","0","title"].',
  )
  .option("--doc", "Diff the whole document, not just value.")
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option("--branch <branch:string>", "Branch (default: '').")
  .action(async (options, space, entity) => {
    const path = parsePathOptions(options);
    const s = await openByToken(space, options);
    try {
      const d = diffEntity(s, {
        id: entity,
        scope: options.scope,
        branch: options.branch,
        fromSeq: options.from,
        toSeq: options.to,
        path: options.doc ? undefined : path,
        doc: !!options.doc,
      });
      out(!!options.json, d, () => {
        const range = `${d.fromSeq ?? "birth"} → ${d.toSeq ?? "latest"}`;
        console.log(`diff ${d.id}  (${range})`);
        if (!d.fromExists && d.toExists) console.log("  (created in range)");
        if (d.fromExists && !d.toExists) console.log("  (deleted in range)");
        if (d.changes.length === 0) {
          console.log("  (no changes)");
          return;
        }
        for (const c of d.changes) {
          const at = formatChangePath(c.path, c.pathSegments);
          if (c.kind === "changed") {
            console.log(
              `  ~ ${at}: ${
                summarizeChangeValue(
                  c.before,
                  c.beforeIsUndefined,
                  c.beforeValueKind,
                )
              } → ${
                summarizeChangeValue(
                  c.after,
                  c.afterIsUndefined,
                  c.afterValueKind,
                )
              }${c.annotationCollision ? " (display annotations match)" : ""}`,
            );
          } else if (c.kind === "added") {
            console.log(
              `  + ${at}: ${summarizeChangeValue(c.after, c.afterIsUndefined)}`,
            );
          } else {
            console.log(
              `  - ${at}: ${
                summarizeChangeValue(c.before, c.beforeIsUndefined)
              }`,
            );
          }
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect timeline */
  .command(
    "timeline <space:string> [entity:string]",
    "How a space grew (no entity), or how one entity evolved (with entity).",
  )
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--limit <n:number>", "Max rows.", { default: 500 })
  .action(async (options, space, entity) => {
    const s = await openByToken(space, options);
    try {
      if (entity) {
        const steps = entityTimeline(s, {
          id: entity,
          scope: options.scope,
          branch: options.branch,
          limit: options.limit,
        });
        out(!!options.json, steps, () => {
          console.log(`timeline of ${entity}  (${steps.length} writes)`);
          for (const st of steps) {
            console.log(
              `  seq=${st.seq}\t${st.op}\t${
                st.changesKnown === false
                  ? "? changes"
                  : st.changes
                  ? `${st.changes} changes`
                  : "—"
              }\t${st.summary}\t${fmtSession(st.session)}\t${st.createdAt}`,
            );
          }
        });
      } else {
        const entries = spaceTimeline(s, {
          scope: options.scope,
          branch: options.branch,
          limit: options.limit,
        });
        out(!!options.json, entries, () => {
          console.log(`space growth  (${entries.length} commits)`);
          for (const e of entries) {
            console.log(
              `  #${e.commitSeq}\t+${e.created} new\t${e.touched} touched\t` +
                `Σ${e.cumulativeEntities}\t${
                  fmtSession(e.session)
                }\t${e.createdAt}`,
            );
          }
        });
      }
    } finally {
      s.close();
    }
  })
  /* inspect converge */
  .command(
    "converge <entity:string>",
    "Compare an entity's value across spaces.",
  )
  .option("--all", "Use all discovered spaces.")
  .option("--spaces <list:string>", "Comma-separated DIDs/prefixes/paths.")
  .option("--dir <dir:string>", "Directory of *.sqlite files.")
  .option("--path <path:string>", "Navigate into value, e.g. value/count.")
  .option(
    "--path-json <segments:string>",
    'Navigate with an exact JSON string array, e.g. ["value","count"].',
  )
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option("--branch <branch:string>", "Branch (default: '').")
  .action(async (options, entity) => {
    const path = parsePathOptions(options);
    const refs = await resolveMultiSpaces(options);
    try {
      const index = buildCrossSpaceLinkIndex(refs, {
        scope: options.scope,
        branch: options.branch,
      });
      const r = convergenceExact(
        refs,
        {
          id: entity,
          scope: options.scope,
          branch: options.branch,
          path,
        },
        index,
      );
      out(!!options.json, r, () => {
        console.log(
          `verdict: ${r.verdict.toUpperCase()}` +
            (r.relationship && r.relationship !== "n/a"
              ? `  [${r.relationship}]`
              : ""),
        );
        console.log(
          `entity:  ${r.id}` +
            (r.path.length
              ? `  path=${
                formatSelectedPath(
                  r.path,
                  options.pathJson !== undefined,
                )
              }`
              : ""),
        );
        for (const v of r.views) {
          if (!v.present) {
            console.log(`  ${escapeTerminalText(v.label)}\tABSENT`);
            continue;
          }
          if (v.error) {
            console.log(
              `  ${escapeTerminalText(v.label)}\tERROR\t${
                escapeTerminalText(v.error)
              }`,
            );
            continue;
          }
          const cluster = r.clusters.findIndex((c) =>
            c.valueKey === v.valueKey
          ) + 1;
          console.log(
            `  ${
              escapeTerminalText(v.label)
            }\thead=${v.headSeq}\trevs=${v.revisions}\tlast=${
              v.lastSession ? fmtSession(v.lastSession) : "?"
            }\tcluster#${cluster}` +
              (v.pathExists === false ? "\tpath=MISSING" : ""),
          );
        }
        console.log(`note: ${r.caveat}`);
      });
    } finally {
      for (const ref of refs) ref.space.close();
    }
  })
  /* inspect converge-scan */
  .command("converge-scan", "Find entities present in >=2 spaces that diverge.")
  .option("--all", "Use all discovered spaces.")
  .option("--spaces <list:string>", "Comma-separated DIDs/prefixes/paths.")
  .option("--dir <dir:string>", "Directory of *.sqlite files.")
  .option("--limit <n:number>", "Max findings.", { default: 50 })
  .option("--branch <branch:string>", "Branch (default: '').")
  .action(async (options) => {
    const refs = await resolveMultiSpaces(options);
    try {
      const result = convergenceScanExact(refs, {
        limit: options.limit,
        branch: options.branch,
      });
      out(!!options.json, result, () => {
        console.log(
          `shared entities (in >=2 spaces): ${result.sharedEntities}  examined: ${result.examined}`,
        );
        console.log(
          `cross-space link edges: ${result.crossSpaceLinkEdges}  ` +
            `(${result.linkedFindings} real-drift / ` +
            `${result.unlinkedFindings} likely-independent / ` +
            `${result.unknownFindings} unknown)`,
        );
        console.log(
          `findings (diverged/partial/unknown): ${result.findings.length}`,
        );
        for (const f of result.findings) {
          const present = f.views.filter((v) => v.present).length;
          const missing = f.views.length - present;
          console.log(
            `  ${f.verdict.toUpperCase()}\t${
              relTag(f)
            }\t${f.id}\tpresent=${present}` +
              (missing ? `\tmissing=${missing}` : "") +
              `\tclusters=${f.clusters.length}`,
          );
        }
      });
    } finally {
      for (const ref of refs) ref.space.close();
    }
  });
