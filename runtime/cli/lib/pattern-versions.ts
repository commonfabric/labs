/**
 * Private versions: every deploy of a person's own pattern from `cf` (`cf
 * piece new <file>`, `cf piece setsrc`) is kept in the pattern index as a
 * version only they can read, so they get history and rollback without git
 * and without ever running a save command.
 *
 * A deploy never shares. Drafts land many times an hour, and a pattern is
 * worth others' time, and the privacy gardener's, once it works, which
 * `cf pattern share` marks. When the person's sharing setting asks that what
 * they build be shared, the deploy's line says to run it then.
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
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import type { RuntimeProgram } from "@commonfabric/runner";
import {
  type PatternIndexClient,
  PatternIndexError,
  type PatternIndexLineage,
  type PatternIndexPublishResponse,
  type PatternIndexSharingSettings,
} from "@commonfabric/pattern-index/client";
import {
  patternDocMetadata,
  publishRequestFor,
} from "@commonfabric/pattern-index/publish";
import type { PatternIndexStore } from "@commonfabric/pattern-index/store";
import { shellWord } from "./shell-quote.ts";

/** The git checkout a file is in: its top directory and `origin` remote. */
export interface GitCheckout {
  root: string;
  remote: string;
}

/** The checkout `dir` is in, or `undefined` outside one or without `origin`. */
export async function gitCheckoutOf(
  dir: string,
): Promise<GitCheckout | undefined> {
  const git = async (...args: string[]) => {
    const { code, stdout } = await new Deno.Command("git", {
      args: ["-C", dir, ...args],
      stdout: "piped",
      stderr: "null",
    }).output().catch(() => ({ code: 1, stdout: new Uint8Array() }));
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
 * taken out: scheme, user, a trailing `.git`, and the `host:path` form.
 */
const normalizeRemote = (remote: string): string =>
  remote.trim()
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();

const sha256Hex = async (text: string): Promise<string> =>
  encodeHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  );

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
  return `cf-git:${await sha256Hex(
    `${normalizeRemote(checkout.remote)}\n${inRepo}`,
  )}`;
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
   * The origin `setsrc --origin` recorded: the piece follows a system or
   * repository pattern, which is not the person's own work.
   */
  origin?: string;
}

/** What recording a deploy as a version came to. */
export type VersionOutcome =
  | {
    status: "recorded";

    /** `false` when the lineage's newest version already had this source. */
    created: boolean;

    response: PatternIndexPublishResponse;

    /** The entry file, as the deploy named it. */
    entry: string;

    /**
     * Whether the person's sharing setting asks that what they build be
     * shared: a deploy keeps every version private, and
     * `cf pattern share` shares one once it works.
     */
    shareWhenReady: boolean;
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
 * entry file. Never throws: every way it can fail is an outcome.
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
    const settings = await sharingSettings(client, deps.store);
    if (settings === "keeps no versions") {
      return {
        status: "skipped",
        reason: "this pattern index does not keep private versions yet",
      };
    }
    const sources: SlotSources = {
      pathKey: () => deps.store.slotKey(),
      ...(deps.checkoutOf === undefined ? {} : { checkoutOf: deps.checkoutOf }),
    };
    const slot = await entrySlot(entry, sources);
    // Source fetched from someone else's pattern and deployed unchanged is
    // still theirs; once edited it is the person's own remix.
    const fetchedFrom = await deps.store.sourceOf(entry);
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
    const doc = patternDocMetadata(await deps.readTextFile(entry));
    // Every deploy stays private, whatever the sharing setting says: a
    // pattern is shared at a point where it works, which `cf pattern share`
    // marks, never as each draft lands.
    const response = await client.publishPattern({
      ...publishRequestFor({
        patternId,
        program: deployed.program,
        // Not the file's name, which can say more than its author meant to
        // once a version is shared.
        description: doc.description ?? "A pattern with no description yet.",
        hashtags: doc.hashtags.map((tag) =>
          tag.replace(/^#/, "").toLowerCase()
        ),
        keywords: doc.keywords,
        ...(remixedFrom === undefined ? {} : { remixedFrom }),
      }),
      slot,
      origin: "self",
      keepPrivate: true,
    });
    const setting = await settings;
    return {
      status: "recorded",
      created: response.created,
      response,
      entry: deployed.entry,
      shareWhenReady: setting?.enabled === true && setting.selfBuilt === true,
    };
  } catch (error) {
    return { status: "failed", reason: failureReason(error) };
  }
}

/**
 * The person's sharing setting, read alongside the version it informs, or
 * `"keeps no versions"` for an index from before private versions, which
 * answers it with 404 and would store a deploy's source where anyone may
 * fetch it by id. The first answer is remembered, so only the first deploy
 * against an index waits for the read before sending anything; a later read
 * that fails answers `undefined`.
 */
const sharingSettings = async (
  client: Pick<PatternIndexClient, "getSharingSettings">,
  store: PatternIndexStore,
): Promise<
  Promise<PatternIndexSharingSettings | undefined> | "keeps no versions"
> => {
  if (await store.keepsVersions()) {
    return client.getSharingSettings().catch(() => undefined);
  }
  let settings: PatternIndexSharingSettings;
  try {
    settings = await client.getSharingSettings();
  } catch (error) {
    if (error instanceof PatternIndexError && error.status === 404) {
      return "keeps no versions";
    }
    throw error;
  }
  await store.recordKeepsVersions();
  return Promise.resolve(settings);
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
      return outcome.shareWhenReady && response.visibility === "private"
        ? `${kept} Your sharing setting shares what you build: once it works, run cf pattern share ${
          shellWord(outcome.entry)
        }.`
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
        shareWhenReady: outcome.shareWhenReady,
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
