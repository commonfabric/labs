/**
 * ============================================================================
 * BUG REPRO: Nested array elements are undefined when reading cross-session data
 * ============================================================================
 *
 * SUMMARY:
 * When one browser session sets a cell's data, and another browser session
 * reads that same cell, the nested array elements resolve as `undefined`.
 *
 * OBSERVED BEHAVIOR:
 * - otherData: {label: 'Player 2', items: Array(2)}  ✓ object resolves
 * - otherData.items: [undefined, undefined]           ✗ array elements undefined!
 * - otherData.items[0]: undefined                     ✗
 * - otherData.items[0]?.id: undefined                 ✗
 *
 * EXPECTED BEHAVIOR:
 * - otherData.items[0]: {id: 10, name: 'P2-Ship1', start: {...}, hits: [...]}
 * - otherData.items[0]?.id: 10
 *
 * KEY CONDITIONS TO TRIGGER:
 * 1. Parent pattern owns cells with Writable<T | null | Default<null>>
 * 2. Child pattern receives cells as Writable<T | null> (no Default wrapper)
 * 3. Cell data is SET by one browser session (piece instance)
 * 4. Cell data is READ by a DIFFERENT browser session (piece instance)
 * 5. Data contains nested arrays with objects
 *
 * STEPS TO REPRODUCE:
 * 1. Deploy this pattern:
 *    CF_API_URL=http://localhost:8000 CF_IDENTITY=./claude.key \
 *    deno task cf piece new patterns/showcase/battleship/multiplayer/repro-minimal.tsx \
 *    --root patterns/showcase/battleship --space gideon
 *
 * 2. Open the piece URL in Browser Tab 1
 * 3. Click "Join as P1" → navigates to Child pattern
 * 4. Open the SAME piece URL in Browser Tab 2 (new session)
 * 5. Click "Join as P2" → this sets data2 cell
 * 6. Go back to Tab 1 (P1's view)
 * 7. Click "Check OTHER Data"
 * 8. Observe console: items array has length 2 but elements are undefined
 *
 * NOTE: "Check MY Data" works correctly because myData was set in the same session.
 */

import {
  action,
  computed,
  Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  UI,
  Writable,
} from "commonfabric";

// ============================================================================
// Types - Nested structure similar to battleship's Ship type
// ============================================================================

interface Coordinate {
  row: number;
  col: number;
}

/** Item with nested object (start) and nested array (hits) - like Ship in battleship */
interface Item {
  id: number;
  name: string;
  start: Coordinate; // Nested object
  hits: boolean[]; // Nested array
}

/** Container holds an array of Items - the items array elements become undefined */
interface Container {
  label: string;
  items: Item[]; // <-- BUG: elements of this array are undefined when read cross-session
}

// ============================================================================
// Child Pattern - receives cells WITHOUT Default<> wrapper
// ============================================================================

interface ChildInput {
  /** Cell set by THIS session - works correctly */
  myData: Writable<Container | null>;

  /** Cell set by OTHER session - BUG: nested array elements are undefined */
  otherData: Writable<Container | null>;
  whichPlayer: 1 | 2;
}

const Child = pattern<ChildInput, object>(
  ({ myData, otherData, whichPlayer }) => {
    /**
     * CHECK OTHER DATA - This demonstrates the bug!
     * When otherData was set by a different browser session,
     * the array elements are undefined even though the array has length > 0.
     */
    const checkOther = action(() => {
      console.log(`[Child P${whichPlayer}] Checking OTHER player's data...`);
      const other = otherData.get();
      console.log("[Child] otherData:", other);
      console.log("[Child] otherData.items:", other?.items);
      console.log("[Child] otherData.items.length:", other?.items?.length);
      if (other?.items && other.items.length > 0) {
        // BUG: These all log undefined even though items.length is 2
        console.log("[Child] otherData.items[0]:", other.items[0]);
        console.log("[Child] otherData.items[0]?.id:", other.items[0]?.id);
        console.log(
          "[Child] otherData.items[0]?.start:",
          other.items[0]?.start,
        );
        console.log(
          "[Child] otherData.items[0]?.start?.row:",
          other.items[0]?.start?.row,
        );
      }
    });

    /**
     * CHECK MY DATA - This works correctly!
     * When myData was set by THIS browser session, everything resolves properly.
     */
    const checkMine = action(() => {
      console.log(`[Child P${whichPlayer}] Checking MY data...`);
      const mine = myData.get();
      console.log("[Child] myData:", mine);
      console.log("[Child] myData.items:", mine?.items);
      console.log("[Child] myData.items.length:", mine?.items?.length);
      if (mine?.items && mine.items.length > 0) {
        // WORKS: These all resolve correctly
        console.log("[Child] myData.items[0]:", mine.items[0]);
        console.log("[Child] myData.items[0]?.id:", mine.items[0]?.id);
      }
    });

    return {
      [NAME]: computed(() => `Child P${whichPlayer}`),
      [UI]: (
        <div
          style={{ padding: "20px", backgroundColor: "#1e293b", color: "#fff" }}
        >
          <h2>Child Pattern - Player {whichPlayer}</h2>
          <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
            <cf-button onClick={() => checkMine.send()}>
              Check MY Data
            </cf-button>
            <cf-button onClick={() => checkOther.send()}>
              Check OTHER Data
            </cf-button>
          </div>
        </div>
      ),
    };
  },
);

// ============================================================================
// Parent Pattern - owns cells WITH Default<> wrappers (type mismatch with child)
// ============================================================================

/**
 * Parent uses Writable<T | Default<...>> but child receives Writable<T>.
 * This type mismatch may be related to the bug.
 */
interface ParentInput {
  data1: Writable<Container | null | Default<null>>;
  data2: Writable<Container | null | Default<null>>;
}

const joinAsP1 = handler<
  void,
  { data1: Writable<Container | null>; data2: Writable<Container | null> }
>((_e, { data1, data2 }) => {
  const items = [
    {
      id: 1,
      name: "P1-Ship1",
      start: { row: 0, col: 0 },
      hits: [false, false, false],
    },
    {
      id: 2,
      name: "P1-Ship2",
      start: { row: 2, col: 3 },
      hits: [false, false],
    },
  ];
  console.log("[Parent] P1 joining with items:", items);
  data1.set({ label: "Player 1", items });
  console.log("[Parent] P1 navigating to child...");
  return navigateTo(
    Child({ myData: data1, otherData: data2, whichPlayer: 1 }),
  );
});

const joinAsP2 = handler<
  void,
  { data1: Writable<Container | null>; data2: Writable<Container | null> }
>((_e, { data1, data2 }) => {
  const items = [
    {
      id: 10,
      name: "P2-Ship1",
      start: { row: 5, col: 5 },
      hits: [false, false, false, false],
    },
    {
      id: 11,
      name: "P2-Ship2",
      start: { row: 7, col: 1 },
      hits: [false, false, false],
    },
  ];
  console.log("[Parent] P2 joining with items:", items);
  data2.set({ label: "Player 2", items });
  console.log("[Parent] P2 navigating to child...");
  return navigateTo(
    Child({ myData: data2, otherData: data1, whichPlayer: 2 }),
  );
});

const Parent = pattern<ParentInput, object>(({ data1, data2 }) => ({
  [NAME]: "Two-Cell Repro",
  [UI]: (
    <div style={{ padding: "20px", backgroundColor: "#0f172a", color: "#fff" }}>
      <h1>Two-Cell Repro (like Battleship)</h1>
      <p>Join as one player, then check the OTHER player's data</p>
      <div style={{ display: "flex", gap: "20px", marginTop: "20px" }}>
        <cf-button onClick={joinAsP1({ data1, data2 })}>Join as P1</cf-button>
        <cf-button onClick={joinAsP2({ data1, data2 })}>Join as P2</cf-button>
      </div>
    </div>
  ),
}));

export default Parent;
