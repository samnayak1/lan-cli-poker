import open from 'open';
import { LocalConnection, RemoteConnection, type TableConnection } from './net/connection.js';
import { HostServer } from './net/HostServer.js';
import { DEFAULT_GAME_PORT } from './net/protocol.js';
import { SaveManager, type SaveFile } from './persistence/SaveManager.js';
import { TableSession } from './TableSession.js';
import { WebServer } from './web/WebServer.js';

export interface CliOptions {
  name?: string;
  /** Serve the browser GUI at all. */
  gui: boolean;
  /** Auto-open the GUI in the default browser. */
  browser: boolean;
  /** Host: WebSocket game port. */
  port: number;
  webPort: number;
}

export interface LaunchedTable {
  conn: TableConnection;
  guiUrl: string | null;
  stop(): void;
}

async function startGui(conn: TableConnection, opts: CliOptions): Promise<WebServer | null> {
  if (!opts.gui) return null;
  const web = new WebServer(conn);
  const url = await web.start(opts.webPort);
  if (opts.browser) open(url).catch(() => {});
  return web;
}

export async function launchSingle(name: string, opts: CliOptions): Promise<LaunchedTable> {
  const session = new TableSession({ mode: 'single', tableName: 'Single player', localName: name, bots: 4, nextHandDelayMs: 4000 });
  const conn = new LocalConnection(session, session.localId);
  const web = await startGui(conn, opts);
  session.start();
  return {
    conn,
    guiUrl: web?.url ?? null,
    stop() {
      web?.stop();
      conn.close();
      session.stop();
    },
  };
}

export async function launchHost(name: string, opts: CliOptions, resume?: SaveFile): Promise<LaunchedTable> {
  const session = new TableSession({
    mode: 'host',
    tableName: resume?.tableName ?? `${name}'s table`,
    localName: name,
    resume,
    saves: new SaveManager(),
    turnTimeoutMs: 60_000,
    nextHandDelayMs: 5000,
  });
  const server = new HostServer(session);
  try {
    await server.start(opts.port);
  } catch (err) {
    session.stop();
    throw err;
  }
  const conn = new LocalConnection(session, session.localId);
  const web = await startGui(conn, opts);
  return {
    conn,
    guiUrl: web?.url ?? null,
    stop() {
      server.stop();
      web?.stop();
      conn.close();
      session.stop(); // saves progress
    },
  };
}

/** `address` is "host" or "host:port". Resolves once seated, rejects if the host refuses. */
export async function launchJoin(name: string, address: string, opts: CliOptions): Promise<LaunchedTable> {
  const [host, port] = address.trim().split(':');
  const url = `ws://${host}:${Number(port) || DEFAULT_GAME_PORT}`;
  const conn = new RemoteConnection(url, name);

  await new Promise<void>((resolve, reject) => {
    let lastError = 'Connection closed';
    const onError = (msg: string) => (lastError = msg);
    const onStatus = (status: string) => {
      if (status === 'connected') done(resolve);
      else if (status === 'closed') done(() => reject(new Error(lastError)));
    };
    const done = (fn: () => void) => {
      conn.off('error', onError);
      conn.off('status', onStatus);
      fn();
    };
    conn.on('error', onError);
    conn.on('status', onStatus);
  });

  const web = await startGui(conn, opts);
  return {
    conn,
    guiUrl: web?.url ?? null,
    stop() {
      web?.stop();
      conn.close();
    },
  };
}
