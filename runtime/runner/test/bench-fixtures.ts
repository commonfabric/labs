/**
 * Shared benchmark fixtures for storage layer performance testing.
 *
 * These fixtures are designed to stress different comparison strategies
 * (JSON.stringify vs deepEqual) in various ways:
 *
 * - medianComplexity: Typical Cell data (small arrays of objects)
 * - largeString: 100k character strings (tests serialization overhead)
 * - manySmallObjects: Wide, shallow graphs (tests traversal overhead)
 */

//
// Median complexity fixtures - representative of typical Cell values
// (arrays of objects with string/boolean/number fields)
//

export const medianComplexityA = {
  items: [
    { id: "item-1", title: "Buy groceries", done: false, priority: 1 },
    { id: "item-2", title: "Call mom", done: true, priority: 2 },
    { id: "item-3", title: "Finish report", done: false, priority: 1 },
    { id: "item-4", title: "Schedule dentist", done: false, priority: 3 },
    { id: "item-5", title: "Review PR", done: true, priority: 1 },
  ],
  metadata: {
    createdAt: "2024-01-15T10:30:00Z",
    updatedAt: "2024-01-15T14:22:00Z",
    version: 3,
  },
};

// Identical structure and values (for "equal" case)
export const medianComplexityB = JSON.parse(JSON.stringify(medianComplexityA));

// Different value late - last item's `done` differs
export const medianComplexityC = JSON.parse(JSON.stringify(medianComplexityA));
medianComplexityC.items[4].done = false;

// Different value early - first item's `done` differs (tests short-circuit)
export const medianComplexityD = JSON.parse(JSON.stringify(medianComplexityA));
medianComplexityD.items[0].done = true;

// Many small objects fixtures - 20 arrays x 15 objects x 15 properties = 4,500
// properties. Tests deepEqual performance on wide, shallow object graphs.
// Note: Originally tried 100 x 25 x 25 = 62,500 properties but that caused OOM
// when running benchmarks with many iterations. Can tune these numbers to find
// a sweet spot that stresses the comparison without exhausting memory.

function buildSmallObject(groupIdx: number, objIdx: number) {
  const obj: Record<string, string | number | boolean | null> = {};
  for (let p = 0; p < 15; p++) {
    const key = `prop_${p}`;
    switch (p % 5) {
      case 0:
        obj[key] = groupIdx * 1000 + objIdx * 15 + p;
        break;
      case 1:
        obj[key] = `val_${groupIdx}_${objIdx}_${p}`;
        break;
      case 2:
        obj[key] = p % 2 === 0;
        break;
      case 3:
        obj[key] = null;
        break;
      case 4:
        obj[key] = (groupIdx + objIdx + p) * 0.123;
        break;
    }
  }
  return obj;
}

function buildManySmallObjects(): {
  groups: Record<string, string | number | boolean | null>[][];
} {
  const groups: Record<string, string | number | boolean | null>[][] = [];
  for (let g = 0; g < 20; g++) {
    const group: Record<string, string | number | boolean | null>[] = [];
    for (let o = 0; o < 15; o++) {
      group.push(buildSmallObject(g, o));
    }
    groups.push(group);
  }
  return { groups };
}

// Identical structure (for "equal" case)
export const manySmallObjectsA = buildManySmallObjects();
export const manySmallObjectsB = JSON.parse(JSON.stringify(manySmallObjectsA));

// Different value at last property of last object (for "unequal late" case)
export const manySmallObjectsC = JSON.parse(JSON.stringify(manySmallObjectsA));
manySmallObjectsC.groups[19][14].prop_14 = "DIFFERENT_VALUE";

// Different value at first property of first object (for "unequal early" case)
export const manySmallObjectsD = JSON.parse(JSON.stringify(manySmallObjectsA));
manySmallObjectsD.groups[0][0].prop_0 = -999999;

//
// Large string fixtures - 100k character strings, difference at last character
// Tests worst case for deepEqual (no short-circuit, maximum traversal)
//

const hugeString = "x".repeat(100_000);
const hugeStringDifferentEnd = hugeString.slice(0, -1) + "y";

export const largeStringA = {
  items: [
    { id: "item-1", title: "Buy groceries", done: false, priority: 1 },
    { id: "item-2", title: "Call mom", done: true, priority: 2 },
  ],
  content: hugeString,
  metadata: {
    createdAt: "2024-01-15T10:30:00Z",
    version: 1,
  },
};

// Identical structure (for "equal" case)
export const largeStringB = JSON.parse(JSON.stringify(largeStringA));

// Different at end of huge string
export const largeStringC = JSON.parse(JSON.stringify(largeStringA));
largeStringC.content = hugeStringDifferentEnd;
