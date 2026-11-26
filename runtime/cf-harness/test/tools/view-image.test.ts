import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  isViewImageToolSuccessOutput,
  viewImageTool,
  type ViewImageToolOutput,
} from "../../src/tools/view-image.ts";
import { RESERVED_ARTIFACT_PATH_DETAIL } from "../../src/tools/reserved-artifacts.ts";
import {
  createToolsSmallContext,
  type ToolsSmallContextOptions,
} from "../support/tools-small-context.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const ONE_PIXEL_PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x04,
  0x00,
  0x00,
  0x00,
  0xb5,
  0x1c,
  0x0c,
  0x02,
  0x00,
  0x00,
  0x00,
  0x0b,
  0x49,
  0x44,
  0x41,
  0x54,
  0x78,
  0xda,
  0x63,
  0xfc,
  0xff,
  0x1f,
  0x00,
  0x03,
  0x03,
  0x02,
  0x00,
  0xef,
  0xbf,
  0xa7,
  0xde,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
]);

describe("view-image", () => {
  let tempDir: string;
  let workspace: string;

  beforeEach(async () => {
    tempDir = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "cf-harness-view-image-" }),
    );
    workspace = join(tempDir, "workspace");
    await Deno.mkdir(workspace);
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  const view = (
    path: string,
    options: Omit<ToolsSmallContextOptions, "workspaceHostPath"> = {},
  ): Promise<ViewImageToolOutput> =>
    viewImageTool.invoke(
      createToolsSmallContext({ ...options, workspaceHostPath: workspace }),
      { path },
    );

  const errorOf = (output: ViewImageToolOutput) => {
    if (isViewImageToolSuccessOutput(output)) {
      throw new Error("expected a view_image error output");
    }
    return output.error;
  };

  it("returns an image attachment for a PNG file in the workspace", async () => {
    await Deno.writeFile(join(workspace, "pixel.png"), ONE_PIXEL_PNG);
    const output = await view("pixel.png");
    if (!isViewImageToolSuccessOutput(output)) {
      throw new Error(`expected an image, got ${JSON.stringify(output)}`);
    }
    expect(output).toMatchObject({
      path: "/workspace/pixel.png",
      mediaType: "image/png",
      bytes: ONE_PIXEL_PNG.byteLength,
    });
    expect(output.imageAttachment.hostPath).toBe(join(workspace, "pixel.png"));
  });

  it("returns path_outside_workspace for a path that escapes the workspace", async () => {
    expect(errorOf(await view("../secret.png"))).toMatchObject({
      code: "path_outside_workspace",
      path: "../secret.png",
    });
  });

  it("returns permission_denied for a path inside the artifact root", async () => {
    expect(
      errorOf(
        await view("artifacts/shot.png", {
          artifactRootHostPath: join(workspace, "artifacts"),
        }),
      ),
    ).toMatchObject({
      code: "permission_denied",
      detail: RESERVED_ARTIFACT_PATH_DETAIL,
    });
  });

  it("returns the classified error when the host path cannot be resolved", async () => {
    const failingHostPath = (message: string) => () => {
      throw new Error(message);
    };
    expect(
      errorOf(
        await view("pixel.png", {
          resolveHostPath: failingHostPath("path escapes workspace root"),
        }),
      ),
    ).toMatchObject({
      code: "path_outside_workspace",
      path: "/workspace/pixel.png",
    });
    expect(
      errorOf(
        await view("pixel.png", {
          resolveHostPath: failingHostPath("mount table unavailable"),
        }),
      ),
    ).toMatchObject({ code: "unknown", detail: "mount table unavailable" });
  });

  it("returns file_not_found for a missing file", async () => {
    expect(errorOf(await view("missing.png")).code).toBe("file_not_found");
  });

  it("returns not_a_file for a directory", async () => {
    await Deno.mkdir(join(workspace, "pictures.png"));
    expect(errorOf(await view("pictures.png")).code).toBe("not_a_file");
  });

  it("returns path_outside_workspace for a symlink that leads out of the workspace", async () => {
    await Deno.writeFile(join(tempDir, "outside.png"), ONE_PIXEL_PNG);
    await Deno.symlink(
      join(tempDir, "outside.png"),
      join(workspace, "link.png"),
    );
    expect(errorOf(await view("link.png")).code).toBe(
      "path_outside_workspace",
    );
  });

  it("returns unknown for an empty file or a file that is not a supported image", async () => {
    await Deno.writeFile(join(workspace, "empty.png"), new Uint8Array());
    await Deno.writeTextFile(join(workspace, "notes.txt"), "not an image");
    expect(errorOf(await view("empty.png"))).toMatchObject({
      code: "unknown",
      detail: expect.stringContaining("path is empty"),
    });
    expect(errorOf(await view("notes.txt"))).toMatchObject({
      code: "unknown",
      detail: expect.stringContaining("supported image type"),
    });
  });
});
