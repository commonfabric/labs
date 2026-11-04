import {
  action,
  computed,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commonfabric";

import {
  areAllShipsSunk,
  buildShipPositions,
  COLS,
  createInitialState,
  findShipAt,
  type GameState,
  GRID_INDICES,
  isShipSunk,
  ROWS,
  SHIP_NAMES,
} from "./schemas.tsx";

// Re-export types for test compatibility
export type {
  Coordinate,
  GameState,
  PlayerBoard,
  Ship,
  ShipType,
  SquareState,
} from "./schemas.tsx";

// =============================================================================
// Types
// =============================================================================

interface BoardCell {
  row: number;
  col: number;
  bgColor: string;
  content: string;
  gridRow: string;
  gridCol: string;
}

// =============================================================================
// Pattern
// =============================================================================

type Input = Record<string, never>;

export interface Output {
  game: Writable<GameState>;
  fireShot: Stream<{ row: number; col: number }>;
  passDevice: Stream<void>;
  playerReady: Stream<void>;
  resetGame: Stream<void>;
}

export default pattern<Input, Output>((_input) => {
  const game = new Writable<GameState>(createInitialState());

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const fireShot = action<{ row: number; col: number }>(({ row, col }) => {
    const state = game.get();

    // Can't fire if game is over, in transition, or awaiting pass
    if (state.phase === "finished") return;
    if (state.viewingAs === null) return;
    if (state.awaitingPass) return;

    // Can only fire on your turn
    if (state.currentTurn !== state.viewingAs) return;

    // Target the opponent's board
    const targetPlayer = state.viewingAs === 1 ? 2 : 1;
    const targetBoard = targetPlayer === 1 ? state.player1 : state.player2;
    const shots = targetBoard.shots;

    // Can't fire at same spot twice
    if (shots[row][col] !== "empty") return;

    // Check if hit
    const hitShip = findShipAt(targetBoard.ships, { row, col });
    const newShots = shots.map((r, ri) =>
      r.map((c, ci) =>
        ri === row && ci === col ? (hitShip ? "hit" : "miss") : c
      )
    );

    const newTargetBoard = { ...targetBoard, shots: newShots };

    // Build message
    let message = "";
    const coordStr = `${COLS[col]}${row + 1}`;

    if (hitShip) {
      if (isShipSunk(hitShip, newShots)) {
        message = `${coordStr}: Hit! You sunk the ${SHIP_NAMES[hitShip.type]}!`;
      } else {
        message = `${coordStr}: Hit!`;
      }
    } else {
      message = `${coordStr}: Miss.`;
    }

    // Check for win
    const allSunk = areAllShipsSunk(targetBoard.ships, newShots);

    if (allSunk) {
      game.update({
        player1: targetPlayer === 1 ? newTargetBoard : state.player1,
        player2: targetPlayer === 2 ? newTargetBoard : state.player2,
        phase: "finished",
        winner: state.currentTurn,
        lastMessage: `${message} Player ${state.currentTurn} wins!`,
        viewingAs: state.viewingAs,
        awaitingPass: false,
      });
    } else {
      const nextTurn = state.currentTurn === 1 ? 2 : 1;
      game.update({
        player1: targetPlayer === 1 ? newTargetBoard : state.player1,
        player2: targetPlayer === 2 ? newTargetBoard : state.player2,
        currentTurn: nextTurn as 1 | 2,
        lastMessage: message,
        viewingAs: state.viewingAs,
        awaitingPass: true,
      });
    }
  });

  const passDevice = action(() => {
    const state = game.get();
    if (state.phase === "finished") return;
    if (!state.awaitingPass) return;
    game.update({
      viewingAs: null,
      awaitingPass: false,
    });
  });

  const playerReady = action(() => {
    const state = game.get();
    if (state.phase === "finished") return;
    if (state.viewingAs !== null) return;
    game.update({
      viewingAs: state.currentTurn,
      awaitingPass: false,
      lastMessage:
        `Player ${state.currentTurn}'s turn - fire at the enemy board!`,
    });
  });

  const resetGame = action(() => {
    game.set(createInitialState());
  });

  // ---------------------------------------------------------------------------
  // Computed Values
  // ---------------------------------------------------------------------------

  // Single computed for all display values (accessed via properties)
  const gameStatus = computed(() => {
    const state = game.get();
    return {
      lastMessage: state.lastMessage,
      currentTurn: state.currentTurn,
      viewingAs: state.viewingAs,
      winner: state.winner,
      awaitingPass: state.awaitingPass,
    };
  });

  // Screen visibility conditions
  const isTransition = computed(() => game.get().viewingAs === null);
  const isFinished = computed(() => game.get().phase === "finished");

  // Board cell computation
  const myBoardCells = computed((): BoardCell[] => {
    const state = game.get();
    const viewer = state.viewingAs;
    if (viewer === null) return [];

    const myBoard = viewer === 1 ? state.player1 : state.player2;
    const shots = myBoard.shots;
    const shipPositions = buildShipPositions(myBoard.ships);

    return GRID_INDICES.map(({ row, col }) => {
      const shotState = shots[row]?.[col] ?? "empty";
      const hasShip = !!shipPositions[`${row},${col}`];
      const bgColor = shotState === "hit"
        ? "#dc2626"
        : shotState === "miss"
        ? "#374151"
        : hasShip
        ? "#22c55e"
        : "#1e3a5f";
      const content = shotState === "hit"
        ? "X"
        : shotState === "miss"
        ? "O"
        : "";
      return {
        row,
        col,
        bgColor,
        content,
        gridRow: `${row + 2}`,
        gridCol: `${col + 2}`,
      };
    });
  });

  const enemyBoardCells = computed((): BoardCell[] => {
    const state = game.get();
    const viewer = state.viewingAs;
    if (viewer === null) return [];

    const enemyBoard = viewer === 1 ? state.player2 : state.player1;
    const shots = enemyBoard.shots;

    return GRID_INDICES.map(({ row, col }) => {
      const shotState = shots[row]?.[col] ?? "empty";
      const bgColor = shotState === "hit"
        ? "#dc2626"
        : shotState === "miss"
        ? "#374151"
        : "#1e3a5f";
      const content = shotState === "hit"
        ? "X"
        : shotState === "miss"
        ? "O"
        : "";
      return {
        row,
        col,
        bgColor,
        content,
        gridRow: `${row + 2}`,
        gridCol: `${col + 2}`,
      };
    });
  });

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const gridContainerStyle = {
    display: "grid",
    gridTemplateColumns: "30px repeat(10, 32px)",
    gap: "2px",
    backgroundColor: "#000",
    padding: "2px",
  };

  const headerCellStyle = {
    backgroundColor: "#1a1a2e",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#888",
    fontSize: "12px",
    fontWeight: "bold",
    height: "30px",
  };

  const baseCellStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontSize: "16px",
    fontWeight: "bold",
    height: "32px",
    width: "32px",
  };

  // ---------------------------------------------------------------------------
  // CSS-based screen visibility (avoid ifElse DOM destruction)
  // ---------------------------------------------------------------------------

  // Compute display styles for each screen - CSS changes instead of DOM swap
  const transitionDisplay = computed(() => isTransition ? "flex" : "none");
  const victoryDisplay = computed(() => isFinished ? "flex" : "none");
  const gameDisplay = computed(() => {
    const state = game.get();
    const showGame = state.phase !== "finished" && state.viewingAs !== null;
    return showGame ? "block" : "none";
  });

  // ---------------------------------------------------------------------------
  // UI Components (now always rendered, visibility via CSS)
  // ---------------------------------------------------------------------------

  const transitionScreen = (
    <div
      style={{
        display: transitionDisplay,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        gap: "20px",
        position: "absolute",
        top: "0",
        left: "0",
        right: "0",
      }}
    >
      <h2 style={{ fontSize: "32px", margin: "0" }}>
        Pass device to Player {gameStatus.currentTurn}
      </h2>
      <p style={{ color: "#94a3b8", fontSize: "18px", margin: "0" }}>
        Make sure the other player isn't looking!
      </p>
      <cf-button onClick={playerReady}>
        I'm Player {gameStatus.currentTurn} - Ready!
      </cf-button>
    </div>
  );

  const victoryScreen = (
    <div
      style={{
        display: victoryDisplay,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        gap: "20px",
        position: "absolute",
        top: "0",
        left: "0",
        right: "0",
      }}
    >
      <h2 style={{ fontSize: "48px", margin: "0", color: "#22c55e" }}>
        Player {gameStatus.winner} Wins!
      </h2>
      <p style={{ color: "#94a3b8", fontSize: "18px", margin: "0" }}>
        All enemy ships have been sunk!
      </p>
      <cf-button onClick={resetGame}>Play Again</cf-button>
    </div>
  );

  const gameScreen = (
    <div
      style={{
        display: gameDisplay,
        position: "absolute",
        top: "0",
        left: "0",
        right: "0",
      }}
    >
      {/* Status bar */}
      <div
        style={{
          textAlign: "center",
          padding: "12px",
          backgroundColor: "#1e293b",
          borderRadius: "8px",
          marginBottom: "20px",
          fontSize: "18px",
        }}
      >
        {gameStatus.lastMessage}
      </div>

      {/* Pass button (shown after firing) */}
      <div
        style={{
          display: computed(() => gameStatus.awaitingPass ? "block" : "none"),
          textAlign: "center",
          padding: "16px",
          marginBottom: "20px",
          backgroundColor: "#1e40af",
          borderRadius: "8px",
        }}
      >
        <cf-button onClick={passDevice}>
          Pass to Player {gameStatus.currentTurn}
        </cf-button>
      </div>

      {/* Game boards */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: "40px",
          flexWrap: "wrap",
        }}
      >
        {/* My Board (left) */}
        <div style={{ display: "inline-block" }}>
          <h3 style={{ textAlign: "center", margin: "0 0 8px 0" }}>
            Your Fleet
          </h3>
          <div style={gridContainerStyle}>
            <div style={headerCellStyle} />
            {COLS.map((c, i) => <div key={i} style={headerCellStyle}>{c}</div>)}
            {ROWS.map((rowIdx) => (
              <div
                style={{
                  ...headerCellStyle,
                  gridRow: `${rowIdx + 2}`,
                  gridColumn: "1",
                }}
              >
                {rowIdx + 1}
              </div>
            ))}
            {myBoardCells.map((cell) => (
              <div
                style={{
                  ...baseCellStyle,
                  gridRow: cell.gridRow,
                  gridColumn: cell.gridCol,
                  backgroundColor: cell.bgColor,
                }}
              >
                {cell.content}
              </div>
            ))}
          </div>
        </div>

        {/* Enemy Board (right) */}
        <div style={{ display: "inline-block" }}>
          <h3 style={{ textAlign: "center", margin: "0 0 8px 0" }}>
            Enemy Waters
          </h3>
          <div style={gridContainerStyle}>
            <div style={headerCellStyle} />
            {COLS.map((c, i) => <div key={i} style={headerCellStyle}>{c}</div>)}
            {ROWS.map((rowIdx) => (
              <div
                style={{
                  ...headerCellStyle,
                  gridRow: `${rowIdx + 2}`,
                  gridColumn: "1",
                }}
              >
                {rowIdx + 1}
              </div>
            ))}
            {enemyBoardCells.map((cell) => (
              <div
                style={{
                  ...baseCellStyle,
                  gridRow: cell.gridRow,
                  gridColumn: cell.gridCol,
                  backgroundColor: cell.bgColor,
                  cursor: "pointer",
                }}
                onClick={() => fireShot.send({ row: cell.row, col: cell.col })}
              >
                {cell.content}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: "20px",
          marginTop: "20px",
          fontSize: "14px",
          color: "#94a3b8",
        }}
      >
        <span>
          <span
            style={{
              display: "inline-block",
              width: "16px",
              height: "16px",
              backgroundColor: "#22c55e",
              marginRight: "4px",
              verticalAlign: "middle",
            }}
          />
          Your Ship
        </span>
        <span>
          <span
            style={{
              display: "inline-block",
              width: "16px",
              height: "16px",
              backgroundColor: "#1e3a5f",
              marginRight: "4px",
              verticalAlign: "middle",
            }}
          />
          Unknown
        </span>
        <span>
          <span
            style={{
              display: "inline-block",
              width: "16px",
              height: "16px",
              backgroundColor: "#dc2626",
              marginRight: "4px",
              verticalAlign: "middle",
              textAlign: "center",
              color: "#fff",
              fontSize: "12px",
              lineHeight: "16px",
            }}
          >
            X
          </span>
          Hit
        </span>
        <span>
          <span
            style={{
              display: "inline-block",
              width: "16px",
              height: "16px",
              backgroundColor: "#374151",
              marginRight: "4px",
              verticalAlign: "middle",
              textAlign: "center",
              color: "#fff",
              fontSize: "12px",
              lineHeight: "16px",
            }}
          >
            O
          </span>
          Miss
        </span>
      </div>
    </div>
  );

  // ---------------------------------------------------------------------------
  // Main UI
  // ---------------------------------------------------------------------------

  return {
    [NAME]: "Battleship",
    [UI]: (
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          padding: "20px",
          backgroundColor: "#0f172a",
          color: "#e2e8f0",
          minHeight: "100vh",
          position: "relative",
        }}
      >
        <h1 style={{ textAlign: "center", margin: "0 0 20px 0" }}>
          BATTLESHIP
        </h1>

        {/* Screen container - relative positioning for absolute children */}
        <div style={{ position: "relative", minHeight: "70vh" }}>
          {victoryScreen}
          {transitionScreen}
          {gameScreen}
        </div>

        {/* Reset button (always visible) */}
        <div style={{ textAlign: "center", marginTop: "30px" }}>
          <cf-button onClick={resetGame}>Reset Game</cf-button>
        </div>
      </div>
    ),
    game,
    fireShot,
    passDevice,
    playerReady,
    resetGame,
  };
});
