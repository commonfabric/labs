import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { extname, isAbsolute, join, relative, resolve } from "@std/path";
import {
  HARNESS_IMAGE_ATTACHMENT_TYPE,
  type HarnessImageAttachment,
  type HarnessImageMediaType,
} from "./contracts/image.ts";
import type { OpenAIChatMessageContentPart } from "./gateway/openai-client.ts";

const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set<HarnessImageMediaType>([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/;

const sha256Digest = async (content: Uint8Array): Promise<string> => {
  const digestInput = new ArrayBuffer(content.byteLength);
  new Uint8Array(digestInput).set(content);
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return `sha256:${
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
};

const mediaTypeFromExtension = (
  path: string,
): HarnessImageMediaType | undefined => {
  switch (extname(path).toLowerCase()) {
    case ".gif":
      return "image/gif";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
};

const detectImageMediaType = (
  bytes: Uint8Array,
  path: string,
): HarnessImageMediaType | undefined => {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    ((bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38 &&
      bytes[4] === 0x37 &&
      bytes[5] === 0x61) ||
      (bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38 &&
        bytes[4] === 0x39 &&
        bytes[5] === 0x61))
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return mediaTypeFromExtension(path);
};

export const isRelativePathWithinWorkspace = (
  relativePath: string,
): boolean =>
  relativePath === "" ||
  !(
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    isAbsolute(relativePath) ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(relativePath)
  );

const assertPathWithinWorkspace = (
  workspaceHostPath: string,
  hostPath: string,
): void => {
  if (!isRelativePathWithinWorkspace(relative(workspaceHostPath, hostPath))) {
    throw new Error("--image paths must stay within the workspace");
  }
};

export const parseImageAttachmentPaths = (
  input: string | readonly string[] | undefined,
): string[] => {
  if (input === undefined) {
    return [];
  }
  const values: readonly string[] = Array.isArray(input) ? input : [input];
  if (values.length === 0) {
    return [];
  }
  const paths = values.flatMap((value) =>
    value.split(",").map((part) => part.trim()).filter((part) =>
      part.length > 0
    )
  );
  if (paths.length === 0) {
    throw new Error("--image requires a non-empty path");
  }
  return paths;
};

const extensionForMediaType = (
  mediaType: HarnessImageMediaType,
): string => {
  switch (mediaType) {
    case "image/gif":
      return ".gif";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
  }
};

// Content-addressed by digest, so a re-view of identical bytes reuses the
// same snapshot file and differing bytes can never collide.
const writeImageAttachmentSnapshot = async (
  snapshotDir: string,
  bytes: Uint8Array,
  digest: string,
  mediaType: HarnessImageMediaType,
): Promise<string> => {
  const snapshotPath = join(
    snapshotDir,
    `${digest.replace(/^sha256:/, "")}${extensionForMediaType(mediaType)}`,
  );
  try {
    const stat = await Deno.stat(snapshotPath);
    if (stat.isFile && stat.size === bytes.byteLength) {
      return snapshotPath;
    }
  } catch (error) {
    // A missing snapshot is written below; anything else (permissions,
    // I/O) must surface as itself rather than as a later write failure.
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  await Deno.mkdir(snapshotDir, { recursive: true });
  const tempPath = `${snapshotPath}.tmp-${crypto.randomUUID()}`;
  await Deno.writeFile(tempPath, bytes);
  await Deno.rename(tempPath, snapshotPath);
  return snapshotPath;
};

export const createHarnessImageAttachment = async (
  options: {
    workspaceHostPath: string;
    cwd: string;
    path: string;

    /**
     * Directory to snapshot the image bytes into. When provided, the
     * attachment materializes from the snapshot for the rest of the run and
     * the source file may change freely afterwards. When absent, the
     * attachment stays locked to the source file's bytes and digest.
     */
    snapshotDir?: string;
  },
): Promise<HarnessImageAttachment> => {
  const workspaceHostPath = await Deno.realPath(options.workspaceHostPath);
  const hostPath = await Deno.realPath(resolve(options.cwd, options.path));
  assertPathWithinWorkspace(workspaceHostPath, hostPath);
  const stat = await Deno.stat(hostPath);
  if (!stat.isFile) {
    throw new Error(`--image path is not a file: ${options.path}`);
  }
  const bytes = await Deno.readFile(hostPath);
  if (bytes.byteLength === 0) {
    throw new Error(`--image path is empty: ${options.path}`);
  }
  if (bytes.byteLength > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error(
      `--image path is too large (${bytes.byteLength} bytes, max ${MAX_IMAGE_ATTACHMENT_BYTES}): ${options.path}`,
    );
  }
  const mediaType = detectImageMediaType(bytes, hostPath);
  if (mediaType === undefined || !IMAGE_MEDIA_TYPES.has(mediaType)) {
    throw new Error(
      `--image path is not a supported image type: ${options.path}`,
    );
  }
  const digest = await sha256Digest(bytes);
  const snapshotPath = options.snapshotDir === undefined
    ? undefined
    : await writeImageAttachmentSnapshot(
      options.snapshotDir,
      bytes,
      digest,
      mediaType,
    );
  return {
    type: HARNESS_IMAGE_ATTACHMENT_TYPE,
    hostPath,
    mediaType,
    bytes: bytes.byteLength,
    digest,
    ...(snapshotPath === undefined ? {} : { snapshotPath }),
  };
};

/** Decode and validate inline bytes before a host accepts or stores a job. */
export const decodeHarnessInlineImage = (
  options: { base64: string; mediaType: HarnessImageMediaType },
): Uint8Array => {
  const { base64, mediaType } = options;
  if (base64.length > Math.ceil(MAX_IMAGE_ATTACHMENT_BYTES / 3) * 4) {
    throw new Error(
      `the image is too large (max ${MAX_IMAGE_ATTACHMENT_BYTES} bytes)`,
    );
  }
  const bytes = decodeBase64(base64);
  if (bytes.byteLength === 0) {
    throw new Error("the image is empty");
  }
  if (bytes.byteLength > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error(
      `the image is too large (${bytes.byteLength} bytes, max ${MAX_IMAGE_ATTACHMENT_BYTES})`,
    );
  }
  if (encodeBase64(bytes) !== base64) {
    throw new Error("the image must use canonical base64");
  }
  // No path to fall back on: only the bytes' own signature decides.
  if (detectImageMediaType(bytes, "") !== mediaType) {
    throw new Error(`the image is not ${mediaType}`);
  }
  return bytes;
};

/**
 * Makes an attachment of base64-encoded image bytes a tool produced rather
 * than read from the workspace — a browser host's screenshot, say. The bytes
 * are written into `snapshotDir` under their digest, and the attachment
 * materializes from there for the rest of the run. An encoding longer than
 * the largest attachment could need is refused before it is decoded.
 *
 * @throws Error when the bytes are empty, larger than an attachment may be,
 * not base64, or not an image of the declared type.
 */
export const createHarnessImageAttachmentFromBase64 = async (
  options: {
    snapshotDir: string;
    base64: string;
    mediaType: HarnessImageMediaType;
  },
): Promise<HarnessImageAttachment> => {
  const { base64, mediaType, snapshotDir } = options;
  const bytes = decodeHarnessInlineImage({ base64, mediaType });
  const digest = await sha256Digest(bytes);
  const snapshotPath = await writeImageAttachmentSnapshot(
    snapshotDir,
    bytes,
    digest,
    mediaType,
  );
  return {
    type: HARNESS_IMAGE_ATTACHMENT_TYPE,
    hostPath: snapshotPath,
    mediaType,
    bytes: bytes.byteLength,
    digest,
    snapshotPath,
  };
};

export const materializeImageAttachmentContentPart = async (
  attachment: HarnessImageAttachment,
): Promise<OpenAIChatMessageContentPart> => {
  const sourceLabel = attachment.snapshotPath === undefined
    ? "image attachment"
    : "image attachment snapshot";
  const sourcePath = attachment.snapshotPath ?? attachment.hostPath;
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(sourcePath);
  } catch (error) {
    if (
      attachment.snapshotPath !== undefined &&
      error instanceof Deno.errors.NotFound
    ) {
      throw new Error(
        `image attachment snapshot missing: ${attachment.snapshotPath}`,
      );
    }
    throw error;
  }
  if (bytes.byteLength !== attachment.bytes) {
    throw new Error(
      `${sourceLabel} changed after run start: ${sourcePath}`,
    );
  }
  const digest = await sha256Digest(bytes);
  if (digest !== attachment.digest) {
    throw new Error(
      `${sourceLabel} digest changed after run start: ${sourcePath}`,
    );
  }
  return {
    type: "image_url",
    image_url: {
      url: `data:${attachment.mediaType};base64,${encodeBase64(bytes)}`,
    },
  };
};
