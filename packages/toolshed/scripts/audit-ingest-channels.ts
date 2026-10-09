/**
 * List every ingest channel this deployment has minted.
 *
 * Why: a minted token is a durable append capability into a user's space, and
 * the registration lives in the toolshed's own service space where no user can
 * see it. Without this, "what have we handed out, to whom, and is any of it
 * still in use" is unanswerable — which matters most on the day the answer
 * determines what has to be retired (see `retire-ingest-channels.ts`).
 *
 * This is the only production reader of the global registration index, which
 * exists precisely so channels are enumerable for audit.
 *
 * Usage:
 *   deno task audit-ingest-channels                  # human-readable
 *   deno task audit-ingest-channels --json           # machine-readable
 *   deno task audit-ingest-channels --repair-indexes # backfill by-space index
 *   deno task audit-ingest-channels --repair-indexes --recover known.txt
 *                                                    # also visit channels the
 *                                                    # index never learned of
 */

import { parseArgs } from "@std/cli/parse-args";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import env from "@/env.ts";
import { identity } from "@/lib/identity.ts";
import {
  channelId,
  getLastSeen,
  getRegistration,
  getRegistrationIndex,
  type IngestRegistration,
  RegistrationConflictError,
  saveRegistration,
} from "@/routes/ingest/ingest.utils.ts";
import { ingestServiceSpace } from "@/routes/ingest/service-space.ts";

export const stateOf = (r: IngestRegistration): string =>
  r.revoked ? "revoked" : r.enabled ? "active" : "disabled";

export interface ChannelRow {
  id: string;
  space: string;
  installId: string;
  owner: string;
  state: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastSeenAt: string | null;
}

/** The audit rows, ordered as the index holds them. Pure over the runtime. */
export async function collectRows(
  runtime: Runtime,
  serviceSpace: string,
  /**
   * Re-write each live registration it walks, which repairs the per-space
   * index. Channels provisioned before that index existed carry no entry, so
   * the space's current owner cannot see them in `cf ingest ls --space` — and
   * an operator-provisioned channel has no `owner`, so nobody else can either.
   * Off by default: an audit should not write unless asked.
   *
   * LIMIT: this walks the audit index, so on its own it cannot recover a
   * registration that is missing FROM that index. Until this change the index
   * write was best-effort and its failure swallowed, so such a channel can
   * exist. `candidates` is how you find them — see {@link recoverIds}.
   */
  repairIndexes = false,
  /**
   * Extra channel ids to visit, over and above the audit index. Any that
   * resolve are reported and — with `repairIndexes` — reindexed, which is what
   * makes a registration the index never learned about recoverable.
   */
  candidates: string[] = [],
): Promise<ChannelRow[]> {
  const ids = [
    ...new Set([
      ...await getRegistrationIndex(runtime, serviceSpace),
      ...candidates,
    ]),
  ];
  const rows: ChannelRow[] = [];
  for (const id of ids) {
    const r = await getRegistration(runtime, serviceSpace, id);
    // An id that does not resolve is skipped rather than trusted.
    if (!r) continue;
    if (repairIndexes && r.enabled && r.revoked === undefined) {
      // Same revision, so this loses to any concurrent lifecycle write rather
      // than clobbering it.
      try {
        await saveRegistration(runtime, serviceSpace, r, r.revision ?? 0);
      } catch (error) {
        // A channel that moved under us is already being maintained, so a lost
        // precondition is benign. Anything else means the repair did NOT
        // happen, and a repair that reports success while leaving a channel
        // undiscoverable is worse than one that fails.
        if (!(error instanceof RegistrationConflictError)) throw error;
      }
    }
    rows.push({
      id: r.id,
      space: r.space,
      installId: r.installId,
      // Operator-provisioned channels carry no verified owner — worth seeing,
      // since those are exactly the ones no user can revoke for themselves.
      owner: r.owner ?? "<operator-provisioned>",
      state: stateOf(r),
      createdAt: r.createdAt,
      expiresAt: r.expiresAt ?? null,
      revokedAt: r.revoked?.at ?? null,
      lastSeenAt: await getLastSeen(runtime, serviceSpace, id),
    });
  }
  return rows;
}

/**
 * Turn a caller-supplied list of `<space> <installId>` pairs into channel ids.
 *
 * This is the answer to "what is the source of truth for a registration the
 * index never learned about". It cannot be the index — repairing an index by
 * enumerating that same index only ever finds what is already there. It cannot
 * be a scan of the service space either: the memory layer exposes no
 * space-wide enumeration, and reaching into its SQLite internals from an
 * operator script would couple the Operation layer to Foundation internals
 * that are actively changing.
 *
 * It does not need to be. A channel id is `channelId(space, installId)` —
 * derived, not random — and `provision-ingest-channel.ts` is the only thing
 * that ever created one, from arguments the operator chose. So the operator's
 * own provisioning record IS the source of truth, and probing it is exact: an
 * id either resolves to a registration or it does not.
 *
 * Blank lines and `#` comments are ignored so a hand-kept file can be
 * annotated.
 */
export function recoverIds(text: string): string[] {
  const ids: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const [space, installId] = line.split(/\s+/);
    if (space === undefined || installId === undefined) {
      throw new Error(
        `--recover expects '<space-did> <install-id>' per line, got: ${line}`,
      );
    }
    ids.push(channelId(space, installId));
  }
  return ids;
}

export function render(rows: ChannelRow[], json: boolean): string[] {
  const out: string[] = [];
  if (json) {
    out.push(JSON.stringify({ channels: rows }, null, 2));
    return out;
  }
  out.push("\nIngest channels\n");
  if (rows.length === 0) out.push("  none.\n");
  for (const row of rows) {
    out.push(`  ${row.id}   [${row.state}]`);
    out.push(`    space:     ${row.space}`);
    out.push(`    installId: ${row.installId}`);
    out.push(`    owner:     ${row.owner}`);
    out.push(
      `    created:   ${row.createdAt}   last seen: ${
        row.lastSeenAt ?? "never"
      }`,
    );
    if (row.revokedAt) out.push(`    revoked:   ${row.revokedAt}`);
    out.push("");
  }
  const live = rows.filter((r) => r.state === "active").length;
  out.push(`  ${rows.length} channel(s), ${live} active.\n`);
  return out;
}

/** The whole command minus argv parsing and runtime construction. */
export async function runAudit(
  runtime: Runtime,
  serviceSpace: string,
  flags: { json?: boolean; "repair-indexes"?: boolean; recover?: string },
): Promise<string[]> {
  const candidates = flags.recover === undefined
    ? []
    : recoverIds(await Deno.readTextFile(flags.recover));
  return render(
    await collectRows(
      runtime,
      serviceSpace,
      Boolean(flags["repair-indexes"]),
      candidates,
    ),
    Boolean(flags.json),
  );
}

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
): Promise<number> {
  const flags = parseArgs(args, {
    boolean: ["json", "repair-indexes"],
    string: ["recover"],
  });
  const runtime = makeRuntime();
  try {
    for (const line of await runAudit(runtime, serviceSpace, flags)) log(line);
    return 0;
  } finally {
    await runtime.dispose();
  }
}

if (import.meta.main) Deno.exit(await main(Deno.args));
