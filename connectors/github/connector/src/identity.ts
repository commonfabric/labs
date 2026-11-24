/** Encode the canonical identity of one GitHub connector destination. */
export function encodeGithubTargetIdentity(
  apiUrl: string,
  spaceDid: string,
  source: string,
): Uint8Array {
  if (/\r|\n/.test(apiUrl) || /\r|\n/.test(spaceDid) || /\r|\n/.test(source)) {
    throw new Error("GitHub target identity must not contain line breaks");
  }
  const endpoint = new URL(apiUrl);
  endpoint.username = "";
  endpoint.password = "";
  endpoint.hash = "";
  endpoint.search = "";
  endpoint.pathname = "/";
  const normalizedSource = source.toLowerCase();
  return new TextEncoder().encode(
    `${endpoint.href}\n${spaceDid}\n${normalizedSource}`,
  );
}
