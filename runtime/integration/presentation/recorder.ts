import { join } from "@std/path";
import type { ScreencastFrame } from "../astral-adapter.ts";
import type { DemoParticipantManifest, RecordedFrame } from "./manifest.ts";

export interface ScreencastPage {
  startScreencast(options?: {
    format?: "jpeg" | "png";
    quality?: number;
    maxWidth?: number;
    maxHeight?: number;
    everyNthFrame?: number;
  }): Promise<void>;
  stopScreencast(): Promise<void>;
  acknowledgeScreencastFrame(sessionId: number): Promise<void>;
  onScreencastFrame(
    listener: (frame: ScreencastFrame) => void,
  ): () => void;
}

export type RecorderClock = { now(): number };

export type FrameRecorderOptions = {
  participantDir: string;
  id: string;
  label: string;
  color: string;
  quality: number;
  viewport: { width: number; height: number };
  finalHoldMs: number;
  clock?: RecorderClock;
  maxPendingWrites?: number;
  writeFile?: (path: string, data: Uint8Array) => Promise<void>;
};

const decodeBase64 = (data: string): Uint8Array => {
  const binary = atob(data);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export class FrameRecorder {
  readonly #page: ScreencastPage;
  readonly #options: FrameRecorderOptions;
  readonly #clock: RecorderClock;
  #removeListener?: () => void;
  #writeTail: Promise<void> = Promise.resolve();
  #pendingAcknowledgments = new Set<Promise<void>>();
  #pendingWrites = 0;
  #error?: Error;
  #startedAtMs?: number;
  #endedAtMs?: number;
  #frames: RecordedFrame[] = [];
  #state: "idle" | "recording" | "stopped" = "idle";

  constructor(page: ScreencastPage, options: FrameRecorderOptions) {
    this.#page = page;
    this.#options = options;
    this.#clock = options.clock ?? { now: () => performance.now() };
  }

  async start(): Promise<void> {
    if (this.#state === "recording") return;
    if (this.#state === "stopped") {
      throw new Error("a stopped frame recorder cannot be restarted");
    }
    await Deno.mkdir(join(this.#options.participantDir, "frames"), {
      recursive: true,
    });
    this.#startedAtMs = this.#clock.now();
    this.#removeListener = this.#page.onScreencastFrame((frame) =>
      this.#acceptFrame(frame)
    );
    await this.#page.startScreencast({
      format: "jpeg",
      quality: this.#options.quality,
      maxWidth: this.#options.viewport.width,
      maxHeight: this.#options.viewport.height,
      everyNthFrame: 1,
    });
    this.#state = "recording";
  }

  async stop(): Promise<DemoParticipantManifest> {
    if (this.#state === "idle") {
      throw new Error("frame recorder was not started");
    }
    if (this.#state === "recording") {
      this.#state = "stopped";
      try {
        await this.#page.stopScreencast();
      } catch (cause) {
        this.#recordError(
          new Error("failed to stop page screencast", { cause }),
        );
      }
      this.#removeListener?.();
      this.#removeListener = undefined;
      this.#endedAtMs = this.#clock.now();
      await this.#writeTail;
      await Promise.all(this.#pendingAcknowledgments);
      this.#finalizeDurations();
    }
    if (this.#error) throw this.#error;
    if (this.#frames.length === 0) {
      throw new Error(`participant ${this.#options.id} recorded no frames`);
    }
    return this.manifest();
  }

  manifest(): DemoParticipantManifest {
    return {
      id: this.#options.id,
      label: this.#options.label,
      color: this.#options.color,
      captureStartedAtMs: this.#startedAtMs ?? 0,
      captureEndedAtMs: this.#endedAtMs,
      frames: this.#frames.map((frame) => ({ ...frame })),
      error: this.#error?.message,
    };
  }

  #acceptFrame(frame: ScreencastFrame): void {
    if (this.#state === "stopped") return;
    const acknowledgment = this.#page
      .acknowledgeScreencastFrame(frame.sessionId)
      .catch((cause) =>
        this.#recordError(
          new Error("failed to acknowledge screencast frame", {
            cause,
          }),
        )
      )
      .finally(() => this.#pendingAcknowledgments.delete(acknowledgment));
    this.#pendingAcknowledgments.add(acknowledgment);

    const limit = this.#options.maxPendingWrites ?? 120;
    if (this.#pendingWrites >= limit) {
      this.#recordError(
        new Error(`screencast write queue exceeded ${limit} frames`),
      );
      return;
    }
    const sequence = this.#frames.length + 1;
    const filename = `${String(sequence).padStart(6, "0")}.jpg`;
    const path = join(this.#options.participantDir, "frames", filename);
    const recorded: RecordedFrame = {
      sequence,
      path,
      recordedAtMs: this.#clock.now(),
      sourceTimestamp: frame.metadata.timestamp,
      durationSeconds: 0,
      width: frame.metadata.deviceWidth,
      height: frame.metadata.deviceHeight,
    };
    this.#frames.push(recorded);
    this.#pendingWrites++;
    const writeFile = this.#options.writeFile ?? Deno.writeFile;
    this.#writeTail = this.#writeTail
      .then(() => writeFile(path, decodeBase64(frame.data)))
      .catch((cause) => {
        this.#recordError(
          new Error(`failed to write frame ${sequence}`, {
            cause,
          }),
        );
      })
      .finally(() => this.#pendingWrites--);
  }

  #finalizeDurations(): void {
    for (let index = 0; index < this.#frames.length - 1; index++) {
      this.#frames[index].durationSeconds = Math.max(
        0.001,
        (this.#frames[index + 1].recordedAtMs -
          this.#frames[index].recordedAtMs) / 1000,
      );
    }
    if (this.#frames.length > 0) {
      this.#frames.at(-1)!.durationSeconds = Math.max(
        0.001,
        this.#options.finalHoldMs / 1000,
      );
    }
  }

  #recordError(error: Error): void {
    this.#error ??= error;
  }
}
