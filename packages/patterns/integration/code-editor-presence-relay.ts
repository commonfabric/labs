/** Disposable co-presence relay for browser integration tests. */

type RelayRecord = {
  participantId: string;
  revision: number;
  name: string;
  focused: boolean;
  cursor: { epoch: number; version: number };
  selection: unknown;
  basis: "provisional" | "confirmed";
};

type RelayClient = {
  participantId: string;
  latest?: RelayRecord;
};

export type PresenceRelay = {
  url: string;
  close(): Promise<void>;
};

export function startPresenceRelay(): PresenceRelay {
  const rooms = new Map<string, Map<WebSocket, RelayClient>>();
  const broadcast = (
    room: Map<WebSocket, RelayClient>,
    message: unknown,
    exclude?: WebSocket,
  ) => {
    const encoded = JSON.stringify(message);
    for (const socket of room.keys()) {
      if (socket !== exclude && socket.readyState === WebSocket.OPEN) {
        socket.send(encoded);
      }
    }
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/v1\/rooms\/([^/]+)$/);
      if (!match) return new Response("Not found", { status: 404 });

      const roomId = decodeURIComponent(match[1]);
      const room = rooms.get(roomId) ?? new Map<WebSocket, RelayClient>();
      rooms.set(roomId, room);
      const { socket, response } = Deno.upgradeWebSocket(request);
      const client: RelayClient = { participantId: crypto.randomUUID() };
      room.set(socket, client);

      const remove = () => {
        if (!room.delete(socket)) return;
        if (client.latest) {
          broadcast(room, {
            v: 1,
            type: "participant.remove",
            participantId: client.participantId,
          });
        }
        if (room.size === 0) rooms.delete(roomId);
      };
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          v: 1,
          type: "room.snapshot",
          selfParticipantId: client.participantId,
          participants: [...room.entries()].flatMap(([peer, state]) =>
            peer !== socket && state.latest ? [state.latest] : []
          ),
        }));
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          v: number;
          type: string;
          revision: number;
          name: string;
          focused: boolean;
          cursor: { epoch: number; version: number };
          selection: unknown;
          basis: "provisional" | "confirmed";
        };
        if (message.v !== 1 || message.type !== "participant.upsert") {
          socket.close(1002, "invalid_message");
          return;
        }
        client.latest = {
          participantId: client.participantId,
          revision: message.revision,
          name: message.name,
          focused: message.focused,
          cursor: message.cursor,
          selection: message.selection,
          basis: message.basis,
        };
        broadcast(room, {
          v: 1,
          type: "participant.upsert",
          ...client.latest,
        }, socket);
      });
      socket.addEventListener("close", remove);
      socket.addEventListener("error", remove);
      return response;
    },
  );
  const address = server.addr as Deno.NetAddr;
  return {
    url: `ws://${address.hostname}:${address.port}`,
    async close() {
      for (const room of rooms.values()) {
        for (const socket of room.keys()) socket.close(1001, "test ended");
      }
      await server.shutdown();
    },
  };
}
