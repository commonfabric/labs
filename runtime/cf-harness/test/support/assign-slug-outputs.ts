/**
 * Persists a run's `assign_slug` outputs through the harness's own artifact
 * store, for tests that write a turn's artifacts by hand.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";
import { createFileSystemHarnessArtifactStore } from "../../src/artifacts.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";
import {
  createToolOutputId,
  createToolResultRef,
} from "../../src/contracts/tool-result.ts";

/**
 * Persists each `assign_slug` result in `transcript` that carries a URL,
 * through the artifact store of run `runId` under `artifactRoot`, and returns
 * the transcript with each such result as the model is shown it: its outcome
 * and slug, with a result reference naming the persisted output.
 */
export const persistAssignSlugOutputs = async (
  artifactRoot: string,
  runId: string,
  transcript: readonly HarnessTranscriptMessage[],
): Promise<HarnessTranscriptMessage[]> => {
  const store = createFileSystemHarnessArtifactStore({ artifactRoot, runId });
  return await Promise.all(transcript.map(async (message, index) => {
    if (message.role !== "tool" || message.toolName !== "assign_slug") {
      return message;
    }
    let value: unknown;
    try {
      value = JSON.parse(message.content);
    } catch {
      return message;
    }
    if (!isObjectNotArray(value) || typeof value.url !== "string") {
      return message;
    }
    const outputId = createToolOutputId(runId, "assign_slug", index);
    const artifactPath = await store.persistToolOutput(
      "assign_slug",
      outputId,
      { ...value, outputId },
    );
    return {
      ...message,
      content: JSON.stringify({
        outputId,
        status: value.status,
        slug: value.slug,
      }),
      resultRef: createToolResultRef(
        outputId,
        "assign_slug",
        runId,
        artifactPath,
      ),
    };
  }));
};
