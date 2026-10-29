import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  entityRefFromString,
  entityRefToString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";

type MockDoc = {
  get: () => unknown;
  getEntityId: () => unknown;
};

describe("Piece reference detection", () => {
  // The core logic of direct reference finding, without maybeGetCellLink.

  it("should find all direct references in an argument structure", () => {
    // Create mock data with multiple references
    const mockData = {
      piece1Id: entityRefFromString("piece-1-id"),
      piece2Id: entityRefFromString("piece-2-id"),
    };

    // Create a value that references two different entity IDs
    const valueWithMultipleRefs = {
      firstRef: {
        cell: mockData.piece1Id,
        path: [],
      },
      secondRef: {
        cell: mockData.piece2Id,
        path: [],
      },
      nestedRefs: {
        a: {
          cell: mockData.piece1Id,
          path: [],
        },
        b: {
          cell: mockData.piece2Id,
          path: [],
        },
      },
    };

    // Track the references we find
    const foundRefs: string[] = [];

    // Direct manual detection (not using maybeGetCellLink which requires proper Cell implementation)
    const findDirectReferences = (value: unknown): void => {
      if (!value) return;

      // Check if the value is a cell-link reference (EntityRef cell + path)
      if (
        isObjectOrArray(value) && isEntityRef(value.cell) &&
        value.path !== undefined
      ) {
        const addr = entityRefToString(value.cell);
        if (!foundRefs.includes(addr)) {
          foundRefs.push(addr);
        }
      }

      // Recursively search objects and arrays
      if (isObjectOrArray(value)) {
        // Check all properties of objects
        if (!Array.isArray(value)) {
          for (const key in value) {
            findDirectReferences(value[key]);
          }
        } // Check all items in arrays
        else {
          for (const item of value) {
            findDirectReferences(item);
          }
        }
      }
    };

    // Search for references
    findDirectReferences(valueWithMultipleRefs);

    console.log(
      `Found ${foundRefs.length} direct references:`,
      foundRefs.join(", "),
    );

    // We should find both piece1Id and piece2Id
    assertEquals(
      foundRefs.length,
      2,
      "Should find exactly 2 unique reference IDs",
    );

    // Verify we found both specific references
    const foundPiece1 = foundRefs.includes(
      entityRefToString(mockData.piece1Id),
    );
    const foundPiece2 = foundRefs.includes(
      entityRefToString(mockData.piece2Id),
    );

    assertEquals(foundPiece1, true, "Should find reference to piece1");
    assertEquals(foundPiece2, true, "Should find reference to piece2");
  });

  it("should find multiple references in argument data that matches the reported issue", () => {
    // Mock the scenario where a piece's argument refers to two other pieces
    const mockPiece1Id = entityRefFromString("piece-1-id");
    const mockPiece2Id = entityRefFromString("piece-2-id");

    // Create a realistic argument cell structure that might be causing the issue
    // This simulates a more realistic structure based on your description of the problem
    const argumentData = {
      // This is a more realistic structure that might be found in an actual argument cell
      // with references to result cells of other pieces
      firstPieceRef: {
        $alias: {
          cell: mockPiece1Id,
          path: ["result"],
        },
      },
      secondPieceRef: {
        $alias: {
          cell: mockPiece2Id,
          path: ["result"],
        },
      },
      // Alternative format - direct references
      directRefs: {
        firstPiece: {
          cell: mockPiece1Id,
          path: ["result"],
        },
        secondPiece: {
          cell: mockPiece2Id,
          path: ["result"],
        },
      },
    };

    // Let's implement our own reference finding logic to compare with what the system does
    const findAllReferences = (
      obj: unknown,
    ): string[] => {
      const refs: string[] = [];
      const seenIds = new Set<string>();

      const traverse = (value: unknown): void => {
        if (!isObjectOrArray(value)) return;

        // Check for direct cell reference
        if (isEntityRef(value.cell) && value.path !== undefined) {
          const addr = entityRefToString(value.cell);
          if (!seenIds.has(addr)) {
            refs.push(addr);
            seenIds.add(addr);
          }
        }

        // Check for $alias reference
        if (isObjectOrArray(value.$alias) && isEntityRef(value.$alias.cell)) {
          const addr = entityRefToString(value.$alias.cell);
          if (!seenIds.has(addr)) {
            refs.push(addr);
            seenIds.add(addr);
          }
        }

        // Traverse objects and arrays
        if (Array.isArray(value)) {
          for (const item of value) {
            traverse(item);
          }
        } else {
          for (const key in value) {
            traverse(value[key]);
          }
        }
      };

      traverse(obj);
      return refs;
    };

    // Find all references using our custom logic
    const foundReferences = findAllReferences(argumentData);

    // We should find both piece references
    console.log(
      `Found ${foundReferences.length} references:`,
      foundReferences.join(", "),
    );

    assertEquals(
      foundReferences.length,
      2,
      "Should find both piece references in the argument data",
    );

    // Check that we specifically found both piece IDs
    const foundPiece1 = foundReferences.includes(
      entityRefToString(mockPiece1Id),
    );
    const foundPiece2 = foundReferences.includes(
      entityRefToString(mockPiece2Id),
    );

    assertEquals(foundPiece1, true, "Should find reference to piece1");
    assertEquals(foundPiece2, true, "Should find reference to piece2");

    // Now let's simulate what happens in the actual getReadingFrom method
    console.log("Reference structure to examine:");
    console.log(JSON.stringify(argumentData, null, 2));

    // This will help us see if there might be an ordering issue affecting which
    // references are found first, potentially causing some to be missed
  });

  it("should follow result metadata chains to find deeply nested references", () => {
    // Mock test data
    const mockPiece1Id = entityRefFromString("piece-1-source");
    const mockPiece2Id = entityRefFromString("piece-2-intermediate");
    const mockPiece3Id = entityRefFromString("piece-3-target");

    // Create a chain of references where:
    // - piece1 references piece2 via result metadata
    // - piece2 references piece3 via result metadata
    const piece2WithResultMeta = {
      // This is the intermediate piece data
      result: {
        cell: mockPiece3Id,
        path: [],
      },
    };

    // Mock linked metadata cell with get and getEntityId methods
    const mockMetadataCell = {
      get: () => piece2WithResultMeta,
      getEntityId: () => mockPiece2Id,
    };

    const piece1WithMetadataCell = {
      // This is the source piece with a result metadata reference
      resultCell: mockMetadataCell,
    };

    // Create mock doc with get and getEntityId methods
    const mockDoc = {
      get: () => piece1WithMetadataCell,
      getEntityId: () => mockPiece1Id,
    };

    // Test our ability to follow this chain
    console.log(
      "Testing n-depth reference detection with result metadata chain...",
    );

    // Simulate following metadata links to the owning result.
    const followMetadataToResult = (
      doc: unknown,
      visited = new Set<string>(),
      depth = 0,
    ): unknown => {
      if (depth > 10) return undefined; // Prevent infinite recursion

      // Get the doc ID
      const docId = (doc as MockDoc).getEntityId?.();
      if (!isEntityRef(docId)) return undefined;

      // If we've already seen this doc, stop to prevent cycles
      const docIdStr = entityRefToString(docId);

      if (visited.has(docIdStr)) return undefined;
      visited.add(docIdStr);

      // Get the doc value
      // FIXME: types
      const value = (doc as MockDoc).get?.();

      // If document has a metadata-linked result cell, follow it
      if (isObjectOrArray(value) && value.resultCell) {
        return followMetadataToResult(value.resultCell, visited, depth + 1);
      }

      // If we've reached the end and have result metadata, return it
      if (isObjectOrArray(value) && isObjectOrArray(value.result)) {
        return value.result.cell;
      }

      // Return the document's ID if no further references
      return docId;
    };

    // Follow the metadata chain to find the ultimate reference
    const ultimateRef = followMetadataToResult(mockDoc);

    // Verify we found the final target (piece3)
    assertEquals(
      isEntityRef(ultimateRef) ? entityRefToString(ultimateRef) : undefined,
      entityRefToString(mockPiece3Id),
      "Should find the final reference through the result metadata chain",
    );
  });
});
