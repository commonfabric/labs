import type {
  ModuleConnector,
  ModuleTransform,
  StationModule,
  Vector3Tuple,
} from "./contract.ts";

export interface WorldConnector extends ModuleConnector {
  moduleId: string;
  position: Vector3Tuple;
  worldNormal: Vector3Tuple;
}

export interface ModuleConnection {
  id: string;
  first: WorldConnector;
  second: WorldConnector;
}

export interface SnapResult {
  transform: ModuleTransform;
  movingConnectorId: string;
  targetModuleId: string;
  targetConnectorId: string;
  travelDistance: number;
}

export function normalizeQuarterTurns(value: number): number {
  return ((Math.round(value) % 4) + 4) % 4;
}

export function rotateVectorY(
  vector: Vector3Tuple,
  quarterTurns: number,
): Vector3Tuple {
  const [x, y, z] = vector;
  switch (normalizeQuarterTurns(quarterTurns)) {
    case 1:
      return [z, y, -x];
    case 2:
      return [-x, y, -z];
    case 3:
      return [-z, y, x];
    default:
      return [x, y, z];
  }
}

export function worldConnectors(module: StationModule): WorldConnector[] {
  return module.connectors.map((connector) => {
    const offset = rotateVectorY(
      connector.offset,
      module.transform.rotationQuarterTurns,
    );
    return {
      ...connector,
      offset: [...connector.offset],
      normal: [...connector.normal],
      moduleId: module.id,
      position: add(module.transform.position, offset),
      worldNormal: rotateVectorY(
        connector.normal,
        module.transform.rotationQuarterTurns,
      ),
    };
  });
}

export function findConnections(
  modules: readonly StationModule[],
  tolerance = 0.12,
): ModuleConnection[] {
  const orderedModules = [...modules].sort((first, second) =>
    first.id < second.id ? -1 : first.id > second.id ? 1 : 0
  );
  const result: ModuleConnection[] = [];
  for (let firstIndex = 0; firstIndex < orderedModules.length; firstIndex++) {
    const firstConnectors = worldConnectors(orderedModules[firstIndex]);
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < orderedModules.length;
      secondIndex++
    ) {
      const secondConnectors = worldConnectors(orderedModules[secondIndex]);
      for (const first of firstConnectors) {
        for (const second of secondConnectors) {
          if (
            distance(first.position, second.position) <= tolerance &&
            dot(first.worldNormal, second.worldNormal) < -0.99
          ) {
            result.push({
              id:
                `${first.moduleId}:${first.id}--${second.moduleId}:${second.id}`,
              first,
              second,
            });
          }
        }
      }
    }
  }
  return result;
}

export function findBestSnap(
  moving: StationModule,
  otherModules: readonly StationModule[],
  maximumTravel = 4,
): SnapResult | undefined {
  const occupiedConnectors = new Set(
    findConnections(otherModules).flatMap((connection) => [
      connectorIdentityKey(connection.first.moduleId, connection.first.id),
      connectorIdentityKey(connection.second.moduleId, connection.second.id),
    ]),
  );
  let best: (SnapResult & { score: number }) | undefined;
  for (
    let rotationQuarterTurns = 0;
    rotationQuarterTurns < 4;
    rotationQuarterTurns++
  ) {
    const rotatedMoving = {
      ...moving,
      transform: { ...moving.transform, rotationQuarterTurns },
    };
    const movingConnectors = worldConnectors(rotatedMoving);
    for (const target of otherModules) {
      for (const targetConnector of worldConnectors(target)) {
        if (
          occupiedConnectors.has(
            connectorIdentityKey(target.id, targetConnector.id),
          )
        ) continue;
        for (const movingConnector of movingConnectors) {
          if (
            dot(movingConnector.worldNormal, targetConnector.worldNormal) >=
              -0.99
          ) continue;
          const candidatePosition = add(
            targetConnector.position,
            scale(
              rotateVectorY(movingConnector.offset, rotationQuarterTurns),
              -1,
            ),
          );
          const travelDistance = distance(
            moving.transform.position,
            candidatePosition,
          );
          if (travelDistance > maximumTravel) continue;
          const turnDistance = Math.min(
            normalizeQuarterTurns(
              rotationQuarterTurns -
                moving.transform.rotationQuarterTurns,
            ),
            normalizeQuarterTurns(
              moving.transform.rotationQuarterTurns -
                rotationQuarterTurns,
            ),
          );
          const score = travelDistance + turnDistance * 0.15;
          if (!best || score < best.score) {
            best = {
              transform: { position: candidatePosition, rotationQuarterTurns },
              movingConnectorId: movingConnector.id,
              targetModuleId: target.id,
              targetConnectorId: targetConnector.id,
              travelDistance,
              score,
            };
          }
        }
      }
    }
  }
  if (!best) return undefined;
  const { score: _score, ...snap } = best;
  return snap;
}

/** Returns an injective key for one module connector identity. */
export function connectorIdentityKey(
  moduleId: string,
  connectorId: string,
): string {
  return JSON.stringify([moduleId, connectorId]);
}

function add(first: Vector3Tuple, second: Vector3Tuple): Vector3Tuple {
  return [
    first[0] + second[0],
    first[1] + second[1],
    first[2] + second[2],
  ];
}

function scale(vector: Vector3Tuple, amount: number): Vector3Tuple {
  return [vector[0] * amount, vector[1] * amount, vector[2] * amount];
}

function dot(first: Vector3Tuple, second: Vector3Tuple): number {
  return first[0] * second[0] + first[1] * second[1] +
    first[2] * second[2];
}

function distance(first: Vector3Tuple, second: Vector3Tuple): number {
  return Math.hypot(
    first[0] - second[0],
    first[1] - second[1],
    first[2] - second[2],
  );
}
