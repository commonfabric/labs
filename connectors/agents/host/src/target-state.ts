import { join, resolve } from "@std/path";

export type TargetStateEnvReader = (key: string) => string | undefined;

export function parseAgentFabricApiUrl(
  value: string,
  errorMessage = "Common Fabric API URL is not valid",
): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(errorMessage);
  }
}

export async function agentTargetKey(
  apiUrl: string,
  spaceDid: string,
  ownerDid: string,
): Promise<string> {
  const endpoint = parseAgentFabricApiUrl(apiUrl);
  endpoint.username = "";
  endpoint.password = "";
  endpoint.hash = "";
  endpoint.search = "";
  endpoint.pathname = "/";
  const identity = `${endpoint.href}\n${spaceDid}\n${ownerDid}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function defaultAgentsHostStateDirectory(
  readEnv: TargetStateEnvReader = (key) => Deno.env.get(key),
): string {
  const xdgStateHome = readEnv("XDG_STATE_HOME")?.trim();
  if (xdgStateHome) {
    return join(resolve(xdgStateHome), "commonfabric", "agents-host");
  }

  if (Deno.build.os === "windows") {
    const localAppData = readEnv("LOCALAPPDATA")?.trim();
    if (!localAppData) {
      throw new Error(
        "LOCALAPPDATA is required to locate durable agent host state",
      );
    }
    return join(resolve(localAppData), "CommonFabric", "agents-host");
  }

  const home = readEnv("HOME")?.trim();
  if (!home) {
    throw new Error("HOME is required to locate durable agent host state");
  }
  if (Deno.build.os === "darwin") {
    return join(
      resolve(home),
      "Library",
      "Application Support",
      "CommonFabric",
      "agents-host",
    );
  }
  return join(resolve(home), ".local", "state", "commonfabric", "agents-host");
}

export async function defaultTargetLedgerPath(
  apiUrl: string,
  spaceDid: string,
  ownerDid: string,
  stateDirectory = defaultAgentsHostStateDirectory(),
): Promise<string> {
  return join(
    resolve(stateDirectory),
    `target-${await agentTargetKey(
      apiUrl,
      spaceDid,
      ownerDid,
    )}.command-ledger.json`,
  );
}
