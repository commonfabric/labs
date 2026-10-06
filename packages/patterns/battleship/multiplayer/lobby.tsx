/**
 * Battleship Multiplayer
 *
 * A single shared game surface. Shared match state is scoped to the space,
 * while each viewer's assigned player slot is scoped per user. The viewer's
 * name and avatar come from their shared profile
 * (`wish({ query: "#profile" })`): the wish's built-in UI lets them pick an
 * existing profile or create a new one, and joining snapshots the resolved
 * values into the shared player slot.
 */

import {
  computed,
  handler,
  hasError,
  NAME,
  pattern,
  type PerSession,
  resultOf,
  Stream,
  UI,
  type VNode,
  wish,
} from "commonfabric";

import BattleshipRoom from "./room.tsx";
import {
  createInitialShots,
  type GameState,
  type GameStateCell,
  generateRandomShips,
  getRandomColor,
  INITIAL_GAME_STATE,
  type LobbyState,
  normalizePlayerNumber,
  type PlayerCell,
  type PlayerData,
  type PlayerNameCell,
  type PlayerNumberCell,
  type ShotsCell,
  type ShotsState,
  trimmedName,
} from "./schemas.tsx";

export interface LobbyOutput {
  [UI]: PerSession<VNode>;
  gameName: string;
  player1: PlayerData | null;
  player2: PlayerData | null;
  shots: ShotsState;
  gameState: GameState;
  myName: string;
  myPlayerNumber: 1 | 2 | null;
  joinWithName: Stream<string>;
  joinPlayer1: Stream<{ name: string }>;
  joinPlayer2: Stream<{ name: string }>;
  reset: Stream<void>;
}

const startIfReady = (
  player1: PlayerCell,
  player2: PlayerCell,
  shots: ShotsCell,
  gameState: GameStateCell,
) => {
  const p1 = player1.get();
  const p2 = player2.get();
  if (!p1 || !p2) return;

  shots.set(createInitialShots());
  gameState.set({
    phase: "playing",
    currentTurn: 1,
    winner: null,
    lastMessage: `${p1.name}'s turn - fire at the enemy fleet!`,
  });
};

const joinSlot = (
  slot: 1 | 2,
  name: string,
  avatar: string,
  player1: PlayerCell,
  player2: PlayerCell,
  shots: ShotsCell,
  gameState: GameStateCell,
) => {
  const playerData: PlayerData = {
    name,
    avatar,
    ships: generateRandomShips(),
    color: getRandomColor(slot - 1),
    joinedAt: Date.now(),
  };

  if (slot === 1) {
    player1.set(playerData);
  } else {
    player2.set(playerData);
  }
  startIfReady(player1, player2, shots, gameState);
  return playerData;
};

const joinAvailableSlot = (
  name: string,
  avatar: string,
  myName: PlayerNameCell,
  myPlayerNumber: PlayerNumberCell,
  player1: PlayerCell,
  player2: PlayerCell,
  shots: ShotsCell,
  gameState: GameStateCell,
) => {
  const existingSlot = normalizePlayerNumber(myPlayerNumber.get());
  if (existingSlot !== null) {
    const slotPlayer = existingSlot === 1 ? player1.get() : player2.get();
    if (slotPlayer && slotPlayer.name === trimmedName(myName.get())) {
      return false;
    }
    myName.set("");
    myPlayerNumber.set(null);
  }

  const slot = !player1.get() ? 1 : !player2.get() ? 2 : null;
  if (slot === null) return false;

  joinSlot(slot, name, avatar, player1, player2, shots, gameState);
  myName.set(name);
  myPlayerNumber.set(slot);
  return true;
};

// Join with the viewer's resolved profile. `name`/`avatar` arrive as plain
// strings (named `computed` values auto-unwrap as handler state).
const joinGame = handler<
  void,
  {
    name: string;
    avatar: string;
    myName: PlayerNameCell;
    myPlayerNumber: PlayerNumberCell;
    player1: PlayerCell;
    player2: PlayerCell;
    shots: ShotsCell;
    gameState: GameStateCell;
  }
>((
  _event,
  { name, avatar, myName, myPlayerNumber, player1, player2, shots, gameState },
) => {
  const trimmed = trimmedName(name);
  if (!trimmed) return; // No resolved profile name yet.

  joinAvailableSlot(
    trimmed,
    (avatar ?? "").trim(),
    myName,
    myPlayerNumber,
    player1,
    player2,
    shots,
    gameState,
  );
});

const joinWithName = handler<
  string,
  {
    myName: PlayerNameCell;
    myPlayerNumber: PlayerNumberCell;
    player1: PlayerCell;
    player2: PlayerCell;
    shots: ShotsCell;
    gameState: GameStateCell;
  }
>((
  name,
  { myName, myPlayerNumber, player1, player2, shots, gameState },
) => {
  const trimmed = trimmedName(name);
  if (!trimmed) return;
  joinAvailableSlot(
    trimmed,
    "",
    myName,
    myPlayerNumber,
    player1,
    player2,
    shots,
    gameState,
  );
});

const joinPlayer = handler<
  { name: string },
  {
    slot: 1 | 2;
    player1: PlayerCell;
    player2: PlayerCell;
    shots: ShotsCell;
    gameState: GameStateCell;
  }
>(({ name }, { slot, player1, player2, shots, gameState }) => {
  const trimmed = trimmedName(name);
  if (!trimmed) return;
  joinSlot(slot, trimmed, "", player1, player2, shots, gameState);
});

const resetGame = handler<
  void,
  {
    player1: PlayerCell;
    player2: PlayerCell;
    shots: ShotsCell;
    gameState: GameStateCell;
    myName: PlayerNameCell;
    myPlayerNumber: PlayerNumberCell;
  }
>((
  _event,
  { player1, player2, shots, gameState, myName, myPlayerNumber },
) => {
  player1.set(null);
  player2.set(null);
  shots.set(createInitialShots());
  gameState.set(INITIAL_GAME_STATE);
  myName.set("");
  myPlayerNumber.set(null);
});

const BattleshipLobby = pattern<LobbyState, LobbyOutput>(
  (
    {
      gameName,
      player1,
      player2,
      shots,
      gameState,
      myName,
      myPlayerNumber,
    },
  ) => {
    // Resolve THIS viewer's shared profile. The `#profile` wish's built-in UI
    // covers the whole lifecycle: a create surface when the viewer has no
    // profile, a link when they have one, and a picker (with inline create)
    // when they have several. The field targets give the snapshot strings.
    const profileWish = wish<{ name?: string; avatar?: string }>({
      query: "#profile",
    });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });

    const profileName = hasError(profileNameWish.result)
      ? ""
      : resultOf(profileNameWish.result);
    const profileAvatar = hasError(profileAvatarWish.result)
      ? ""
      : resultOf(profileAvatarWish.result);
    const hasProfile = computed(() => profileName.trim() !== "");
    const joinLabel = computed(() =>
      hasProfile ? `Join as ${profileName}` : "Create a profile to join"
    );

    const sharedCells = { player1, player2, shots, gameState };
    const join = joinGame({
      name: profileName,
      avatar: profileAvatar,
      myName,
      myPlayerNumber,
      ...sharedCells,
    });
    const joinWithNameStream = joinWithName({
      myName,
      myPlayerNumber,
      ...sharedCells,
    });
    const joinPlayer1 = joinPlayer({
      slot: 1,
      ...sharedCells,
    });
    const joinPlayer2 = joinPlayer({
      slot: 2,
      ...sharedCells,
    });
    const reset = resetGame({
      ...sharedCells,
      myName,
      myPlayerNumber,
    });

    const room = BattleshipRoom({
      gameName,
      ...sharedCells,
      myName,
      myPlayerNumber,
    });

    const player1Data = computed(() => player1.get());
    const player2Data = computed(() => player2.get());
    const joined = computed(() => {
      const slot = normalizePlayerNumber(myPlayerNumber.get());
      if (slot === null) return false;
      const player = slot === 1 ? player1.get() : player2.get();
      return !!player && player.name === trimmedName(myName.get());
    });
    const isFull = computed(() => !!player1.get() && !!player2.get());
    const waitingLabel = computed(() => {
      const p1 = player1.get();
      const p2 = player2.get();
      if (p1 && p2) return "Both fleets are deployed.";
      if (p1) return "Waiting for a second captain.";
      return "Join to deploy the first fleet.";
    });

    return {
      [NAME]: computed(() => `${gameName} - Battleship`),
      [UI]: (
        <div
          style={{
            minHeight: "100vh",
            backgroundColor: "#0f172a",
            color: "#e2e8f0",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          {joined ? room[UI] : (
            <div
              style={{
                minHeight: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "32px",
              }}
            >
              <section
                style={{
                  width: "min(520px, 100%)",
                  border: "1px solid #334155",
                  borderRadius: "8px",
                  backgroundColor: "#162033",
                  padding: "24px",
                }}
              >
                <h1 style={{ margin: "0 0 8px", fontSize: "32px" }}>
                  BATTLESHIP
                </h1>
                <p style={{ margin: "0 0 20px", color: "#94a3b8" }}>
                  {waitingLabel}
                </p>

                <div
                  style={{
                    display: "grid",
                    gap: "10px",
                    marginBottom: "20px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <cf-avatar
                      src={player1Data?.avatar}
                      name={player1Data?.name ?? "?"}
                      size="xs"
                    />
                    Player 1: {String(player1Data?.name ?? "Open")}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <cf-avatar
                      src={player2Data?.avatar}
                      name={player2Data?.name ?? "?"}
                      size="xs"
                    />
                    Player 2: {String(player2Data?.name ?? "Open")}
                  </div>
                </div>

                {isFull
                  ? (
                    <div style={{ color: "#fbbf24", marginBottom: "16px" }}>
                      This game already has two players.
                    </div>
                  )
                  : (
                    <div
                      style={{
                        display: "grid",
                        gap: "10px",
                      }}
                    >
                      {
                        /* Built-in profile UI: create a profile when there is
                          none, pick between existing profiles otherwise. */
                      }
                      <div>{profileWish[UI]}</div>
                      <cf-button
                        onClick={join}
                        disabled={computed(() => !hasProfile)}
                      >
                        {joinLabel}
                      </cf-button>
                    </div>
                  )}

                <cf-button
                  variant="secondary"
                  style="margin-top: 20px;"
                  onClick={reset}
                >
                  Reset game
                </cf-button>
              </section>
            </div>
          )}
        </div>
      ),
      gameName,
      player1: player1Data,
      player2: player2Data,
      shots: computed(() => shots.get()),
      gameState: computed(() => gameState.get()),
      // Normalize like myPlayerNumber below: an unwritten PerUser cell reads
      // as undefined in runtimes that didn't create the instance, and a
      // computed that RETURNS undefined is indistinguishable from "not yet
      // computed" for cross-runtime readers.
      myName: computed(() => trimmedName(myName.get())),
      myPlayerNumber: computed(() =>
        normalizePlayerNumber(myPlayerNumber.get())
      ),
      joinWithName: joinWithNameStream,
      joinPlayer1,
      joinPlayer2,
      reset,
    };
  },
);

export default BattleshipLobby;
