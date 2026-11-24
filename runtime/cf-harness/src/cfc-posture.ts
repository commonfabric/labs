/**
 * The posture record for the run's Fabric session, and how a surface renders
 * it.
 *
 * The session's Runtime is built lazily — on the first `run_pattern` call, if
 * one ever comes — while the two surfaces that publish its posture speak
 * earlier than that: the run state is written when the run starts, and the
 * console prints its posture when it binds its port. Neither can read a
 * constructed Runtime, so both project one, through the same preset
 * resolution and the same default table the Runtime itself resolves from
 * (`presetCfcOptions` and `resolveCfcDials` in the runner). A projection that
 * restated either in its own words would be a second answer to the question
 * the record exists to have one answer to.
 */

import {
  type CfcPostureReport,
  projectedCfcPostureReport,
} from "@commonfabric/runner/cfc";
import { presetCfcOptions } from "@commonfabric/runner";

import {
  fabricSessionPresetCfcDials,
  type HarnessFabricSessionConfig,
} from "./config.ts";

/**
 * The posture the session's runtime will run at, as the shared record.
 *
 * The session's controller passes the config's dials to the `remoteClient`
 * preset, so the preset's own resolution — the core pin, the named posture
 * bundle, then the host dials over both — is what decides the values, and
 * whatever the preset leaves unset resolves through the Runtime's dial
 * defaults.
 *
 * A PROJECTION, and the record says so. Two things it cannot promise. The
 * session may never be built at all — nothing constructs one until the first
 * `run_pattern` — and a host may supply its own session factory
 * (`fabricSessionFactory`), whose runtime this config does not describe. So a
 * reader gets a claim about what the run expected to be at, never an
 * attestation of what a runtime was at. Re-stamping the record from the real
 * runtime once one exists is what would make it the second thing.
 */
export const harnessFabricSessionPosture = (
  config: HarnessFabricSessionConfig,
): CfcPostureReport =>
  projectedCfcPostureReport(
    presetCfcOptions(fabricSessionPresetCfcDials(config)),
  );

const dialLine = (
  name: string,
  dial: CfcPostureReport["enforcementMode"],
): string =>
  `    ${name.padEnd(24)}${dial.rung}${
    dial.diagnosticOnly ? " (diagnostic only)" : ""
  } — decides on ${dial.decidesOn}`;

/**
 * The record as lines an operator reads.
 *
 * Every known sink appears, ungated ones included: a list of the governed
 * sinks reads as coverage, and the sink missing from it is the one the reader
 * needed to see. So do the deviations, which is what publishing one means
 * (AH-CFC-15) — a deviation an operator has to go and look for has not been
 * published.
 */
export const renderCfcPostureReport = (
  record: CfcPostureReport,
): readonly string[] => {
  const lines = [
    `    ${"provenance".padEnd(24)}${record.provenance}${
      record.provenance === "projected"
        ? " — what the session's runtime is expected to resolve, not what one attested"
        : ""
    }`,
    dialLine("enforcement mode", record.enforcementMode),
    dialLine("flow labels", record.flowLabels),
    dialLine("write floor", record.writeFloor),
    dialLine("policy evaluation", record.policyEvaluation),
    dialLine("label metadata", record.labelMetadataProtection),
    dialLine("declared monotonicity", record.declaredMonotonicity),
    `    ${"trigger read gating".padEnd(24)}${record.triggerReadGating}`,
    `    ${"decomposed envelopes".padEnd(24)}${record.decomposedEnvelopes}`,
    `    ${
      "content-addressed labels".padEnd(24)
    }${record.contentAddressedLabels}`,
    `    ${"policy digest".padEnd(24)}${record.policyDigest ?? "(none)"}`,
  ];
  for (const sink of record.sinks) {
    lines.push(
      `    sink ${sink.sink.padEnd(19)}${
        "ceiling" in sink
          ? sink.ceiling.length === 0
            ? "public only"
            : `ceiling ${JSON.stringify(sink.ceiling)}`
          : `UNGATED — ${sink.ungated}`
      }`,
    );
  }
  for (const deviation of record.deviations) {
    lines.push(
      `    deviation: ${deviation.what}`,
      `      owner: ${deviation.owner}`,
      `      retires when: ${deviation.retirement}`,
    );
  }
  return lines;
};

/**
 * The posture block a console prints at startup: the bundle it opted into,
 * then the record that bundle resolves to.
 *
 * Composed here rather than at the `console.log` calls so that what an
 * operator reads is a value a test can read too. The console's own job is
 * then only to write the lines out, which is the part a test has no reason to
 * reach.
 */
export const harnessFabricSessionPostureBanner = (
  config: HarnessFabricSessionConfig,
): readonly string[] => [
  `  cfc:        ${config.cfcPosture ?? "first-party default"}`,
  ...renderCfcPostureReport(harnessFabricSessionPosture(config)),
];
