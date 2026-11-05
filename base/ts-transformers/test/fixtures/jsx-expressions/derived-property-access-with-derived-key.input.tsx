import { Cell, computed, pattern, UI } from "commonfabric";

interface Item {
  name: string;
  done: Cell<boolean>;
}

interface Assignment {
  aisle: string;
  item: Item;
}

// CT-1036: Property access on derived grouped objects with derived keys
// This pattern groups items by a property, then maps over the group keys
// and accesses the grouped object with each key.
// FIXTURE: derived-property-access-with-derived-key
// Verifies: .map() chains with derived keys and element access are fully transformed
//   aisleNames.map(...)            → aisleNames.mapWithPattern(pattern(...).curry({captures}))
//   groupedByAisle[aisleName].map  → lift over {groupedByAisle, aisleName} then .mapWithPattern(...)
// Context: CT-1036 -- nested map with derived object indexed by derived key, two levels deep
export default pattern<{ items: Item[] }>(
  ({ items }) => {
    // Create assignments with aisle data (whole-array map kept inside computed)
    const itemsWithAisles = computed(() =>
      items.map((item, idx) => ({
        aisle: `Aisle ${(idx % 3) + 1}`,
        item: item,
      }))
    );

    // Group by aisle - returns Record<string, Assignment[]>
    const groupedByAisle = computed(() => {
      const groups: Record<string, Assignment[]> = {};
      for (const assignment of itemsWithAisles) {
        if (!groups[assignment.aisle]) {
          groups[assignment.aisle] = [];
        }
        groups[assignment.aisle]!.push(assignment);
      }
      return groups;
    });

    // Derive sorted aisle names from grouped object
    const aisleNames = computed(() => Object.keys(groupedByAisle).sort());

    // The pattern from CT-1036:
    // - Map over derived keys (aisleNames)
    // - Access derived object with derived key (groupedByAisle[aisleName])
    // - Map over the result
    return {
      [UI]: (
        <div>
          {aisleNames.map((aisleName) => (
            <div>
              <h3>{aisleName}</h3>
              {groupedByAisle[aisleName]!.map((assignment) => (
                <div>
                  <span>{assignment.item.name}</span>
                  <cf-checkbox $checked={assignment.item.done} />
                </div>
              ))}
            </div>
          ))}
        </div>
      ),
    };
  },
);
