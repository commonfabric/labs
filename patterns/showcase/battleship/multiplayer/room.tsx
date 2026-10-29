/**
 * Battleship Multiplayer - Game Room Pattern
 *
 * ARCHITECTURE:
 * - Each player has their own instance with shared state Cells
 * - myName and myPlayerNumber determine what this player can see
 * - Ships are only visible on your own board
 * - Shots you've fired are visible on enemy board
 *
 * Uses properly typed Cells instead of JSON serialization.
 *
 * See: lobby.tsx for the lobby entry point
 */

import { action, computed, NAME, pattern, UI } from "commonfabric";

import {
  areAllShipsSunk,
  buildShipPositions,
  COLS,
  findShipAt,
  type GameState,
  getInitials,
  GRID_INDICES,
  isShipSunk,
  normalizePlayerNumber,
  type RoomInput,
  type RoomOutput,
  ROWS,
  SHIP_NAMES,
  type ShotsState,
  type SquareState,
} from "./schemas.tsx";

// =============================================================================
// STATIC STYLES (at module scope - safe because they're plain objects, not JSX)
// =============================================================================

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

const gridContainerStyle = {
  display: "grid",
  gridTemplateColumns: "30px repeat(10, 32px)",
  gap: "2px",
  backgroundColor: "#000",
  padding: "2px",
};

// =============================================================================
// PATTERN
// =============================================================================

const BattleshipRoom = pattern<RoomInput, RoomOutput>(
  ({
    gameName: _gameName,
    player1,
    player2,
    shots,
    gameState,
    myName,
    myPlayerNumber,
  }) => {
    const myNameValue = computed(() => myName.get());
    const myPlayerNumberValue = computed(() =>
      normalizePlayerNumber(myPlayerNumber.get())
    );

    // Fire shot action - closes over pattern state directly
    const fireShot = action<{ row: number; col: number }>(({ row, col }) => {
      const state = gameState.get();
      const playerNum = normalizePlayerNumber(myPlayerNumber.get());
      if (playerNum === null) return;

      // Can't fire if game is over
      if (state.phase === "finished") return;

      // Can only fire on your turn
      if (state.currentTurn !== playerNum) return;

      // Get current shots
      const currentShots = shots.get();

      // Target the opponent's board (shots are stored as "shots received by player X")
      const targetPlayerNum = playerNum === 1 ? 2 : 1;
      const targetShots = currentShots[targetPlayerNum];

      // Can't fire at same spot twice
      if (targetShots[row]?.[col] !== "empty") return;

      // Get opponent's data directly
      const opponentData = targetPlayerNum === 1
        ? player1.get()
        : player2.get();
      if (!opponentData) return;

      // Debug: Log the raw ships data to understand reactive proxy behavior
      console.log("[fireShot] opponentData:", opponentData);
      console.log("[fireShot] opponentData.ships:", opponentData.ships);
      console.log(
        "[fireShot] ships array length:",
        opponentData.ships?.length,
      );
      if (opponentData.ships && opponentData.ships.length > 0) {
        console.log("[fireShot] first ship element:", opponentData.ships[0]);
        console.log(
          "[fireShot] first ship type:",
          opponentData.ships[0]?.type,
        );
      }

      // Get ships array, filtering out any undefined elements (can happen with reactive proxies)
      const ships = (opponentData.ships || []).filter(
        (s): s is NonNullable<typeof s> => s != null && s.type != null,
      );
      console.log("[fireShot] filtered ships length:", ships.length);
      if (ships.length === 0) {
        console.warn("[fireShot] No valid ships found in opponent data");
        return;
      }

      // Check if hit
      const hitShip = findShipAt(ships, { row, col });

      // Update shots grid
      const newTargetShots = targetShots.map((r, ri) =>
        r.map((c, ci) =>
          ri === row && ci === col ? (hitShip ? "hit" : "miss") : c
        )
      ) as SquareState[][];

      const updatedShotsData: ShotsState = {
        ...currentShots,
        [targetPlayerNum]: newTargetShots,
      };
      shots.set(updatedShotsData);

      // Build message
      let message = "";
      const coordStr = `${COLS[col]}${row + 1}`;

      if (hitShip) {
        if (isShipSunk(hitShip, newTargetShots)) {
          message = `${coordStr}: Hit! You sunk the ${
            SHIP_NAMES[hitShip.type]
          }!`;
        } else {
          message = `${coordStr}: Hit!`;
        }
      } else {
        message = `${coordStr}: Miss.`;
      }

      // Check for win (use filtered ships array)
      const allSunk = ships.length > 0 &&
        areAllShipsSunk(ships, newTargetShots);

      if (allSunk) {
        // Get winner's data directly
        const winnerData = playerNum === 1 ? player1.get() : player2.get();
        const winnerName = winnerData?.name || `Player ${playerNum}`;

        const newState: GameState = {
          ...state,
          phase: "finished",
          winner: playerNum,
          lastMessage: `${message} ${winnerName} wins!`,
        };
        gameState.set(newState);
      } else {
        // Switch turns
        const nextTurn = playerNum === 1 ? 2 : 1;
        const nextPlayerData = nextTurn === 1 ? player1.get() : player2.get();
        const nextPlayerName = nextPlayerData?.name || `Player ${nextTurn}`;

        const newState: GameState = {
          ...state,
          currentTurn: nextTurn,
          lastMessage: `${message} ${nextPlayerName}'s turn.`,
        };
        gameState.set(newState);
      }
    });

    // Board cells computed directly
    const myBoardCells = computed(() => {
      const playerNum = normalizePlayerNumber(myPlayerNumber.get());
      if (playerNum === null) return [];
      const playerData = playerNum === 1 ? player1.get() : player2.get();
      const currentShots = shots.get();

      // Guard against null state during hydration
      if (!playerData || !currentShots) {
        return [];
      }

      // Filter out undefined ship elements (reactive proxy issue across pattern boundaries)
      const myShips = (playerData.ships || []).filter(
        (s): s is NonNullable<typeof s> => s != null && s.type != null,
      );
      const myShots = currentShots[playerNum] || [];
      const shipPositions = buildShipPositions(myShips);

      return GRID_INDICES.map(({ row, col }) => {
        const shotState: SquareState = myShots[row]?.[col] ?? "empty";
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

    const enemyBoardCells = computed(() => {
      const playerNum = normalizePlayerNumber(myPlayerNumber.get());
      if (playerNum === null) return [];
      const gs = gameState.get();
      const currentShots = shots.get();

      // Guard against null state during hydration
      if (!gs || !currentShots) {
        return [];
      }

      const isFinished = gs.phase === "finished";
      const oppNum = playerNum === 1 ? 2 : 1;
      const oppShots = currentShots[oppNum] || [];

      return GRID_INDICES.map(({ row, col }) => {
        const shotState: SquareState = oppShots[row]?.[col] ?? "empty";
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
        const canClick = shotState === "empty" && !isFinished;
        return {
          row,
          col,
          bgColor,
          content,
          gridRow: `${row + 2}`,
          gridCol: `${col + 2}`,
          cursor: canClick ? "pointer" : "default",
        };
      });
    });

    // Consolidated computed values - reduces subscription overhead
    const myColor = computed(() => {
      const playerNum = normalizePlayerNumber(myPlayerNumber.get());
      const data = playerNum === 1
        ? player1.get()
        : playerNum === 2
        ? player2.get()
        : null;
      return data?.color || "#3b82f6";
    });

    // Consolidated player 1 display data
    const player1Display = computed(() => {
      const p1 = player1.get();
      const gs = gameState.get();
      return {
        color: p1?.color || "#3b82f6",
        name: p1?.name || "Player 1",
        initials: getInitials(p1?.name || "P1"),
        bgColor: gs?.currentTurn === 1 ? "#1e40af" : "#1e293b",
        status: gs?.currentTurn === 1 ? "Active" : "Waiting",
      };
    });

    // Consolidated player 2 display data
    const player2Display = computed(() => {
      const p2 = player2.get();
      const gs = gameState.get();
      return {
        color: p2?.color || "#ef4444",
        name: p2?.name || "Player 2",
        initials: getInitials(p2?.name || "P2"),
        bgColor: gs?.currentTurn === 2 ? "#1e40af" : "#1e293b",
        status: gs?.currentTurn === 2 ? "Active" : "Waiting",
      };
    });

    // Consolidated status display data
    const statusDisplay = computed(() => {
      const gs = gameState.get();
      if (!gs) {
        return {
          showTurnIndicator: "none",
          bgColor: "#1e293b",
          message: "Loading...",
          lastMessage: "",
        };
      }
      const finished = gs.phase === "finished";
      const playerNum = normalizePlayerNumber(myPlayerNumber.get());
      const won = gs.winner === playerNum;
      const myTurn = gs.currentTurn === playerNum;
      return {
        showTurnIndicator: myTurn && !finished ? "block" : "none",
        bgColor: finished
          ? (won ? "#166534" : "#991b1b")
          : myTurn
          ? "#1e40af"
          : "#1e293b",
        message: finished
          ? (won
            ? "Victory! You sunk all enemy ships!"
            : "Defeat. Your fleet was destroyed.")
          : (myTurn
            ? "Your turn - fire at the enemy fleet!"
            : "Waiting for opponent..."),
        lastMessage: gs.lastMessage || "",
      };
    });

    return {
      [NAME]: computed(() => `Battleship: ${myName.get() || "Joining"}`),
      [UI]: (
        <div
          style={{
            fontFamily: "system-ui, sans-serif",
            padding: "20px",
            backgroundColor: "#0f172a",
            color: "#e2e8f0",
            minHeight: "100vh",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "20px",
            }}
          >
            <h1 style={{ margin: "0", fontSize: "1.5rem" }}>BATTLESHIP</h1>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
              }}
            >
              <span style={{ color: "#94a3b8", fontSize: "0.875rem" }}>
                Playing as
              </span>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "4px 12px",
                  backgroundColor: myColor,
                  borderRadius: "20px",
                }}
              >
                <div
                  style={{
                    width: "24px",
                    height: "24px",
                    borderRadius: "50%",
                    backgroundColor: "rgba(255,255,255,0.2)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "10px",
                    fontWeight: "bold",
                  }}
                >
                  {getInitials(myName.get())}
                </div>
                <span style={{ fontWeight: "600" }}>{myName}</span>
              </div>
            </div>
          </div>

          {/* Status bar */}
          <div
            style={{
              textAlign: "center",
              padding: "16px",
              backgroundColor: statusDisplay.bgColor,
              borderRadius: "8px",
              marginBottom: "20px",
              fontSize: "18px",
              fontWeight: "500",
            }}
          >
            {statusDisplay.message}
          </div>

          {/* Turn indicator */}
          <div
            style={{
              display: statusDisplay.showTurnIndicator,
              textAlign: "center",
              marginBottom: "12px",
            }}
          >
            <span
              style={{
                display: "inline-block",
                padding: "6px 16px",
                backgroundColor: "#22c55e",
                borderRadius: "20px",
                fontSize: "14px",
                fontWeight: "600",
                animation: "pulse 2s infinite",
              }}
            >
              YOUR TURN
            </span>
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
            {/* My Board (left) - uses pre-computed headers from module scope */}
            <div style={{ display: "inline-block" }}>
              <h3 style={{ textAlign: "center", margin: "0 0 8px 0" }}>
                Your Fleet
              </h3>
              <div style={gridContainerStyle}>
                <div style={headerCellStyle} />
                {COLS.map((c, i) => (
                  <div key={i} style={headerCellStyle}>{c}</div>
                ))}
                {ROWS.map((rowIdx) => (
                  <div
                    key={rowIdx}
                    style={{
                      ...headerCellStyle,
                      gridRow: `${rowIdx + 2}`,
                      gridColumn: "1",
                    }}
                  >
                    {rowIdx + 1}
                  </div>
                ))}
                {myBoardCells.map((cell, idx) => (
                  <div
                    key={idx}
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

            {/* Enemy Board (right) - uses event delegation for clicks */}
            <div style={{ display: "inline-block" }}>
              <h3 style={{ textAlign: "center", margin: "0 0 8px 0" }}>
                Enemy Waters
              </h3>
              <div style={gridContainerStyle}>
                <div style={headerCellStyle} />
                {COLS.map((c, i) => (
                  <div key={i} style={headerCellStyle}>{c}</div>
                ))}
                {ROWS.map((rowIdx) => (
                  <div
                    key={rowIdx}
                    style={{
                      ...headerCellStyle,
                      gridRow: `${rowIdx + 2}`,
                      gridColumn: "1",
                    }}
                  >
                    {rowIdx + 1}
                  </div>
                ))}
                {enemyBoardCells.map((cell, idx) => (
                  <div
                    key={idx}
                    style={{
                      ...baseCellStyle,
                      gridRow: cell.gridRow,
                      gridColumn: cell.gridCol,
                      backgroundColor: cell.bgColor,
                      cursor: cell.cursor,
                    }}
                    onClick={() =>
                      fireShot.send({ row: cell.row, col: cell.col })}
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

          {/* Players sidebar */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: "16px",
              marginTop: "24px",
            }}
          >
            {/* Player 1 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 16px",
                backgroundColor: player1Display.bgColor,
                borderRadius: "8px",
                border: myPlayerNumberValue === 1
                  ? "2px solid #fbbf24"
                  : "2px solid transparent",
              }}
            >
              <div
                style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  backgroundColor: player1Display.color,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: "bold",
                  fontSize: "12px",
                }}
              >
                {player1Display.initials}
              </div>
              <div>
                <div style={{ fontWeight: "600", fontSize: "14px" }}>
                  {player1Display.name}
                  {myPlayerNumberValue === 1 ? " (you)" : ""}
                </div>
                <div style={{ fontSize: "12px", color: "#94a3b8" }}>
                  {player1Display.status}
                </div>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                color: "#64748b",
                fontSize: "20px",
              }}
            >
              vs
            </div>

            {/* Player 2 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 16px",
                backgroundColor: player2Display.bgColor,
                borderRadius: "8px",
                border: myPlayerNumberValue === 2
                  ? "2px solid #fbbf24"
                  : "2px solid transparent",
              }}
            >
              <div
                style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  backgroundColor: player2Display.color,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: "bold",
                  fontSize: "12px",
                }}
              >
                {player2Display.initials}
              </div>
              <div>
                <div style={{ fontWeight: "600", fontSize: "14px" }}>
                  {player2Display.name}
                  {myPlayerNumberValue === 2 ? " (you)" : ""}
                </div>
                <div style={{ fontSize: "12px", color: "#94a3b8" }}>
                  {player2Display.status}
                </div>
              </div>
            </div>
          </div>

          {/* Last message from game state */}
          <div
            style={{
              textAlign: "center",
              marginTop: "16px",
              padding: "12px",
              backgroundColor: "#1e293b",
              borderRadius: "8px",
              fontSize: "14px",
              color: "#94a3b8",
            }}
          >
            {statusDisplay.lastMessage}
          </div>
        </div>
      ),
      myName: myNameValue,
      myPlayerNumber: myPlayerNumberValue,
      fireShot,
    };
  },
);

export default BattleshipRoom;
