/**
 * Loom's per-request pattern-index helper.
 *
 * Contract: `runtime/pattern-index/cli.ts --identity <PKCS#8 path>
 * --base-url <index URL>` reads one JSON request on stdin and writes one JSON
 * answer on stdout. Requests use `op: search`, `op: feedback` or `op:
 * source`; replies are `{ok: true, value}` or `{ok: false, status, error}`.
 * A completed request, including a refusal, exits zero. Host failures exit
 * nonzero with detail on stderr and nothing on stdout. Malformed stdin
 * produces a 400 JSON answer.
 * Index 401 (signature failure) and 403 (DID not allowlisted) remain distinct.
 *
 * CFS invocation: `deno run --no-lock --config <labs deno.json[c]>
 * --allow-read=<identity path> --allow-net=<base URL hostname>
 * runtime/pattern-index/cli.ts --identity <identity path> --base-url <URL>`.
 * These read and network grants are the complete permission set; environment
 * and FFI permissions are not required.
 *
 * `op: source {patternIds}` answers each pattern's program as the index
 * holds it (`getPattern` with its source), at most
 * {@link SOURCE_PATTERNS_MAX} per request, in the order asked: `{patterns:
 * [{patternId, name?, description, mine?, program} | {patternId, status}]}`,
 * where `status` is 404 for a pattern the index does not hold or will not
 * show this member, and 403 for one it answered without its program, so one
 * unreadable pattern does not cost the others. Any other refusal answers the
 * whole request, as for `search`. A caller reads someone else's pattern to build
 * on it, so it can credit that pattern when it deploys what it built.
 *
 * Besides `search`, `feedback` and `source`, `op: whoami` answers the member the
 * identity acts as (with `signer`), `op: admit {did}` admits a key (admins),
 * and `op: join {link}` or `op: join {chain}` (a chain file's text, one
 * chain) joins the index exactly as `cf index join` does, answering
 * `{handle, role, root, signer, joined, storeDir, rootKeptHere}`; a join needs
 * `--membership-store`. A refused join answers the index's status, or 400
 * for a link or chain that is not one and 409 for a conflicting membership.
 *
 * `--membership-store <dir>` names the directory `cf index join` keeps
 * memberships under (`~/.local/state/commonfabric/pattern-index` by default
 * for `cf`). With it, each call presents the chain the person's index root
 * issued to `--identity`, renewing it there when the root is kept and the
 * chain has under a week left, so the host also grants read and write on
 * `<dir>/<index host>`. Without it the identity signs as its own root.
 */

import { parseArgs } from "@std/cli/parse-args";
import { join as joinPath } from "@std/path";
import {
  isPieceRef,
  PatternIndexClient,
  PatternIndexError,
} from "./src/client.ts";
import { openPatternIndexClient } from "./src/access.ts";
import { PatternIndexStore } from "./src/store.ts";
import {
  adoptIndexChain,
  JoinError,
  joinPatternIndex,
  parseInviteLink,
} from "./src/join.ts";
import {
  decodeDelegationChains,
  type DIDKey,
  Identity,
  isCanonicalEd25519DID,
} from "@commonfabric/identity";
import { feedbackEventType, recordPatternFeedback } from "./src/feedback.ts";
import {
  type PatternIndexFailure,
  patternIndexFailure,
  patternIndexSearchRequest,
} from "./src/front.ts";

/** The single reply owned by this process. */
type CliAnswer =
  | { readonly ok: true; readonly value: unknown }
  | PatternIndexFailure;

/** What one request is answered with. */
interface HelperContext {
  client: PatternIndexClient;
  signer: Identity<DIDKey>;
  baseUrl: string;

  /** The membership store, when `--membership-store` named one. */
  store?: PatternIndexStore;
}

/** Joins with the invite link or the chain text the request carries. */
const join = async (
  context: HelperContext,
  body: Record<string, unknown>,
): Promise<CliAnswer> => {
  const { store, signer, baseUrl } = context;
  if (store === undefined) {
    return {
      ok: false,
      status: 400,
      error: "join needs --membership-store, where the membership is kept",
    };
  }
  if (body.link !== undefined && body.chain !== undefined) {
    return {
      ok: false,
      status: 400,
      error: "join takes a link or a chain, not both",
    };
  }
  if (typeof body.link === "string") {
    return {
      ok: true,
      value: await joinPatternIndex({
        baseUrl,
        signer,
        store,
        invite: parseInviteLink(body.link),
      }),
    };
  }
  if (typeof body.chain === "string") {
    let chains: Uint8Array[][];
    try {
      chains = decodeDelegationChains(body.chain);
    } catch {
      return { ok: false, status: 400, error: "chain is not a chain file" };
    }
    if (chains.length !== 1) {
      return {
        ok: false,
        status: 400,
        error: "chain must hold exactly one chain",
      };
    }
    return {
      ok: true,
      value: await adoptIndexChain({
        baseUrl,
        signer,
        store,
        chain: chains[0],
      }),
    };
  }
  return { ok: false, status: 400, error: "join needs a link or a chain" };
};

/** The most patterns one `source` request reads. */
export const SOURCE_PATTERNS_MAX = 5;

/** `op: source`: each pattern's program, or the index's refusal of it. */
const answerSource = async (
  client: PatternIndexClient,
  body: Record<string, unknown>,
): Promise<CliAnswer> => {
  const { patternIds } = body;
  if (
    !Array.isArray(patternIds) || patternIds.length === 0 ||
    patternIds.length > SOURCE_PATTERNS_MAX ||
    !patternIds.every((id) => typeof id === "string" && id !== "")
  ) {
    return {
      ok: false,
      status: 400,
      error:
        `patternIds must name 1 to ${SOURCE_PATTERNS_MAX} patterns, each a non-empty string`,
    };
  }
  // Read concurrently; `Promise.all` keeps the order asked.
  const patterns = await Promise.all(
    (patternIds as string[]).map(async (patternId) => {
      try {
        const found = await client.getPattern({
          patternId,
          includeSource: true,
        });
        // The index answered for the pattern and withheld its program.
        if (found.program === undefined) return { patternId, status: 403 };
        return {
          patternId: found.patternId,
          ...(found.name === undefined ? {} : { name: found.name }),
          description: found.description,
          ...(found.mine === undefined ? {} : { mine: found.mine }),
          program: found.program,
        };
      } catch (error) {
        // Only "no such pattern" is about the one pattern; any other refusal
        // (a signature, an allowlist, a rate) is the request's, and answers it.
        if (!(error instanceof PatternIndexError && error.status === 404)) {
          throw error;
        }
        return { patternId, status: 404 };
      }
    }),
  );
  return { ok: true, value: { patterns } };
};

/** Answers one operation, mapping index refusals and propagating failures. */
const answerRequest = async (
  context: HelperContext,
  request: unknown,
): Promise<CliAnswer> => {
  const { client } = context;
  const body: Record<string, unknown> =
    typeof request === "object" && request !== null
      ? request as Record<string, unknown>
      : {};
  try {
    switch (body.op) {
      case "search":
        return {
          ok: true,
          value: await client.searchPatterns(patternIndexSearchRequest(body)),
        };
      case "feedback": {
        const { patternId, verdict } = body;
        if (typeof patternId !== "string" || patternId === "") {
          return { ok: false, status: 400, error: "patternId is required" };
        }
        const eventType = feedbackEventType(verdict);
        if (eventType === undefined) {
          return {
            ok: false,
            status: 400,
            error: 'verdict must be "up" or "down"',
          };
        }
        const recorded = await recordPatternFeedback(client, {
          patternId,
          eventType,
        });
        return recorded.ok
          ? {
            ok: true,
            value: { patternId, eventType, recordedBy: client.did },
          }
          : { ok: false, status: 502, error: recorded.message };
      }
      case "source":
        return await answerSource(client, body);
      case "whoami":
        return {
          ok: true,
          value: { ...await client.whoami(), signer: client.did },
        };
      case "admit": {
        const { did } = body;
        if (typeof did !== "string" || !isCanonicalEd25519DID(did)) {
          return { ok: false, status: 400, error: "did must be a did:key" };
        }
        return { ok: true, value: await client.admitKey({ did }) };
      }
      case "join":
        return await join(context, body);
      case "view": {
        // A person used something in a loom: a piece (counts toward settling
        // the version of theirs deployed to it) or a pattern they placed from
        // the index (it ranks). Exactly one.
        const { patternId, piece } = body;
        const subject = typeof patternId === "string" && patternId !== "" &&
            piece === undefined
          ? { patternId }
          : typeof piece === "string" && isPieceRef(piece) &&
              patternId === undefined
          ? { piece }
          : undefined;
        if (subject === undefined) {
          return {
            ok: false,
            status: 400,
            error: "view needs a patternId or a piece, exactly one",
          };
        }
        const viewed = await client.recordUsageEvent({
          ...subject,
          eventType: "viewed_in_loom",
        });
        return viewed.ok ? { ok: true, value: viewed } : {
          ok: false,
          status: 502,
          error: "the index did not take the view",
        };
      }
      case "getSharing":
        return { ok: true, value: await client.getSharingSettings() };
      case "setSharing": {
        // Only the switches the caller set, so changing one never writes
        // the other from a value the caller guessed.
        const change: { enabled?: boolean; selfBuilt?: boolean } = {};
        for (const name of ["enabled", "selfBuilt"] as const) {
          const value = body[name];
          if (value === undefined) continue;
          if (typeof value !== "boolean") {
            return {
              ok: false,
              status: 400,
              error: `${name} must be true or false`,
            };
          }
          change[name] = value;
        }
        if (Object.keys(change).length === 0) {
          return {
            ok: false,
            status: 400,
            error: "setSharing needs enabled or selfBuilt",
          };
        }
        return { ok: true, value: await client.setSharingSettings(change) };
      }
      default:
        return {
          ok: false,
          status: 400,
          error:
            "op must be search, feedback, source, whoami, admit, join, view, getSharing or setSharing",
        };
    }
  } catch (error) {
    if (error instanceof JoinError) {
      return { ok: false, status: error.status, error: error.message };
    }
    const failure = patternIndexFailure(error);
    if (failure !== undefined) return failure;
    throw error;
  }
};

/** Reads and answers the one request owned by this process. */
const main = async (): Promise<void> => {
  const {
    identity,
    "base-url": baseUrl,
    "membership-store": membershipStore,
  } = parseArgs(Deno.args, {
    string: ["identity", "base-url", "membership-store"],
  });
  if (!identity || !baseUrl) {
    console.error(
      "usage: cli.ts --identity <path> --base-url <url> [--membership-store <dir>]",
    );
    Deno.exitCode = 2;
    return;
  }
  const signer = await Identity.fromPkcs8(await Deno.readFile(identity));
  const store = membershipStore
    ? new PatternIndexStore(joinPath(membershipStore, new URL(baseUrl).host))
    : undefined;
  const client = store !== undefined
    ? await openPatternIndexClient({ baseUrl, signer, store })
    : new PatternIndexClient({ baseUrl, signer });
  const input = await new Response(Deno.stdin.readable).text();
  let request: unknown;
  try {
    request = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({
      ok: false,
      status: 400,
      error: "request body is not JSON",
    }));
    return;
  }
  const answer = await answerRequest(
    { client, signer, baseUrl, ...(store === undefined ? {} : { store }) },
    request,
  );
  console.log(JSON.stringify(answer));
};

try {
  await main();
} catch (error) {
  console.error("pattern-index helper failed host-side:", error);
  Deno.exitCode = 1;
}
