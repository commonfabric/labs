#!/usr/bin/env -S deno run -A

import { dirname, join, resolve } from "@std/path";
import { findFfmpeg } from "@commonfabric/integration";
import { findIntegrationTestFiles } from "./integration.ts";
import { packageDirNamed } from "./package-layout.ts";

export type DemoOptions = {
  packageName: "patterns" | "shell";
  filters: string[];
  outputPath?: string;
  keepFrames: boolean;
  portOffset?: number;
  viewport?: string;
};

export type DemoDependencies = {
  now(): Date;
  preflight(): Promise<void>;
  runIntegration(
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ): Promise<{ success: boolean; code: number }>;
};

export const defaultDependencies: DemoDependencies = {
  now: () => new Date(),
  preflight: async () => {
    await findFfmpeg();
  },
  runIntegration: async (args, cwd, env) =>
    await new Deno.Command(Deno.execPath(), {
      args,
      cwd,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn().status,
};

export function parseDemoArgs(args: string[]): DemoOptions {
  const positional: string[] = [];
  let outputPath: string | undefined;
  let keepFrames = false;
  let portOffset: number | undefined;
  let viewport: string | undefined;
  for (const arg of args) {
    if (arg === "--keep-frames") keepFrames = true;
    else if (arg.startsWith("--output=")) outputPath = arg.slice(9);
    else if (arg.startsWith("--port-offset=")) {
      portOffset = Number(arg.slice(14));
      if (!Number.isInteger(portOffset) || portOffset < 0) {
        throw new Error(`invalid --port-offset: ${arg}`);
      }
    } else if (arg.startsWith("--viewport=")) viewport = arg.slice(11);
    else if (arg === "--help" || arg === "-h") throw new HelpRequested();
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length < 2) {
    throw new Error(
      "usage: deno task demo <patterns|shell> <test-file-filter> [...filters]",
    );
  }
  const packageName = positional[0];
  if (packageName !== "patterns" && packageName !== "shell") {
    throw new Error(`unsupported browser-test package: ${packageName}`);
  }
  return {
    packageName,
    filters: positional.slice(1),
    outputPath,
    keepFrames,
    portOffset,
    viewport,
  };
}

export async function resolveDemoTest(
  rootDir: string,
  packageName: DemoOptions["packageName"],
  filter: string,
): Promise<string> {
  const integrationDir = join(
    rootDir,
    packageDirNamed(rootDir, packageName),
    "integration",
  );
  const matches = await findIntegrationTestFiles(
    integrationDir,
    filter,
  );
  const exactName = filter.endsWith(".test.ts") ? filter : `${filter}.test.ts`;
  if (matches.includes(exactName)) return exactName;
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `no ${packageName} integration test matches "${filter}"`
        : `demo filter "${filter}" is ambiguous: ${matches.join(", ")}`,
    );
  }
  return matches[0];
}

export async function runDemo(
  options: DemoOptions,
  rootDir = Deno.cwd(),
  dependencies: DemoDependencies = defaultDependencies,
): Promise<number> {
  const testFiles = await Promise.all(
    options.filters.map((filter) =>
      resolveDemoTest(rootDir, options.packageName, filter)
    ),
  );
  if (new Set(testFiles).size !== testFiles.length) {
    throw new Error("demo filters must resolve to distinct test files");
  }
  const testNames = testFiles.map((file) => file.replace(/\.test\.ts$/, ""));
  if (testNames.length > 1 && options.outputPath?.endsWith(".mp4")) {
    throw new Error("multi-test --output must be a directory, not an MP4 path");
  }
  await dependencies.preflight();
  const stamp = dependencies.now().toISOString().replace(/[:.]/g, "-");
  const runName = testNames.length === 1 ? testNames[0] : "gallery";
  const runDir = resolve(
    rootDir,
    "tmp",
    "demos",
    `${options.packageName}-${runName}-${stamp}`,
  );
  await Deno.mkdir(runDir, { recursive: true });
  console.log(`Demo artifacts: ${runDir}`);
  const galleryVideos: GalleryVideo[] = [];
  await writeGallery(runDir, galleryVideos);
  const collectionOutputDir = testNames.length > 1 && options.outputPath
    ? resolve(rootDir, options.outputPath)
    : undefined;

  for (let index = 0; index < testFiles.length; index++) {
    const testFile = testFiles[index];
    const testName = testNames[index];
    const filter = options.filters[index];
    const testDir = testFiles.length === 1 ? runDir : join(runDir, testName);
    await Deno.mkdir(testDir, { recursive: true });
    const integrationArgs = ["task", "integration"];
    if (options.portOffset !== undefined) {
      integrationArgs.push(`--port-offset=${options.portOffset}`);
    }
    integrationArgs.push(options.packageName, filter);
    const env = {
      ...Deno.env.toObject(),
      HEADLESS: "1",
      CF_DEMO_OUTPUT_DIR: testDir,
      CF_DEMO_NAME: testName,
      ...(options.keepFrames ? { CF_DEMO_KEEP_FRAMES: "1" } : {}),
      ...(options.viewport ? { CF_DEMO_VIEWPORT: options.viewport } : {}),
    };
    console.log(`Recording ${options.packageName}/${testFile}`);
    const status = await dependencies.runIntegration(
      integrationArgs,
      rootDir,
      env,
    );
    if (!status.success) {
      const manifestPath = join(testDir, "manifest.json");
      try {
        const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
        if (manifest.status === "passed" || manifest.status === "recording") {
          manifest.status = "test-failed";
          manifest.error = `integration test exited with code ${status.code}`;
          await Deno.writeTextFile(
            manifestPath,
            `${JSON.stringify(manifest, null, 2)}\n`,
          );
        }
      } catch {
        // A setup failure may occur before presentation mode creates a manifest.
      }
      console.error(`Demo test failed; diagnostics retained at ${testDir}`);
      return status.code;
    }

    const generatedVideo = join(testDir, `${testName}.mp4`);
    try {
      await Deno.stat(generatedVideo);
    } catch (cause) {
      throw new Error(`the test passed but did not produce ${testName}.mp4`, {
        cause,
      });
    }
    let finalPath = generatedVideo;
    if (collectionOutputDir) {
      await Deno.mkdir(collectionOutputDir, { recursive: true });
      finalPath = join(collectionOutputDir, `${testName}.mp4`);
      await Deno.copyFile(generatedVideo, finalPath);
    } else if (options.outputPath) {
      finalPath = resolve(rootDir, options.outputPath);
      await Deno.mkdir(dirname(finalPath), { recursive: true });
      await Deno.copyFile(generatedVideo, finalPath);
    }
    galleryVideos.push({
      title: testName,
      src: testFiles.length === 1
        ? `${testName}.mp4`
        : `${testName}/${testName}.mp4`,
    });
    await writeGallery(runDir, galleryVideos);
    if (collectionOutputDir) {
      await writeGallery(
        collectionOutputDir,
        galleryVideos.map((video) => ({
          ...video,
          src: `${video.title}.mp4`,
        })),
      );
    }
    console.log(`Demo video: ${finalPath}`);
  }
  console.log(`Demo gallery: ${join(runDir, "index.html")}`);
  return 0;
}

export type GalleryVideo = { title: string; src: string };

export async function writeGallery(
  directory: string,
  videos: GalleryVideo[],
): Promise<void> {
  const cards = videos.length === 0
    ? '<p class="empty">No completed videos yet.</p>'
    : videos.map((video) => `
      <article>
        <h2>${escapeHtml(video.title)}</h2>
        <video controls preload="metadata" src="${
      escapeHtml(video.src)
    }"></video>
      </article>`).join("");
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    join(directory, "index.html"),
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Integration test demos</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 90rem; margin: 0 auto; padding: 2rem; }
    main { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(30rem, 100%), 1fr)); gap: 2rem; }
    article { min-width: 0; }
    h1 { margin-top: 0; }
    h2 { font-size: 1rem; overflow-wrap: anywhere; }
    video { display: block; width: 100%; background: #000; border-radius: .5rem; }
    .empty { opacity: .7; }
  </style>
</head>
<body>
  <h1>Integration test demos</h1>
  <main>${cards}
  </main>
</body>
</html>
`,
  );
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

class HelpRequested extends Error {}

function printHelp(): void {
  console.log(`Integration-test video demo

Usage:
  deno task demo <patterns|shell> <test-file-filter> [...filters] [options]

Options:
  --output=PATH       Copy one MP4 to PATH, or a batch gallery to a directory
  --keep-frames       Retain JPEG frames and FFconcat inputs
  --viewport=WxH      Source viewport (default 1280x720)
  --port-offset=N     Reuse an explicit local-dev port offset
`);
}

export async function main(
  args: string[],
  run: (options: DemoOptions) => Promise<number> = runDemo,
): Promise<number> {
  try {
    return await run(parseDemoArgs(args));
  } catch (error) {
    if (error instanceof HelpRequested) {
      printHelp();
      return 0;
    }
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

if (import.meta.main) Deno.exitCode = await main(Deno.args);
