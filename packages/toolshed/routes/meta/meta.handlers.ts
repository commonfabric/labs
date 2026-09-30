import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import { resolveGitSha, shellServerExecutionDefine } from "@/lib/build-info.ts";
import { cfcPosture } from "@/lib/cfc-posture.ts";
import { experimentalPosture } from "@/lib/experimental-posture.ts";
import { identity } from "@/lib/identity.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import type { IndexRoute } from "./meta.routes.ts";

const SERVER_DID = identity.did();
const GIT_SHA = resolveGitSha();

/**
 * One dial's resolved rung. `diagnosticOnly` rides beside the value because a
 * bare `observe` invites being read as enforcement, and a client reading the
 * posture has no reason to know which rung of which ladder decides anything.
 */
const CfcDialSchema = z.object({
  rung: z.string(),
  diagnosticOnly: z.boolean(),
  decidesOn: z.string(),
});

export const MetaResponseSchema = z.object({
  did: z.string(),
  gitSha: z.string().nullable(),
  // The server-execution v2 posture the binary's browser shell was BUILT
  // with (the raw `EXPERIMENTAL_SERVER_EXECUTION` build define: "true",
  // "false", or null when unset — the shell then follows the first-party
  // default; null in a source run too). Build provenance like `gitSha`,
  // read from the compiled marker; CI's server-execution lanes assert on
  // it (docs/specs/server-side-execution/testing.md §2).
  shellServerExecutionDefine: z.string().nullable(),
  // The experimental-flag posture this server RUNS AT — its own Runtime's
  // resolved flags, with the ones a serving runtime forces applied over them
  // — which a client not built alongside it adopts rather than being
  // configured to match by hand (docs/development/EXPERIMENTAL_OPTIONS.md).
  // An omitted flag means this server said nothing about it, and `null` means
  // it has no Runtime yet; a client keeps its built-in default for either.
  experimental: z.record(z.string(), z.boolean()).nullable(),
  // The CFC posture this server's Runtime resolved — every enforcement dial
  // with what its rung decides on, the policy-snapshot digest, and EVERY
  // known sink with its ceiling or the reason it releases ungated — so a
  // deployment's enforcement is readable rather than indistinguishable from
  // the default, and a sink's absence from a ceiling list cannot read as
  // coverage. The shared record (`@commonfabric/runner/cfc`
  // `cfcPostureReport`), published identically by every surface that
  // publishes one. `null` means no Runtime yet.
  cfc: z.object({
    // `resolved` here always: the route publishes what a constructed Runtime
    // is at. A surface that publishes before its runtime exists says
    // `projected`, and one running on another host's runtime says
    // `inherited`; the field is what keeps a reader from taking one for
    // another. The enum states the shared record's whole vocabulary rather
    // than the one value this route emits, so a client reading the schema
    // reads the record's shape.
    provenance: z.enum(["resolved", "projected", "inherited"]),
    enforcementMode: CfcDialSchema,
    flowLabels: CfcDialSchema,
    writeFloor: CfcDialSchema,
    triggerReadGating: z.boolean(),
    decomposedEnvelopes: z.boolean(),
    contentAddressedLabels: z.boolean(),
    policyEvaluation: CfcDialSchema,
    labelMetadataProtection: CfcDialSchema,
    declaredMonotonicity: CfcDialSchema,
    policyDigest: z.string().nullable(),
    sinks: z.array(z.union([
      z.object({ sink: z.string(), ceiling: z.array(z.unknown()).readonly() }),
      z.object({ sink: z.string(), ungated: z.string() }),
    ])).readonly(),
    deviations: z.array(z.object({
      what: z.string(),
      owner: z.string(),
      retirement: z.string(),
    })).readonly(),
  }).nullable(),
});
export type MetaResponse = z.infer<typeof MetaResponseSchema>;

export const index: AppRouteHandler<IndexRoute> = (c) => {
  const response: MetaResponse = {
    did: SERVER_DID,
    gitSha: GIT_SHA,
    shellServerExecutionDefine,
    experimental: experimentalPosture(),
    cfc: cfcPosture(),
  };
  return c.json(response, HttpStatusCodes.OK);
};
