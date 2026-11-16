/**
 * Loom's per-request pattern-index helper.
 *
 * Contract: `runtime/pattern-index/cli.ts --identity <PKCS#8 path>
 * --base-url <index URL>` reads one JSON request on stdin and writes one JSON
 * answer on stdout. Requests use `op: search` or `op: feedback`; replies are
 * `{ok: true, value}` or `{ok: false, status, error}`. A completed request,
 * including a refusal, exits zero. Host failures exit nonzero with detail on
 * stderr and nothing on stdout. Malformed stdin produces a 400 JSON answer.
 * Index 401 (signature failure) and 403 (DID not allowlisted) remain distinct.
 *
 * CFS invocation: `deno run --no-lock --config <labs deno.json[c]>
 * --allow-read=<identity path> --allow-net=<base URL hostname>
 * runtime/pattern-index/cli.ts --identity <identity path> --base-url <URL>`.
 * These read and network grants are the complete permission set; environment
 * and FFI permissions are not required.
 *
 * Besides `search` and `feedback`, `op: whoami` answers the member the
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
import { PatternIndexClient } from "./src/client.ts";
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
      default:
        return {
          ok: false,
          status: 400,
          error: "op must be search, feedback, whoami, admit or join",
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
