import type { DID } from "@commonfabric/identity";
import type { RuntimeClient } from "@commonfabric/runtime-client";

export interface StoredFile {
  id: string;
  name: string;
  mediaType: string;
  type: string;
  size: number;
  createdAt: number;
  timestamp: number;
  lastModified?: number;
  url: string;
  data?: string;
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
}

export interface StoreFileOptions {
  file: File;
  runtime: RuntimeClient;

  /** The space the file's blob belongs to — part of its address. */
  space: DID;

  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
  includeDataUrl?: boolean;
}

export async function uploadFile(
  options: StoreFileOptions,
): Promise<StoredFile> {
  const { file, runtime, space, width, height, metadata, includeDataUrl } =
    options;
  const createdAt = Date.now();
  const mediaType = file.type || "application/octet-stream";
  const buffer = await file.arrayBuffer();
  const upload = await runtime.uploadBlob({
    space,
    contentType: mediaType,
    body: buffer,
    suffix: fileSuffix(file.name, mediaType),
  });

  return {
    id: upload.id,
    name: file.name,
    mediaType,
    type: mediaType,
    size: file.size,
    createdAt,
    timestamp: createdAt,
    lastModified: file.lastModified || undefined,
    url: upload.url,
    ...(includeDataUrl ? { data: await fileToDataUrl(file, buffer) } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

export function sanitizeFileName(name: string): string {
  const trimmed = name.trim() || "file";
  return trimmed
    .replace(/[^\w.\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "file";
}

export function fileSuffix(name: string, mediaType: string): string {
  const sanitized = sanitizeFileName(name);
  const dot = sanitized.lastIndexOf(".");
  if (dot >= 0 && dot < sanitized.length - 1) {
    return sanitizeFileName(sanitized.slice(dot + 1)).toLowerCase();
  }
  return MIME_SUFFIXES[mediaType] ?? "bin";
}

export async function fileToDataUrl(file: Blob): Promise<string>;
export async function fileToDataUrl(
  file: Blob,
  buffer: ArrayBuffer,
): Promise<string>;
export async function fileToDataUrl(
  file: Blob,
  buffer?: ArrayBuffer,
): Promise<string> {
  const bytes = new Uint8Array(buffer ?? await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    // deno-lint-ignore cf-spread/no-spread-arguments -- one chunk, at most chunkSize bytes, per call
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${file.type || "application/octet-stream"};base64,${
    btoa(binary)
  }`;
}

const MIME_SUFFIXES: Record<string, string> = {
  "application/json": "json",
  "application/pdf": "pdf",
  "application/xml": "xml",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "text/plain": "txt",
};
