import type { ConfidenceAssessment, TapeAnnotation } from "./contract.ts";

export interface CueSpec {
  id: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export type AnnotationEdits = Pick<TapeAnnotation, "range" | "label" | "note">;

type AnnotationEditKey = keyof AnnotationEdits;

export interface WritableAnnotationFields {
  key<Key extends AnnotationEditKey>(key: Key): {
    set(value: AnnotationEdits[Key]): Promise<void>;
  };
}

const ANNOTATION_EDIT_KEYS: readonly AnnotationEditKey[] = [
  "range",
  "label",
  "note",
];

/** Returns only fields changed from the version presented to the editor. */
export function changedAnnotationEdits(
  baseline: AnnotationEdits,
  next: AnnotationEdits,
): Partial<AnnotationEdits> {
  return Object.fromEntries(
    ANNOTATION_EDIT_KEYS.filter((key) =>
      key === "range"
        ? baseline.range.startSeconds !== next.range.startSeconds ||
          baseline.range.endSeconds !== next.range.endSeconds
        : baseline[key] !== next[key]
    ).map((key) => [key, next[key]]),
  );
}

/** Writes the coupled time range atomically while unrelated text edits compose. */
export async function writeAnnotationEdits(
  cell: WritableAnnotationFields,
  edits: Partial<AnnotationEdits>,
): Promise<void> {
  await Promise.all(
    ANNOTATION_EDIT_KEYS.flatMap((key) =>
      Object.hasOwn(edits, key) ? [cell.key(key).set(edits[key]!)] : []
    ),
  );
}

export const WAV_SAMPLE_RATE = 12_000;
export const MIN_DURATION_SECONDS = 1;
export const MAX_DURATION_SECONDS = 120;
export const FALLBACK_DURATION_SECONDS = 18;

export function normalizeDurationSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return FALLBACK_DURATION_SECONDS;
  return Math.min(
    MAX_DURATION_SECONDS,
    Math.max(MIN_DURATION_SECONDS, seconds),
  );
}

/** Remembers the latest duration until hydration can synchronize its buffer. */
export function durationRequestTarget(
  currentDurationSeconds: number,
  loadedDurationSeconds: number | undefined,
  ready: boolean,
): number | undefined {
  const current = normalizeDurationSeconds(currentDurationSeconds);
  return ready && current === loadedDurationSeconds ? undefined : current;
}

export interface DurationTransitionPlan {
  durationSeconds: number;
  positionSeconds: number;
  resumePlayback: boolean;
}

/** Samples the live playback head from its source offset and audio clock. */
export function playbackPositionAt(
  durationSeconds: number,
  offsetSeconds: number,
  startedAtSeconds: number | undefined,
  currentTimeSeconds: number,
): number {
  const elapsed = startedAtSeconds === undefined
    ? 0
    : Math.max(0, currentTimeSeconds - startedAtSeconds);
  return clamp(offsetSeconds + elapsed, 0, durationSeconds);
}

/** Clamps local playback when a reactive recording duration changes. */
export function planDurationTransition(
  durationSeconds: number,
  positionSeconds: number,
  wasPlaying: boolean,
): DurationTransitionPlan {
  const duration = normalizeDurationSeconds(durationSeconds);
  const position = Number.isFinite(positionSeconds)
    ? clamp(positionSeconds, 0, duration)
    : 0;
  return {
    durationSeconds: duration,
    positionSeconds: position,
    resumePlayback: wasPlaying && position < duration,
  };
}

export function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalTenths = Math.round(safe * 10);
  const minutes = Math.floor(totalTenths / 600);
  const remainder = totalTenths % 600 / 10;
  return `${String(minutes).padStart(2, "0")}:${
    remainder.toFixed(1).padStart(4, "0")
  }`;
}

export function cueSpecs(
  annotations: readonly TapeAnnotation[],
): CueSpec[] {
  return annotations.map((annotation) => ({
    id: annotation.id,
    startSeconds: annotation.range.startSeconds,
    endSeconds: annotation.range.endSeconds,
    text: annotation.label,
  }));
}

export function assessmentValues(
  annotation: TapeAnnotation,
  assessments: readonly ConfidenceAssessment[],
): number[] {
  return [
    annotation.initialConfidence,
    ...assessments.filter((item) => item.annotationId === annotation.id).map(
      (item) => item.confidence,
    ),
  ];
}

export function confidenceFor(
  annotation: TapeAnnotation,
  assessments: readonly ConfidenceAssessment[],
): number {
  const values = assessmentValues(annotation, assessments);
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function buildSyntheticWav(durationSeconds: number): ArrayBuffer {
  const safeDuration = normalizeDurationSeconds(durationSeconds);
  const sampleCount = Math.floor(safeDuration * WAV_SAMPLE_RATE);
  const bytes = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(bytes);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, WAV_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);

  let noiseSeed = 0x5eed1234;
  for (let index = 0; index < sampleCount; index++) {
    noiseSeed = (Math.imul(noiseSeed, 1_664_525) + 1_013_904_223) >>> 0;
    const time = index / WAV_SAMPLE_RATE;
    const noise = (noiseSeed / 0xffff_ffff) * 2 - 1;
    const water = Math.sin(2 * Math.PI * 92 * time) * 0.055 +
      Math.sin(2 * Math.PI * 137 * time) * 0.03;
    const frogEnvelope = Math.max(0, Math.sin(Math.PI * (time - 3.2) / 2.6));
    const frog = time >= 3.2 && time <= 5.8
      ? Math.sin(2 * Math.PI * (310 + 28 * Math.sin(time * 18)) * time) *
        frogEnvelope * 0.19
      : 0;
    const rustleEnvelope = time >= 10.4 && time <= 12.1
      ? Math.sin(Math.PI * (time - 10.4) / 1.7)
      : 0;
    const rustle = noise * rustleEnvelope * 0.23;
    const sample = clamp(water + noise * 0.025 + frog + rustle, -1, 1);
    view.setInt16(44 + index * 2, Math.round(sample * 0x7fff), true);
  }
  return bytes;
}
