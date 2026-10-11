# Common Tools Annotation System Design

> **Status**: Draft v1
> **Date**: 2026-01-09
> **Related**: `NOTIFICATIONS.md`, `NOTIFICATIONS_PRD.md`

---

## Executive Summary

Annotations are a general-purpose system for users to attach private metadata to any content without modifying the source. Unlike editing shared content, annotations live in the user's own space and are never "tainted" by the content they reference.

**Core Philosophy**:
- Annotations are **user-owned metadata** about content they don't own
- The annotation lives in your space; the content lives elsewhere
- **Holding a reference doesn't taint** - only reading/dereferencing does (CFC)
- Annotations are general-purpose: seen state, stars, notes, tags, hide flags
- The shim implementation today should migrate cleanly to real projection spaces

---

## Part 1: Data Model

### Annotation Structure

Annotations are typed by `kind` and keyed by their target reference:

```typescript
/**
 * A single annotation attached to content.
 * The annotation lives in the user's space, not on the source content.
 */
interface Annotation<K extends AnnotationKind = AnnotationKind> {
  /** What we're annotating - a reference, not the content itself */
  target: NormalizedFullLink;

  /** The kind of annotation (discriminated union key) */
  kind: K;

  /** When this annotation was created or last updated */
  updatedAt: Date;

  /** Kind-specific payload */
  value: AnnotationValue<K>;
}

/**
 * Supported annotation kinds.
 * Extensible - patterns can define custom kinds.
 */
type AnnotationKind =
  | 'seen'      // Content has been viewed
  | 'starred'   // User favorited this
  | 'hidden'    // Hide from my view
  | 'note'      // Personal note attached
  | 'tag'       // Custom tags/labels
  | string;     // Custom kinds allowed

/**
 * Kind-specific value payloads
 */
type AnnotationValue<K extends AnnotationKind> =
  K extends 'seen' ? { seenAt: Date } :
  K extends 'starred' ? { starredAt: Date; priority?: number } :
  K extends 'hidden' ? { hiddenAt: Date; reason?: string } :
  K extends 'note' ? { content: string; createdAt: Date } :
  K extends 'tag' ? { tags: string[] } :
  Record<string, unknown>;  // Custom kinds use generic object
```

### Alternative: Freeform Annotations

For maximum flexibility, annotations could be completely freeform:

```typescript
/**
 * Freeform annotation - any metadata on any target.
 * Trades type safety for flexibility.
 */
interface FreeformAnnotation {
  target: NormalizedFullLink;
  metadata: Record<string, unknown>;
  updatedAt: Date;
}

// Usage examples:
{ target: ref, metadata: { seen: true, seenAt: "..." } }
{ target: ref, metadata: { starred: true, notes: "Important!" } }
{ target: ref, metadata: { myCustomField: 42 } }
```

**Recommendation**: Use the typed `kind` approach for common annotations, but allow freeform `metadata` field for extensibility:

```typescript
interface Annotation<K extends AnnotationKind = AnnotationKind> {
  target: NormalizedFullLink;
  kind: K;
  value: AnnotationValue<K>;
  metadata?: Record<string, unknown>;  // Extensibility escape hatch
  updatedAt: Date;
}
```

---

## Part 2: Storage Location

### Option A: Home Space (Recommended for Shim)

Store all annotations in a well-known location in the user's home space:

```typescript
// Home space schema extension
interface HomeSpaceAnnotations {
  // Keyed by serialized target link
  annotations: Map<string, Annotation[]>;
}

// Access pattern
const homeSpace = runtime.getHomeSpaceCell(tx);
const annotations = homeSpace.key('annotations');
```

**Pros**:
- Already syncs across devices (home space is synced)
- Single location for all user's annotations
- Works with existing infrastructure
- Easy to migrate later

**Cons**:
- Could grow large over time
- All annotations in one document (no sharding)

### Option B: Dedicated Annotations Space

Create a separate space just for annotations:

```typescript
// did:annotations:<user-did>
const annotationsSpace = `annotations:${userDID}`;
```

**Pros**:
- Clean separation of concerns
- Could have different sync policies
- Easier to shard by kind or target

**Cons**:
- New space type to manage
- More infrastructure work

### Option C: Per-Space Annotation Cells (Future)

Store annotations in projection cells within each space:

```typescript
// In each space the user visits:
// did:space:xyz/projections/<user-did>/annotations
```

**Pros**:
- Aligns with future projection space model
- Annotations co-located with content they reference

**Cons**:
- Requires projection space infrastructure
- More complex migration

### Recommendation

**Shim (Phase 1)**: Use Option A - home space storage with a single annotations cell.

**Future (Phase 2+)**: Migrate to Option C when projection spaces ship.

---

## Part 3: Key Format

### Target Identification

Annotations need to uniquely identify what they're annotating:

```typescript
/**
 * Generate a unique key for an annotation target.
 * This key is used to look up and deduplicate annotations.
 */
function annotationKey(target: NormalizedFullLink): string {
  // Full identification: space + id + path
  const parts = [
    target.space,
    target.id,
    ...target.path,
  ];
  return parts.join(':');
}

// Examples:
// "did:key:z123:of:bafyabc123:"           -> Root of a charm
// "did:key:z123:of:bafyabc123:items:0"    -> First item in items array
// "did:key:z123:of:bafydef456:title"      -> Title field of a document
```

### Path-Level vs Document-Level Annotations

Two strategies for sub-cell annotations:

**Strategy A: Path-specific (Precise)**
```typescript
// Annotate specific paths independently
annotate(cell.key('items').key(0), { kind: 'starred' });
annotate(cell.key('items').key(1), { kind: 'hidden' });

// Keys:
// "space:id:items:0" -> starred
// "space:id:items:1" -> hidden
```

**Strategy B: Document-level with path metadata**
```typescript
// Single annotation per document, with paths in value
interface DocumentAnnotation {
  target: NormalizedFullLink;  // Points to document root
  paths: {
    [path: string]: AnnotationValue<any>;
  };
}
```

**Recommendation**: Strategy A (path-specific) for simplicity. Each path gets its own annotation.

### Versioning Considerations

Should annotations track specific versions or always refer to "latest"?

```typescript
interface VersionedTarget extends NormalizedFullLink {
  // Optional: pin to a specific version
  version?: string;  // Chronicle clock or hash
}
```

**Recommendation**: For the shim, always annotate "latest". Versioned annotations are a future consideration for:
- "I read this version, show me what changed"
- Annotation archaeology (what did I think when I saw v1?)

---

## Part 4: API Design

### Recommended API: Hybrid Approach

Combine convenience methods for common kinds with a generic fallback:

```typescript
// ============================================
// patterns/common/annotations.ts
// ============================================

import { Cell, NormalizedFullLink } from "commontools";

/**
 * Mark content as seen by the current user.
 * Used by inbox to track what needs attention.
 */
export function markSeen(target: Cell<any> | NormalizedFullLink): void {
  const link = normalizeTarget(target);
  setAnnotation(link, {
    kind: 'seen',
    value: { seenAt: new Date() },
  });
}

/**
 * Check if content has been seen by the current user.
 */
export function isSeen(target: Cell<any> | NormalizedFullLink): boolean {
  const annotation = getAnnotation(normalizeTarget(target), 'seen');
  return annotation?.value?.seenAt !== undefined;
}

/**
 * Star/favorite content.
 */
export function star(
  target: Cell<any> | NormalizedFullLink,
  priority?: number
): void {
  const link = normalizeTarget(target);
  setAnnotation(link, {
    kind: 'starred',
    value: { starredAt: new Date(), priority },
  });
}

/**
 * Remove star from content.
 */
export function unstar(target: Cell<any> | NormalizedFullLink): void {
  removeAnnotation(normalizeTarget(target), 'starred');
}

/**
 * Check if content is starred.
 */
export function isStarred(target: Cell<any> | NormalizedFullLink): boolean {
  const annotation = getAnnotation(normalizeTarget(target), 'starred');
  return annotation !== undefined;
}

/**
 * Hide content from your view.
 */
export function hide(
  target: Cell<any> | NormalizedFullLink,
  reason?: string
): void {
  const link = normalizeTarget(target);
  setAnnotation(link, {
    kind: 'hidden',
    value: { hiddenAt: new Date(), reason },
  });
}

/**
 * Unhide content.
 */
export function unhide(target: Cell<any> | NormalizedFullLink): void {
  removeAnnotation(normalizeTarget(target), 'hidden');
}

/**
 * Check if content is hidden.
 */
export function isHidden(target: Cell<any> | NormalizedFullLink): boolean {
  const annotation = getAnnotation(normalizeTarget(target), 'hidden');
  return annotation !== undefined;
}

/**
 * Attach a personal note to content.
 */
export function addNote(
  target: Cell<any> | NormalizedFullLink,
  content: string
): void {
  const link = normalizeTarget(target);
  setAnnotation(link, {
    kind: 'note',
    value: { content, createdAt: new Date() },
  });
}

/**
 * Get the note attached to content.
 */
export function getNote(
  target: Cell<any> | NormalizedFullLink
): string | undefined {
  const annotation = getAnnotation(normalizeTarget(target), 'note');
  return annotation?.value?.content;
}

/**
 * Add tags to content.
 */
export function tag(
  target: Cell<any> | NormalizedFullLink,
  tags: string[]
): void {
  const link = normalizeTarget(target);
  const existing = getAnnotation(link, 'tag');
  const allTags = [...new Set([...(existing?.value?.tags || []), ...tags])];
  setAnnotation(link, {
    kind: 'tag',
    value: { tags: allTags },
  });
}

/**
 * Remove tags from content.
 */
export function untag(
  target: Cell<any> | NormalizedFullLink,
  tags: string[]
): void {
  const link = normalizeTarget(target);
  const existing = getAnnotation(link, 'tag');
  if (!existing) return;

  const remaining = existing.value.tags.filter(t => !tags.includes(t));
  if (remaining.length === 0) {
    removeAnnotation(link, 'tag');
  } else {
    setAnnotation(link, {
      kind: 'tag',
      value: { tags: remaining },
    });
  }
}

/**
 * Get all tags on content.
 */
export function getTags(
  target: Cell<any> | NormalizedFullLink
): string[] {
  const annotation = getAnnotation(normalizeTarget(target), 'tag');
  return annotation?.value?.tags || [];
}

// ============================================
// Generic API (for custom annotation kinds)
// ============================================

/**
 * Generic annotation setter for custom kinds.
 */
export function annotate<K extends AnnotationKind>(
  target: Cell<any> | NormalizedFullLink,
  annotation: Omit<Annotation<K>, 'target' | 'updatedAt'>
): void {
  const link = normalizeTarget(target);
  setAnnotation(link, annotation);
}

/**
 * Generic annotation getter.
 */
export function getAnnotation<K extends AnnotationKind>(
  target: Cell<any> | NormalizedFullLink,
  kind: K
): Annotation<K> | undefined {
  const link = normalizeTarget(target);
  return readAnnotation(link, kind);
}

/**
 * Get all annotations on a target.
 */
export function getAllAnnotations(
  target: Cell<any> | NormalizedFullLink
): Annotation[] {
  const link = normalizeTarget(target);
  return readAllAnnotations(link);
}

/**
 * Remove a specific annotation kind.
 */
export function removeAnnotation(
  target: Cell<any> | NormalizedFullLink,
  kind: AnnotationKind
): void {
  const link = normalizeTarget(target);
  deleteAnnotation(link, kind);
}
```

### Cell-Like API (Alternative)

For patterns that want reactive access to annotations:

```typescript
/**
 * Get a reactive cell containing all annotations for a target.
 * Changes to annotations will trigger reactive updates.
 */
export function useAnnotations<T>(
  target: Cell<T> | NormalizedFullLink
): Cell<AnnotationSet> {
  const link = normalizeTarget(target);
  const key = annotationKey(link);

  // Return a cell that reactively tracks this target's annotations
  return getAnnotationsCell().key(key);
}

// Usage in patterns:
const myAnnotations = useAnnotations(item);

// Reactive - updates when annotations change
const isSeen = computed(() => myAnnotations.seen !== undefined);
const myNote = computed(() => myAnnotations.note?.content);

// Write via the cell
myAnnotations.set({
  ...myAnnotations.get(),
  starred: { starredAt: new Date() }
});
```

---

## Part 5: Reading Annotations

### Reactive vs One-Shot

The API supports both patterns:

```typescript
// One-shot read (non-reactive)
const seen = isSeen(messageRef);
if (seen) { ... }

// Reactive read via useAnnotations
const annotations = useAnnotations(messageRef);
// In computed():
const hasSeen = computed(() => annotations.seen !== undefined);
```

### Reading Other Users' Annotations

**Current Scope**: Annotations are private. You can only read your own.

**Future Consideration**: For features like read receipts:

```typescript
// Future API - reading others' annotations requires explicit sharing
interface SharedAnnotation extends Annotation {
  owner: DID;  // Who created this annotation
  visibility: 'private' | 'shared' | 'public';
}

// Only readable if:
// 1. You own it (always)
// 2. visibility === 'shared' and you have read access to the space
// 3. visibility === 'public'
```

**Privacy Implications**:
- Default is private (only you see your annotations)
- Sharing annotations is opt-in
- Read receipts require the annotator to choose to share

---

## Part 6: CFC (Contextual Flow Control) Considerations

### The Key Insight

From the user's guidance: **"If annotation has OpaqueRef to another thing, it's NOT tainted by it."**

This is crucial for the security model:

```typescript
interface Annotation {
  // This is a REFERENCE (OpaqueRef-like), not the content itself
  target: NormalizedFullLink;
  // ...
}
```

### Taint Model

```
┌─────────────────────────────────────────────────────────────────────┐
│  YOUR SPACE (Untainted - you own this)                               │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Annotation                                                     │ │
│  │  {                                                              │ │
│  │    target: { space: "...", id: "...", path: [] }  ◄── REFERENCE │ │
│  │    kind: "seen",                                   (not content)│ │
│  │    value: { seenAt: "2026-01-09T..." }                         │ │
│  │  }                                                              │ │
│  │                                                                 │ │
│  │  Holding this reference does NOT taint your annotation.        │ │
│  │  The annotation is YOUR data, in YOUR space.                   │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
         │
         │ Reference points to...
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SHARED SPACE (Potentially Tainted)                                  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Message Cell                                                   │ │
│  │  {                                                              │ │
│  │    content: "Hello!",         ◄── If you READ this, you get    │ │
│  │    author: did:alice,             tainted by its classification │ │
│  │    // Classification: confidential                              │ │
│  │  }                                                              │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### What This Means in Practice

1. **Creating an annotation** doesn't read the target, so no taint
2. **The annotation itself** is in your space, untainted
3. **Dereferencing the target** (calling `.get()`) would taint the reader
4. **Displaying annotation metadata** (like "you starred this") is safe
5. **Showing the target's content** requires appropriate clearance

### Implementation Implications

```typescript
// SAFE - no taint, just stores a reference
markSeen(secretDocument);  // Stores link, doesn't read content

// SAFE - annotation data is yours
const myNote = getNote(secretDocument);  // Returns YOUR note text

// POTENTIALLY TAINTING - reads the actual content
const content = secretDocument.get();  // Reads classified content

// SAFE - just checking if annotation exists
const starred = isStarred(secretDocument);  // Boolean, no content access
```

---

## Part 7: Shim Implementation

### Storage Schema

```typescript
// packages/home-schemas/annotations.ts

import type { JSONSchema, Schema } from "@commontools/api";

export const annotationSchema = {
  type: "object",
  properties: {
    target: {
      type: "object",
      properties: {
        space: { type: "string" },
        id: { type: "string" },
        path: { type: "array", items: { type: "string" } },
        type: { type: "string" },
      },
      required: ["space", "id", "path"],
    },
    kind: { type: "string" },
    value: { type: "object", additionalProperties: true },
    metadata: { type: "object", additionalProperties: true },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["target", "kind", "value", "updatedAt"],
} as const satisfies JSONSchema;

export type Annotation = Schema<typeof annotationSchema>;

// Annotations are stored as an object keyed by annotation key
export const annotationsStoreSchema = {
  type: "object",
  additionalProperties: {
    type: "array",
    items: annotationSchema,
  },
  default: {},
} as const satisfies JSONSchema;

export type AnnotationsStore = Schema<typeof annotationsStoreSchema>;
```

### Home Space Extension

```typescript
// packages/runner/src/runtime.ts (additions)

export const homeSpaceCellSchema: JSONSchema = {
  type: "object",
  properties: {
    // ... existing properties ...
    favorites: { ...favoriteListSchema, asCell: true },
    journal: { ...journalSchema, asCell: true },
    // NEW: Annotations storage
    annotations: { ...annotationsStoreSchema, asCell: true },
  },
} as JSONSchema;
```

### CRUD Operations

```typescript
// packages/common/src/annotations-shim.ts

import { Cell, NormalizedFullLink } from "commontools";
import type { Annotation, AnnotationKind } from "@commontools/home-schemas";

const ANNOTATIONS_KEY = 'annotations';

/**
 * Get the annotations storage cell from home space.
 */
function getAnnotationsCell(tx?: IExtendedStorageTransaction): Cell<AnnotationsStore> {
  const runtime = getRuntime();  // From frame context
  return runtime.getHomeSpaceCell(tx).key(ANNOTATIONS_KEY);
}

/**
 * Convert a target to a storage key.
 */
function toKey(target: NormalizedFullLink): string {
  return [target.space, target.id, ...target.path].join(':');
}

/**
 * Normalize Cell or link to NormalizedFullLink.
 */
function normalizeTarget(target: Cell<any> | NormalizedFullLink): NormalizedFullLink {
  if ('getAsNormalizedFullLink' in target) {
    return target.getAsNormalizedFullLink();
  }
  return target as NormalizedFullLink;
}

/**
 * Set an annotation (create or update).
 */
export function setAnnotation<K extends AnnotationKind>(
  target: NormalizedFullLink,
  annotation: Omit<Annotation<K>, 'target' | 'updatedAt'>
): void {
  const key = toKey(target);
  const cell = getAnnotationsCell();
  const store = cell.get() || {};

  // Get existing annotations for this target
  const existing = store[key] || [];

  // Find and replace annotation of same kind, or append
  const kindIndex = existing.findIndex(a => a.kind === annotation.kind);
  const newAnnotation: Annotation<K> = {
    target,
    ...annotation,
    updatedAt: new Date(),
  };

  if (kindIndex >= 0) {
    existing[kindIndex] = newAnnotation;
  } else {
    existing.push(newAnnotation);
  }

  cell.set({ ...store, [key]: existing });
}

/**
 * Read an annotation by kind.
 */
export function readAnnotation<K extends AnnotationKind>(
  target: NormalizedFullLink,
  kind: K
): Annotation<K> | undefined {
  const key = toKey(target);
  const cell = getAnnotationsCell();
  const store = cell.get() || {};
  const annotations = store[key] || [];
  return annotations.find(a => a.kind === kind) as Annotation<K> | undefined;
}

/**
 * Read all annotations for a target.
 */
export function readAllAnnotations(target: NormalizedFullLink): Annotation[] {
  const key = toKey(target);
  const cell = getAnnotationsCell();
  const store = cell.get() || {};
  return store[key] || [];
}

/**
 * Delete an annotation by kind.
 */
export function deleteAnnotation(
  target: NormalizedFullLink,
  kind: AnnotationKind
): void {
  const key = toKey(target);
  const cell = getAnnotationsCell();
  const store = cell.get() || {};
  const existing = store[key] || [];

  const filtered = existing.filter(a => a.kind !== kind);

  if (filtered.length === 0) {
    // Remove the key entirely if no annotations left
    const { [key]: _, ...rest } = store;
    cell.set(rest);
  } else {
    cell.set({ ...store, [key]: filtered });
  }
}
```

### Performance Considerations

**Indexing by Kind**:

For queries like "show me all starred items", we might want secondary indices:

```typescript
interface AnnotationsStore {
  // Primary: by target key
  byTarget: Record<string, Annotation[]>;

  // Secondary indices (optional, for performance)
  byKind?: {
    starred?: string[];   // List of target keys
    hidden?: string[];
    // etc.
  };
}
```

**Sharding**:

If annotations grow large, shard by kind:

```typescript
// Instead of one annotations cell:
homeSpace.annotations

// Shard by kind:
homeSpace.annotations.seen
homeSpace.annotations.starred
homeSpace.annotations.hidden
homeSpace.annotations.notes
homeSpace.annotations.tags
```

**Recommendation for Shim**: Start simple (single cell), add indices/sharding if performance becomes an issue.

### Garbage Collection

Annotations can accumulate for deleted content. Strategies:

1. **Lazy cleanup**: When reading annotations, check if target still exists
2. **Periodic sweep**: Background job removes orphaned annotations
3. **Explicit cleanup**: Patterns that delete content also clean up annotations

```typescript
/**
 * Remove annotations for targets that no longer exist.
 * Call periodically or on demand.
 */
export async function cleanupOrphanedAnnotations(): Promise<number> {
  const cell = getAnnotationsCell();
  const store = cell.get() || {};
  let removed = 0;

  for (const [key, annotations] of Object.entries(store)) {
    // Try to resolve the target
    const target = annotations[0]?.target;
    if (!target) continue;

    try {
      const targetCell = runtime.getCellFromLink(target);
      await targetCell.sync();
      const value = targetCell.getRaw();
      if (value === undefined) {
        // Target doesn't exist, remove annotations
        delete store[key];
        removed += annotations.length;
      }
    } catch {
      // Target inaccessible, consider removing
      delete store[key];
      removed += annotations.length;
    }
  }

  if (removed > 0) {
    cell.set(store);
  }

  return removed;
}
```

---

## Part 8: Migration Path

### When Real Annotations (Projection Spaces) Ship

The shim is designed for seamless migration:

**What Changes**:

1. Storage location moves from `homeSpace.annotations` to projection space
2. Internal implementation of `setAnnotation`, `readAnnotation`, etc.
3. Possibly better indexing/query capabilities

**What Stays the Same**:

1. Public API (`markSeen`, `star`, `annotate`, etc.)
2. Data format (Annotation interface)
3. Key format (space:id:path)

**Migration Steps**:

```typescript
// 1. Ship new annotations infrastructure alongside shim
// 2. Detect if real annotations available:
function useRealAnnotations(): boolean {
  return runtime.capabilities.includes('projectionSpaces');
}

// 3. Route writes to both during transition:
export function setAnnotation(...) {
  if (useRealAnnotations()) {
    realAnnotations.set(...);
  }
  // Always write to shim during transition for backward compat
  shimAnnotations.set(...);
}

// 4. Read from real first, fall back to shim:
export function readAnnotation(...) {
  if (useRealAnnotations()) {
    const real = realAnnotations.get(...);
    if (real) return real;
  }
  return shimAnnotations.get(...);
}

// 5. Eventually: remove shim, migrate remaining data
```

### Data Migration

```typescript
/**
 * Migrate shim annotations to real projection spaces.
 * Run once per user when projection spaces are available.
 */
export async function migrateAnnotations(): Promise<void> {
  const shimCell = getAnnotationsCell();
  const shimStore = shimCell.get() || {};

  for (const [key, annotations] of Object.entries(shimStore)) {
    for (const annotation of annotations) {
      // Write to real annotation system
      await realAnnotations.set(annotation.target, annotation);
    }
  }

  // Mark migration complete
  shimCell.set({ _migrated: true, _migratedAt: new Date() });
}
```

---

## Part 9: Multi-Device Sync

### Conflict Resolution

Annotations in home space sync via the standard sync mechanism. Conflict strategy:

**Last-Write-Wins Per Kind**:

```typescript
// If two devices both update 'seen' annotation:
// Device A: seen at 10:00:00
// Device B: seen at 10:00:05
// Winner: Device B (later timestamp in updatedAt)

function resolveAnnotationConflict(
  local: Annotation,
  remote: Annotation
): Annotation {
  // Simple: latest updatedAt wins
  return local.updatedAt > remote.updatedAt ? local : remote;
}
```

**Per-Kind Independence**:

Different annotation kinds don't conflict:
- Starring on device A while adding note on device B: both apply
- Only same-kind updates on same target can conflict

### Offline Behavior

1. **Reads**: Work from local cache
2. **Writes**: Queue locally, sync when online
3. **Conflicts**: Resolve on sync using last-write-wins

### Merge Semantics

For array-valued annotations (like tags):

```typescript
function mergeTagAnnotations(
  local: Annotation<'tag'>,
  remote: Annotation<'tag'>
): Annotation<'tag'> {
  // Union of tags, keep later timestamp
  const mergedTags = [...new Set([
    ...local.value.tags,
    ...remote.value.tags,
  ])];

  return {
    ...local,
    value: { tags: mergedTags },
    updatedAt: new Date(Math.max(
      local.updatedAt.getTime(),
      remote.updatedAt.getTime()
    )),
  };
}
```

---

## Part 10: Use Cases Beyond Notifications

### 1. Starring/Favoriting Content

```typescript
// Pattern: Quick access to important items
export default pattern(({ items }) => {
  const starredItems = computed(() =>
    items.filter(item => isStarred(item))
  );

  return {
    [UI]: (
      <div>
        <h2>Starred Items</h2>
        {starredItems.map(item => (
          <div>
            {item.name}
            <button onClick={() => unstar(item)}>Unstar</button>
          </div>
        ))}
      </div>
    ),
  };
});
```

### 2. Personal Notes on Shared Documents

```typescript
// Pattern: Add private notes to team documents
export default pattern(({ document }) => {
  const myNote = useAnnotations(document).note?.content ?? '';

  return {
    [UI]: (
      <div>
        <h1>{document.title}</h1>
        <div>{document.content}</div>

        <div class="my-notes">
          <h3>My Notes (private)</h3>
          <ct-textarea
            value={myNote}
            onChange={e => addNote(document, e.target.value)}
            placeholder="Add personal notes..."
          />
        </div>
      </div>
    ),
  };
});
```

### 3. "Hide from My View"

```typescript
// Pattern: Filter out content I don't want to see
export default pattern(({ feedItems }) => {
  const visibleItems = computed(() =>
    feedItems.filter(item => !isHidden(item))
  );

  return {
    [UI]: (
      <div>
        {visibleItems.map(item => (
          <div>
            {item.content}
            <button onClick={() => hide(item, "Not interested")}>
              Hide
            </button>
          </div>
        ))}
      </div>
    ),
  };
});
```

### 4. Custom Tags/Labels

```typescript
// Pattern: Organize content with personal tags
export default pattern(({ items }) => {
  const tagFilter = Cell.of<string | null>(null);

  const allTags = computed(() => {
    const tags = new Set<string>();
    for (const item of items) {
      for (const t of getTags(item)) {
        tags.add(t);
      }
    }
    return [...tags].sort();
  });

  const filteredItems = computed(() => {
    const filter = tagFilter.get();
    if (!filter) return items;
    return items.filter(item => getTags(item).includes(filter));
  });

  return {
    [UI]: (
      <div>
        <div class="tag-filter">
          <button onClick={() => tagFilter.set(null)}>All</button>
          {allTags.map(t => (
            <button onClick={() => tagFilter.set(t)}>{t}</button>
          ))}
        </div>

        {filteredItems.map(item => (
          <div>
            {item.name}
            <span class="tags">{getTags(item).join(', ')}</span>
            <ct-input
              placeholder="Add tag..."
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  tag(item, [e.target.value]);
                  e.target.value = '';
                }
              }}
            />
          </div>
        ))}
      </div>
    ),
  };
});
```

### 5. Read Progress Tracking

```typescript
// Pattern: Track reading progress through long content
interface ReadProgress {
  position: number;  // Percentage or section
  lastReadAt: Date;
}

export default pattern(({ book }) => {
  const progress = getAnnotation<'readProgress'>(book, 'readProgress');

  const onScroll = (e: ScrollEvent) => {
    const position = e.target.scrollTop / e.target.scrollHeight;
    annotate(book, {
      kind: 'readProgress',
      value: { position, lastReadAt: new Date() },
    });
  };

  return {
    [UI]: (
      <div onScroll={onScroll}>
        <progress value={progress?.value?.position ?? 0} max={1} />
        {book.content}
      </div>
    ),
  };
});
```

---

## Summary

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Storage** | Home space (shim) | Works today, syncs across devices |
| **Data model** | Typed by kind | Type safety for common cases, extensible |
| **Key format** | `space:id:path` | Unique, supports sub-cell annotations |
| **API style** | Convenience + generic | Easy for common cases, flexible for custom |
| **CFC** | Reference doesn't taint | User owns their annotations |
| **Sync** | Last-write-wins per kind | Simple, predictable |
| **Versioning** | Always "latest" (for now) | Simplicity, versioning later |

### Implementation Priority

1. **Phase 1 (MVP)**:
   - Home space storage schema
   - CRUD operations (setAnnotation, readAnnotation, etc.)
   - Convenience methods (markSeen, star, hide, addNote, tag)
   - Basic wish integration for #annotations

2. **Phase 2 (Polish)**:
   - Secondary indices for queries
   - Garbage collection for orphaned annotations
   - useAnnotations() reactive API
   - Shell UI for viewing/managing annotations

3. **Phase 3 (Projection Spaces)**:
   - Migration to real annotation infrastructure
   - Per-space projection cells
   - Cross-user annotation sharing (opt-in)

---

## References

- `NOTIFICATIONS.md` - Uses annotations for seen state
- `NOTIFICATIONS_PRD.md` - Product requirements for notification system
- `packages/home-schemas/` - Home space schema definitions
- `packages/runner/src/cfc.ts` - Contextual flow control implementation
