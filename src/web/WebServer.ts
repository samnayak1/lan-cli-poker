import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { PAGE_HTML, PEOPLE_WEBP } from '../generated/assets.js';
import type { TableConnection } from '../net/connection.js';
import { parseMessage, type ClientMessage } from '../net/protocol.js';
import type { TableView } from '../types.js';

// The page and images are compiled in (scripts/embed-assets.mjs), so nothing is read from disk:
// the same code works from npm and as a single standalone executable.

/** The crowd faces. Only these exact files are ever served — no path handling. */
function loadPeople(): Map<string, Buffer> {
  return new Map(Object.entries(PEOPLE_WEBP).map(([name, base64]) => [`/people/${name}`, Buffer.from(base64, 'base64')]));
}

/**
 * Localhost-only mirror of the terminal table: the browser sees the same view and can act
 * for the same seat. A random token in the URL keeps other local processes out.
 */
export class WebServer {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly token = randomBytes(12).toString('hex');
  url = '';

  private readonly push = (view: TableView) => this.broadcast({ type: 'view', view });
  private readonly pushError = (message: string) => this.broadcast({ type: 'error', message });
  private readonly pushStatus = (status: string) => this.broadcast({ type: 'status', status });

  constructor(private readonly conn: TableConnection) {}

  async start(preferredPort: number): Promise<string> {
    const page = PAGE_HTML;
    const people = loadPeople();
    for (let port = preferredPort; port < preferredPort + 20; port++) {
      try {
        await this.listen(port, page, people);
        this.url = `http://127.0.0.1:${port}/?t=${this.token}`;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      }
    }
    if (!this.url) throw new Error('No free port for the browser GUI');
    this.conn.on('view', this.push);
    this.conn.on('error', this.pushError);
    this.conn.on('status', this.pushStatus);
    return this.url;
  }

  private listen(port: number, page: string, people: Map<string, Buffer>): Promise<void> {
    return new Promise((resolve, reject) => {
      const http = createServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0];
        if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(page);
        } else if (req.method === 'GET' && people.has(path!)) {
          res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'max-age=86400' }).end(people.get(path!));
        } else {
          res.writeHead(404).end('Not found');
        }
      });
      http.once('error', reject);
      http.listen(port, '127.0.0.1', () => {
        http.off('error', reject);
        this.http = http;
        this.wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 16 * 1024 });
        this.wss.on('connection', (ws, req) => this.onConnection(ws, req.url ?? ''));
        resolve();
      });
    });
  }

  private onConnection(ws: WebSocket, url: string): void {
    const token = new URL(url, 'http://localhost').searchParams.get('t');
    if (token !== this.token) return void ws.close(4001, 'Bad token');

    ws.send(JSON.stringify({ type: 'status', status: this.conn.status }));
    if (this.conn.view) ws.send(JSON.stringify({ type: 'view', view: this.conn.view }));

    ws.on('message', (data) => {
      const msg = parseMessage<ClientMessage>(data);
      if (msg?.type === 'action') this.conn.act(msg.action);
      else if (msg?.type === 'command') this.conn.command(msg.command);
    });
  }

  private broadcast(msg: object): void {
    const data = JSON.stringify(msg);
    for (const ws of this.wss?.clients ?? []) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  stop(): void {
    this.conn.off('view', this.push);
    this.conn.off('error', this.pushError);
    this.conn.off('status', this.pushStatus);
    for (const ws of this.wss?.clients ?? []) ws.close(1001, 'Table closed');
    this.wss?.close();
    this.http?.close();
  }
}
