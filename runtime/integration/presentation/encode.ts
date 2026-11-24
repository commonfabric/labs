import { dirname, isAbsolute, join, relative } from "@std/path";
import type { RecordedFrame } from "./manifest.ts";

export type CompositionPlan = {
  width: number;
  height: number;
  filter: string;
  outputLabel: string;
};

export type CommandResult = {
  success: boolean;
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

export type CommandRunner = (
  command: string,
  args: string[],
  cwd?: string,
) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (command, args, cwd) => {
  return await new Deno.Command(command, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
};

const ffconcatQuote = (path: string): string =>
  `'${path.replaceAll("'", "'\\''")}'`;

export function buildFfconcat(frames: RecordedFrame[]): string {
  if (frames.length === 0) {
    throw new Error("cannot encode recording with no frames");
  }
  const lines = ["ffconcat version 1.0"];
  for (const frame of frames) {
    lines.push(`file ${ffconcatQuote(frame.path)}`);
    lines.push(`duration ${frame.durationSeconds.toFixed(6)}`);
  }
  lines.push(`file ${ffconcatQuote(frames.at(-1)!.path)}`, "");
  return lines.join("\n");
}

export function buildCompositionPlan(
  participantIds: string[],
): CompositionPlan {
  const count = participantIds.length;
  if (count < 1) {
    throw new Error("composition requires at least one participant");
  }
  if (count > 4) {
    throw new Error("composition supports at most four participants");
  }

  const normalize = (index: number) =>
    `[${index}:v]scale=1280:720:force_original_aspect_ratio=decrease,` +
    `pad=1280:720:(ow-iw)/2:(oh-ih)/2:black[v${index}]`;
  if (count === 1) {
    return {
      width: 1280,
      height: 720,
      filter: normalize(0).replace("[v0]", "[vout]"),
      outputLabel: "vout",
    };
  }

  const filters = participantIds.map((_, index) => normalize(index));
  if (count === 2) {
    filters.push("[v0][v1]hstack=inputs=2:shortest=1[vout]");
    return {
      width: 2560,
      height: 720,
      filter: filters.join(";"),
      outputLabel: "vout",
    };
  }

  if (count === 3) {
    filters.push("color=c=black:s=1280x720:d=86400[v3]");
  }
  filters.push(
    "[v0][v1][v2][v3]xstack=inputs=4:" +
      "layout=0_0|1280_0|0_720|1280_720:shortest=1[vout]",
  );
  return {
    width: 2560,
    height: 1440,
    filter: filters.join(";"),
    outputLabel: "vout",
  };
}

export async function findFfmpeg(
  runner: CommandRunner = runCommand,
): Promise<{ command: string; version: string }> {
  const command = Deno.env.get("FFMPEG") ?? "ffmpeg";
  let result: CommandResult;
  try {
    result = await runner(command, ["-version"]);
  } catch (cause) {
    throw new Error(
      "ffmpeg was not found; install ffmpeg or set FFMPEG to its path",
      { cause },
    );
  }
  if (!result.success) {
    throw new Error("ffmpeg preflight failed");
  }
  const firstLine = new TextDecoder().decode(result.stdout).split("\n")[0];
  return { command, version: firstLine };
}

export async function encodeParticipant(
  options: {
    ffmpeg: string;
    participantDir: string;
    frames: RecordedFrame[];
    outputPath: string;
  },
  runner: CommandRunner = runCommand,
): Promise<void> {
  const concatPath = join(options.participantDir, "frames.ffconcat");
  const relativeFrames = options.frames.map((frame) => ({
    ...frame,
    path: isAbsolute(frame.path)
      ? relative(options.participantDir, frame.path)
      : frame.path,
  }));
  await Deno.writeTextFile(concatPath, buildFfconcat(relativeFrames));
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatPath,
    "-vf",
    "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    options.outputPath,
  ];
  const result = await runner(options.ffmpeg, args, options.participantDir);
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).slice(-4000);
    throw new Error(`ffmpeg participant encode failed: ${stderr}`);
  }
}

export async function composeParticipants(
  options: {
    ffmpeg: string;
    streams: string[];
    outputPath: string;
  },
  runner: CommandRunner = runCommand,
): Promise<void> {
  const plan = buildCompositionPlan(options.streams);
  if (options.streams.length === 1) {
    await Deno.copyFile(options.streams[0], options.outputPath);
    return;
  }
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const stream of options.streams) args.push("-i", stream);
  args.push(
    "-filter_complex",
    plan.filter,
    "-map",
    `[${plan.outputLabel}]`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    options.outputPath,
  );
  const result = await runner(
    options.ffmpeg,
    args,
    dirname(options.outputPath),
  );
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).slice(-4000);
    throw new Error(`ffmpeg composition failed: ${stderr}`);
  }
}
