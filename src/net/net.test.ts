import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import WebSocket from 'ws';
import { SaveManager } from '../persistence/SaveManager.js';
import { TableSession } from '../TableSession.js';
import type { TableView } from '../types.js';
import { WebServer } from '../web/WebServer.js';
import { LocalConnection, RemoteConnection, type TableConnection } from './connection.js';
import { HostServer } from './HostServer.js';

const dir = mkdtempSync(join(tmpdir(), 'poker-lan-test-'));
/** Everything opened by a test, closed even if an assertion fails so the process can exit. */
const cleanups: (() => void)[] = [];
after(() => {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      fn();
    } catch {
      /* already closed */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});
const track = <T extends { stop?: () => void; close?: () => void }>(x: T): T => {
  cleanups.push(() => (x.stop ?? x.close)!.call(x));
  return x;
};

function waitFor(conn: TableConnection, pred: (v: TableView) => boolean, ms = 30_000): Promise<TableView> {
  return new Promise((resolve, reject) => {
    if (conn.view && pred(conn.view)) return resolve(conn.view);
    const t = setTimeout(() => {
      conn.off('view', check);
      reject(new Error(`timed out; last view phase=${conn.view?.phase} hand=${conn.view?.handNumber}`));
    }, ms);
    const check = (v: TableView) => {
      if (!pred(v)) return;
      clearTimeout(t);
      conn.off('view', check);
      resolve(v);
    };
    conn.on('view', check);
  });
}

/** Keeps calling/checking for a seat whenever it's their turn. */
function autoPlay(conn: TableConnection): void {
  conn.on('view', (v) => {
    if (v.legal) conn.act(v.legal.canCheck ? { type: 'check' } : { type: 'call' });
  });
}

describe('LAN host ↔ client', () => {
  it('plays hands over the network, saves, and lets players reclaim seats on resume', async () => {
    const saves = new SaveManager(join(dir, 'saves'));
    const fast = { botThinkMs: [1, 3] as [number, number], nextHandDelayMs: 30 };
    const session = track(new TableSession({ mode: 'host', tableName: 'Test table', localName: 'Hosty', saves, ...fast }));
    const server = track(new HostServer(session));
    const port = await server.start(48_100);
    const host = new LocalConnection(session, session.localId);

    const alice = track(new RemoteConnection(`ws://127.0.0.1:${port}`, 'Alice'));
    await waitFor(alice, (v) => v.phase === 'lobby' && v.seats.length === 2);
    assert.equal(alice.view!.lobby!.isHost, false);

    // Duplicate names are refused.
    const dup = track(new RemoteConnection(`ws://127.0.0.1:${port}`, 'alice'));
    const refused = await new Promise<string>((r) => dup.on('error', r));
    assert.match(refused, /already at this table/);

    // Clients cannot run host commands.
    alice.command('start');
    const denied = await new Promise<string>((r) => alice.once('error', r));
    assert.match(denied, /Only the host/);

    autoPlay(host);
    autoPlay(alice);
    host.command('addBot');
    host.command('start');

    const v = await waitFor(alice, (x) => x.handNumber >= 3);
    const me = v.seats.find((s) => s.isYou)!;
    assert.equal(me.name, 'Alice');
    // Alice never sees opponents' hole cards before showdown.
    if (v.phase === 'playing') {
      for (const s of v.seats) if (!s.isYou) assert.ok(s.holeCards.every((c) => c === null));
    }

    alice.close();
    host.close();
    server.stop();
    session.stop();

    const [save] = saves.list();
    assert.ok(save, 'game was saved');
    assert.equal(save.snapshot.players.length, 3);
    const total = save.snapshot.players.reduce((s, p) => s + p.chips, 0);
    assert.equal(total, 3000);

    // Resume: Alice's seat is reserved until she rejoins by name.
    const resumed = track(new TableSession({ mode: 'host', tableName: save.tableName, localName: 'Hosty', saves, resume: save, ...fast }));
    const server2 = track(new HostServer(resumed));
    const port2 = await server2.start(48_200);
    const host2 = new LocalConnection(resumed, resumed.localId);
    assert.equal(resumed.canStart(), false);

    const alice2 = track(new RemoteConnection(`ws://127.0.0.1:${port2}`, 'Alice'));
    const lobby = await waitFor(alice2, (x) => x.seats.some((s) => s.isYou && !s.reserved));
    const savedAlice = save.snapshot.players.find((p) => p.name === 'Alice')!;
    assert.equal(lobby.seats.find((s) => s.isYou)!.chips, savedAlice.chips);
    assert.equal(resumed.canStart(), true);

    alice2.close();
    host2.close();
    server2.stop();
    resumed.stop();
  });
});

describe('WebServer', () => {
  it('serves the GUI and requires the URL token for the socket', async () => {
    const session = track(new TableSession({ mode: 'single', tableName: 'Web', localName: 'Me', bots: 1, botThinkMs: [1, 2] }));
    const conn = track(new LocalConnection(session, session.localId));
    const web = track(new WebServer(conn));
    const url = await web.start(48_300);

    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /CLI LAN Poker/);

    // Crowd cutouts are served; nothing outside that allow-list is.
    const origin = new URL(url).origin;
    const img = await fetch(`${origin}/people/face-01.webp`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/webp');
    for (const path of ['/people/CREDITS.md', '/people/../package.json', '/people/%2e%2e/package.json', '/package.json']) {
      assert.equal((await fetch(origin + path)).status, 404, path);
    }

    const wsUrl = url.replace('http', 'ws').replace('/?t=', '/ws?t=');
    const good = new WebSocket(wsUrl);
    const first = await new Promise<{ type: string }>((r) => good.once('message', (d) => r(JSON.parse(String(d)))));
    assert.ok(['status', 'view'].includes(first.type));

    const bad = new WebSocket(wsUrl.replace(/t=\w+/, 't=nope'));
    const code = await new Promise<number>((r) => bad.on('close', r));
    assert.equal(code, 4001);

    good.close();
    web.stop();
    conn.close();
    session.stop();
  });
});
