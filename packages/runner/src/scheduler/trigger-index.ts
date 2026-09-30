import type { MemorySpace } from "@commonfabric/memory/interface";
import type { Cancel } from "../cancel.ts";
import {
  addressesToPathByEntity,
  determineTriggeredActions,
  nonRecursiveReadMayOverlapWrite,
  type SortedAndCompactPaths,
} from "../reactive-dependencies.ts";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import type {
  IMemoryChange,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import { EntityTriggers } from "./entity-triggers.ts";
import { entityKey } from "./keys.ts";
import type { Action, ReactivityLog, SpaceScopeAndURI } from "./types.ts";

export interface TriggerIndexState {
  /** Identity entity keys resolve scoped addresses against (keys.ts). */
  readonly scopeKeyIdentity: () => ScopeKeyIdentity;

  readonly triggers: Map<SpaceScopeAndURI, EntityTriggers>;
  readonly nonRecursiveTriggers: Map<SpaceScopeAndURI, EntityTriggers>;
  readonly actionTriggerEntities: WeakMap<Action, Set<SpaceScopeAndURI>>;
  addActionReads(
    action: Action,
    reads: IMemorySpaceAddress[],
    shallowReads: IMemorySpaceAddress[],
  ): {
    entities: Set<SpaceScopeAndURI>;
    triggerPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>;
  };
  removeActionFromEntities(
    action: Action,
    entities: Iterable<SpaceScopeAndURI>,
  ): void;
  removeSpace(space: MemorySpace): void;
  collectReadersForWrite(write: IMemorySpaceAddress): Set<Action>;
  hasRegisteredTriggers(): boolean;
  clear(): void;
  collectTriggeredActionsForChange(
    space: MemorySpace,
    change: IMemoryChange,
  ): {
    entity: SpaceScopeAndURI;
    hasMatchingTriggerPaths: boolean;
    triggeredActions: Action[];
  };
}

export interface TriggerSubscriptionState extends TriggerIndexState {
  readonly cancels: WeakMap<Action, Cancel>;
  readonly getActionId: (action: Action) => string;
  readonly onTriggerUnsubscribe?: (
    actionId: string,
    entityCount: number,
  ) => void;
}

function removeActionFromTriggerMap(
  triggerMap: Map<SpaceScopeAndURI, EntityTriggers>,
  entity: SpaceScopeAndURI,
  action: Action,
): void {
  const triggers = triggerMap.get(entity);
  if (!triggers) return;

  triggers.delete(action);
  if (triggers.size === 0) {
    triggerMap.delete(entity);
  }
}

function removeTriggerMapSpace(
  triggerMap: Map<SpaceScopeAndURI, EntityTriggers>,
  spacePrefix: string,
): void {
  for (const entity of triggerMap.keys()) {
    if (entity.startsWith(spacePrefix)) {
      triggerMap.delete(entity);
    }
  }
}

export class SchedulerTriggerSubscriptions implements TriggerSubscriptionState {
  readonly #state: {
    readonly triggerIndex: TriggerIndexState;
    readonly cancels: WeakMap<Action, Cancel>;
    readonly getActionId: (action: Action) => string;
    readonly onTriggerUnsubscribe?: (
      actionId: string,
      entityCount: number,
    ) => void;
  };

  constructor(
    state: {
      readonly triggerIndex: TriggerIndexState;
      readonly cancels: WeakMap<Action, Cancel>;
      readonly getActionId: (action: Action) => string;
      readonly onTriggerUnsubscribe?: (
        actionId: string,
        entityCount: number,
      ) => void;
    },
  ) {
    this.#state = state;
  }

  get scopeKeyIdentity(): TriggerIndexState["scopeKeyIdentity"] {
    return this.#state.triggerIndex.scopeKeyIdentity;
  }

  get triggers(): TriggerIndexState["triggers"] {
    return this.#state.triggerIndex.triggers;
  }

  get nonRecursiveTriggers(): TriggerIndexState["nonRecursiveTriggers"] {
    return this.#state.triggerIndex.nonRecursiveTriggers;
  }

  get actionTriggerEntities(): TriggerIndexState["actionTriggerEntities"] {
    return this.#state.triggerIndex.actionTriggerEntities;
  }

  get cancels(): WeakMap<Action, Cancel> {
    return this.#state.cancels;
  }

  get getActionId(): (action: Action) => string {
    return this.#state.getActionId;
  }

  get onTriggerUnsubscribe():
    | ((actionId: string, entityCount: number) => void)
    | undefined {
    return this.#state.onTriggerUnsubscribe;
  }

  addActionReads(
    action: Action,
    reads: IMemorySpaceAddress[],
    shallowReads: IMemorySpaceAddress[],
  ): {
    entities: Set<SpaceScopeAndURI>;
    triggerPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>;
  } {
    return this.#state.triggerIndex.addActionReads(action, reads, shallowReads);
  }

  removeActionFromEntities(
    action: Action,
    entities: Iterable<SpaceScopeAndURI>,
  ): void {
    this.#state.triggerIndex.removeActionFromEntities(action, entities);
  }

  removeSpace(space: MemorySpace): void {
    this.#state.triggerIndex.removeSpace(space);
  }

  collectReadersForWrite(write: IMemorySpaceAddress): Set<Action> {
    return this.#state.triggerIndex.collectReadersForWrite(write);
  }

  hasRegisteredTriggers(): boolean {
    return this.#state.triggerIndex.hasRegisteredTriggers();
  }

  clear(): void {
    this.#state.triggerIndex.clear();
  }

  collectTriggeredActionsForChange(
    space: MemorySpace,
    change: IMemoryChange,
  ): {
    entity: SpaceScopeAndURI;
    hasMatchingTriggerPaths: boolean;
    triggeredActions: Action[];
  } {
    return this.#state.triggerIndex.collectTriggeredActionsForChange(
      space,
      change,
    );
  }
}

export class SchedulerTriggerIndex implements TriggerIndexState {
  constructor(
    /** Identity entity keys resolve scoped addresses against (keys.ts). */
    readonly scopeKeyIdentity: () => ScopeKeyIdentity,
  ) {}

  readonly triggers = new Map<SpaceScopeAndURI, EntityTriggers>();
  readonly nonRecursiveTriggers = new Map<SpaceScopeAndURI, EntityTriggers>();
  readonly actionTriggerEntities = new WeakMap<
    Action,
    Set<SpaceScopeAndURI>
  >();

  addActionReads(
    action: Action,
    reads: IMemorySpaceAddress[],
    shallowReads: IMemorySpaceAddress[],
  ): {
    entities: Set<SpaceScopeAndURI>;
    triggerPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>;
  } {
    const identity = this.scopeKeyIdentity();
    const pathsByEntity = addressesToPathByEntity(reads, identity);
    const nonRecursivePathsByEntity = addressesToPathByEntity(
      shallowReads,
      identity,
    );
    const entities = new Set<SpaceScopeAndURI>();
    const triggerPathsByEntity = new Map<
      SpaceScopeAndURI,
      SortedAndCompactPaths
    >();

    for (const [spaceAndURI, paths] of pathsByEntity) {
      entities.add(spaceAndURI);
      triggersFor(this.triggers, spaceAndURI).set(action, paths);
      triggerPathsByEntity.set(spaceAndURI, paths);
    }

    for (const [spaceAndURI, paths] of nonRecursivePathsByEntity) {
      entities.add(spaceAndURI);
      triggersFor(this.nonRecursiveTriggers, spaceAndURI).set(action, paths);
    }

    this.actionTriggerEntities.set(action, entities);

    return { entities, triggerPathsByEntity };
  }

  removeActionFromEntities(
    action: Action,
    entities: Iterable<SpaceScopeAndURI>,
  ): void {
    for (const spaceAndURI of entities) {
      removeActionFromTriggerMap(this.triggers, spaceAndURI, action);
      removeActionFromTriggerMap(
        this.nonRecursiveTriggers,
        spaceAndURI,
        action,
      );
    }
  }

  removeSpace(space: MemorySpace): void {
    const spacePrefix = `${space}/`;
    removeTriggerMapSpace(this.triggers, spacePrefix);
    removeTriggerMapSpace(this.nonRecursiveTriggers, spacePrefix);
  }

  collectReadersForWrite(write: IMemorySpaceAddress): Set<Action> {
    const entity = entityKey(write, this.scopeKeyIdentity());
    const readers = new Set<Action>();

    const recursiveReaders = this.triggers.get(entity);
    recursiveReaders?.forEachMatching(write.path, (_path, actions) => {
      for (const action of actions) readers.add(action);
    });

    // A non-recursive read is reached by a write at its own path, above it, or
    // one component below it, so the reads the index hands over are narrowed
    // again by depth.
    const nonRecursiveReaders = this.nonRecursiveTriggers.get(entity);
    nonRecursiveReaders?.forEachMatching(write.path, (read, actions) => {
      if (!nonRecursiveReadMayOverlapWrite(read, write.path)) return;
      for (const action of actions) readers.add(action);
    });

    return readers;
  }

  hasRegisteredTriggers(): boolean {
    return this.triggers.size > 0 || this.nonRecursiveTriggers.size > 0;
  }

  clear(): void {
    this.triggers.clear();
    this.nonRecursiveTriggers.clear();
  }

  collectTriggeredActionsForChange(
    space: MemorySpace,
    change: IMemoryChange,
  ): {
    entity: SpaceScopeAndURI;
    hasMatchingTriggerPaths: boolean;
    triggeredActions: Action[];
  } {
    // The change notification names the scope by NAME (the storage layer's
    // per-session wire shape); this runtime's own identity maps it to the
    // same instance key the registered reads mapped to — the same
    // name→instance function on both sides, so matching is preserved.
    const entity = entityKey(
      { ...change.address, space },
      this.scopeKeyIdentity(),
    );
    const triggers = this.triggers.get(entity);
    const nonRecursiveTriggers = this.nonRecursiveTriggers.get(entity);

    if (!triggers && !nonRecursiveTriggers) {
      return {
        entity,
        hasMatchingTriggerPaths: false,
        triggeredActions: [],
      };
    }

    // The index hands over the reads this change can reach and no others,
    // which is the same set the overlap test inside would keep.
    const triggeredActionSet = new Set<Action>();
    if (triggers) {
      for (
        const action of determineTriggeredActions(
          triggers.matching(change.address.path),
          change.before,
          change.after,
          change.address.path,
        )
      ) {
        triggeredActionSet.add(action);
      }
    }
    if (nonRecursiveTriggers) {
      for (
        const action of determineTriggeredActions(
          nonRecursiveTriggers.matching(change.address.path),
          change.before,
          change.after,
          change.address.path,
          { nonRecursive: true },
        )
      ) {
        triggeredActionSet.add(action);
      }
    }

    return {
      entity,
      hasMatchingTriggerPaths: true,
      triggeredActions: [...triggeredActionSet],
    };
  }
}

export function applyActionReadDelta(
  state: TriggerIndexState,
  action: Action,
  prevLog: Pick<ReactivityLog, "reads" | "shallowReads">,
  nextLog: Pick<ReactivityLog, "reads" | "shallowReads">,
): {
  entities: Set<SpaceScopeAndURI>;
  triggerPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>;
} {
  const identity = state.scopeKeyIdentity();
  const prevPathsByEntity = addressesToPathByEntity(prevLog.reads, identity);
  const nextPathsByEntity = addressesToPathByEntity(nextLog.reads, identity);
  const prevNonRecursivePathsByEntity = addressesToPathByEntity(
    prevLog.shallowReads,
    identity,
  );
  const nextNonRecursivePathsByEntity = addressesToPathByEntity(
    nextLog.shallowReads,
    identity,
  );

  applyActionReadDeltaToMap(
    state.triggers,
    action,
    prevPathsByEntity,
    nextPathsByEntity,
  );
  applyActionReadDeltaToMap(
    state.nonRecursiveTriggers,
    action,
    prevNonRecursivePathsByEntity,
    nextNonRecursivePathsByEntity,
  );

  const entities = new Set<SpaceScopeAndURI>([
    ...nextPathsByEntity.keys(),
    ...nextNonRecursivePathsByEntity.keys(),
  ]);
  state.actionTriggerEntities.set(action, entities);

  return { entities, triggerPathsByEntity: nextPathsByEntity };
}

export function ensureCancelForActionTriggers(
  state: TriggerSubscriptionState,
  action: Action,
): void {
  if (state.cancels.has(action)) return;

  const actionId = state.getActionId(action);
  state.cancels.set(action, () => {
    const entities = state.actionTriggerEntities.get(action) ?? new Set();
    state.onTriggerUnsubscribe?.(actionId, entities.size);
    state.removeActionFromEntities(action, entities);
    state.actionTriggerEntities.delete(action);
  });
}

function applyActionReadDeltaToMap(
  triggerMap: Map<SpaceScopeAndURI, EntityTriggers>,
  action: Action,
  prevPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>,
  nextPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>,
): void {
  const entities = new Set<SpaceScopeAndURI>([
    ...prevPathsByEntity.keys(),
    ...nextPathsByEntity.keys(),
  ]);

  for (const entity of entities) {
    const nextPaths = nextPathsByEntity.get(entity);
    if (nextPaths === undefined) {
      removeActionFromTriggerMap(triggerMap, entity, action);
      continue;
    }
    triggersFor(triggerMap, entity).set(action, nextPaths);
  }
}

/** The entity's registered reads, started when it has none yet. */
function triggersFor(
  triggerMap: Map<SpaceScopeAndURI, EntityTriggers>,
  entity: SpaceScopeAndURI,
): EntityTriggers {
  let triggers = triggerMap.get(entity);
  if (!triggers) {
    triggers = new EntityTriggers();
    triggerMap.set(entity, triggers);
  }
  return triggers;
}
