import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import WebSocket from 'ws';
import { TableSession } from '../TableSession.js';
import { WebServer } from '../web/WebServer.js';
import { LocalConnection } from './connection.js';

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
});
const track = <T extends { stop?: () => void; close?: () => void }>(x: T): T => {
  cleanups.push(() => (x.stop ?? x.close)!.call(x));
  return x;
};

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
