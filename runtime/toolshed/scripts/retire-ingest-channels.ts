/**
 * Mass-revoke ingest channels — the operator lever for a trust event.
 *
 * Why this is a script and not a runtime concept:
 *
 * A minted token is a durable append capability that outlives the conditions
 * which authorized it. The forcing case is the fix to passphrase-derived space
 * keys: until that lands, anyone who knew a space NAME could sign as that
 * space, grant themselves OWNER, and mint entirely legitimately. Fixing the
 * derivation stops new abuse and retracts nothing already issued.
 *
 * The tempting design is a "trust epoch" stamped on every registration and
 * compared on every POST. That buys a declarative, atomic cutover — and pays
 * for it with a field, an env var, and a hot-path branch that live forever to
 * serve an event that happens once. Not worth it.
 *
 * Revocation already does the job, and it is already the right shape: it is
 * fail-closed (the data plane refuses a revoked channel even with a valid
 * token), it is loud (a correct token gets an actionable 403 telling the device
 * to re-pair, not a blank 401), and it retains the registration as an audit
 * record. Retiring a population is therefore just "revoke all of it" — a
 * deliberate operator action, at a moment of the operator's choosing.
 *
 * Re-minting is the manual conversion: an owner runs `cf ingest mint` again,
 * which re-authorizes the channel under the new conditions and clears the
 * revocation while preserving its history.
 *
 * TRADE-OFF, stated so it is a known property rather than a surprise: this is
 * imperative, so it is not atomic. A channel minted between the run and the
 * cutover is missed. Re-run it (it is idempotent) or take the control plane
 * down for the migration, and use `audit-ingest-channels` to confirm.
 *
 * Usage:
 *   deno task retire-ingest-channels --reason "space-key-derivation-fix"
 *   deno task retire-ingest-channels --reason "..." --confirm
 *
 * Dry run by default; nothing is written without --confirm.
 */

import { parseArgs } from "@std/cli/parse-args";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import env from "@/env.ts";
import { identity } from "@/lib/identity.ts";
import {
  getRegistration,
  getRegistrationIndex,
  RegistrationConflictError,
  saveRegistration,
} from "@/routes/ingest/ingest.utils.ts";
import { ingestServiceSpace } from "@/routes/ingest/service-space.ts";
import { plainRevocations } from "@/routes/ingest-channels/ingest-channels.utils.ts";

export interface RetirePlan {
  /** Channels this run would retire (or did, when `confirm`). */
  retired: { id: string; space: string; installId: string; owner: string }[];

  /** Already revoked, so left alone. */
  skipped: number;

  /**
   * Changed underneath the sweep and therefore NOT retired. Re-running picks
   * them up; reporting them is what keeps the sweep from claiming completeness
   * it does not have.
   */
  conflicted: string[];
}

/**
 * Retire every live channel (optionally scoped to one space). Pure over the
 * runtime so the selection logic is testable without a deployment; `confirm`
 * is what makes it write.
 */
export async function retireChannels(
  runtime: Runtime,
  serviceSpace: string,
  options: { reason: string; space?: string; confirm?: boolean; now?: Date },
): Promise<RetirePlan> {
  const ids = await getRegistrationIndex(runtime, serviceSpace);
  const at = (options.now ?? new Date()).toISOString();
  // `by` is a DID for a user-initiated revoke; a marker here keeps operator
  // retirements distinguishable in the audit trail.
  const by = `operator:${options.reason}`;

  const plan: RetirePlan = { retired: [], skipped: 0, conflicted: [] };
  for (const id of ids) {
    const r = await getRegistration(runtime, serviceSpace, id);
    if (!r) continue;
    if (options.space && r.space !== options.space) continue;
    if (r.revoked) {
      plan.skipped++;
      continue;
    }

    if (options.confirm) {
      // Rebuild the history as plain objects: values read back from a cell are
      // deep-frozen, and re-embedding them into a new array does not
      // round-trip — the array reads back absent, silently.
      const history = plainRevocations(r.revocations);
      try {
        await saveRegistration(
          runtime,
          serviceSpace,
          {
            ...r,
            enabled: false,
            revoked: { at, by },
            revision: (r.revision ?? 0) + 1,
            ...(history !== undefined ? { revocations: history } : {}),
          },
          // Optimistic, like every other lifecycle write. A rotate that read
          // this registration before the sweep reached it would otherwise still
          // satisfy its own precondition afterwards, land, and bring the
          // channel back live with the retirement erased from the history — and
          // a sweep over thousands of channels is long enough for that to be
          // ordinary rather than a narrow race.
          r.revision ?? 0,
        );
      } catch (error) {
        if (error instanceof RegistrationConflictError) {
          plan.conflicted.push(id);
          continue;
        }
        throw error;
      }
    }

    plan.retired.push({
      id,
      space: r.space,
      installId: r.installId,
      owner: r.owner ?? "<operator-provisioned>",
    });
  }
  return plan;
}

/** The whole command minus argv parsing and runtime construction. */
export async function runRetire(
  runtime: Runtime,
  serviceSpace: string,
  flags: { reason: string; space?: string; confirm?: boolean },
): Promise<string[]> {
  const plan = await retireChannels(runtime, serviceSpace, flags);
  const out = plan.retired.map((row) =>
    `${flags.confirm ? "retiring" : "would retire"}  ${row.id}  ` +
    `space=${row.space}  installId=${row.installId}  owner=${row.owner}`
  );
  out.push(
    `\n${flags.confirm ? "Retired" : "Would retire"} ${plan.retired.length} ` +
      `channel(s); ${plan.skipped} already revoked.`,
  );
  if (plan.conflicted.length > 0) {
    out.push(
      `\n${plan.conflicted.length} channel(s) changed mid-sweep and were NOT ` +
        `retired — re-run to pick them up:\n  ${plan.conflicted.join("\n  ")}`,
    );
  }
  out.push(
    flags.confirm
      ? "\nOwners re-mint with `cf ingest mint` when they are ready; a device\n" +
        "still holding an old token gets a 403 telling it to re-pair.\n" +
        "Run `deno task audit-ingest-channels` to confirm the result.\n"
      : "Dry run — nothing written. Re-run with --confirm.\n",
  );
  return out;
}

export const USAGE =
  "usage: deno task retire-ingest-channels --reason <why> [--space <did>] [--confirm]\n\n" +
  "  --reason is recorded on every revocation, so the audit trail says WHY\n" +
  "  these were retired. Make it meaningful, e.g. 'space-key-derivation-fix'.";

/** Build the runtime this command talks to. Replaced in tests. */
export const defaultRuntime = (): Runtime =>
  new Runtime({
    apiUrl: new URL(env.MEMORY_URL),
    storageManager: StorageManager.open({
      memoryHost: new URL(env.MEMORY_URL),
      as: identity,
    }),
  });

export async function main(
  args: string[],
  makeRuntime: () => Runtime = defaultRuntime,
  serviceSpace: string = ingestServiceSpace,
  log: (line: string) => void = console.log,
  logError: (line: string) => void = console.error,
): Promise<number> {
  const flags = parseArgs(args, {
    string: ["reason", "space"],
    boolean: ["confirm"],
  });
  if (!flags.reason) {
    logError(USAGE);
    return 2;
  }
  const runtime = makeRuntime();
  try {
    const lines = await runRetire(runtime, serviceSpace, {
      reason: flags.reason,
      space: flags.space,
      confirm: Boolean(flags.confirm),
    });
    await runtime.storageManager.synced();
    for (const line of lines) log(line);
    return 0;
  } finally {
    await runtime.dispose();
  }
}

if (import.meta.main) Deno.exit(await main(Deno.args));
