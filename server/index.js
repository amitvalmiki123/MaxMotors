import express from 'express';
import { createServer } from 'node:http';
import { Room, Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';

class EmptyRoom extends Room {
  onCreate() {
    // M1 keeps multiplayer gameplay local-only; the room is a connection-ready M3 placeholder.
    this.maxClients = 8;
  }
}

const app = express();
app.disable('x-powered-by');
app.get('/health', (_request, response) => {
  response.status(200).json({ ok: true, service: 'maxmotors-server', milestone: 'm1' });
});

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});
gameServer.define('lobby', EmptyRoom);

const port = Number(process.env.PORT || 2567);
await gameServer.listen(port, '0.0.0.0');
console.log(`MaxMotors Colyseus server listening on 0.0.0.0:${port}`);
