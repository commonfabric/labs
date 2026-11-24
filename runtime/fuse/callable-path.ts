import { decodeFuseComponent } from "./path-codec.ts";

export interface MountedCallablePath {
  spaceName: string;
  rootKind: "pieces" | "entities";
  rootName: string;
  cellProp: "input" | "result";
  cellKey: string;
  callableKind: "handler" | "tool";
  rootLevel: boolean;
}

export function parseMountedCallablePath(
  path: string,
): MountedCallablePath | null {
  const normalized = path.replace(/^\/+|\/+$/g, "");
  if (!normalized) return null;

  const segments = normalized.split("/");
  if (segments.length !== 4 && segments.length !== 5) return null;

  if (segments.length === 4) {
    const [spaceName, rootKind, rootName, fileName] = segments;
    if (!spaceName || !rootName) return null;
    if (rootKind !== "pieces" && rootKind !== "entities") return null;

    const match = /^(.+)\.(handler|tool)$/.exec(fileName);
    if (!match) return null;

    const [, encodedCellKey, callableKind] = match;
    const cellKey = decodeFuseComponent(encodedCellKey);
    if (!cellKey) return null;

    return {
      spaceName: decodeFuseComponent(spaceName),
      rootKind,
      rootName: decodeFuseComponent(rootName),
      cellProp: "result",
      cellKey,
      callableKind: callableKind as "handler" | "tool",
      rootLevel: true,
    };
  }

  const [spaceName, rootKind, rootName, cellProp, fileName] = segments;
  if (!spaceName || !rootName) return null;
  if (rootKind !== "pieces" && rootKind !== "entities") return null;
  if (cellProp !== "input" && cellProp !== "result") return null;

  const match = /^(.+)\.(handler|tool)$/.exec(fileName);
  if (!match) return null;

  const [, encodedCellKey, callableKind] = match;
  const cellKey = decodeFuseComponent(encodedCellKey);
  if (!cellKey) return null;

  return {
    spaceName: decodeFuseComponent(spaceName),
    rootKind,
    rootName: decodeFuseComponent(rootName),
    cellProp,
    cellKey,
    callableKind: callableKind as "handler" | "tool",
    rootLevel: false,
  };
}
