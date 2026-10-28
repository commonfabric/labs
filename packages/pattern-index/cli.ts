/**
 * Loom's per-request pattern-index helper.
 *
 * Contract: `packages/pattern-index/cli.ts --identity <PKCS#8 path>
 * --base-url <index URL>` reads one JSON request on stdin and writes one JSON
 * answer on stdout. Requests use `op: search` or `op: feedback`; replies are
 * `{ok: true, value}` or `{ok: false, status, error}`. A completed request,
 * including a refusal, exits zero. Host failures exit nonzero with detail on
 * stderr and nothing on stdout. Malformed stdin produces a 400 JSON answer.
 * Index 401 (signature failure) and 403 (DID not allowlisted) remain distinct.
 *
 * CFS invocation: `deno run --no-lock --config <labs deno.json[c]>
 * --allow-read=<identity path> --allow-net=<base URL hostname>
 * packages/pattern-index/cli.ts --identity <identity path> --base-url <URL>`.
 * These read and network grants are the complete permission set; environment
 * and FFI permissions are not required.
 */

import { parseArgs } from "@std/cli/parse-args";
import { Identity } from "@commonfabric/identity";
import { PatternIndexClient } from "./src/client.ts";
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

/** Answers one operation, mapping index refusals and propagating failures. */
const answerRequest = async (
  client: PatternIndexClient,
  request: unknown,
): Promise<CliAnswer> => {
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
      default:
        return {
          ok: false,
          status: 400,
          error: "op must be search or feedback",
        };
    }
  } catch (error) {
    const failure = patternIndexFailure(error);
    if (failure !== undefined) return failure;
    throw error;
  }
};

/** Reads and answers the one request owned by this process. */
const main = async (): Promise<void> => {
  const { identity, "base-url": baseUrl } = parseArgs(Deno.args, {
    string: ["identity", "base-url"],
  });
  if (!identity || !baseUrl) {
    console.error("usage: cli.ts --identity <path> --base-url <url>");
    Deno.exitCode = 2;
    return;
  }
  const signer = await Identity.fromPkcs8(await Deno.readFile(identity));
  const client = new PatternIndexClient({ baseUrl, signer });
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
  const answer = await answerRequest(client, request);
  console.log(JSON.stringify(answer));
};

try {
  await main();
} catch (error) {
  console.error("pattern-index helper failed host-side:", error);
  Deno.exitCode = 1;
}
