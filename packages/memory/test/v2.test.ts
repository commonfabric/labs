import { assert, assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import {
  type EntityRef,
  entityRefFromString,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";

import {
  compatibleMemoryProtocolFlags,
  decodeMemoryBoundary,
  DEFAULT_BRANCH,
  encodeMemoryBoundary,
  type EntityDocument,
  getEntityDocumentMetadata,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  parseMemoryProtocolFlags,
  resetCommitPreconditionsConfig,
  resetMessageCompressionConfig,
  resetServerExecutionConfig,
  resetSyncSchemaTableConfig,
  setCommitPreconditionsConfig,
  setMessageCompressionConfig,
  setServerExecutionConfig,
  setSyncSchemaTableConfig,
  toDocumentPath,
  toDocumentSelector,
  toValuePath,
  wireMemoryProtocolFlags,
} from "../v2.ts";

const toEntityDocument = (
  value: unknown,
  source?: EntityRef,
  metadata: Record<string, unknown> = {},
) => {
  const document: Record<string, unknown> = {
    ...metadata,
    ...(source !== undefined ? { source } : {}),
  };
  if (value !== undefined) {
    document.value = value;
  }
  return document;
};

//
// Flag-independent tests (run once, not per-flag-state)
//

describe("memory v2 protocol constants", () => {
  it("exports the phase-1 protocol constants", () => {
    assertEquals(MEMORY_PROTOCOL, "memory");
    assertEquals(DEFAULT_BRANCH, "");
  });
});

describe("memory v2 documents", () => {
  it("builds explicit in-memory documents", () => {
    const source = entityRefFromString("abc123");
    assertEquals(
      toEntityDocument({ hello: "world" }, source),
      {
        value: { hello: "world" },
        source,
      },
    );
  });

  it("builds explicit logical documents", () => {
    assertEquals(
      toEntityDocument({
        hello: "world",
      }),
      {
        value: { hello: "world" },
      },
    );
  });

  it("extracts document metadata without value", () => {
    const source = entityRefFromString("abc123");
    const document: EntityDocument = {
      value: { hello: "world" },
      source,
      label: "example",
      count: 2,
    };

    assertEquals(
      getEntityDocumentMetadata(document),
      {
        source,
        label: "example",
        count: 2,
      },
    );
  });
});

describe("memory v2 paths", () => {
  it("document paths are explicit full-document paths", () => {
    assertEquals([...toDocumentPath([])], []);
    assertEquals(
      [...toDocumentPath(["value", "items", "0", "title"])],
      ["value", "items", "0", "title"],
    );
  });

  it("value-relative paths stay distinct from document paths", () => {
    assertEquals([...toValuePath([])], []);
    assertEquals(
      toDocumentSelector({
        path: toValuePath(["items", "0"]),
        schema: false,
      }),
      {
        path: toDocumentPath(["value", "items", "0"]),
        schema: false,
      },
    );
  });
});

//
// Flag-mechanism test (explicitly tests both OFF and ON in one test)
//

describe("memory v2 flags", () => {
  it("reflects the active runtime storage flags", () => {
    resetModernCellRepConfig();
    resetCommitPreconditionsConfig();
    resetMessageCompressionConfig();
    resetSyncSchemaTableConfig();
    setServerExecutionConfig(false);
    setModernCellRepConfig(false);
    setCommitPreconditionsConfig(false);
    setMessageCompressionConfig(false);
    setSyncSchemaTableConfig(false);

    assertEquals(getMemoryProtocolFlags(), {
      genesisRoot: true,
      modernCellRep: false,
      stableExpressionResultIds: true,
      versionedGeneratedCellIds: true,
      commitPreconditions: false,
      applyOp: true,
      operationCodecs: ["codemirror-changeset@1"],
      messageCompressionV1: false,
      // Build-inherent capability, not configuration: always advertised.
      sqliteCommitRowLabelEval: true,
      sqliteQueryReader: true,
      pendingReadStacks: true,
      verdictCatchUpMarkers: true,
      entityIdListing: true,
      entityIdPagination: true,
      entityIdLookup: true,
      sessionHoldings: true,
      viewScopedReplicationV1: false,
      sessionReadCeiling: true,
      syncSchemaTableV2: false,
    });

    setModernCellRepConfig(true);
    setCommitPreconditionsConfig(true);
    setMessageCompressionConfig(true);
    setSyncSchemaTableConfig(true);

    assertEquals(getMemoryProtocolFlags(), {
      genesisRoot: true,
      modernCellRep: true,
      stableExpressionResultIds: true,
      versionedGeneratedCellIds: true,
      commitPreconditions: true,
      applyOp: true,
      operationCodecs: ["codemirror-changeset@1"],
      messageCompressionV1: true,
      sqliteCommitRowLabelEval: true,
      sqliteQueryReader: true,
      pendingReadStacks: true,
      verdictCatchUpMarkers: true,
      entityIdListing: true,
      entityIdPagination: true,
      entityIdLookup: true,
      sessionHoldings: true,
      viewScopedReplicationV1: false,
      sessionReadCeiling: true,
      syncSchemaTableV2: true,
    });

    resetModernCellRepConfig();
    resetCommitPreconditionsConfig();
    resetMessageCompressionConfig();
    resetSyncSchemaTableConfig();
    resetServerExecutionConfig();
  });

  it("treats non-wire-shape flags as optional capabilities", () => {
    assert(compatibleMemoryProtocolFlags(
      {
        modernCellRep: true,
        stableExpressionResultIds: true,
        versionedGeneratedCellIds: true,
        commitPreconditions: true,
        applyOp: true,
        syncSchemaTableV2: true,
        messageCompressionV1: true,
        sqliteCommitRowLabelEval: true,
        sqliteQueryReader: true,
        pendingReadStacks: true,
        verdictCatchUpMarkers: false,
        entityIdListing: true,
        entityIdPagination: true,
        entityIdLookup: true,
        sessionHoldings: false,
        viewScopedReplicationV1: true,
        sessionReadCeiling: true,
      },
      {
        modernCellRep: true,
        stableExpressionResultIds: true,
        versionedGeneratedCellIds: true,
        commitPreconditions: false,
        applyOp: false,
        syncSchemaTableV2: false,
        messageCompressionV1: false,
        // A peer without commit-time sqlite row-label evaluation stays
        // compatible — the capability only gates the runner's write-gate
        // relaxation, never the connection.
        sqliteCommitRowLabelEval: false,
        sqliteQueryReader: false,
        pendingReadStacks: false,
        verdictCatchUpMarkers: false,
        entityIdListing: false,
        entityIdPagination: false,
        entityIdLookup: false,
        sessionHoldings: false,
        viewScopedReplicationV1: false,
        // Likewise: a client carrying a read ceiling refuses such a
        // server itself, and one carrying none connects as before.
        sessionReadCeiling: false,
      },
    ));
  });
});

describe("parseMemoryProtocolFlags", () => {
  it("requires an explicit custom-root capability", () => {
    assertEquals(parseMemoryProtocolFlags({})?.genesisRoot, false);
    assertEquals(
      parseMemoryProtocolFlags({ genesisRoot: true })?.genesisRoot,
      true,
    );
    assertEquals(parseMemoryProtocolFlags({ genesisRoot: "true" }), null);
  });
  it("negotiates view replication as an optional server-execution capability", () => {
    try {
      setServerExecutionConfig(false);
      assertEquals(getMemoryProtocolFlags().viewScopedReplicationV1, false);
      setServerExecutionConfig(true);
      assertEquals(getMemoryProtocolFlags().viewScopedReplicationV1, true);
      assertEquals(
        parseMemoryProtocolFlags({ viewScopedReplicationV1: true })
          ?.viewScopedReplicationV1,
        true,
      );
      assertEquals(
        parseMemoryProtocolFlags({ modernCellRep: true })
          ?.viewScopedReplicationV1,
        false,
      );
      assertEquals(
        parseMemoryProtocolFlags({ viewScopedReplicationV1: "true" }),
        null,
      );
    } finally {
      resetServerExecutionConfig();
    }
  });

  it("requires explicit SQLite reader capability advertisement", () => {
    assertEquals(parseMemoryProtocolFlags({})?.sqliteQueryReader, false);
    assertEquals(
      parseMemoryProtocolFlags({ sqliteQueryReader: true })?.sqliteQueryReader,
      true,
    );
    assertEquals(
      parseMemoryProtocolFlags({ sqliteQueryReader: false })?.sqliteQueryReader,
      false,
    );
    assertEquals(parseMemoryProtocolFlags({ sqliteQueryReader: "true" }), null);
    assertEquals(
      parseMemoryProtocolFlags(
        wireMemoryProtocolFlags(getMemoryProtocolFlags()),
      )?.sqliteQueryReader,
      true,
    );
  });

  it("accepts the modernCellRep key", () => {
    assertEquals(parseMemoryProtocolFlags({ modernCellRep: true }), {
      genesisRoot: false,
      modernCellRep: true,
      stableExpressionResultIds: false,
      versionedGeneratedCellIds: false,
      commitPreconditions: false,
      applyOp: false,
      syncSchemaTableV2: false,
      messageCompressionV1: false,
      sqliteCommitRowLabelEval: false,
      sqliteQueryReader: false,
      pendingReadStacks: false,
      verdictCatchUpMarkers: false,
      entityIdListing: false,
      entityIdPagination: false,
      entityIdLookup: false,
      sessionHoldings: false,
      viewScopedReplicationV1: false,
      sessionReadCeiling: false,
    });
    assertEquals(parseMemoryProtocolFlags({ modernCellRep: false }), {
      genesisRoot: false,
      modernCellRep: false,
      stableExpressionResultIds: false,
      versionedGeneratedCellIds: false,
      commitPreconditions: false,
      applyOp: false,
      syncSchemaTableV2: false,
      messageCompressionV1: false,
      sqliteCommitRowLabelEval: false,
      sqliteQueryReader: false,
      pendingReadStacks: false,
      verdictCatchUpMarkers: false,
      entityIdListing: false,
      entityIdPagination: false,
      entityIdLookup: false,
      sessionHoldings: false,
      viewScopedReplicationV1: false,
      sessionReadCeiling: false,
    });
  });

  it("accepts the canonical commitPreconditions key", () => {
    assertEquals(
      parseMemoryProtocolFlags({
        commitPreconditions: true,
      }),
      {
        genesisRoot: false,
        modernCellRep: false,
        stableExpressionResultIds: false,
        versionedGeneratedCellIds: false,
        commitPreconditions: true,
        applyOp: false,
        syncSchemaTableV2: false,
        messageCompressionV1: false,
        sqliteCommitRowLabelEval: false,
        sqliteQueryReader: false,
        pendingReadStacks: false,
        verdictCatchUpMarkers: false,
        entityIdListing: false,
        entityIdPagination: false,
        entityIdLookup: false,
        sessionHoldings: false,
        viewScopedReplicationV1: false,
        sessionReadCeiling: false,
      },
    );
  });

  it("accepts the applyOp capability key", () => {
    assertEquals(parseMemoryProtocolFlags({ applyOp: true })?.applyOp, true);
  });

  it("accepts only versioned operation codec capability ids", () => {
    assertEquals(
      parseMemoryProtocolFlags({
        applyOp: true,
        operationCodecs: ["codemirror-changeset@1"],
      })?.operationCodecs,
      ["codemirror-changeset@1"],
    );
    assertEquals(
      parseMemoryProtocolFlags({ operationCodecs: ["missing"] }),
      null,
    );
  });

  it("accepts the canonical syncSchemaTableV2 key", () => {
    assertEquals(
      parseMemoryProtocolFlags({
        syncSchemaTableV2: true,
      }),
      {
        genesisRoot: false,
        modernCellRep: false,
        stableExpressionResultIds: false,
        versionedGeneratedCellIds: false,
        commitPreconditions: false,
        applyOp: false,
        syncSchemaTableV2: true,
        messageCompressionV1: false,
        sessionHoldings: false,
        viewScopedReplicationV1: false,
        sessionReadCeiling: false,
        sqliteCommitRowLabelEval: false,
        sqliteQueryReader: false,
        pendingReadStacks: false,
        verdictCatchUpMarkers: false,
        entityIdListing: false,
        entityIdPagination: false,
        entityIdLookup: false,
      },
    );
  });

  it("accepts the messageCompressionV1 capability key", () => {
    assertEquals(
      parseMemoryProtocolFlags({ messageCompressionV1: true }),
      {
        genesisRoot: false,
        modernCellRep: false,
        stableExpressionResultIds: false,
        versionedGeneratedCellIds: false,
        commitPreconditions: false,
        applyOp: false,
        syncSchemaTableV2: false,
        messageCompressionV1: true,
        sqliteCommitRowLabelEval: false,
        sqliteQueryReader: false,
        pendingReadStacks: false,
        verdictCatchUpMarkers: false,
        entityIdListing: false,
        entityIdPagination: false,
        entityIdLookup: false,
        sessionHoldings: false,
        viewScopedReplicationV1: false,
        sessionReadCeiling: false,
      },
    );
  });

  it("accepts the sqliteCommitRowLabelEval capability key", () => {
    assertEquals(
      parseMemoryProtocolFlags({
        sqliteCommitRowLabelEval: true,
      }),
      {
        genesisRoot: false,
        modernCellRep: false,
        stableExpressionResultIds: false,
        versionedGeneratedCellIds: false,
        commitPreconditions: false,
        applyOp: false,
        syncSchemaTableV2: false,
        messageCompressionV1: false,
        sqliteCommitRowLabelEval: true,
        sqliteQueryReader: false,
        pendingReadStacks: false,
        verdictCatchUpMarkers: false,
        entityIdListing: false,
        entityIdPagination: false,
        entityIdLookup: false,
        sessionHoldings: false,
        viewScopedReplicationV1: false,
        sessionReadCeiling: false,
      },
    );
  });

  it("round-trips verdictCatchUpMarkers through the wire flags shape", () => {
    const flags = getMemoryProtocolFlags();
    assertEquals(flags.verdictCatchUpMarkers, true);
    const wire = wireMemoryProtocolFlags(flags);
    assertEquals(wire.verdictCatchUpMarkers, true);
    assertEquals(parseMemoryProtocolFlags(wire), flags);
  });

  it("accepts the verdictCatchUpMarkers capability key", () => {
    assertEquals(
      parseMemoryProtocolFlags({
        verdictCatchUpMarkers: true,
      }),
      {
        genesisRoot: false,
        modernCellRep: false,
        stableExpressionResultIds: false,
        versionedGeneratedCellIds: false,
        commitPreconditions: false,
        applyOp: false,
        syncSchemaTableV2: false,
        messageCompressionV1: false,
        sqliteCommitRowLabelEval: false,
        sqliteQueryReader: false,
        pendingReadStacks: false,
        verdictCatchUpMarkers: true,
        entityIdListing: false,
        entityIdPagination: false,
        entityIdLookup: false,
        sessionHoldings: false,
        viewScopedReplicationV1: false,
        sessionReadCeiling: false,
      },
    );
  });

  it("accepts the pendingReadStacks capability key", () => {
    assertEquals(
      parseMemoryProtocolFlags({
        pendingReadStacks: true,
        verdictCatchUpMarkers: false,
      }),
      {
        genesisRoot: false,
        modernCellRep: false,
        stableExpressionResultIds: false,
        versionedGeneratedCellIds: false,
        commitPreconditions: false,
        applyOp: false,
        syncSchemaTableV2: false,
        messageCompressionV1: false,
        sqliteCommitRowLabelEval: false,
        sqliteQueryReader: false,
        pendingReadStacks: true,
        verdictCatchUpMarkers: false,
        entityIdListing: false,
        entityIdPagination: false,
        entityIdLookup: false,
        sessionHoldings: false,
        viewScopedReplicationV1: false,
        sessionReadCeiling: false,
      },
    );
  });

  it("accepts the entityIdListing capability key", () => {
    assertEquals(
      parseMemoryProtocolFlags({ entityIdListing: true }),
      {
        genesisRoot: false,
        modernCellRep: false,
        stableExpressionResultIds: false,
        versionedGeneratedCellIds: false,
        commitPreconditions: false,
        applyOp: false,
        syncSchemaTableV2: false,
        messageCompressionV1: false,
        sqliteCommitRowLabelEval: false,
        sqliteQueryReader: false,
        pendingReadStacks: false,
        verdictCatchUpMarkers: false,
        entityIdListing: true,
        entityIdPagination: false,
        entityIdLookup: false,
        sessionHoldings: false,
        viewScopedReplicationV1: false,
        sessionReadCeiling: false,
      },
    );
  });

  it("accepts entity identifier pagination and lookup capability keys", () => {
    assertEquals(
      parseMemoryProtocolFlags({
        entityIdPagination: true,
        entityIdLookup: true,
        sessionHoldings: false,
        viewScopedReplicationV1: false,
        sessionReadCeiling: false,
      }),
      {
        genesisRoot: false,
        modernCellRep: false,
        stableExpressionResultIds: false,
        versionedGeneratedCellIds: false,
        commitPreconditions: false,
        applyOp: false,
        syncSchemaTableV2: false,
        messageCompressionV1: false,
        sqliteCommitRowLabelEval: false,
        sqliteQueryReader: false,
        pendingReadStacks: false,
        verdictCatchUpMarkers: false,
        entityIdListing: false,
        entityIdPagination: true,
        entityIdLookup: true,
        sessionHoldings: false,
        viewScopedReplicationV1: false,
        sessionReadCeiling: false,
      },
    );
  });

  it("rejects values that are not a recognizable flags shape", () => {
    assertEquals(parseMemoryProtocolFlags(null), null);
    assertEquals(
      parseMemoryProtocolFlags({ pendingReadStacks: "true" }),
      null,
    );
    assertEquals(parseMemoryProtocolFlags(undefined), null);
    assertEquals(parseMemoryProtocolFlags("modernCellRep"), null);
    assertEquals(parseMemoryProtocolFlags([true]), null);
    assertEquals(parseMemoryProtocolFlags({ modernCellRep: "true" }), null);
    assertEquals(parseMemoryProtocolFlags({ syncSchemaTableV2: "true" }), null);
    assertEquals(parseMemoryProtocolFlags({ applyOp: "true" }), null);
    assertEquals(
      parseMemoryProtocolFlags({ messageCompressionV1: "true" }),
      null,
    );
    assertEquals(
      parseMemoryProtocolFlags({ verdictCatchUpMarkers: "true" }),
      null,
    );
    assertEquals(
      parseMemoryProtocolFlags({ sqliteCommitRowLabelEval: "true" }),
      null,
    );
    assertEquals(parseMemoryProtocolFlags({ entityIdListing: "true" }), null);
    assertEquals(
      parseMemoryProtocolFlags({ entityIdPagination: "true" }),
      null,
    );
    assertEquals(parseMemoryProtocolFlags({ entityIdLookup: "true" }), null);
    assertEquals(parseMemoryProtocolFlags({ sessionHoldings: "true" }), null);
    assertEquals(
      parseMemoryProtocolFlags({
        modernCellRep: true,
        stableExpressionResultIds: false,
        versionedGeneratedCellIds: false,
        commitPreconditions: "true",
      }),
      null,
    );
  });
});

//
// Boundary encode/decode dispatch test (explicitly tests OFF and ON paths)
//

describe("memory v2 boundary decode", () => {
  it("returns deeply-frozen plain JSON trees", () => {
    const decoded = decodeMemoryBoundary<{
      value: {
        nested: {
          count: number;
        };
      };
    }>(
      encodeMemoryBoundary({
        value: {
          nested: {
            count: 1,
          },
        },
      }),
    );

    assertEquals(decoded, {
      value: {
        nested: {
          count: 1,
        },
      },
    });
    assert(Object.isFrozen(decoded));
    assert(Object.isFrozen(decoded.value));
    assert(Object.isFrozen(decoded.value.nested));

    assertThrows(() => {
      decoded.value.nested.count = 2;
    }, TypeError);
    assertEquals(decoded.value.nested.count, 1);
  });
});
