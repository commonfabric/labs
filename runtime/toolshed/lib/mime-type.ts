import { basename } from "@std/path";

const MIME_TYPES: Record<string, string> = {
  "css": "text/css",
  "html": "text/html",
  "js": "text/javascript",
  "json": "application/json",
  "map": "application/json",
  "md": "text/plain",
  "png": "image/png",
  "svg": "image/svg+xml",
  "ts": "text/typescript",
  "ttf": "font/ttf",
  "txt": "text/plain",
  "webmanifest": "application/manifest+json",
};

const DEFAULT_MIME_TYPE = "application/octet-stream";

export function getMimeType(filename: string): string {
  const split = basename(filename).split(".");
  if (split.length < 2) {
    // No "." in name.
    return DEFAULT_MIME_TYPE;
  }
  const ext = split.pop()!;
  return MIME_TYPES[ext] ?? DEFAULT_MIME_TYPE;
}
