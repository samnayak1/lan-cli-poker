import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_BOTS, TableSession } from './TableSession.js';

describe('TableSession bot limit', () => {
  it('never seats more than MAX_BOTS bots', () => {
    const session = new TableSession({ mode: 'host', tableName: 't', localName: 'Host' });
    for (let i = 0; i < 7; i++) session.addBot();
    assert.equal(session.state.players.filter((p) => p.isBot).length, MAX_BOTS);
    assert.equal(MAX_BOTS, 4);
    session.stop();
  });

  it('closes saved seats beyond the limit when filling them with bots', () => {
    const first = new TableSession({ mode: 'host', tableName: 't', localName: 'Host' });
    for (let i = 0; i < 3; i++) first.addBot();
    for (const name of ['Ann', 'Ben', 'Cal']) first.join(name);
    const snapshot = first.state.toSnapshot();
    first.stop();

    const resumed = new TableSession({
      mode: 'host',
      tableName: 't',
      localName: 'Host',
      resume: { id: 'x', tableName: 't', createdAt: '', updatedAt: '', hostPlayerId: first.localId, snapshot },
    });
    resumed.fillReservedWithBots();
    const players = resumed.state.players;
    assert.equal(players.filter((p) => p.isBot).length, MAX_BOTS);
    assert.equal(players.length, 1 + MAX_BOTS);
    assert.equal(resumed.canStart(), true);
    resumed.stop();
  });
});
