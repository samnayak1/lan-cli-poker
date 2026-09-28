import { createServer, type Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import type { TableSession } from '../TableSession.js';
import { lanAddresses, startBeacon } from './discovery.js';
import { PROTOCOL_VERSION, parseMessage, type ClientMessage, type ServerMessage } from './protocol.js';

/** Serves a TableSession to other players on the LAN and advertises it. */
export class HostServer {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly seats = new Map<WebSocket, string>();
  private stopBeacon: (() => void) | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  port = 0;

  private readonly broadcast = () => {
    for (const [ws, id] of this.seats) send(ws, { type: 'view', view: this.session.viewFor(id) });
  };

  constructor(private readonly session: TableSession) {}

  /** Listens on the first free port from `preferredPort` upward. */
  async start(preferredPort: number): Promise<number> {
    for (let port = preferredPort; port < preferredPort + 20; port++) {
      try {
        await this.listen(port);
        this.port = port;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      }
    }
    if (!this.port) throw new Error(`No free port in ${preferredPort}-${preferredPort + 19}`);

    this.session.addresses = lanAddresses().map((a) => `${a}:${this.port}`);
    this.session.on('update', this.broadcast);
    this.stopBeacon = startBeacon(() => ({
      version: PROTOCOL_VERSION,
      tableName: this.session.tableName,
      port: this.port,
      players: this.session.state.players.length,
      maxPlayers: this.session.maxPlayers,
      inProgress: this.session.phase !== 'lobby',
    }));
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss?.clients ?? []) {
        const alive = ws as WebSocket & { isAlive?: boolean };
        if (alive.isAlive === false) {
          ws.terminate();
          continue;
        }
        alive.isAlive = false;
        ws.ping();
      }
    }, 10_000);
    return this.port;
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const http = createServer((_req, res) => {
        res.writeHead(426, { 'Content-Type': 'text/plain' }).end('poker-lan-cli game server — connect with `poker-lan` → Join');
      });
      http.once('error', reject);
      http.listen(port, '0.0.0.0', () => {
        http.off('error', reject);
        this.http = http;
        this.wss = new WebSocketServer({ server: http, maxPayload: 16 * 1024 });
        this.wss.on('connection', (ws) => this.onConnection(ws));
        resolve();
      });
    });
  }

  private onConnection(ws: WebSocket): void {
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => ((ws as WebSocket & { isAlive?: boolean }).isAlive = true));
    const helloTimeout = setTimeout(() => ws.close(), 5000);

    ws.on('message', (data) => {
      const msg = parseMessage<ClientMessage>(data);
      if (!msg) return;
      const playerId = this.seats.get(ws);

      if (!playerId) {
        if (msg.type !== 'hello') return;
        clearTimeout(helloTimeout);
        if (msg.version !== PROTOCOL_VERSION) {
          send(ws, { type: 'error', message: 'Version mismatch — update poker-lan-cli on both machines', fatal: true });
          return void ws.close();
        }
        const joined = this.session.join(String(msg.name ?? ''));
        if (!joined.ok) {
          send(ws, { type: 'error', message: joined.error, fatal: true });
          return void ws.close();
        }
        this.seats.set(ws, joined.playerId);
        send(ws, { type: 'welcome', playerId: joined.playerId });
        send(ws, { type: 'view', view: this.session.viewFor(joined.playerId) });
        return;
      }

      if (msg.type === 'action') {
        const err = this.session.act(playerId, msg.action);
        if (err) send(ws, { type: 'error', message: err });
      } else if (msg.type === 'command') {
        const err = this.session.command(playerId, msg.command);
        if (err) send(ws, { type: 'error', message: err });
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimeout);
      const playerId = this.seats.get(ws);
      this.seats.delete(ws);
      if (playerId && ![...this.seats.values()].includes(playerId)) this.session.disconnect(playerId);
    });
  }

  stop(): void {
    this.stopBeacon?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.session.off('update', this.broadcast);
    for (const ws of this.seats.keys()) ws.close(1001, 'Host closed the table');
    this.wss?.close();
    this.http?.close();
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
