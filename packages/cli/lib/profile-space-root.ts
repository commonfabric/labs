/**
 * The repair that makes each existing profile its space's root, run by an
 * operator across a whole store or by a person over their own Home's
 * profiles. Which profiles exist is read offline from a snapshot of the
 * store's space databases, or live from the person's Home; where each one
 * stands, and any write, is read and made live, through an ordinary connection
 * as the running identity. `docs/common/conventions/HOME_SPACE.md` describes
 * what a repaired profile is, and the CLI README describes running the repair.
 */

import { hashStringOf } from "@commonfabric/data-model";
import { isDID } from "@commonfabric/identity/did";
import {
  inspectProfileSpaceRoot,
  listedProfiles,
  type ProfileSpaceRootInspection,
  type ProfileSpaceRootStatus,
  repairProfileSpaceRoot,
} from "@commonfabric/piece/ops";
import type { MemorySpace } from "@commonfabric/runner";
import { parseCellReference } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import {
  discoverProfiles,
  discoverSpaceDbs,
} from "@commonfabric/state-inspector";

import { loadIdentity } from "./identity.ts";
import { loadPieces, type SpaceConfig } from "./piece.ts";

/**
 * Which repair this is. A caller that records having run it to a clean finish
 * runs it again when this number rises.
 */
export const PROFILE_ROOT_REPAIR_VERSION = 1;

/** Why a run stopped before it wrote anything. */
export type ProfileSpaceRootRefusalReason =
  | "server-execution"
  | "server-execution-unknown"
  | "inspection-changed";

/**
 * The exit status `cf profile repair-root` ends with for each refusal: one
 * for an apply whose receipt no longer matches, one for a server that runs
 * server execution or does not say.
 */
export const PROFILE_ROOT_REPAIR_REFUSAL_EXIT_CODES: Readonly<
  Record<ProfileSpaceRootRefusalReason, number>
> = {
  "inspection-changed": 3,
  "server-execution": 4,
  "server-execution-unknown": 4,
};

/**
 * A run that stopped, having written nothing, for `reason`; `space` names the
 * space whose server refused, for a refusal over server execution.
 */
export class ProfileSpaceRootRefusal extends Error {
  constructor(
    readonly reason: ProfileSpaceRootRefusalReason,
    message: string,
    readonly space?: string,
  ) {
    super(message);
    this.name = "ProfileSpaceRootRefusal";
  }
}

/** What the repair is asked to do. */
export interface ProfileSpaceRootConfig extends Omit<SpaceConfig, "space"> {
  /**
   * A directory holding a snapshot of the store's space databases, whose
   * Homes' lists name the profiles to repair. Exactly one of this and `home`
   * is given.
   */
  snapshot?: string;

  /**
   * The space of a Home, read live as the running identity, whose list names
   * the profiles to repair: the running identity's own, for a person
   * repairing their own profiles.
   */
  home?: string;

  /**
   * Full profile addresses to repair instead of every profile a Home in the
   * snapshot lists, which is how a profile no Home lists is repaired. Given
   * only with `snapshot`.
   */
  cells?: readonly string[];

  /** The `inspection` of a run whose plan is to be applied. */
  expectedInspection?: string;
}

/**
 * One profile's row of the report, or, as `unreadable`, one space of the
 * snapshot that could not be read, which names no profile.
 */
export type ProfileSpaceRootRow =
  & {
    /** The space and id the profile was named by; a space alone if unreadable. */
    named: { space: string; id?: string };

    /** The Home listing it, when one in the snapshot does. */
    home?: string;
  }
  & (
    | ProfileSpaceRootInspection
    | {
      status: "unlisted" | "unreadable" | "failed";
      action: "none";
      reason: string;
    }
  );

/** The whole report: one row per profile, a tally, and the run's receipt. */
export interface ProfileSpaceRootReport {
  /** `PROFILE_ROOT_REPAIR_VERSION`, the repair that produced this report. */
  repairVersion: number;

  /** Whether this run applied its plan, rather than only inspecting. */
  applied: boolean;

  /** A hash of every row's status, action and receipt. */
  inspection: string;

  rows: ProfileSpaceRootRow[];

  /** How many rows have each status. */
  summary: Partial<
    Record<
      ProfileSpaceRootStatus | "unlisted" | "unreadable" | "failed",
      number
    >
  >;
}

/** Injectable effects, so a test can stand in for the live connection. */
export interface ProfileSpaceRootDeps {
  load?: typeof loadPieces;

  /**
   * Reads the flags the server holding `config.space` reports in its
   * handshake, opening no session there.
   */
  serverFlags?: (config: SpaceConfig) => Promise<ServerFlags>;
}

type ServerFlags = Awaited<
  ReturnType<ReturnType<typeof StorageManager.open>["serverFlags"]>
>;

/** The default `ProfileSpaceRootDeps.serverFlags`, over a fresh connection. */
async function readServerFlags(config: SpaceConfig): Promise<ServerFlags> {
  const manager = StorageManager.open({
    as: await loadIdentity(config.identity),
    memoryHost: new URL(config.apiUrl),
  });
  try {
    return await manager.serverFlags(config.space as MemorySpace);
  } finally {
    await manager.close();
  }
}

interface Target {
  space: string;
  id: string;
  home?: string;
}

/** Helper for `profileSpaceRoot()`, which parses one `--cell` address. */
function namedTarget(cell: string): Target {
  const ref = parseCellReference(cell);
  if (
    !isDID(ref.space) || !ref.id.startsWith("of:") ||
    ref.path.length !== 0 || ref.member !== undefined ||
    ref.pin !== undefined ||
    (ref.scope !== undefined && ref.scope !== "space")
  ) {
    throw new Error(
      "A profile to repair is named by a full cell address with a space DID, no member or path, and space scope.",
    );
  }
  return { space: ref.space, id: ref.id };
}

/** The profiles a run targets, and the rows of what it skips. */
interface Discovery {
  targets: Target[];
  skipped: ProfileSpaceRootRow[];
}

/** Helper for `profileSpaceRoot()`: one target per profile address. */
function dedupe(targets: Target[]): Target[] {
  // However many times a Home's list or the command line names it.
  return [...new Map(targets.map((t) => [`${t.space} ${t.id}`, t])).values()];
}

/**
 * Helper for `profileSpaceRoot()`, which reads the profiles the Homes of the
 * snapshot in `snapshot` list, or the ones `cells` names, and what it skips.
 */
function fromSnapshot(
  snapshot: string,
  cells: readonly string[] | undefined,
): Discovery {
  const discovered = discoverSpaceDbs({
    dirs: [snapshot],
    defaultRoots: false,
  });
  if (discovered.length === 0) {
    throw new Error(`No space databases under ${snapshot}`);
  }
  const { listed, unlisted, unreadable } = discoverProfiles(discovered);
  const homeOf = new Map(listed.map((p) => [`${p.space} ${p.id}`, p.home]));
  const targets = dedupe(
    (cells === undefined ? listed : cells.map(namedTarget)).map((t) => {
      const home = homeOf.get(`${t.space} ${t.id}`);
      return {
        space: t.space,
        id: t.id,
        ...(home === undefined ? {} : { home }),
      };
    }),
  );
  // A space the snapshot holds that could not be read may hold profiles no
  // other row names, so it is reported whatever the run targets.
  const skipped: ProfileSpaceRootRow[] = [
    ...(cells === undefined
      ? unlisted.map((p) => ({
        named: { space: p.space, id: p.id },
        status: "unlisted" as const,
        action: "none" as const,
        reason: "no Home in the snapshot lists it; name it to repair it",
      }))
      : []),
    ...unreadable.map((u) => ({
      named: { space: u.space },
      status: "unreadable" as const,
      action: "none" as const,
      reason: u.reason,
    })),
  ];
  return { targets, skipped };
}

/**
 * Inspects every profile the snapshot's Homes list, or the profiles
 * `config.cells` names, or every profile the Home at `config.home` lists, and
 * returns a row for each. A run over a snapshot adds a row for each
 * profile-shaped piece no Home lists, which is skipped, and one for each
 * space file of the snapshot that could not be read. With
 * `config.expectedInspection`, it inspects again first, and applies the plan
 * only when the run's receipt is the one given, profile by profile; a
 * profile whose own receipt has changed by the time its turn comes, or whose
 * inspection failed, is reported as `failed` and left alone.
 *
 * Before it opens a session on any space, the Home it reads included, it reads
 * that space's server handshake, and refuses to run when one reports server
 * execution, or does not say whether it runs it. A session opened on a space a
 * server executes has the server ensure that space's root, which in a profile
 * space with none writes a junk root, so not even an inspection would leave
 * the store as it found it.
 *
 * @throws Error when it is given both or neither of `config.snapshot` and
 *   `config.home`, or `config.cells` with `config.home`; when the snapshot
 *   holds no space database, or the Home's space holds no Home; when a named
 *   address is not a full profile address. `ProfileSpaceRootRefusal`, having
 *   written nothing, when a space's server runs server execution or does not
 *   say whether it does, or when the run's receipt differs from
 *   `config.expectedInspection`.
 */
export async function profileSpaceRoot(
  config: ProfileSpaceRootConfig,
  deps: ProfileSpaceRootDeps = {},
): Promise<ProfileSpaceRootReport> {
  const load = deps.load ?? loadPieces;
  const serverFlags = deps.serverFlags ?? readServerFlags;
  if ((config.snapshot === undefined) === (config.home === undefined)) {
    throw new Error(
      "A repair takes its profiles from a snapshot or from a Home, not both and not neither",
    );
  }
  if (config.home !== undefined && config.cells !== undefined) {
    throw new Error(
      "Profiles are named by address only in a repair that reads a snapshot",
    );
  }

  /**
   * Refuses to go on when the server holding `space` runs server execution,
   * or does not say whether it does. Called before any session opens there.
   */
  const refuseServerExecution = async (space: string) => {
    const flags = await serverFlags({ ...config, space });
    if (flags?.serverExecution !== false) {
      const runs = flags?.serverExecution === true;
      throw new ProfileSpaceRootRefusal(
        runs ? "server-execution" : "server-execution-unknown",
        `The server at ${config.apiUrl} ${
          runs
            ? "runs server execution"
            : "does not say whether it runs server execution"
        } for ${space}, so opening a profile space there can write a root into it. Serve the store with server execution off and run the repair against that server, as "Making existing profiles their space's root" in the CLI README describes.`,
        space,
      );
    }
  };

  /** The profiles a Home's live list names, read as the running identity. */
  const fromHome = async (home: string): Promise<Discovery> => {
    await refuseServerExecution(home);
    let pieces;
    try {
      pieces = await load({ ...config, space: home });
      return {
        targets: dedupe(
          (await listedProfiles(pieces)).map((t) => ({ ...t, home })),
        ),
        skipped: [],
      };
    } finally {
      await pieces?.dispose();
    }
  };

  const { targets, skipped } = config.snapshot !== undefined
    ? fromSnapshot(config.snapshot, config.cells)
    : await fromHome(config.home!);

  /** Runs `step` over each target, each over a connection to its space. */
  const each = async (
    step: (
      pieces: Awaited<ReturnType<typeof loadPieces>>,
      target: Target,
      index: number,
    ) => Promise<ProfileSpaceRootInspection>,
  ): Promise<ProfileSpaceRootRow[]> => {
    const rows: ProfileSpaceRootRow[] = [];
    for (const [index, target] of targets.entries()) {
      const named = { space: target.space, id: target.id };
      const home = target.home === undefined ? {} : { home: target.home };
      let pieces;
      try {
        pieces = await load({ ...config, space: target.space });
        rows.push({ named, ...home, ...await step(pieces, target, index) });
      } catch (error) {
        rows.push({
          named,
          ...home,
          status: "failed",
          action: "none",
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await pieces?.dispose();
      }
    }
    return rows;
  };

  const report = (
    rows: ProfileSpaceRootRow[],
    applied: boolean,
  ): ProfileSpaceRootReport => {
    const all = [...rows, ...skipped];
    const summary: ProfileSpaceRootReport["summary"] = {};
    for (const row of all) summary[row.status] = (summary[row.status] ?? 0) + 1;
    return {
      repairVersion: PROFILE_ROOT_REPAIR_VERSION,
      applied,
      inspection: hashStringOf(
        all.map((row) => ({
          named: row.named,
          status: row.status,
          action: row.action,
          receipt: "inspection" in row ? row.inspection : row.reason,
        })),
      ),
      rows: all,
      summary,
    };
  };

  for (const space of new Set(targets.map((t) => t.space))) {
    await refuseServerExecution(space);
  }

  const inspected = report(
    await each((pieces, target) => inspectProfileSpaceRoot(pieces, target.id)),
    false,
  );
  if (config.expectedInspection === undefined) return inspected;
  if (inspected.inspection !== config.expectedInspection) {
    throw new ProfileSpaceRootRefusal(
      "inspection-changed",
      "The profiles changed after inspection; inspect them again before applying",
    );
  }
  return report(
    await each((pieces, target, index) => {
      const row = inspected.rows[index];
      return "inspection" in row
        ? repairProfileSpaceRoot(pieces, target.id, row.inspection)
        : Promise.reject(new Error(row.reason));
    }),
    true,
  );
}
