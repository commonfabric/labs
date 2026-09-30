/**
 * Provision a vouched ingest channel — the OPERATOR / break-glass path.
 *
 * PREFER `cf ingest mint`. Users can now mint their own channels against
 * /api/ingest-channels, signing with their own identity key; the server checks
 * they hold an explicit OWNER grant on the target space's ACL, which is what
 * closes the confused-deputy hole that kept creation out-of-band originally.
 * See docs/features/self-serve-ingest-channels.md.
 *
 * This script remains for the cases the self-serve path cannot cover: minting
 * for a space whose ACL does not (yet) name a concrete owner, and recovery when
 * the control plane itself is unavailable. It bypasses the ownership check
 * entirely — it runs AS the operator identity — so treat it as an admin action.
 *
 * A channel minted here has no verified `owner`, so it does not appear in a
 * user's own `cf ingest ls`. It DOES appear in `cf ingest ls --space <space>`,
 * which lists everything targeting a space its current owner holds — so a
 * break-glass channel is discoverable, and revocable, by that owner.
 *
 * It mints a per-install token, writes the registration into the toolshed
 * service space, and prints the token ONCE. Adding an install = re-run this.
 *
 * Usage:
 *   deno task provision-ingest-channel \
 *     --space did:key:<user-space> --install-id <stable-id> \
 *     [--cause-prefix location] [--name <label>] [--force]
 */

import { parseArgs } from "@std/cli/parse-args";
import { isDID } from "@commonfabric/identity/did";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import env from "@/env.ts";
import { identity } from "@/lib/identity.ts";
import {
  channelId,
  generateIngestSecret,
  getRegistration,
  isValidSegment,
  MAX_REVOCATION_HISTORY,
  RegistrationConflictError,
  saveRegistration,
} from "@/routes/ingest/ingest.utils.ts";
import { DEFAULT_TTL_DAYS } from "@/routes/ingest-channels/ingest-channels.utils.ts";

const USAGE =
  "usage: deno task provision-ingest-channel --space <did:key:...> " +
  "--install-id <id> [--cause-prefix location] [--name <label>] [--force]";

const defaultRuntime = () =>
  new Runtime({
    apiUrl: new URL(env.MEMORY_URL),
    storageManager: StorageManager.open({
      memoryHost: new URL(env.MEMORY_URL),
      as: identity,
    }),
  });

export interface ProvisionRequest {
  space: string;
  installId: string;
  causePrefix?: string;
  name?: string;
  force?: boolean;
}

export type ProvisionOutcome =
  | { ok: true; id: string; name: string; causePrefix: string; secret: string }
  | { ok: false; code: 1 | 2; message: string };

/**
 * Argument validation, separated so `main` can reject bad input BEFORE building
 * a runtime. Constructing one reads `MEMORY_URL`, so validating afterwards
 * turned a plain usage error into an uncaught construction failure on a
 * deployment whose config is wrong — the two things an operator most needs to
 * tell apart.
 */
export function validateProvisionRequest(
  request: ProvisionRequest,
): { code: 2; message: string } | null {
  const { space, installId } = request;
  if (!space || !installId) return { code: 2, message: USAGE };
  // A typo'd space durably writes marked data into a garbage space (loom's
  // reader silently orphaned); installId is the mark's audience AND a
  // `\n`-separated input to channelId, so whitespace/newlines corrupt the
  // cross-repo join key.
  if (!isDID(space)) {
    return {
      code: 2,
      message: `Invalid --space '${space}': must be a DID (did:...).`,
    };
  }
  if (!isValidSegment(installId)) {
    return {
      code: 2,
      message:
        `Invalid --install-id '${installId}': must match [A-Za-z0-9._-]{1,64} and not be '.' or '..'`,
    };
  }
  // causePrefix is the other half of the `${causePrefix}/${partition}` cause
  // that loom must recompute to read the cells — hold it to the same
  // clean-segment rule as the partition so an operator typo can't silently
  // orphan the read path.
  const causePrefix = request.causePrefix ?? "location";
  if (!isValidSegment(causePrefix)) {
    return {
      code: 2,
      message:
        `Invalid --cause-prefix '${causePrefix}': must match [A-Za-z0-9._-]{1,64} and not be '.' or '..'`,
    };
  }
  return null;
}

/**
 * The provisioning write itself. BORROWS the runtime rather than owning it —
 * `main` below constructs and disposes one, but the lifecycle behavior here
 * (carrying expiry and revocation history forward, refusing to overwrite a
 * concurrent revoke) is what a test needs to reach, and a function that
 * disposes its caller's runtime cannot be tested against stored state.
 */
export async function provisionChannel(
  runtime: Runtime,
  serviceSpace: string,
  request: ProvisionRequest,
): Promise<ProvisionOutcome> {
  const invalid = validateProvisionRequest(request);
  if (invalid) return { ok: false, ...invalid };
  const { space, installId } = request;
  const causePrefix = request.causePrefix ?? "location";
  const name = request.name ?? `ingest-${installId}`;

  // Deterministic id: re-running for the same space+install rotates the token
  // in place (overwrites the one registration) rather than leaving a stale one
  // live.
  const id = channelId(space, installId);

  // Re-provisioning with a different --cause-prefix would rotate the token AND
  // silently move where data lands (orphaning loom's existing read path), since
  // channelId derives from (space, installId) only. Refuse unless --force.
  const existing = await getRegistration(runtime, serviceSpace, id);
  if (existing && existing.causePrefix !== causePrefix && !request.force) {
    return {
      ok: false,
      code: 2,
      message:
        `Channel ${id} already exists with cause-prefix '${existing.causePrefix}', ` +
        `not '${causePrefix}'. Re-run with --force to repoint (this orphans the ` +
        `old read path), or keep the existing prefix.`,
    };
  }

  const { secret, secretHash } = generateIngestSecret();

  // Carry the existing lifecycle state forward. Building a fresh object here
  // silently un-revokes a retired channel, deletes its revocation history,
  // orphans a self-serve channel from its owner's list, resets the revision
  // that lifecycle writes are gated on, and drops the expiry — which is the
  // only way this deployment can still issue a credential that never expires.
  const now = new Date();
  const expiresAt = existing?.expiresAt !== undefined &&
      Date.parse(existing.expiresAt) > now.getTime()
    ? existing.expiresAt
    : new Date(now.getTime() + DEFAULT_TTL_DAYS * 86_400_000).toISOString();

  try {
    await saveRegistration(runtime, serviceSpace, {
      id,
      name,
      space,
      causePrefix,
      installId,
      sink: "journal",
      secretHash,
      // Re-provisioning an existing channel replaces its secret, so it IS a
      // rotation and must leave the re-pair signal behind. Without it a device
      // still holding the old token gets the equalized 401 —
      // indistinguishable from "unknown channel" — on the single most likely
      // path to reach it, which is exactly the case `previousSecretHash`
      // exists for.
      ...(existing?.secretHash !== undefined
        ? { previousSecretHash: existing.secretHash }
        : {}),
      createdBy: serviceSpace,
      createdAt: existing?.createdAt ?? now.toISOString(),
      enabled: true,
      expiresAt,
      revision: (existing?.revision ?? 0) + 1,
      ...(existing?.owner !== undefined ? { owner: existing.owner } : {}),
      // Re-provisioning is an operator re-authorizing the channel, so the live
      // revocation clears; the record of it does not.
      ...(existing?.revoked !== undefined
        ? {
          revocations: [
            ...(existing.revocations ?? []).map((r) => ({
              at: r.at,
              by: r.by,
            })),
            { at: existing.revoked.at, by: existing.revoked.by },
          ].slice(-MAX_REVOCATION_HISTORY),
        }
        : existing?.revocations !== undefined
        ? {
          revocations: existing.revocations
            .map((r) => ({ at: r.at, by: r.by }))
            .slice(-MAX_REVOCATION_HISTORY),
        }
        : {}),
    }, existing === null ? null : (existing.revision ?? 0));
  } catch (error) {
    if (error instanceof RegistrationConflictError) {
      // Admin is trusted, but a trusted action should conflict visibly rather
      // than silently undo a security action someone else just took. A revoke
      // landing between the read above and this write is exactly that case.
      return {
        ok: false,
        code: 1,
        message:
          `\nChannel ${id} changed while this command was running — most likely ` +
          `revoked. Nothing was written.\nRe-run to act on the current state.`,
      };
    }
    throw error;
  }
  await runtime.storageManager.synced();
  return { ok: true, id, name, causePrefix, secret };
}

/** Returns an exit code rather than calling `Deno.exit`, so it is testable. */
export async function main(
  args: string[],
  makeRuntime: () => Runtime = defaultRuntime,
  serviceSpace: string = identity.did(),
  log: (line: string) => void = console.log,
  logError: (line: string) => void = console.error,
): Promise<number> {
  const flags = parseArgs(args, {
    string: ["space", "install-id", "cause-prefix", "name"],
    boolean: ["force"],
  });

  const request = {
    space: flags.space ?? "",
    installId: flags["install-id"] ?? "",
    causePrefix: flags["cause-prefix"],
    name: flags.name,
    force: flags.force,
  };
  // Before `makeRuntime()`: a usage error must stay a usage error even when
  // MEMORY_URL is unset or malformed.
  const invalid = validateProvisionRequest(request);
  if (invalid) {
    logError(invalid.message);
    return invalid.code;
  }

  const runtime = makeRuntime();
  try {
    const outcome = await provisionChannel(runtime, serviceSpace, request);
    if (!outcome.ok) {
      logError(outcome.message);
      return outcome.code;
    }

    const url = `${env.API_URL}/api/ingest/${outcome.id}`;
    log("\nIngest channel provisioned.\n");
    log(`  id:          ${outcome.id}`);
    log(`  name:        ${outcome.name}`);
    log(`  space:       ${flags.space}`);
    log(`  causePrefix: ${outcome.causePrefix}`);
    log(`  installId:   ${flags["install-id"]}`);
    log(`  URL:         ${url}`);
    log(
      `\n  token (shown once — hand to the beacon, sent as 'Authorization: Bearer <token>'):\n\n    ${outcome.secret}\n`,
    );
    log(
      "  (re-running with the same --space and --install-id rotates this channel's\n" +
        "   token in place; the previous token stops working.)\n",
    );
    return 0;
  } finally {
    await runtime.dispose();
  }
}

if (import.meta.main) Deno.exit(await main(Deno.args));
