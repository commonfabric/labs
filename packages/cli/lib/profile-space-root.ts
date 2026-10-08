/**
 * The store-wide repair that makes each existing profile its space's root,
 * run by an operator. Which profiles exist is read offline from a snapshot of
 * the store's space databases; where each one stands, and any write, is read
 * and made live, through an ordinary connection as the operator's own
 * identity. `docs/common/conventions/HOME_SPACE.md` describes what a repaired
 * profile is, and the CLI README describes running the repair.
 */

import { hashStringOf } from "@commonfabric/data-model";
import { isDID } from "@commonfabric/identity/did";
import {
  inspectProfileSpaceRoot,
  type ProfileSpaceRootInspection,
  type ProfileSpaceRootStatus,
  repairProfileSpaceRoot,
} from "@commonfabric/piece/ops";
import { parseCellReference } from "@commonfabric/runner/shared";
import {
  discoverProfiles,
  discoverSpaceDbs,
} from "@commonfabric/state-inspector";

import { loadPieces, type SpaceConfig } from "./piece.ts";

/** What the repair is asked to do. */
export interface ProfileSpaceRootConfig extends Omit<SpaceConfig, "space"> {
  /** A directory holding a snapshot of the store's space databases. */
  snapshot: string;

  /**
   * Full profile addresses to repair instead of every profile a Home lists,
   * which is how a profile no Home lists is repaired.
   */
  cells?: readonly string[];

  /** The `inspection` of a run whose plan is to be applied. */
  expectedInspection?: string;
}

/** One profile's row of the report. */
export type ProfileSpaceRootRow =
  & {
    /** The space and id the profile was named by. */
    named: { space: string; id: string };

    /** The Home listing it, when one in the snapshot does. */
    home?: string;
  }
  & (
    | ProfileSpaceRootInspection
    | {
      status: "unlisted" | "failed";
      action: "none";
      reason: string;
    }
  );

/** The whole report: one row per profile, a tally, and the run's receipt. */
export interface ProfileSpaceRootReport {
  /** Whether this run applied its plan, rather than only inspecting. */
  applied: boolean;

  /** A hash of every row's status, action and receipt. */
  inspection: string;

  rows: ProfileSpaceRootRow[];

  /** How many rows have each status. */
  summary: Partial<
    Record<ProfileSpaceRootStatus | "unlisted" | "failed", number>
  >;
}

/** Injectable effects, so a test can stand in for the live connection. */
export interface ProfileSpaceRootDeps {
  load?: typeof loadPieces;
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

/**
 * Inspects every profile the snapshot's Homes list, or the profiles
 * `config.cells` names, and returns a row for each, plus a row for each
 * profile-shaped piece no Home lists, which is skipped. With
 * `config.expectedInspection`, it inspects again first, and applies the plan
 * only when the run's receipt is the one given, profile by profile; a
 * profile whose own receipt has changed by the time its turn comes, or whose
 * inspection failed, is reported as `failed` and left alone.
 *
 * @throws Error when the snapshot holds no space database, when a named
 *   address is not a full profile address, or when the run's receipt differs
 *   from `config.expectedInspection`.
 */
export async function profileSpaceRoot(
  config: ProfileSpaceRootConfig,
  deps: ProfileSpaceRootDeps = {},
): Promise<ProfileSpaceRootReport> {
  const load = deps.load ?? loadPieces;
  const discovered = discoverSpaceDbs({
    dirs: [config.snapshot],
    defaultRoots: false,
  });
  if (discovered.length === 0) {
    throw new Error(`No space databases under ${config.snapshot}`);
  }
  const { listed, unlisted } = discoverProfiles(discovered);
  const homeOf = new Map(listed.map((p) => [`${p.space} ${p.id}`, p.home]));
  // One target per profile address, however many times a Home's list or the
  // command line names it.
  const targets = [
    ...new Map(
      (config.cells === undefined ? listed : config.cells.map(namedTarget))
        .map((t): [string, Target] => {
          const key = `${t.space} ${t.id}`;
          const home = homeOf.get(key);
          return [key, {
            space: t.space,
            id: t.id,
            ...(home === undefined ? {} : { home }),
          }];
        }),
    ).values(),
  ];
  const skipped: ProfileSpaceRootRow[] = config.cells === undefined
    ? unlisted.map((p) => ({
      named: { space: p.space, id: p.id },
      status: "unlisted" as const,
      action: "none" as const,
      reason: "no Home in the snapshot lists it; name it to repair it",
    }))
    : [];

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

  const inspected = report(
    await each((pieces, target) => inspectProfileSpaceRoot(pieces, target.id)),
    false,
  );
  if (config.expectedInspection === undefined) return inspected;
  if (inspected.inspection !== config.expectedInspection) {
    throw new Error(
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
