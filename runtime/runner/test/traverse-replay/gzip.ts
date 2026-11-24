/** Web-standard gzip helpers (repo lint forbids `node:` imports). */

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readMaybeGzippedText(path: string): Promise<string> {
  if (path.endsWith(".gz")) {
    return new TextDecoder().decode(await gunzip(Deno.readFileSync(path)));
  }
  return Deno.readTextFileSync(path);
}

export async function writeGzippedText(
  path: string,
  text: string,
): Promise<void> {
  Deno.writeFileSync(path, await gzip(new TextEncoder().encode(text)));
}
