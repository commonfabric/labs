/**
 * Store Mapper Pattern
 *
 * Captures grocery store layouts through:
 * - Manual aisle entry with descriptions
 * - Perimeter department positioning
 * - Entrance marking
 * - Item location corrections for future reference
 *
 * The generated store data is used by Shopping List for AI-powered aisle sorting.
 */
import {
  computed,
  Default,
  generateObject,
  handler,
  NAME,
  pattern,
  UI,
  VNode,
  Writable,
} from "commonfabric";

// Types for store layout
type WallPosition =
  | "front-left"
  | "front-center"
  | "front-right"
  | "back-left"
  | "back-center"
  | "back-right"
  | "left-front"
  | "left-center"
  | "left-back"
  | "right-front"
  | "right-center"
  | "right-back"
  | "unassigned"
  | "not-in-store"
  | "in-center-aisle";

interface Aisle {
  name: string; // Just the number, e.g., "1", "2", "5A"
  description: string | Default<"">;
}

interface Department {
  name: string;
  icon: string;
  location: WallPosition | Default<"unassigned">;
  description: string | Default<"">;
}

interface Entrance {
  position: WallPosition;
}

interface ItemLocation {
  itemName: string;
  correctAisle: string;
  incorrectAisle: string | Default<"">;
  timestamp: number;
}

interface Input {
  storeName: Writable<string | Default<"My Store">>;
  aisles: Writable<Aisle[] | Default<[]>>;
  departments: Writable<Department[] | Default<[]>>;
  entrances: Writable<Entrance[] | Default<[]>>;
  itemLocations: Writable<ItemLocation[] | Default<[]>>;
}

export interface Output {
  [NAME]: string;
  [UI]: VNode;
  storeName: string;
  aisles: Aisle[];
  departments: Department[];
  entrances: Entrance[];
  itemLocations: ItemLocation[];
  outline: string;
  aisleCount: number;
  deptCount: number;
  correctionCount: number;
}

// Type for position grouping in visual map (must be at module scope for pattern compiler)
type ItemsByPos = Record<
  string,
  { depts: Department[]; entrances: Entrance[] }
>;

// Natural aisle order: by leading number, then by name, so "5A" precedes
// "5B" and both follow "4"; an aisle with no number sorts last.
const byAisleNumber = (a: Aisle, b: Aisle): number => {
  const numA = parseInt(a.name.match(/^\d+/)?.[0] || "999", 10);
  const numB = parseInt(b.name.match(/^\d+/)?.[0] || "999", 10);
  if (numA !== numB) return numA - numB;
  return a.name.localeCompare(b.name);
};

// A row of location buttons: its title and color, the class that tints its
// buttons, and the positions it offers.
interface LocationRow {
  title: string;
  color: string;
  buttonClass?: string;
  positions: { position: WallPosition; label: string }[];
}

type Wall = "front" | "back" | "left" | "right";

// Each wall's buttons, with the name its legend entry gives it.
const WALLS: Record<Wall, LocationRow & { legend: string }> = {
  front: {
    title: "Front",
    legend: "Front (entrance)",
    color: "#3b82f6",
    buttonClass: "wall-btn-front",
    positions: [
      { position: "front-left", label: "Left" },
      { position: "front-center", label: "Center" },
      { position: "front-right", label: "Right" },
    ],
  },
  back: {
    title: "Back",
    legend: "Back",
    color: "#f97316",
    buttonClass: "wall-btn-back",
    positions: [
      { position: "back-left", label: "Left" },
      { position: "back-center", label: "Center" },
      { position: "back-right", label: "Right" },
    ],
  },
  left: {
    title: "Left",
    legend: "Left",
    color: "#10b981",
    buttonClass: "wall-btn-left",
    positions: [
      { position: "left-front", label: "Front" },
      { position: "left-center", label: "Center" },
      { position: "left-back", label: "Back" },
    ],
  },
  right: {
    title: "Right",
    legend: "Right",
    color: "#a855f7",
    buttonClass: "wall-btn-right",
    positions: [
      { position: "right-front", label: "Front" },
      { position: "right-center", label: "Center" },
      { position: "right-back", label: "Back" },
    ],
  },
};

// The walls in the order their buttons and legend entries appear.
const WALL_ORDER: Wall[] = ["front", "back", "left", "right"];
const WALL_ROWS = WALL_ORDER.map((wall) => WALLS[wall]);

// A department can also be placed off the walls.
const DEPARTMENT_LOCATION_ROWS: LocationRow[] = [
  ...WALL_ROWS,
  {
    title: "Other",
    color: "#6b7280",
    positions: [
      { position: "in-center-aisle", label: "Normal Aisle" },
      { position: "not-in-store", label: "N/A" },
    ],
  },
];

// The slots along one wall of the visual map: each shows a door for every
// entrance at its position and an icon for every department. The side walls
// run from the back of the store at the top to the front at the bottom.
const wallSlots = (items: ItemsByPos, wall: Wall) => {
  const positions = WALLS[wall].positions.map(({ position }) => position);
  if (wall === "left" || wall === "right") positions.reverse();
  return (
    <>
      {positions.map((position) => {
        const { depts, entrances } = items[position] ??
          { depts: [], entrances: [] };
        return (
          <div
            className={`store-map-slot${
              entrances.length > 0 ? " store-map-entrance-slot" : ""
            }`}
          >
            {entrances.map(() => (
              <span className="store-map-entrance" title="Entrance">🚪</span>
            ))}
            {depts.map((d) => (
              <span className="store-map-badge" title={d.name}>{d.icon}</span>
            ))}
          </div>
        );
      })}
    </>
  );
};

// Types for AI photo-based aisle import
interface ImageData {
  id: string;
  name: string;
  url?: string;
  data?: string;
}

type ImageUploadEvent = {
  detail?: {
    images?: ImageData[];
    files?: ImageData[];
  };
};

const appendUploadedPhotos = handler<
  ImageUploadEvent,
  { uploadedPhotos: Writable<ImageData[]> }
>(({ detail }, { uploadedPhotos }) => {
  const uploaded = detail?.images ?? detail?.files ?? [];
  if (uploaded.length === 0) return;
  uploadedPhotos.set([
    ...(uploadedPhotos.get() ?? []),
    ...uploaded,
  ]);
});

export interface ExtractedAisle {
  name: string;
  // The AI extraction may omit or null the products list.
  products?: string[] | null;
}

// Default departments to load
const DEFAULT_DEPARTMENTS: Array<{ name: string; icon: string }> = [
  { name: "Bakery", icon: "🥖" },
  { name: "Deli", icon: "🥪" },
  { name: "Produce", icon: "🥬" },
  { name: "Dairy", icon: "🥛" },
  { name: "Frozen Foods", icon: "🧊" },
  { name: "Meat & Seafood", icon: "🥩" },
  { name: "Pharmacy", icon: "💊" },
];

// Whether two names differ only in case. The add handlers refuse a name that
// matches an existing aisle this way.
const sameName = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

// Handlers
const addAisle = handler<
  { detail: { message: string } },
  { aisles: Writable<Aisle[]> }
>(({ detail }, { aisles }) => {
  const name = detail?.message?.trim();
  if (!name) return;

  // Check for duplicate aisle
  const existing = aisles.get();
  if (existing.some((a) => sameName(a.name, name))) return;

  aisles.push({
    name,
    description: "",
  });
});

// Exported for tests. Finds the aisle by its exact name, so a reference read
// before an update still finds it.
export const removeAisle = handler<
  unknown,
  { aisles: Writable<Aisle[]>; aisle: Aisle }
>((_event, { aisles, aisle }) => {
  const current = aisles.get();
  const index = current.findIndex((el) => el.name === aisle.name);
  if (index >= 0) {
    aisles.set(current.toSpliced(index, 1));
  }
});

// Entrance handlers
const addEntrance = handler<
  unknown,
  { entrances: Writable<Entrance[]>; position: WallPosition }
>((_event, { entrances, position }) => {
  const current = entrances.get();
  // Don't add duplicate entrances at same position
  if (current.some((e) => e.position === position)) return;
  entrances.push({ position });
});

const removeEntrance = handler<
  unknown,
  { entrances: Writable<Entrance[]>; entrance: Entrance }
>((_event, { entrances, entrance }) => {
  const current = entrances.get();
  // `addEntrance` keeps one entrance per position.
  const index = current.findIndex((el) => el.position === entrance.position);
  if (index >= 0) {
    entrances.set(current.toSpliced(index, 1));
  }
});

// Department location handler
// Exported for tests. Finds the department by name, so a reference read before
// an update still finds it, and writes through the element's cell
// (`.key(index)`): replacing the array slot with a fresh object literal would
// re-mint the department's entity identity and orphan previously-held
// references (see patterns/product/primitives/editable-list.tsx).
export const setDepartmentLocation = handler<
  unknown,
  {
    departments: Writable<Department[]>;
    dept: Department;
    location: WallPosition;
  }
>((_event, { departments, dept, location }) => {
  const current = departments.get();
  const index = current.findIndex((el) => el.name === dept.name);
  if (index >= 0) {
    departments.key(index).key("location").set(location);
  }
});

// Handlers for AI photo import
// Exported for tests.
export const addExtractedAisle = handler<
  unknown,
  { aisles: Writable<Aisle[]>; extracted: ExtractedAisle }
>((_event, { aisles, extracted }) => {
  const current = aisles.get() || [];
  const exists = current.some(
    (a: Aisle) => sameName(a.name, extracted.name),
  );
  if (!exists) {
    aisles.push({
      name: extracted.name,
      description: (extracted.products || []).map((p: string) => `- ${p}`).join(
        "\n",
      ),
    });
  }
});

const addAllExtractedAisles = handler<
  unknown,
  {
    aisles: Writable<Aisle[]>;
    extractedList: ExtractedAisle[];
    hiddenPhotoIds: Writable<string[]>;
    photoId: string;
  }
>((_event, { aisles, extractedList, hiddenPhotoIds, photoId }) => {
  const current = aisles.get() || [];
  const existingNames = new Set(
    current.map((a: Aisle) => a.name.toLowerCase()),
  );
  const newAisles = extractedList
    .filter((e) => !existingNames.has(e.name.toLowerCase()))
    .map((e) => ({
      name: e.name,
      description: (e.products || []).map((p) => `- ${p}`).join("\n"),
    }));
  aisles.set([...current, ...newAisles]);
  // Hide the photo after adding
  hiddenPhotoIds.addUnique(photoId);
});

// Exported for tests. Writes the merged description through the element's
// cell instead of replacing the array slot — slot replacement re-mints the
// aisle's entity identity and orphans previously-held references.
export const mergeExtractedAisle = handler<
  unknown,
  { aisles: Writable<Aisle[]>; extracted: ExtractedAisle }
>((_event, { aisles, extracted }) => {
  const current = aisles.get() || [];
  const idx = current.findIndex(
    (a: Aisle) => sameName(a.name, extracted.name),
  );
  if (idx >= 0) {
    const existing = current[idx];
    const existingItems = (existing.description || "")
      .split("\n")
      .map((l) => l.replace(/^-\s*/, "").trim().toLowerCase())
      .filter(Boolean);
    const newProducts = (extracted.products || []).filter(
      (p) => !existingItems.includes(p.toLowerCase()),
    );
    if (newProducts.length > 0) {
      const newDesc = existing.description
        ? existing.description + "\n" +
          newProducts.map((p) => `- ${p}`).join("\n")
        : newProducts.map((p) => `- ${p}`).join("\n");
      aisles.key(idx).key("description").set(newDesc);
    }
  }
});

const hidePhoto = handler<
  unknown,
  { hiddenPhotoIds: Writable<string[]>; photoId: string }
>((_event, { hiddenPhotoIds, photoId }) => {
  hiddenPhotoIds.addUnique(photoId);
});

interface ExtractedAisleResultsInput {
  extracted: ExtractedAisle[];
  aisles: Writable<Aisle[]>;
  hiddenPhotoIds: Writable<string[]>;
  photoId: string;
}

interface ExtractedAisleResultsOutput {
  [UI]: VNode;
}

// The aisles the model read off one photo, each offered for adding (or, when
// an aisle of that name exists, merging), with a button that adds every new
// one at once and hides the photo, or a note that the photo showed no aisles.
export const ExtractedAisleResults = pattern<
  ExtractedAisleResultsInput,
  ExtractedAisleResultsOutput
>(({ extracted, aisles, hiddenPhotoIds, photoId }) => ({
  [UI]: computed(() => {
    if (extracted.length === 0) {
      return (
        <div style={{ fontSize: "12px", color: "#999" }}>
          No aisles detected in photo
        </div>
      );
    }

    const existingAisleNames = aisles.get().map((existing: Aisle) =>
      existing?.name?.toLowerCase?.() ?? ""
    );
    const newCount = extracted.filter(
      (e) => !existingAisleNames.includes(e.name.toLowerCase()),
    ).length;

    return (
      <cf-vstack gap="1">
        {/* Batch add button */}
        {newCount > 0 && (
          <cf-button
            size="sm"
            variant="primary"
            onClick={addAllExtractedAisles({
              aisles,
              extractedList: extracted,
              hiddenPhotoIds,
              photoId,
            })}
            style="margin-bottom: 0.5rem;"
          >
            + Add All {newCount} New Aisles
          </cf-button>
        )}

        {/* Individual aisle results */}
        {extracted.map((extractedAisle: ExtractedAisle) => {
          const exists = existingAisleNames.includes(
            extractedAisle.name.toLowerCase(),
          );
          return (
            <cf-hstack
              gap="2"
              align="center"
              style={`padding: 0.5rem; background: ${
                exists ? "#fef3c7" : "#dcfce7"
              }; border-radius: 4px;`}
            >
              <div style={{ flex: 1 }}>
                <strong>Aisle {extractedAisle.name}</strong>
                {exists && (
                  <span
                    style={{
                      color: "#92400e",
                      marginLeft: "0.5rem",
                      fontSize: "11px",
                    }}
                  >
                    (exists)
                  </span>
                )}
                <div style={{ fontSize: "12px", color: "#6b7280" }}>
                  {(extractedAisle.products || []).join(", ") ||
                    "(no products)"}
                </div>
              </div>
              {exists
                ? (
                  <cf-button
                    size="sm"
                    variant="secondary"
                    onClick={mergeExtractedAisle({
                      aisles,
                      extracted: extractedAisle,
                    })}
                  >
                    Merge
                  </cf-button>
                )
                : (
                  <cf-button
                    size="sm"
                    variant="primary"
                    onClick={addExtractedAisle({
                      aisles,
                      extracted: extractedAisle,
                    })}
                  >
                    Add
                  </cf-button>
                )}
            </cf-hstack>
          );
        })}
      </cf-vstack>
    );
  }),
}));

type Section = "map" | "aisles" | "departments" | "corrections" | "outline";

interface MapTabInput {
  departments: Department[];
  entrances: Writable<Entrance[]>;
  aisleCount: number;
  currentSection: Writable<Section>;
}

interface TabOutput {
  [UI]: VNode;
}

// The visual store map, the controls that mark entrances, and shortcuts to
// the aisle and department tabs.
export const MapTab = pattern<MapTabInput, TabOutput>(
  ({ departments, entrances, aisleCount, currentSection }) => {
    const entranceCount = entrances.get().length;

    // Group departments and entrances by position for the visual map
    const itemsByPosition = computed((): ItemsByPos => {
      const byPos: ItemsByPos = {};
      // Add departments
      for (const dept of departments) {
        if (
          dept.location && dept.location !== "unassigned" &&
          dept.location !== "not-in-store" &&
          dept.location !== "in-center-aisle"
        ) {
          if (!byPos[dept.location]) {
            byPos[dept.location] = { depts: [], entrances: [] };
          }
          byPos[dept.location].depts.push(dept);
        }
      }
      // Add entrances
      for (const entrance of entrances.get()) {
        if (!byPos[entrance.position]) {
          byPos[entrance.position] = { depts: [], entrances: [] };
        }
        byPos[entrance.position].entrances.push(entrance);
      }
      return byPos;
    });

    // Pre-compute entrance positions for button states (use Record instead of Set for JSON-serializable)
    const entrancePositions = computed(() => {
      const positions: Record<string, boolean> = {};
      for (const e of entrances.get()) {
        positions[e.position] = true;
      }
      return positions;
    });

    return {
      [UI]: (
        <cf-vscroll flex showScrollbar fadeEdges>
          <cf-vstack gap="3" style="padding: 1rem; max-width: 800px;">
            {/* CSS for store map */}
            <style>
              {`
                    .store-map {
                      display: grid;
                      grid-template-columns: 60px 1fr 60px;
                      grid-template-rows: 60px 140px 60px;
                      gap: 0;
                      width: 100%;
                      max-width: 400px;
                      height: 260px;
                      border: 3px solid #374151;
                      border-radius: 8px;
                      overflow: hidden;
                      background: transparent;
                      margin: 0 auto;
                    }
                    .store-map-corner {
                      background: #d1d5db;
                      width: 100%;
                      height: 100%;
                    }
                    .store-map-corner-tl { background: linear-gradient(to bottom left, #fed7aa 50%, #bbf7d0 50%); }
                    .store-map-corner-tr { background: linear-gradient(to bottom right, #fed7aa 50%, #e9d5ff 50%); }
                    .store-map-corner-bl { background: linear-gradient(to top left, #dbeafe 50%, #bbf7d0 50%); }
                    .store-map-corner-br { background: linear-gradient(to top right, #dbeafe 50%, #e9d5ff 50%); }
                    .store-map-wall {
                      display: flex;
                      padding: 4px;
                      gap: 2px;
                      overflow: hidden;
                      width: 100%;
                      height: 100%;
                    }
                    .store-map-wall-horizontal { flex-direction: row; }
                    .store-map-wall-vertical { flex-direction: column; }
                    .store-map-wall-front { grid-column: 2; grid-row: 3; background: #dbeafe; }
                    .store-map-wall-back { grid-column: 2; grid-row: 1; background: #fed7aa; }
                    .store-map-wall-left { grid-column: 1; grid-row: 2; background: #bbf7d0; }
                    .store-map-wall-right { grid-column: 3; grid-row: 2; background: #e9d5ff; }
                    .store-map-slot {
                      flex: 1;
                      display: flex;
                      justify-content: center;
                      align-items: center;
                      min-width: 0;
                      min-height: 0;
                      gap: 2px;
                      flex-wrap: wrap;
                    }
                    .store-map-entrance-slot {
                      background: #374151;
                      border-radius: 2px;
                    }
                    .store-map-center {
                      grid-column: 2;
                      grid-row: 2;
                      background: #f9fafb;
                      display: flex;
                      flex-direction: column;
                      align-items: center;
                      justify-content: center;
                      color: #6b7280;
                      font-size: 14px;
                    }
                    .store-map-badge {
                      font-size: 24px;
                      cursor: default;
                    }
                    .store-map-entrance {
                      font-size: 20px;
                      cursor: default;
                    }
                    .wall-btn-front::part(button) {
                      background-color: #eff6ff;
                      color: #1e40af;
                      border-color: #3b82f6;
                    }
                    .wall-btn-back::part(button) {
                      background-color: #fff7ed;
                      color: #c2410c;
                      border-color: #f97316;
                    }
                    .wall-btn-left::part(button) {
                      background-color: #f0fdf4;
                      color: #047857;
                      border-color: #10b981;
                    }
                    .wall-btn-right::part(button) {
                      background-color: #faf5ff;
                      color: #7e22ce;
                      border-color: #a855f7;
                    }
                  `}
            </style>

            {/* Visual Store Map */}
            <cf-card>
              <cf-vstack gap="2">
                <span style={{ fontWeight: 600, fontSize: "16px" }}>
                  🏪 Store Layout
                </span>
                <div className="store-map">
                  {/* Corners */}
                  <div
                    className="store-map-corner store-map-corner-tl"
                    style={{ gridColumn: 1, gridRow: 1 }}
                  />
                  <div
                    className="store-map-corner store-map-corner-tr"
                    style={{ gridColumn: 3, gridRow: 1 }}
                  />
                  <div
                    className="store-map-corner store-map-corner-bl"
                    style={{ gridColumn: 1, gridRow: 3 }}
                  />
                  <div
                    className="store-map-corner store-map-corner-br"
                    style={{ gridColumn: 3, gridRow: 3 }}
                  />

                  {/* Back wall (top - orange) */}
                  <div className="store-map-wall store-map-wall-horizontal store-map-wall-back">
                    {computed(() => wallSlots(itemsByPosition, "back"))}
                  </div>

                  {/* Left wall (green) */}
                  <div className="store-map-wall store-map-wall-vertical store-map-wall-left">
                    {computed(() => wallSlots(itemsByPosition, "left"))}
                  </div>

                  {/* Center */}
                  <div className="store-map-center">
                    <div style={{ fontWeight: 500 }}>Aisles</div>
                    <div>{aisleCount}</div>
                  </div>

                  {/* Right wall (purple) */}
                  <div className="store-map-wall store-map-wall-vertical store-map-wall-right">
                    {computed(() => wallSlots(itemsByPosition, "right"))}
                  </div>

                  {/* Front wall (bottom - blue) */}
                  <div className="store-map-wall store-map-wall-horizontal store-map-wall-front">
                    {computed(() => wallSlots(itemsByPosition, "front"))}
                  </div>
                </div>
                <div
                  style={{
                    textAlign: "center",
                    fontSize: "12px",
                    color: "var(--cf-colors-gray-500)",
                  }}
                >
                  {WALL_ROWS.map((wall, i) => (
                    <>
                      <span style={{ color: wall.color }}>■</span> {wall.legend}
                      {i < WALL_ROWS.length - 1 ? " " : ""}
                    </>
                  ))}
                </div>
              </cf-vstack>
            </cf-card>

            {/* Add Entrances Section */}
            <cf-card style="background: #fef3c7; border: 1px solid #fbbf24;">
              <cf-vstack gap="2">
                <span style={{ fontWeight: 600, color: "#92400e" }}>
                  🚪 Mark Store Entrances
                </span>
                <div
                  style={{
                    fontSize: "13px",
                    color: "#78350f",
                  }}
                >
                  Click to add entrances:
                </div>

                {WALL_ROWS.map((wall) => (
                  <div
                    style={{
                      display: "flex",
                      gap: "6px",
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        width: "60px",
                        fontSize: "12px",
                        fontWeight: 600,
                        color: wall.color,
                      }}
                    >
                      {wall.title}:
                    </span>
                    {wall.positions.map(({ position, label }) => (
                      <cf-button
                        size="sm"
                        variant="outline"
                        className={wall.buttonClass}
                        disabled={!!entrancePositions[position]}
                        onClick={addEntrance({ entrances, position })}
                      >
                        {label}
                      </cf-button>
                    ))}
                  </div>
                ))}

                {/* Show added entrances */}
                {entranceCount > 0
                  ? (
                    <div style={{ marginTop: "0.5rem" }}>
                      <span
                        style={{
                          fontSize: "12px",
                          fontWeight: 600,
                          color: "#92400e",
                        }}
                      >
                        Added ({entranceCount}):
                      </span>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "0.5rem",
                          marginTop: "0.5rem",
                        }}
                      >
                        {entrances.map((entrance) => (
                          <div
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "0.25rem",
                              padding: "4px 8px",
                              background: "white",
                              border: "1px solid #fbbf24",
                              borderRadius: "4px",
                              fontSize: "12px",
                            }}
                          >
                            🚪 {entrance.position}
                            <cf-button
                              size="sm"
                              variant="ghost"
                              onClick={removeEntrance({
                                entrances,
                                entrance,
                              })}
                              style="padding: 2px 4px; min-height: 0;"
                            >
                              ×
                            </cf-button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                  : null}
              </cf-vstack>
            </cf-card>

            {/* Quick Actions */}
            <cf-hstack gap="2">
              <cf-button
                variant="secondary"
                onClick={() => currentSection.set("aisles")}
                style="flex: 1;"
              >
                + Add Aisles
              </cf-button>
              <cf-button
                variant="secondary"
                onClick={() => currentSection.set("departments")}
                style="flex: 1;"
              >
                + Add Departments
              </cf-button>
            </cf-hstack>
          </cf-vstack>
        </cf-vscroll>
      ),
    };
  },
);

interface AislesTabInput {
  aisles: Writable<Aisle[]>;
  uploadedPhotos: Writable<ImageData[]>;
  hiddenPhotoIds: Writable<string[]>;
}

// The aisle list with its gap warning and add input, and the photo import that
// reads aisle signs with a model.
export const AislesTab = pattern<AislesTabInput, TabOutput>(
  ({ aisles, uploadedPhotos, hiddenPhotoIds }) => {
    // Each uploaded photo's aisles, read by a model. Changing uploadedPhotos
    // re-runs this map, which sends every photo to the model again and shows
    // each as "Analyzing photo..." until it answers, so "Add All" and the ×
    // button hide a photo (hiddenPhotoIds) rather than remove it.
    const photoExtractions = uploadedPhotos.map((photo) => {
      const extraction = generateObject<{ aisles: ExtractedAisle[] }>({
        system:
          'You are analyzing photos from a grocery store. Your task is to extract ALL visible aisle signs and return them as JSON.\n\nIMPORTANT: You MUST return a JSON object with an "aisles" array, even if you only see one aisle or partial information.\n\nFor each aisle sign you see:\n- Extract ONLY the aisle number (e.g., "8", "12", "5A", "5B") - DO NOT include the word "Aisle"\n- Extract each product category as a separate item in the products array\n- Include partially visible signs - do your best to read them\n\nExample output:\n{\n  "aisles": [\n    {"name": "8", "products": ["Bread", "Cereal", "Coffee"]},\n    {"name": "9", "products": ["Snacks", "Chips"]}\n  ]\n}',
        prompt: computed(() => {
          // Safety check: photo might be undefined after deletion
          const image = photo?.data || photo?.url;
          if (!image) return [];
          return [
            { type: "image" as const, image },
            {
              type: "text" as const,
              text:
                "Look at this grocery store photo and extract ALL aisle signs you can see. Return a JSON object with an 'aisles' array containing objects with 'name' (just the number like '5' or '5A', NOT 'Aisle 5') and 'products' (array of strings) fields. Each product category should be a separate item in the products array. Read any text on hanging signs, endcaps, or aisle markers.",
            },
          ];
        }),
        schema: {
          type: "object",
          properties: {
            aisles: {
              type: "array",
              description: "List of aisles detected in the photo",
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description:
                      "Aisle number only (e.g., '8', '5A', '12') - do NOT include the word 'Aisle'",
                  },
                  products: {
                    type: "array",
                    description: "Array of product categories in this aisle",
                    items: {
                      type: "string",
                    },
                  },
                },
              },
            },
          },
        },
      });

      return {
        photo,
        photoName: photo.name,
        extractedAisles: {
          aisles: (extraction.result && extraction.result.aisles) || [],
        },
        pending: extraction.pending,
        error: extraction.error,
      };
    });

    // Sorted aisles (natural numeric order)
    // The stored aisles' own cells in natural order, so an edit or removal in
    // a row reaches the stored aisle however the list was written.
    const sortedAisles = computed(() =>
      aisles.get()
        .map((aisle, index) => ({ aisle, index }))
        .sort((a, b) => byAisleNumber(a.aisle, b.aisle))
        .map(({ index }) => aisles.key(index))
    );

    // Gap detection for aisles
    const detectedGaps = computed(() => {
      const numbers = aisles.get()
        .map((a) => parseInt(a.name.match(/^\d+/)?.[0] || "", 10))
        .filter((n) => !isNaN(n))
        .sort((a, b) => a - b);

      const gaps: number[] = [];
      for (let i = 1; i < numbers.length; i++) {
        // Push all missing numbers in the gap, not just the first one
        for (
          let missing = numbers[i - 1] + 1;
          missing < numbers[i];
          missing++
        ) {
          gaps.push(missing);
        }
      }
      return gaps;
    });

    return {
      [UI]: (
        <cf-vscroll flex showScrollbar fadeEdges>
          <cf-vstack gap="2" style="padding: 1rem; max-width: 800px;">
            {/* Gap warning */}
            {detectedGaps.length > 0
              ? (
                <cf-card style="background: #fef3c7; border: 1px solid #fbbf24;">
                  <cf-vstack gap="1">
                    <span style={{ fontWeight: 500, color: "#92400e" }}>
                      ⚠️ Missing aisle(s) detected: {detectedGaps.join(", ")}
                    </span>
                  </cf-vstack>
                </cf-card>
              )
              : null}

            {/* Aisle list */}
            {sortedAisles.map((aisle) => (
              <cf-card>
                <cf-hstack gap="2" align="start">
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: "1.25rem",
                      minWidth: "80px",
                      color: "#667eea",
                    }}
                  >
                    Aisle {aisle.key("name")}
                  </div>
                  <cf-vstack gap="1" style="flex: 1;">
                    <cf-textarea
                      $value={aisle.key("description")}
                      placeholder="Description (e.g., Bread & Cereal)"
                      rows={3}
                      autoResize
                    />
                  </cf-vstack>
                  <cf-button
                    variant="ghost"
                    onClick={removeAisle({ aisles, aisle })}
                  >
                    ×
                  </cf-button>
                </cf-hstack>
              </cf-card>
            ))}

            {/* Empty state */}
            {aisles.get().length === 0
              ? (
                <div
                  style={{
                    textAlign: "center",
                    color: "var(--cf-colors-gray-500)",
                    padding: "2rem",
                  }}
                >
                  No aisles yet. Add one below!
                </div>
              )
              : null}

            {/* Add aisle input */}
            <cf-message-input
              placeholder="Enter aisle number (e.g., 1, 2, 5A)..."
              appearance="rounded"
              oncf-send={addAisle({ aisles })}
            />

            {/* AI Photo Import Section */}
            <cf-card style="background: #f0fdf4; border: 1px solid #86efac; margin-top: 1rem;">
              <cf-vstack gap="2">
                <cf-hstack gap="2" align="center">
                  <span style={{ fontSize: "1.2rem" }}>📷</span>
                  <span style={{ fontWeight: 600, color: "#166534" }}>
                    Import Aisles from Photos
                  </span>
                </cf-hstack>
                <div
                  style={{
                    fontSize: "13px",
                    color: "#166534",
                  }}
                >
                  Take photos of aisle signs - AI will extract aisle numbers and
                  products automatically.
                </div>
                <cf-image-input
                  multiple
                  maxImages={20}
                  maxSizeBytes={4000000}
                  includeData
                  showPreview={false}
                  buttonText="📷 Scan Aisle Signs"
                  variant="secondary"
                  oncf-change={appendUploadedPhotos({
                    uploadedPhotos,
                  })}
                />

                {/* Photo extraction results */}
                {photoExtractions.map((extraction) =>
                  hiddenPhotoIds.get().includes(extraction.photo.id)
                    ? null
                    : (
                      <div
                        style={{
                          padding: "0.75rem",
                          background: "white",
                          borderRadius: "6px",
                          border: "1px solid #86efac",
                          marginTop: "0.5rem",
                        }}
                      >
                        <cf-hstack
                          justify="between"
                          align="center"
                          style="margin-bottom: 0.5rem;"
                        >
                          <span
                            style={{
                              fontSize: "12px",
                              fontWeight: 600,
                              color: "#166534",
                            }}
                          >
                            📷 {extraction.photoName}
                          </span>
                          <cf-button
                            size="sm"
                            variant="ghost"
                            onClick={hidePhoto({
                              hiddenPhotoIds,
                              photoId: extraction.photo.id,
                            })}
                          >
                            ×
                          </cf-button>
                        </cf-hstack>

                        {extraction.pending
                          ? (
                            <div
                              style={{
                                fontSize: "12px",
                                color: "#16a34a",
                                fontStyle: "italic",
                              }}
                            >
                              Analyzing photo...
                            </div>
                          )
                          : extraction.error
                          ? (
                            <div
                              style={{
                                fontSize: "12px",
                                color: "#dc2626",
                                fontStyle: "italic",
                              }}
                            >
                              Error analyzing photo. Please try removing and
                              re-uploading.
                            </div>
                          )
                          : (
                            <ExtractedAisleResults
                              extracted={extraction.extractedAisles
                                .aisles}
                              aisles={aisles}
                              hiddenPhotoIds={hiddenPhotoIds}
                              photoId={extraction.photo.id}
                            />
                          )}
                      </div>
                    )
                )}
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-vscroll>
      ),
    };
  },
);

interface DepartmentCardInput {
  dept: Department;
  departments: Writable<Department[]>;
}

// One department: its icon, name and location, a button per location, and its
// description.
const DepartmentCard = pattern<DepartmentCardInput, TabOutput>(
  ({ dept, departments }) => {
    // The rows as a cell, so the buttons are mapped reactively and each one's
    // variant follows the department's location.
    const rows = computed(() => DEPARTMENT_LOCATION_ROWS);
    return {
      [UI]: (
        <cf-card>
          <cf-vstack gap="2">
            <cf-hstack gap="2" align="center">
              <span style={{ fontSize: "1.5rem" }}>{dept.icon}</span>
              <span style={{ fontWeight: 500, flex: 1 }}>{dept.name}</span>
              <span
                style={{
                  fontSize: "12px",
                  padding: "4px 8px",
                  borderRadius: "4px",
                  background: dept.location === "unassigned"
                    ? "var(--cf-theme-color-status-warning-soft)"
                    : "var(--cf-colors-green-100)",
                }}
              >
                {dept.location}
              </span>
            </cf-hstack>
            {/* Location button grid */}
            <cf-vstack gap="1">
              {rows.map((row) => (
                <div
                  style={{
                    display: "flex",
                    gap: "4px",
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      width: "50px",
                      fontSize: "11px",
                      fontWeight: 600,
                      color: row.color,
                    }}
                  >
                    {row.title}:
                  </span>
                  {row.positions.map(({ position, label }) => (
                    <cf-button
                      size="sm"
                      variant={dept.location === position
                        ? "primary"
                        : "outline"}
                      className={row.buttonClass}
                      onClick={setDepartmentLocation({
                        departments,
                        dept,
                        location: position,
                      })}
                    >
                      {label}
                    </cf-button>
                  ))}
                </div>
              ))}
            </cf-vstack>
            <cf-input
              $value={dept.description}
              placeholder="Description (optional)"
            />
          </cf-vstack>
        </cf-card>
      ),
    };
  },
);

interface DepartmentsTabInput {
  departments: Writable<Department[]>;
}

// Every department, unassigned ones first, each with a button per location.
export const DepartmentsTab = pattern<DepartmentsTabInput, TabOutput>(
  ({ departments }) => ({
    [UI]: (
      <cf-vscroll flex showScrollbar fadeEdges>
        <cf-vstack gap="2" style="padding: 1rem; max-width: 800px;">
          {
            /* Unassigned departments first, then assigned ones, each rendered
              from the stored list so its edits reach the stored department */
          }
          {departments.map((dept) =>
            dept.location === "unassigned"
              ? <DepartmentCard dept={dept} departments={departments} />
              : null
          )}
          {departments.map((dept) =>
            dept.location === "unassigned"
              ? null
              : <DepartmentCard dept={dept} departments={departments} />
          )}
        </cf-vstack>
      </cf-vscroll>
    ),
  }),
);

interface CorrectionsTabInput {
  itemLocations: Writable<ItemLocation[]>;
  newCorrectionItem: Writable<string>;
  newCorrectionAisle: Writable<string>;
}

// The form that records where an item really is, and the saved corrections.
export const CorrectionsTab = pattern<CorrectionsTabInput, TabOutput>(
  ({ itemLocations, newCorrectionItem, newCorrectionAisle }) => ({
    [UI]: (
      <cf-vscroll flex showScrollbar fadeEdges>
        <cf-vstack gap="2" style="padding: 1rem; max-width: 800px;">
          <cf-card>
            <cf-vstack gap="2">
              <span style={{ fontWeight: 500 }}>
                Add Item Correction
              </span>
              <p
                style={{
                  fontSize: "14px",
                  color: "var(--cf-colors-gray-500)",
                }}
              >
                Record where items are actually located for future reference.
              </p>
              <cf-input
                $value={newCorrectionItem}
                placeholder="Item name (e.g., coffee)"
              />
              <cf-input
                $value={newCorrectionAisle}
                placeholder="Correct location (e.g., Aisle 9 or Bakery)"
              />
              <cf-button
                variant="primary"
                onClick={() => {
                  const item = newCorrectionItem.get().trim();
                  const aisle = newCorrectionAisle.get().trim();
                  if (item && aisle) {
                    const current = itemLocations.get();
                    const filtered = current.filter(
                      (loc) =>
                        loc.itemName.toLowerCase() !==
                          item.toLowerCase(),
                    );
                    filtered.push({
                      itemName: item,
                      correctAisle: aisle,
                      incorrectAisle: "",
                      timestamp: Date.now(),
                    });
                    itemLocations.set(filtered);
                    newCorrectionItem.set("");
                    newCorrectionAisle.set("");
                  }
                }}
              >
                Save Correction
              </cf-button>
            </cf-vstack>
          </cf-card>

          {/* Existing corrections */}
          {itemLocations.get().length > 0
            ? (
              <cf-card>
                <cf-vstack gap="2">
                  <span style={{ fontWeight: 500 }}>
                    Saved Corrections
                  </span>
                  {itemLocations.map((loc) => (
                    <cf-hstack
                      gap="2"
                      align="center"
                      style="padding: 0.5rem; background: var(--cf-colors-gray-50); border-radius: 6px;"
                    >
                      <span style={{ flex: 1 }}>
                        <strong>{loc.itemName}</strong> → {loc.correctAisle}
                      </span>
                      <cf-button
                        variant="ghost"
                        onClick={() => {
                          const current = itemLocations.get();
                          const itemName = loc.itemName;
                          itemLocations.set(
                            current.filter(
                              (l) =>
                                l.itemName.toLowerCase() !==
                                  itemName.toLowerCase(),
                            ),
                          );
                        }}
                      >
                        ×
                      </cf-button>
                    </cf-hstack>
                  ))}
                </cf-vstack>
              </cf-card>
            )
            : (
              <div
                style={{
                  textAlign: "center",
                  color: "var(--cf-colors-gray-500)",
                  padding: "2rem",
                }}
              >
                No corrections saved yet.
              </div>
            )}
        </cf-vstack>
      </cf-vscroll>
    ),
  }),
);

export default pattern<Input, Output>(
  ({ storeName, aisles, departments, entrances, itemLocations }) => {
    // Pre-load default departments if empty (using computed to safely access reactive value)
    const _initDepts = computed(() => {
      const current = departments.get();
      if (current.length === 0) {
        departments.set(
          DEFAULT_DEPARTMENTS.map((d) => ({
            ...d,
            location: "unassigned" as const,
            description: "",
          })),
        );
      }
      return true;
    });
    // Force evaluation of the computed
    void _initDepts;

    // UI state
    const currentSection = new Writable<Section>("map");
    const newCorrectionItem = new Writable("");
    const newCorrectionAisle = new Writable("");

    // Photo import state
    const uploadedPhotos = new Writable<ImageData[]>([]);
    const hiddenPhotoIds = new Writable<string[]>([]);

    // Generate markdown outline
    const outline = computed(() => {
      const aislesSorted = [...aisles.get()].sort(byAisleNumber);
      const depts = departments.get();
      const corrections = itemLocations.get();
      const lines: string[] = [];

      // Aisles
      for (const aisle of aislesSorted) {
        const knownItems = corrections
          .filter((c) => c.correctAisle === `Aisle ${aisle.name}`)
          .map((c) => c.itemName);
        const knownStr = knownItems.length > 0
          ? ` (Known items: ${knownItems.join(", ")})`
          : "";
        lines.push(`# Aisle ${aisle.name}${knownStr}`);
        lines.push(aisle.description || "(no description)");
        lines.push("");
      }

      // Departments with locations
      const assignedDepts = depts.filter(
        (d) =>
          d.location !== "unassigned" &&
          d.location !== "not-in-store" &&
          d.location !== "in-center-aisle",
      );
      for (const dept of assignedDepts) {
        const locStr = dept.location.replace("-", " ");
        const knownItems = corrections
          .filter((c) => c.correctAisle === dept.name)
          .map((c) => c.itemName);
        const knownStr = knownItems.length > 0
          ? ` (Known items: ${knownItems.join(", ")})`
          : "";
        lines.push(`# ${dept.name} (${locStr})${knownStr}`);
        lines.push(dept.description || "(no description)");
        lines.push("");
      }

      return lines.join("\n");
    });

    // Counts for reactive arrays
    const aisleCount = aisles.get().length;
    const deptCount = departments.get().length;
    const correctionCount = itemLocations.get().length;
    const entranceCount = entrances.get().length;

    return {
      [NAME]: storeName,
      [UI]: (
        <cf-screen>
          {/* Header */}
          <div
            slot="header"
            style={{
              background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
              borderRadius: "8px",
              padding: "1rem",
              color: "white",
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}
          >
            <cf-hstack justify="between" align="center">
              <cf-hstack gap="2" align="center">
                <span style={{ fontSize: "1.5rem" }}>🗺️</span>
                <cf-input
                  $value={storeName}
                  placeholder="Store name..."
                  customStyle="font-size: 1.25rem; font-weight: bold; background: transparent; border: none; color: white;"
                />
              </cf-hstack>
            </cf-hstack>
            <div
              style={{
                fontSize: "13px",
                opacity: 0.9,
                marginTop: "0.5rem",
              }}
            >
              {`${aisleCount} aisles • ${deptCount} departments • ${entranceCount} entrances`}
            </div>
          </div>

          {/* Navigation tabs */}
          <cf-tabs $value={currentSection}>
            <cf-tab-list>
              <cf-tab value="map">Map</cf-tab>
              <cf-tab value="aisles">Aisles</cf-tab>
              <cf-tab value="departments">Depts</cf-tab>
              <cf-tab value="corrections">Fixes</cf-tab>
              <cf-tab value="outline">Outline</cf-tab>
            </cf-tab-list>

            {/* MAP SECTION */}
            <cf-tab-panel value="map">
              <MapTab
                departments={departments}
                entrances={entrances}
                aisleCount={aisleCount}
                currentSection={currentSection}
              />
            </cf-tab-panel>

            {/* AISLES SECTION */}
            <cf-tab-panel value="aisles">
              <AislesTab
                aisles={aisles}
                uploadedPhotos={uploadedPhotos}
                hiddenPhotoIds={hiddenPhotoIds}
              />
            </cf-tab-panel>

            {/* DEPARTMENTS SECTION */}
            <cf-tab-panel value="departments">
              <DepartmentsTab departments={departments} />
            </cf-tab-panel>

            {/* CORRECTIONS SECTION */}
            <cf-tab-panel value="corrections">
              <CorrectionsTab
                itemLocations={itemLocations}
                newCorrectionItem={newCorrectionItem}
                newCorrectionAisle={newCorrectionAisle}
              />
            </cf-tab-panel>

            {/* OUTLINE SECTION */}
            <cf-tab-panel value="outline">
              <cf-vscroll flex showScrollbar fadeEdges>
                <cf-vstack gap="2" style="padding: 1rem; max-width: 800px;">
                  <cf-card>
                    <cf-vstack gap="2">
                      <span style={{ fontWeight: 500 }}>
                        Store Layout Outline
                      </span>
                      <p
                        style={{
                          fontSize: "14px",
                          color: "var(--cf-colors-gray-500)",
                        }}
                      >
                        This outline is used by the Shopping List for AI-powered
                        aisle sorting.
                      </p>
                      <pre
                        style={{
                          background: "var(--cf-colors-gray-50)",
                          padding: "1rem",
                          borderRadius: "6px",
                          fontSize: "13px",
                          whiteSpace: "pre-wrap",
                          overflowX: "auto",
                        }}
                      >
                        {outline}
                      </pre>
                    </cf-vstack>
                  </cf-card>
                </cf-vstack>
              </cf-vscroll>
            </cf-tab-panel>
          </cf-tabs>
        </cf-screen>
      ),
      storeName,
      aisles,
      departments,
      entrances,
      itemLocations,
      outline,
      aisleCount,
      deptCount,
      correctionCount,
    };
  },
);
