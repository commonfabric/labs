export type DemoStatus =
  | "recording"
  | "passed"
  | "test-failed"
  | "capture-failed"
  | "encode-failed";

export type RecordedFrame = {
  sequence: number;
  path: string;
  recordedAtMs: number;
  sourceTimestamp?: number;
  durationSeconds: number;
  width: number;
  height: number;
};

export type DemoParticipantManifest = {
  id: string;
  label: string;
  color: string;
  captureStartedAtMs: number;
  captureEndedAtMs?: number;
  frames: RecordedFrame[];
  streamPath?: string;
  error?: string;
};

export type DemoStep = {
  label: string;
  startedAtMs: number;
  endedAtMs?: number;
  participantId?: string;
  failed?: boolean;
};

export type DemoManifest = {
  version: 1;
  runId: string;
  status: DemoStatus;
  startedAt: string;
  viewport: { width: number; height: number };
  participants: DemoParticipantManifest[];
  steps: DemoStep[];
  outputPath?: string;
  error?: string;
};

export async function writeManifest(
  path: string,
  manifest: DemoManifest,
): Promise<void> {
  const tempPath = `${path}.tmp`;
  await Deno.writeTextFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await Deno.rename(tempPath, path);
}
