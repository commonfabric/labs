import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { ConfidenceAssessment, TapeAnnotation } from "./contract.ts";
import {
  buildSyntheticWav,
  changedAnnotationEdits,
  confidenceFor,
  cueSpecs,
  durationRequestTarget,
  formatTime,
  normalizeDurationSeconds,
  planDurationTransition,
  playbackPositionAt,
  WAV_SAMPLE_RATE,
  type WritableAnnotationFields,
  writeAnnotationEdits,
} from "./model.ts";

const annotation: TapeAnnotation = {
  id: "annotation-stable-id",
  range: { startSeconds: 3.2, endSeconds: 5.8 },
  label: "Frog cluster",
  note: "Three short calls.",
  authorId: "reviewer-a",
  initialConfidence: 0.8,
};

describe("model", () => {
  describe("annotation edits", () => {
    it("composes disjoint edits from the same stale editor snapshot", async () => {
      const stored = {
        range: { ...annotation.range },
        label: annotation.label,
        note: annotation.note,
      };
      const baseline = { ...stored };
      const cell: WritableAnnotationFields = {
        key(key) {
          return {
            set(value) {
              Object.assign(stored, { [key]: value });
              return Promise.resolve();
            },
          };
        },
      };

      await Promise.all([
        writeAnnotationEdits(
          cell,
          changedAnnotationEdits(baseline, {
            ...baseline,
            label: "Updated label",
          }),
        ),
        writeAnnotationEdits(
          cell,
          changedAnnotationEdits(baseline, {
            ...baseline,
            note: "Updated note",
          }),
        ),
      ]);

      expect(stored.label).toBe("Updated label");
      expect(stored.note).toBe("Updated note");
    });

    it("keeps a concurrently edited time range internally valid", async () => {
      const stored = {
        range: { startSeconds: 3, endSeconds: 7 },
        label: annotation.label,
        note: annotation.note,
      };
      const baseline = structuredClone(stored);
      const cell: WritableAnnotationFields = {
        key(key) {
          return {
            set(value) {
              Object.assign(stored, { [key]: structuredClone(value) });
              return Promise.resolve();
            },
          };
        },
      };

      await Promise.all([
        writeAnnotationEdits(
          cell,
          changedAnnotationEdits(baseline, {
            ...baseline,
            range: { startSeconds: 6, endSeconds: 7 },
          }),
        ),
        writeAnnotationEdits(
          cell,
          changedAnnotationEdits(baseline, {
            ...baseline,
            range: { startSeconds: 3, endSeconds: 5 },
          }),
        ),
      ]);

      expect(stored.range.endSeconds).toBeGreaterThan(
        stored.range.startSeconds,
      );
      expect([
        { startSeconds: 6, endSeconds: 7 },
        { startSeconds: 3, endSeconds: 5 },
      ]).toContainEqual(stored.range);
    });
  });

  describe("formatTime()", () => {
    it("returns a tenths-precision tape timecode", () => {
      expect(formatTime(65.26)).toBe("01:05.3");
    });

    it("carries rounded tenths across a minute boundary", () => {
      expect(formatTime(59.96)).toBe("01:00.0");
    });

    it("returns zero for negative and non-finite positions", () => {
      expect([formatTime(-1), formatTime(Number.NaN)]).toEqual([
        "00:00.0",
        "00:00.0",
      ]);
    });
  });

  describe("cueSpecs()", () => {
    it("preserves stable annotation identity and timing", () => {
      expect(cueSpecs([annotation])).toEqual([{
        id: "annotation-stable-id",
        startSeconds: 3.2,
        endSeconds: 5.8,
        text: "Frog cluster",
      }]);
    });
  });

  describe("normalizeDurationSeconds()", () => {
    it("bounds untrusted durations before audio allocation", () => {
      expect([
        normalizeDurationSeconds(-50),
        normalizeDurationSeconds(Number.POSITIVE_INFINITY),
        normalizeDurationSeconds(1_000_000),
      ]).toEqual([1, 18, 120]);
    });
  });

  describe("durationRequestTarget()", () => {
    it("retains a duration update that arrives before hydration finishes", () => {
      let requested = durationRequestTarget(18, undefined, false);

      requested = durationRequestTarget(24, 18, false);

      expect(requested).toBe(24);
      expect(durationRequestTarget(requested!, 18, true)).toBe(24);
      expect(durationRequestTarget(requested!, 24, true)).toBeUndefined();
    });
  });

  describe("planDurationTransition()", () => {
    it("keeps playback moving when an extended tape still contains the playhead", () => {
      expect(planDurationTransition(24, 8.5, true)).toEqual({
        durationSeconds: 24,
        positionSeconds: 8.5,
        resumePlayback: true,
      });
    });

    it("clamps and stops playback when a shorter tape ends before the playhead", () => {
      expect(planDurationTransition(4, 8.5, true)).toEqual({
        durationSeconds: 4,
        positionSeconds: 4,
        resumePlayback: false,
      });
    });

    it("restores playback when the final coalesced duration contains the original playhead", () => {
      const originalPosition = 90;
      expect(planDurationTransition(60, originalPosition, true)).toEqual({
        durationSeconds: 60,
        positionSeconds: 60,
        resumePlayback: false,
      });
      expect(planDurationTransition(120, originalPosition, true)).toEqual({
        durationSeconds: 120,
        positionSeconds: 90,
        resumePlayback: true,
      });
    });
  });

  describe("playbackPositionAt()", () => {
    it("captures elapsed playback before a coalesced duration rebuild", () => {
      const position = playbackPositionAt(120, 12, 7, 37);
      expect(position).toBe(42);
      expect(planDurationTransition(100, position, true)).toEqual({
        durationSeconds: 100,
        positionSeconds: 42,
        resumePlayback: true,
      });
    });
  });

  describe("confidenceFor()", () => {
    it("averages the initial reading with matching shared assessments", () => {
      const assessments: ConfidenceAssessment[] = [
        {
          id: "assessment-a",
          annotationId: annotation.id,
          reviewerId: "reviewer-b",
          confidence: 0.6,
        },
        {
          id: "assessment-b",
          annotationId: annotation.id,
          reviewerId: "reviewer-c",
          confidence: 0.7,
        },
        {
          id: "assessment-other",
          annotationId: "another-annotation",
          reviewerId: "reviewer-d",
          confidence: 0.1,
        },
      ];

      expect(confidenceFor(annotation, assessments)).toBeCloseTo(0.7);
    });
  });

  describe("buildSyntheticWav()", () => {
    it("returns a deterministic mono PCM WAV at the declared duration", () => {
      const first = buildSyntheticWav(1);
      const second = buildSyntheticWav(1);
      const firstBytes = new Uint8Array(first);

      expect(firstBytes).toEqual(new Uint8Array(second));
      expect(first.byteLength).toBe(44 + WAV_SAMPLE_RATE * 2);
      expect(new TextDecoder().decode(firstBytes.slice(0, 4))).toBe("RIFF");
      expect(new TextDecoder().decode(firstBytes.slice(8, 12))).toBe("WAVE");
      expect(firstBytes.slice(44).some((byte) => byte !== 0)).toBe(true);
    });

    it("emits PCM RIFF headers with internally consistent chunk lengths", () => {
      const wav = buildSyntheticWav(1);
      const view = new DataView(wav);
      const ascii = (start: number, end: number) =>
        new TextDecoder().decode(wav.slice(start, end));

      expect(ascii(0, 4)).toBe("RIFF");
      expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
      expect(ascii(8, 12)).toBe("WAVE");
      expect(ascii(12, 16)).toBe("fmt ");
      expect(view.getUint32(16, true)).toBe(16);
      expect(view.getUint16(20, true)).toBe(1);
      expect(view.getUint16(22, true)).toBe(1);
      expect(view.getUint32(24, true)).toBe(WAV_SAMPLE_RATE);
      expect(view.getUint32(28, true)).toBe(WAV_SAMPLE_RATE * 2);
      expect(view.getUint16(32, true)).toBe(2);
      expect(view.getUint16(34, true)).toBe(16);
      expect(ascii(36, 40)).toBe("data");
      expect(view.getUint32(40, true)).toBe(wav.byteLength - 44);
    });

    it("uses the minimum safe duration for a negative input", () => {
      expect(buildSyntheticWav(-1).byteLength).toBe(
        44 + WAV_SAMPLE_RATE * 2,
      );
    });
  });
});
