import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Card } from '../engine/Card.js';
import { Game } from '../engine/Game.js';
import { GameState } from '../engine/GameState.js';
import { Player } from '../engine/Player.js';
import { Bot, PERSONALITIES } from './Bot.js';
import { estimateEquity } from './equity.js';
import { handClass, preflopPercentile } from './ranges.js';

const cards = (s: string) => s.split(' ').map(Card.fromCode);
const any = { maxPercentile: 1, aggressivePostflop: false };

describe('ranges', () => {
  it('classifies and ranks starting hands', () => {
    const [a, k] = cards('As Ks');
    assert.equal(handClass(a!, k!), 'AKs');
    const aa = preflopPercentile(...(cards('Ah Ad') as [Card, Card]));
    const aks = preflopPercentile(a!, k!);
    const trash = preflopPercentile(...(cards('7c 2d') as [Card, Card]));
    assert.ok(aa < aks && aks < 0.05, `AA ${aa}, AKs ${aks}`);
    assert.ok(trash > 0.9, `72o ${trash}`);
  });
});

describe('estimateEquity', () => {
  it('AA is about 85% vs a random hand', () => {
    const eq = estimateEquity(cards('Ah Ad'), [], [any], 4000);
    assert.ok(eq > 0.81 && eq < 0.89, `got ${eq}`);
  });

  it('a made nut flush on the river is nearly unbeatable', () => {
    const eq = estimateEquity(cards('Ah 2h'), cards('Kh 9h 4h Jc 3s'), [any, any], 1000);
    assert.ok(eq > 0.95, `got ${eq}`);
  });

  it('a tight range lowers equity of a medium hand', () => {
    const vsAny = estimateEquity(cards('Tc 9c'), [], [any], 3000);
    const vsTight = estimateEquity(cards('Tc 9c'), [], [{ maxPercentile: 0.05, aggressivePostflop: false }], 3000);
    assert.ok(vsTight < vsAny - 0.1, `any ${vsAny}, tight ${vsTight}`);
  });
});

describe('Bot', () => {
  it('plays full games with only legal actions', () => {
    for (const personality of Object.keys(PERSONALITIES)) {
      const state = new GameState({ smallBlind: 10, bigBlind: 20, startingChips: 500, maxPlayers: 8 });
      state.players = ['tag', 'lag', 'rock', 'station', personality].map(
        (p, i) => new Player({ id: `b${i}`, name: `B${i}`, chips: 500, kind: 'bot', personality: p }),
      );
      const game = new Game(state);
      const bots = new Map(state.players.map((p) => [p.id, new Bot(p.personality!, undefined, 60)]));
      for (let hand = 0; hand < 40 && game.canStartHand(); hand++) {
        game.startHand();
        while (state.handInProgress) {
          const p = state.toAct!;
          game.act(p.id, bots.get(p.id)!.decide(game, p)); // throws on an illegal action
        }
      }
      assert.equal(state.players.reduce((s, p) => s + p.chips, 0), 2500);
    }
  });
});
