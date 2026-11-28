/**
 * Private versions: every deploy of a person's own pattern from `cf` (`cf
 * piece new <file>`, `cf piece setsrc`) is kept in the pattern index as a
 * version only they can read, so they get history and rollback without git
 * and without ever running a save command.
 *
 * A deploy never shares. Drafts land many times an hour; the index shares a
 * version once it settles, when its owner has used it in a loom for a day
 * with no newer version and it passes the privacy check, and only while
 * their sharing setting says to. The deploy's line says which.
 * `cf pattern share` shares one at once.
 *
 * The index is never in the deploy's way. The version is recorded after the
 * deploy commits, a failure is reported in one line and never changes the
 * deploy's outcome, and a machine that never joined an index makes no index
 * call at all: it is told so once, and then nothing.
 *
 * A pattern is recognized across deploys by its entry file, through the
 * lineage slot {@link entrySlot} computes.
 */

import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import { sha256 } from "@commonfabric/content-hash";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import type { RuntimeProgram } from "@commonfabric/runner";
import {
  deployedPieceRef,
  type PatternIndexClient,
  PatternIndexError,
  type PatternIndexLineage,
  type PatternIndexPublishResponse,
} from "@commonfabric/pattern-index/client";
import {
  normalizeHashtags,
  patternDocMetadata,
  publishRequestFor,
} from "@commonfabric/pattern-index/publish";
import {
  PatternIndexStore,
  patternIndexStoreDir,
} from "@commonfabric/pattern-index/store";
import {
  openPatternIndexClient,
  resolvePatternIndexUrl,
} from "@commonfabric/pattern-index/access";
import { loadIdentity } from "./identity.ts";

/** The git checkout a file is in: its top directory and `origin` remote. */
export interface GitCheckout {
  root: string;
  remote: string;
}

/**
 * The checkout `dir` is in, or `undefined` outside one or without `origin`.
 * Throws when `git` cannot be started at all.
 */
export async function gitCheckoutOf(
  dir: string,
): Promise<GitCheckout | undefined> {
  const git = async (...args: string[]) => {
    const { code, stdout } = await new Deno.Command("git", {
      args: ["-C", dir, ...args],
      stdout: "piped",
      stderr: "null",
    }).output();
    return code === 0 ? new TextDecoder().decode(stdout).trim() : undefined;
  };
  const root = await git("rev-parse", "--show-toplevel");
  const remote = await git("remote", "get-url", "origin");
  return root === undefined || remote === undefined || remote === ""
    ? undefined
    : { root, remote };
}

/**
 * A remote URL with the differences that do not name a different repository
 * taken out: scheme, user, a trailing `.git`, the `host:path` form, and the
 * host's case. The path keeps its case, which a host may treat as telling
 * two repositories apart.
 */
const normalizeRemote = (remote: string): string => {
  const bare = remote.trim()
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const slash = bare.indexOf("/");
  return slash === -1
    ? bare.toLowerCase()
    : `${bare.slice(0, slash).toLowerCase()}${bare.slice(slash)}`;
};

const sha256Hex = (text: string): string =>
  encodeHex(sha256(new TextEncoder().encode(text)));

const hmacHex = async (key: Uint8Array, text: string): Promise<string> => {
  const imported = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encodeHex(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        imported,
        new TextEncoder().encode(text),
      ),
    ),
  );
};

/** What {@link entrySlot} reads besides the path. */
export interface SlotSources {
  /** This machine's slot key (`PatternIndexStore.slotKey`). */
  pathKey: () => Promise<Uint8Array>;

  checkoutOf?: (dir: string) => Promise<GitCheckout | undefined>;
}

/**
 * The lineage slot `cf` records an entry file's versions under. In a git
 * checkout with an `origin` remote it is a hash of the remote and the file's
 * path in the repository, so every worktree and clone of it, on any machine,
 * continues one lineage; anyone who guesses the repository and path can
 * confirm them. Elsewhere it is the file's absolute path keyed with this
 * machine's slot key, which tells the index nothing it can check a guess
 * against.
 */
export async function entrySlot(
  entry: string,
  sources: SlotSources,
): Promise<string> {
  const path = resolve(entry);
  const checkout = await (sources.checkoutOf ?? gitCheckoutOf)(dirname(path));
  if (checkout === undefined) {
    return `cf-path:${await hmacHex(await sources.pathKey(), path)}`;
  }
  const inRepo = relative(
    await Deno.realPath(checkout.root),
    await realPathOf(path),
  ).split(SEPARATOR).join("/");
  return `cf-git:${
    sha256Hex(
      `${normalizeRemote(checkout.remote)}\n${inRepo}`,
    )
  }`;
}

/**
 * `path` with symbolic links in its directory resolved, as the checkout's
 * root is, so the two compare; as given where the directory is gone.
 */
const realPathOf = (path: string): Promise<string> =>
  Deno.realPath(dirname(path)).then(
    (dir) => join(dir, basename(path)),
    () => path,
  );

/** One deploy, as the deploying command saw it. */
export interface DeployedSource {
  /** The entry file the deploy read. */
  entry: string;

  program: RuntimeProgram;

  /**
   * Reads the content-addressed id the deploy committed, `undefined` when it
   * cannot be read back. Called only for a machine that joined an index.
   */
  patternId: () => Promise<string | undefined>;

  /**
   * The space (a DID) and piece the deploy wrote, so the person's use of
   * that piece in a loom finds this version.
   */
  piece: { space: string; id: string };

  /**
   * The origin `setsrc --origin` recorded: the piece follows a system or
   * repository pattern, which is not the person's own work.
   */
  origin?: string;

  /**
   * Keep the version private whatever the person's sharing setting says, so
   * only an explicit `cf pattern share` hands it to anyone.
   */
  keepPrivate?: boolean;

  /**
   * Who wrote the deployed source: absent for the person, `agent` for an
   * agent deploying on their behalf (a service building a pattern for one of
   * their pieces). An agent's version is recorded with the index's `agent`
   * origin, so the person's sharing setting treats it as agent work, and its
   * history follows the piece it was deployed to, as an agent run's does,
   * rather than the entry file, which for such a deploy is a staged copy.
   */
  versionOrigin?: "agent";

  /**
   * What the version says the pattern does, in place of the entry's doc
   * comment: a deploy that knows better than its source's header says so.
   */
  description?: string;

  /**
   * The pattern the deployed source was built from, as `cf piece getsrc`
   * notes for a file it writes: credited as a remix when it is someone
   * else's, and the version skipped when the source is that pattern
   * unchanged. Without it, the note `getsrc` left for the entry is used.
   */
  builtFrom?: string;
}

/** What recording a deploy as a version came to. */
export type VersionOutcome =
  | {
    status: "recorded";

    /** `false` when the lineage's newest version already had this source. */
    created: boolean;

    response: PatternIndexPublishResponse;
  }
  | {
    status: "not-joined";

    /** Whether this is the first time this machine is told. */
    firstTime: boolean;
  }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export interface VersionDeps {
  store: PatternIndexStore;

  /** Opened only for a machine that joined the index. */
  openClient: () => Promise<
    Pick<
      PatternIndexClient,
      | "publishPattern"
      | "getPattern"
      | "listLineages"
      | "getSharingSettings"
    >
  >;

  readTextFile: (path: string) => Promise<string>;

  /** The git checkout a directory is in; `git` by default. */
  checkoutOf?: SlotSources["checkoutOf"];
}

/**
 * Records `deployed` as a private version of the person's lineage for its
 * entry file, or for its piece when an agent made it. Never throws: every
 * way it can fail is an outcome.
 */
export async function recordDeployedVersion(
  deployed: DeployedSource,
  deps: VersionDeps,
): Promise<VersionOutcome> {
  try {
    if (deployed.origin !== undefined) {
      return {
        status: "skipped",
        reason: `the piece follows ${deployed.origin}, not your own source`,
      };
    }
    if ((await deps.store.membership()) === undefined) {
      const firstTime = !(await deps.store.notedNotJoined());
      if (firstTime) await deps.store.recordNotedNotJoined();
      return { status: "not-joined", firstTime };
    }
    const patternId = await deployed.patternId();
    if (patternId === undefined) {
      return {
        status: "failed",
        reason: "the deploy's pattern id could not be read back",
      };
    }
    const entry = resolve(deployed.entry);
    const client = await deps.openClient();
    if (!await keepsVersions(client, deps.store)) {
      return {
        status: "skipped",
        reason: "this pattern index does not keep private versions yet",
      };
    }
    const sources: SlotSources = {
      pathKey: () => deps.store.slotKey(),
      ...(deps.checkoutOf === undefined ? {} : { checkoutOf: deps.checkoutOf }),
    };
    const deployedTo = deployedPieceRef(
      deployed.piece.space,
      deployed.piece.id,
    );
    const slot = deployed.versionOrigin === "agent"
      ? deployedTo
      : await entrySlot(entry, sources);
    // Source fetched from someone else's pattern and deployed unchanged is
    // still theirs; once edited it is the person's own remix.
    const fetchedFrom = deployed.builtFrom ??
      await deps.store.sourceOf(entry);
    let remixedFrom: string | undefined;
    if (fetchedFrom !== undefined) {
      const source = await client.getPattern({ patternId: fetchedFrom })
        .catch(() => undefined);
      if (source?.mine !== true) {
        if (fetchedFrom === patternId) {
          return {
            status: "skipped",
            reason: `it is ${fetchedFrom} unchanged, someone else's pattern`,
          };
        }
        // Credited once, when the remix starts its lineage: the index
        // starts a new lineage for every version that names one.
        const started = (await client.listLineages()).lineages.some((
          lineage,
        ) => lineage.slot === slot);
        if (!started) remixedFrom = fetchedFrom;
      }
    }
    // An agent's entry is a staged copy, which a deploy that does not wait on
    // its version (the share sidecar) may already have removed: its doc
    // comment is read from the program the deploy committed.
    const source = deployed.versionOrigin === "agent"
      ? deployed.program.files.find((file) =>
        file.name === deployed.program.main
      )?.contents ?? ""
      : await deps.readTextFile(entry);
    const doc = {
      ...patternDocMetadata(source),
      ...(deployed.description === undefined
        ? {}
        : { description: deployed.description }),
    };
    const response = await client.publishPattern({
      ...publishRequestFor({
        patternId,
        program: deployed.program,
        // Not the file's name, which can say more than its author meant to
        // once a version is shared.
        description: doc.description ?? "A pattern with no description yet.",
        hashtags: normalizeHashtags(doc.hashtags),
        keywords: doc.keywords,
        ...(remixedFrom === undefined ? {} : { remixedFrom }),
      }),
      slot,
      origin: deployed.versionOrigin ?? "self",
      deployedTo,
      ...(deployed.keepPrivate === true ? { keepPrivate: true } : {}),
    });
    return { status: "recorded", created: response.created, response };
  } catch (error) {
    return { status: "failed", reason: failureReason(error) };
  }
}

/**
 * Keeps a deploy of the person's own source as a private version in the
 * pattern index `CF_PATTERN_INDEX_URL` names, else the default index,
 * signing as `identity` (a key file's path) and keeping this machine's
 * index state where `cf` keeps it, so the lineage is the one `cf` deploys
 * continue. Never throws: the deploy it follows has committed, and an index
 * that is misconfigured or unreachable must not turn that into a failure.
 */
export async function recordVersionInIndex(
  identity: string,
  deployed: DeployedSource,
): Promise<VersionOutcome> {
  let baseUrl: string;
  let store: PatternIndexStore;
  try {
    baseUrl = resolvePatternIndexUrl(undefined);
    store = new PatternIndexStore(patternIndexStoreDir(baseUrl));
  } catch (error) {
    return { status: "failed", reason: describeFailure(error) };
  }
  return await recordDeployedVersion(deployed, {
    store,
    openClient: async () =>
      openPatternIndexClient({
        baseUrl,
        signer: await loadIdentity(identity),
        store,
      }),
    readTextFile: (path) => Deno.readTextFile(path),
  });
}

/**
 * Whether the index keeps private versions, asked once and remembered: an
 * index from before them has no sharing setting to answer with, and would
 * store a deploy's source where anyone may fetch it by id.
 */
const keepsVersions = async (
  client: Pick<PatternIndexClient, "getSharingSettings">,
  store: PatternIndexStore,
): Promise<boolean> => {
  if (await store.keepsVersions()) return true;
  try {
    await client.getSharingSettings();
  } catch (error) {
    if (error instanceof PatternIndexError && error.status === 404) {
      return false;
    }
    throw error;
  }
  await store.recordKeepsVersions();
  return true;
};

/** A failure in words the person can act on, quoting no index detail. */
const failureReason = (error: unknown): string => {
  if (error instanceof PatternIndexError) {
    if (error.status === 401 || error.status === 403) {
      return "this identity is not a member of the index (cf index join)";
    }
    return error.message;
  }
  return describeFailure(error);
};

/**
 * The line a deploy prints about its version, or `undefined` for none: a
 * machine that never joined hears it once, and a deploy that is not the
 * person's own work says nothing.
 */
export function versionLine(outcome: VersionOutcome): string | undefined {
  switch (outcome.status) {
    case "not-joined":
      return outcome.firstTime
        ? "Not keeping versions of this pattern: this machine has not joined a pattern index (cf index join). You will not be told again."
        : undefined;
    case "skipped":
      return undefined;
    case "failed":
      return `Version not kept: ${outcome.reason}. The deploy itself succeeded.`;
    case "recorded": {
      const { response } = outcome;
      const kept = outcome.created
        ? `Kept as private version ${
          response.seq ?? "?"
        }; cf pattern history lists them.`
        : "No new version: your newest one already has this source.";
      return response.autoShare === "when_used"
        ? `${kept} Your sharing setting shares it anonymously once you have used it in a loom for a day with no newer version.`
        : kept;
    }
  }
}

/** A version outcome as a `--json` report carries it. */
export function versionJson(outcome: VersionOutcome): Record<string, unknown> {
  switch (outcome.status) {
    case "recorded": {
      const { response } = outcome;
      return {
        status: outcome.created ? "recorded" : "unchanged",
        ...(response.seq === undefined ? {} : { version: response.seq }),
        ...(response.visibility === undefined
          ? {}
          : { visibility: response.visibility }),
        ...(response.autoShare === undefined
          ? {}
          : { autoShare: response.autoShare }),
      };
    }
    case "not-joined":
      return { status: "not-joined" };
    case "skipped":
    case "failed":
      return { status: outcome.status, reason: outcome.reason };
  }
}

/** The caller's lineage kept for `entry`, or `undefined` for none yet. */
export async function lineageForEntry(
  client: Pick<PatternIndexClient, "listLineages">,
  entry: string,
  sources: SlotSources,
): Promise<PatternIndexLineage | undefined> {
  const slot = await entrySlot(entry, sources);
  const { lineages } = await client.listLineages();
  return lineages.find((lineage) => lineage.slot === slot);
}
