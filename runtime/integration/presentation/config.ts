export type PresentationConfig =
  | { enabled: false }
  | {
    enabled: true;
    outputDir: string;
    videoFileName: string;
    viewport: { width: number; height: number };
    typingDelayMs: number;
    cursorTravelMs: number;
    cursorSettleMs: number;
    clickPulseMs: number;
    postResultHoldMs: number;
    jpegQuality: number;
    keepFrames: boolean;
  };

export type PresentationParticipant = {
  id?: string;
  label?: string;
  color?: string;
};

const positiveInt = (
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number => {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
};

export function parsePresentationConfig(
  env: Record<string, string | undefined>,
): PresentationConfig {
  const outputDir = env.CF_DEMO_OUTPUT_DIR;
  if (!outputDir) return { enabled: false };

  const demoName = env.CF_DEMO_NAME ?? "demo";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(demoName)) {
    throw new Error(
      `CF_DEMO_NAME must be a safe filename stem, got "${demoName}"`,
    );
  }

  const viewportRaw = env.CF_DEMO_VIEWPORT ?? "1280x720";
  const match = /^(\d+)x(\d+)$/.exec(viewportRaw);
  if (!match) {
    throw new Error(
      `CF_DEMO_VIEWPORT must have WIDTHxHEIGHT form, got "${viewportRaw}"`,
    );
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 320 || height < 240) {
    throw new Error("CF_DEMO_VIEWPORT must be at least 320x240");
  }

  const jpegQuality = positiveInt(env, "CF_DEMO_JPEG_QUALITY", 85);
  if (jpegQuality < 1 || jpegQuality > 100) {
    throw new Error("CF_DEMO_JPEG_QUALITY must be between 1 and 100");
  }

  return {
    enabled: true,
    outputDir,
    videoFileName: `${demoName}.mp4`,
    viewport: { width, height },
    typingDelayMs: positiveInt(env, "CF_DEMO_TYPING_DELAY_MS", 55),
    cursorTravelMs: positiveInt(env, "CF_DEMO_CURSOR_TRAVEL_MS", 350),
    cursorSettleMs: positiveInt(env, "CF_DEMO_CURSOR_SETTLE_MS", 150),
    clickPulseMs: positiveInt(env, "CF_DEMO_CLICK_PULSE_MS", 180),
    postResultHoldMs: positiveInt(env, "CF_DEMO_POST_RESULT_HOLD_MS", 800),
    jpegQuality,
    keepFrames: env.CF_DEMO_KEEP_FRAMES === "1" ||
      env.CF_DEMO_KEEP_FRAMES === "true",
  };
}

export const presentationConfig = parsePresentationConfig(Deno.env.toObject());
