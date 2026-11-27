import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  createHarnessImageAttachment,
  decodeHarnessInlineImage,
  isRelativePathWithinWorkspace,
  materializeImageAttachmentContentPart,
  parseImageAttachmentPaths,
} from "../src/image-attachments.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
  test,
} from "@commonfabric/test-support/test";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngBytes = (...payload: number[]): Uint8Array =>
  new Uint8Array([...PNG_SIGNATURE, ...payload]);

const dataUrl = (bytes: Uint8Array): string =>
  `data:image/png;base64,${encodeBase64(bytes)}`;

test("inline images reject noncanonical padding bits for the same bytes", () => {
  assertEquals(
    decodeHarnessInlineImage({
      mediaType: "image/png",
      base64: "iVBORw0KGgo=",
    }),
    pngBytes(),
  );
  assertThrows(
    () =>
      decodeHarnessInlineImage({
        mediaType: "image/png",
        base64: "iVBORw0KGgp=",
      }),
    Error,
    "canonical base64",
  );
});

const makeWorkspaceImage = async (
  bytes: Uint8Array,
): Promise<{ workspace: string; imagePath: string }> => {
  const workspace = await Deno.makeTempDir();
  const imagePath = join(workspace, "render.png");
  await Deno.writeFile(imagePath, bytes);
  return { workspace, imagePath };
};

test("isRelativePathWithinWorkspace rejects escaped and absolute relative results", () => {
  const cases: Array<[string, boolean]> = [
    ["", true],
    ["capture.png", true],
    ["captures/example.png", true],
    ["..capture.png", true],
    ["..", false],
    ["../capture.png", false],
    ["..\\capture.png", false],
    ["/tmp/capture.png", false],
    ["C:\\captures\\example.png", false],
    ["D:/captures/example.png", false],
    ["\\\\server\\share\\capture.png", false],
  ];

  for (const [relativePath, expected] of cases) {
    assertEquals(isRelativePathWithinWorkspace(relativePath), expected);
  }
});

test("snapshot attachment survives regeneration of the source image", async () => {
  const original = pngBytes(1, 2, 3);
  const { workspace, imagePath } = await makeWorkspaceImage(original);
  const snapshotDir = join(await Deno.makeTempDir(), "image-attachments");

  const attachment = await createHarnessImageAttachment({
    workspaceHostPath: workspace,
    cwd: workspace,
    path: imagePath,
    snapshotDir,
  });
  assert(attachment.snapshotPath !== undefined);
  assertStringIncludes(attachment.snapshotPath, snapshotDir);

  // The agent regenerates the image it already viewed — the run must not die.
  await Deno.writeFile(imagePath, pngBytes(9, 9, 9, 9));

  const part = await materializeImageAttachmentContentPart(attachment);
  assertEquals(part.type, "image_url");
  assertEquals(
    (part as { image_url: { url: string } }).image_url.url,
    dataUrl(original),
  );
});

test("identical re-view reuses the content-addressed snapshot file", async () => {
  const bytes = pngBytes(4, 5, 6);
  const { workspace, imagePath } = await makeWorkspaceImage(bytes);
  const snapshotDir = join(await Deno.makeTempDir(), "image-attachments");

  const first = await createHarnessImageAttachment({
    workspaceHostPath: workspace,
    cwd: workspace,
    path: imagePath,
    snapshotDir,
  });
  const second = await createHarnessImageAttachment({
    workspaceHostPath: workspace,
    cwd: workspace,
    path: imagePath,
    snapshotDir,
  });
  assertEquals(first.snapshotPath, second.snapshotPath);

  // Different content must land in a different snapshot file, so
  // re-materializing `first` still sees its original bytes.
  const revisedPath = join(workspace, "render-v2.png");
  await Deno.writeFile(revisedPath, pngBytes(7, 8));
  const changed = await createHarnessImageAttachment({
    workspaceHostPath: workspace,
    cwd: workspace,
    path: revisedPath,
    snapshotDir,
  });
  assertNotEquals(first.snapshotPath, changed.snapshotPath);
});

test("without a snapshot dir, source mutation still fails closed", async () => {
  const { workspace, imagePath } = await makeWorkspaceImage(pngBytes(1));

  const attachment = await createHarnessImageAttachment({
    workspaceHostPath: workspace,
    cwd: workspace,
    path: imagePath,
  });
  assertEquals(attachment.snapshotPath, undefined);

  await Deno.writeFile(imagePath, pngBytes(2, 2));

  await assertRejects(
    () => materializeImageAttachmentContentPart(attachment),
    Error,
    "image attachment changed after run start",
  );
});

test("tampered snapshot fails closed with a snapshot-specific error", async () => {
  const { workspace, imagePath } = await makeWorkspaceImage(pngBytes(3, 1));
  const snapshotDir = join(await Deno.makeTempDir(), "image-attachments");

  const attachment = await createHarnessImageAttachment({
    workspaceHostPath: workspace,
    cwd: workspace,
    path: imagePath,
    snapshotDir,
  });
  assert(attachment.snapshotPath !== undefined);

  // Same length, different content: only the digest check can catch it.
  await Deno.writeFile(attachment.snapshotPath, pngBytes(3, 2));

  await assertRejects(
    () => materializeImageAttachmentContentPart(attachment),
    Error,
    "image attachment snapshot digest changed after run start",
  );
});

test("snapshot file extension follows the detected media type", async () => {
  const cases: Array<{
    bytes: Uint8Array;
    mediaType: string;
    extension: string;
  }> = [
    {
      bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]),
      mediaType: "image/gif",
      extension: ".gif",
    },
    {
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
      mediaType: "image/jpeg",
      extension: ".jpg",
    },
    {
      bytes: new Uint8Array([
        0x52,
        0x49,
        0x46,
        0x46,
        0,
        0,
        0,
        0,
        0x57,
        0x45,
        0x42,
        0x50,
        1,
      ]),
      mediaType: "image/webp",
      extension: ".webp",
    },
  ];
  for (const { bytes, mediaType, extension } of cases) {
    const workspace = await Deno.makeTempDir();
    // An extension-free name forces detection from the magic bytes alone.
    const imagePath = join(workspace, "render");
    await Deno.writeFile(imagePath, bytes);
    const snapshotDir = join(await Deno.makeTempDir(), "image-attachments");

    const attachment = await createHarnessImageAttachment({
      workspaceHostPath: workspace,
      cwd: workspace,
      path: imagePath,
      snapshotDir,
    });

    assertEquals(attachment.mediaType, mediaType);
    assert(attachment.snapshotPath !== undefined);
    assert(
      attachment.snapshotPath.endsWith(extension),
      `expected ${attachment.snapshotPath} to end with ${extension}`,
    );
  }
});

test("a snapshot dir blocked by a regular file surfaces the stat error itself", async () => {
  const { workspace, imagePath } = await makeWorkspaceImage(pngBytes(5));
  const snapshotDir = join(await Deno.makeTempDir(), "image-attachments");
  await Deno.writeTextFile(snapshotDir, "not a directory");

  await assertRejects(
    () =>
      createHarnessImageAttachment({
        workspaceHostPath: workspace,
        cwd: workspace,
        path: imagePath,
        snapshotDir,
      }),
    Deno.errors.NotADirectory,
  );
});

test("a missing source without a snapshot surfaces the original NotFound", async () => {
  const { workspace, imagePath } = await makeWorkspaceImage(pngBytes(8));

  const attachment = await createHarnessImageAttachment({
    workspaceHostPath: workspace,
    cwd: workspace,
    path: imagePath,
  });
  assertEquals(attachment.snapshotPath, undefined);
  await Deno.remove(imagePath);

  await assertRejects(
    () => materializeImageAttachmentContentPart(attachment),
    Deno.errors.NotFound,
  );
});

test("missing snapshot fails closed with a clear error", async () => {
  const { workspace, imagePath } = await makeWorkspaceImage(pngBytes(6));
  const snapshotDir = join(await Deno.makeTempDir(), "image-attachments");

  const attachment = await createHarnessImageAttachment({
    workspaceHostPath: workspace,
    cwd: workspace,
    path: imagePath,
    snapshotDir,
  });
  assert(attachment.snapshotPath !== undefined);
  await Deno.remove(attachment.snapshotPath);

  await assertRejects(
    () => materializeImageAttachmentContentPart(attachment),
    Error,
    "image attachment snapshot missing",
  );
});

describe("image-attachments", () => {
  describe("parseImageAttachmentPaths()", () => {
    it("returns no paths where no `--image` was given", () => {
      expect(parseImageAttachmentPaths(undefined)).toEqual([]);
      expect(parseImageAttachmentPaths([])).toEqual([]);
    });

    it("returns every comma-separated path of every value, trimmed", () => {
      expect(parseImageAttachmentPaths("a.png, b.jpg")).toEqual([
        "a.png",
        "b.jpg",
      ]);
      expect(parseImageAttachmentPaths(["a.png,", " c.gif "])).toEqual([
        "a.png",
        "c.gif",
      ]);
    });

    it("throws where the values name no path at all", () => {
      for (const input of ["", " , ", ["", ","]]) {
        expect(() => parseImageAttachmentPaths(input)).toThrow(
          "--image requires a non-empty path",
        );
      }
    });
  });

  describe("createHarnessImageAttachment()", () => {
    let workspace: string;

    beforeEach(async () => {
      workspace = await Deno.realPath(await Deno.makeTempDir());
    });

    afterEach(async () => {
      await Deno.remove(workspace, { recursive: true });
    });

    const attach = (path: string) =>
      createHarnessImageAttachment({
        workspaceHostPath: workspace,
        cwd: workspace,
        path,
      });

    it("throws for an image outside the workspace", async () => {
      const elsewhere = await Deno.makeTempDir();
      try {
        const imagePath = join(elsewhere, "render.png");
        await Deno.writeFile(imagePath, pngBytes(1));
        await expect(attach(imagePath)).rejects.toThrow(
          "--image paths must stay within the workspace",
        );
      } finally {
        await Deno.remove(elsewhere, { recursive: true });
      }
    });

    it("throws for a directory", async () => {
      await Deno.mkdir(join(workspace, "shots.png"));
      await expect(attach("shots.png")).rejects.toThrow(
        "--image path is not a file: shots.png",
      );
    });

    it("throws for an empty file", async () => {
      await Deno.writeFile(join(workspace, "empty.png"), new Uint8Array());
      await expect(attach("empty.png")).rejects.toThrow(
        "--image path is empty: empty.png",
      );
    });

    it("throws for a file larger than an attachment may be, and not for one at the limit", async () => {
      const limit = 20 * 1024 * 1024;
      const bytes = new Uint8Array(limit + 1);
      bytes.set(PNG_SIGNATURE);
      await Deno.writeFile(join(workspace, "huge.png"), bytes);
      await expect(attach("huge.png")).rejects.toThrow(
        `--image path is too large (${
          limit + 1
        } bytes, max ${limit}): huge.png`,
      );
      await Deno.writeFile(
        join(workspace, "max.png"),
        bytes.subarray(0, limit),
      );
      expect((await attach("max.png")).bytes).toBe(limit);
    });

    it("throws for a file whose bytes and name are both no image's", async () => {
      await Deno.writeTextFile(join(workspace, "notes.txt"), "hello");
      await expect(attach("notes.txt")).rejects.toThrow(
        "--image path is not a supported image type: notes.txt",
      );
    });

    it("returns the media type an image's name gives where its bytes carry no known signature", async () => {
      const unsigned = new TextEncoder().encode("not a known signature");
      for (
        const [name, mediaType] of [
          ["a.gif", "image/gif"],
          ["b.jpeg", "image/jpeg"],
          ["c.JPG", "image/jpeg"],
          ["d.png", "image/png"],
          ["e.webp", "image/webp"],
        ]
      ) {
        await Deno.writeFile(join(workspace, name), unsigned);
        expect((await attach(name)).mediaType).toBe(mediaType);
      }
    });
  });
});
