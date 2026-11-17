/**
 * Private versions: every deploy of a person's own pattern from `cf` (`cf
 * piece new <file>`, `cf piece setsrc`) is kept in the pattern index as a
 * version only they can read, so they get history and rollback without git
 * and without ever running a save command. The index shares a version
 * anonymously on its own when the person's sharing setting says to, after
 * its privacy gardener passes it; `cf` only reports what it did.
 *
 * The index is never in the deploy's way. The version is recorded after the
 * deploy commits, a failure is reported in one line and never changes the
 * deploy's outcome, and a machine that never joined an index makes no index
 * call at all: it is told so once, and then nothing.
 *
 * A pattern is recognized across deploys by its entry file: the lineage's
 * slot is a hash of the file's absolute path, so the index never stores the
 * person's directory names.
 */

import { basename, resolve } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import type { RuntimeProgram } from "@commonfabric/runner";
import {
  type PatternIndexClient,
  PatternIndexError,
  type PatternIndexLineage,
  type PatternIndexPublishResponse,
} from "@commonfabric/pattern-index/client";
import {
  patternDocMetadata,
  publishRequestFor,
} from "@commonfabric/pattern-index/publish";
import type { PatternIndexStore } from "@commonfabric/pattern-index/store";

/** The lineage slot `cf` records an entry file's versions under. */
export async function entrySlot(entry: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(resolve(entry)),
  );
  return `cf-path:${encodeHex(new Uint8Array(digest))}`;
}

/** One deploy, as the deploying command saw it. */
export interface DeployedSource {
  /** The entry file the deploy read. */
  entry: string;

  program: RuntimeProgram;

  /** The content-addressed id the deploy committed, when it could be read. */
  patternId?: string;

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
    Pick<PatternIndexClient, "publishPattern" | "getPattern">
  >;

  readTextFile: (path: string) => Promise<string>;
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
    if (deployed.patternId === undefined) {
      return {
        status: "failed",
        reason: "the deploy's pattern id could not be read back",
      };
    }
    const entry = resolve(deployed.entry);
    const client = await deps.openClient();
    // Source fetched from someone else's pattern and deployed unchanged is
    // still theirs; once edited it is the person's own remix.
    const fetchedFrom = await deps.store.sourceOf(entry);
    let remixedFrom: string | undefined;
    if (fetchedFrom !== undefined) {
      const source = await client.getPattern({ patternId: fetchedFrom })
        .catch(() => undefined);
      if (source?.mine !== true) {
        if (fetchedFrom === deployed.patternId) {
          return {
            status: "skipped",
            reason: `it is ${fetchedFrom} unchanged, someone else's pattern`,
          };
        }
        remixedFrom = fetchedFrom;
      }
    }
    const doc = patternDocMetadata(await deps.readTextFile(entry));
    const response = await client.publishPattern({
      ...publishRequestFor({
        patternId: deployed.patternId,
        program: deployed.program,
        description: doc.description ?? basename(entry),
        hashtags: doc.hashtags.map((tag) =>
          tag.replace(/^#/, "").toLowerCase()
        ),
        keywords: doc.keywords,
        ...(remixedFrom === undefined ? {} : { remixedFrom }),
      }),
      slot: await entrySlot(entry),
      origin: "self",
    });
    return { status: "recorded", created: response.created, response };
  } catch (error) {
    return { status: "failed", reason: failureReason(error) };
  }
}

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
      if (!outcome.created) {
        return "No new version: your newest one already has this source.";
      }
      return `Kept as version ${response.seq ?? "?"} (${
        shareNote(response)
      }); cf pattern history lists them.`;
    }
  }
}

/** What the index did about sharing a version, in a few words. */
const shareNote = (response: PatternIndexPublishResponse): string => {
  switch (response.autoShare) {
    case "requested":
      return "private; shared anonymously once the privacy check passes";
    case "already_shared":
      return "shared";
    case "not_eligible":
      return `private; not shared${
        response.reason === undefined ? "" : `: ${response.reason}`
      }`;
    case "sharing_off":
    case "kept_private":
    case undefined:
      return "private";
  }
};

/** The caller's lineage kept for `entry`, or `undefined` for none yet. */
export async function lineageForEntry(
  client: Pick<PatternIndexClient, "listLineages">,
  entry: string,
): Promise<PatternIndexLineage | undefined> {
  const slot = await entrySlot(entry);
  const { lineages } = await client.listLineages();
  return lineages.find((lineage) => lineage.slot === slot);
}
