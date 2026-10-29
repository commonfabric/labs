import {
  moduleConnectors,
  type ModuleKind,
  type ModuleSnapClaim,
  type ModuleTransform,
  type StationModule,
  type Vector3Tuple,
} from "./contract.ts";
import {
  connectorIdentityKey,
  findConnections,
  normalizeQuarterTurns,
  rotateVectorY,
  worldConnectors,
} from "./geometry.ts";

export interface WritableBookmarkMap {
  key(moduleId: string): {
    set(value: boolean): Promise<void>;
  };
}

export interface PointerDragOwner {
  pointerId: number;
  moved?: boolean;
}

export interface WritableValue<T> {
  set(value: T): Promise<void>;
}

export interface WritableModuleTransform {
  initialize(value: ModuleTransform): Promise<ModuleTransform>;
  key<Key extends keyof ModuleTransform>(key: Key): WritableValue<
    ModuleTransform[Key]
  >;
}

export type DragDisposition = "ignore" | "restore" | "commit";

export function canBeginDrag(
  active: PointerDragOwner | undefined,
): boolean {
  return active === undefined;
}

export function ownsDrag<T extends PointerDragOwner>(
  active: T | undefined,
  pointerId: number,
): active is T {
  return active?.pointerId === pointerId;
}

/** Decides whether a pointer ending restores or commits its owned preview. */
export function dragDisposition(
  active: PointerDragOwner | undefined,
  pointerId: number,
  cancelled: boolean,
): DragDisposition {
  if (!ownsDrag(active, pointerId)) return "ignore";
  return cancelled || !active.moved ? "restore" : "commit";
}

/** Records cancellation before a renderer can translate it into pointer-up. */
export function markPointerCancelled(
  cancelledPointers: Set<number>,
  pointerId: number,
): void {
  cancelledPointers.add(pointerId);
}

/** Reports whether a renderer's pointer-up originated from cancellation. */
export function pointerWasCancelled(
  cancelledPointers: ReadonlySet<number>,
  pointerId: number,
): boolean {
  return cancelledPointers.has(pointerId);
}

/** Returns the stable transform record used after a snap claim is released. */
export function moduleTransformId(
  moduleId: string,
  claimId?: string,
): string {
  return JSON.stringify([moduleId, claimId ?? null]);
}

/** Projects stable-ID transform records over the append-only module manifest. */
export function applyModuleTransforms(
  modules: readonly StationModule[],
  transforms: Readonly<Record<string, ModuleTransform>>,
  transformIds: Readonly<Record<string, string>>,
  claims: Readonly<Record<string, ModuleSnapClaim | null>> = {},
  releasedClaims: Readonly<Record<string, boolean>> = {},
): StationModule[] {
  return modules.map((module) => {
    const claim = claims[module.id];
    const transformId = claim && releasedClaims[claim.id] === true
      ? moduleTransformId(module.id, claim.id)
      : transformIds[module.id];
    const transform = transforms[transformId];
    return transform ? { ...module, transform } : module;
  });
}

/** Omits only claims whose exact ID was released into a manual transform. */
export function activeSnapClaims(
  claims: Readonly<Record<string, ModuleSnapClaim | null>>,
  releasedClaims: Readonly<Record<string, boolean>>,
): Record<string, ModuleSnapClaim | null> {
  return Object.fromEntries(
    Object.entries(claims).filter(([, claim]) =>
      claim === null || releasedClaims[claim.id] !== true
    ),
  );
}

/** Materializes one transform record and edits one field at a stable ID. */
export async function writeModuleTransformField<
  Key extends keyof ModuleTransform,
>(
  transformId: string,
  transform: WritableModuleTransform,
  activeTransformId: WritableValue<string> | undefined,
  current: ModuleTransform,
  key: Key,
  value: ModuleTransform[Key],
  releasedClaim: WritableValue<boolean> | undefined,
): Promise<void> {
  await transform.initialize(current);
  await transform.key(key).set(value);
  await activeTransformId?.set(transformId);
  await releasedClaim?.set(true);
}

/** Surfaces graphics bootstrap failures before preserving the thrown cause. */
export function initializeGraphics<T>(
  create: () => T,
  onFailure: (cause: unknown) => void,
): T {
  try {
    return create();
  } catch (cause) {
    onFailure(cause);
    throw cause;
  }
}

const KIND_LABEL: Record<ModuleKind, string> = {
  hub: "Junction hub",
  habitat: "Habitat canister",
  cargo: "Cargo spine",
  solar: "Solar rig",
  relay: "Relay mast",
};

const KIND_COLOR: Record<ModuleKind, Vector3Tuple> = {
  hub: [0.28, 0.45, 0.57],
  habitat: [0.29, 0.56, 0.43],
  cargo: [0.69, 0.4, 0.18],
  solar: [0.32, 0.41, 0.72],
  relay: [0.57, 0.34, 0.64],
};

export function createSalvageModule(
  kind: ModuleKind,
  id: string,
): StationModule {
  const firstSeed = stableHash(id, 0x811c_9dc5);
  const secondSeed = stableHash(id, 0x9e37_79b9);
  const angle = firstSeed / 0x1_0000_0000 * Math.PI * 2;
  const radius = 8.5 + secondSeed / 0x1_0000_0000 * 4.2;
  return {
    id,
    label: `${KIND_LABEL[kind]} · ${stableModuleCode(id)}`,
    kind,
    color: [...KIND_COLOR[kind]],
    transform: {
      position: [
        Math.cos(angle) * radius,
        1.2,
        Math.sin(angle) * radius,
      ],
      rotationQuarterTurns: 0,
    },
    connectors: moduleConnectors(kind),
  };
}

export function isBookmarked(
  bookmarks: Readonly<Record<string, boolean>>,
  moduleId: string,
): boolean {
  return bookmarks[moduleId] === true;
}

export function setBookmark(
  bookmarks: WritableBookmarkMap,
  moduleId: string,
  value: boolean,
): Promise<void> {
  return bookmarks.key(moduleId).set(value);
}

/** Resolves snap intents in dependency order through connector-shaped locks. */
export function resolveSnapClaims(
  modules: readonly StationModule[],
  claims: Readonly<Record<string, ModuleSnapClaim | null>>,
): StationModule[] {
  const modulesById = new Map(modules.map((module) => [module.id, module]));
  const candidates = Object.entries(claims).flatMap(([moduleId, claim]) => {
    const moving = modulesById.get(moduleId);
    const target = claim && modulesById.get(claim.targetModuleId);
    if (
      !claim || !moving || !target || moving.id === target.id ||
      !moving.connectors.some((connector) =>
        connector.id === claim.movingConnectorId
      ) ||
      !target.connectors.some((connector) =>
        connector.id === claim.targetConnectorId
      )
    ) return [];
    return [{ moduleId, claim }];
  });
  candidates.sort((left, right) => {
    const leftTarget = connectorIdentityKey(
      left.claim.targetModuleId,
      left.claim.targetConnectorId,
    );
    const rightTarget = connectorIdentityKey(
      right.claim.targetModuleId,
      right.claim.targetConnectorId,
    );
    return leftTarget.localeCompare(rightTarget) ||
      left.moduleId.localeCompare(right.moduleId) ||
      left.claim.id.localeCompare(right.claim.id);
  });
  const claimedTargets = new Set<string>();
  const validClaims = candidates.filter(({ claim }) => {
    const target = connectorIdentityKey(
      claim.targetModuleId,
      claim.targetConnectorId,
    );
    if (claimedTargets.has(target)) return false;
    claimedTargets.add(target);
    return true;
  });
  const pending = new Map(
    validClaims.map(({ moduleId, claim }) => [moduleId, claim]),
  );
  const resolved = new Map(
    modules
      .filter((module) => !pending.has(module.id))
      .map((module) => [module.id, module]),
  );
  const effectiveTransforms = new Map(
    modules.map((module) => [module.id, module.transform]),
  );
  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    for (const { moduleId, claim } of validClaims) {
      if (!pending.has(moduleId) || !resolved.has(claim.targetModuleId)) {
        continue;
      }
      const occupied = occupiedConnectorKeys([...resolved.values()]);
      if (
        occupied.has(
          connectorIdentityKey(claim.targetModuleId, claim.targetConnectorId),
        )
      ) {
        pending.delete(moduleId);
        resolved.set(moduleId, modulesById.get(moduleId)!);
        madeProgress = true;
        continue;
      }
      const moving = modulesById.get(moduleId)!;
      const target = resolved.get(claim.targetModuleId)!;
      const transform = deriveSnapTransform(moving, target, claim);
      pending.delete(moduleId);
      if (!transform) {
        resolved.set(moduleId, moving);
        madeProgress = true;
        continue;
      }
      const snapped = { ...moving, transform };
      if (!realizesClaim(snapped, target, claim)) {
        resolved.set(moduleId, moving);
        madeProgress = true;
        continue;
      }
      effectiveTransforms.set(moduleId, transform);
      resolved.set(moduleId, snapped);
      madeProgress = true;
    }
  }

  return modules.map((module) => {
    const transform = effectiveTransforms.get(module.id)!;
    if (transform === module.transform) return module;
    return {
      ...module,
      transform: {
        position: [...transform.position],
        rotationQuarterTurns: transform.rotationQuarterTurns,
      },
    };
  });
}

/** Returns the shared conflict-domain key for one target connector. */
export function snapTargetKey(
  moduleId: string,
  connectorId: string,
): string {
  return connectorIdentityKey(moduleId, connectorId);
}

function occupiedConnectorKeys(modules: readonly StationModule[]): Set<string> {
  return new Set(
    findConnections(modules).flatMap((connection) => [
      connectorIdentityKey(connection.first.moduleId, connection.first.id),
      connectorIdentityKey(connection.second.moduleId, connection.second.id),
    ]),
  );
}

function deriveSnapTransform(
  moving: StationModule,
  target: StationModule,
  claim: ModuleSnapClaim,
): StationModule["transform"] | undefined {
  const movingConnector = moving.connectors.find((connector) =>
    connector.id === claim.movingConnectorId
  );
  const targetConnector = worldConnectors(target).find((connector) =>
    connector.id === claim.targetConnectorId
  );
  if (!movingConnector || !targetConnector) return undefined;

  const rotationQuarterTurns = [0, 1, 2, 3]
    .filter((rotation) =>
      dot(
        rotateVectorY(movingConnector.normal, rotation),
        targetConnector.worldNormal,
      ) < -0.99
    )
    .sort((left, right) =>
      quarterTurnDistance(left, claim.rotationQuarterTurns) -
        quarterTurnDistance(right, claim.rotationQuarterTurns) || left - right
    )[0];
  if (rotationQuarterTurns === undefined) return undefined;
  const offset = rotateVectorY(movingConnector.offset, rotationQuarterTurns);
  return {
    position: [
      targetConnector.position[0] - offset[0],
      targetConnector.position[1] - offset[1],
      targetConnector.position[2] - offset[2],
    ],
    rotationQuarterTurns,
  };
}

function realizesClaim(
  moving: StationModule,
  target: StationModule,
  claim: ModuleSnapClaim,
): boolean {
  return findConnections([moving, target]).some((connection) => {
    const endpoints = [connection.first, connection.second];
    return endpoints.some((connector) =>
      connector.moduleId === moving.id &&
      connector.id === claim.movingConnectorId
    ) && endpoints.some((connector) =>
      connector.moduleId === target.id &&
      connector.id === claim.targetConnectorId
    );
  });
}

function quarterTurnDistance(first: number, second: number): number {
  return Math.min(
    normalizeQuarterTurns(first - second),
    normalizeQuarterTurns(second - first),
  );
}

function dot(first: Vector3Tuple, second: Vector3Tuple): number {
  return first[0] * second[0] + first[1] * second[1] +
    first[2] * second[2];
}

function stableModuleCode(id: string): string {
  const hexadecimal = id.replaceAll("-", "");
  if (/^[0-9a-f]{32}$/i.test(hexadecimal)) {
    return BigInt(`0x${hexadecimal}`).toString(36).toUpperCase();
  }
  return id;
}

function stableHash(value: string, initial: number): number {
  let hash = initial;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
