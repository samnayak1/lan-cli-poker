import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Card } from '../engine/Card.js';
import { Game } from '../engine/Game.js';
import { GameState } from '../engine/GameState.js';
import { Player } from '../engine/Player.js';
import type { ActionRecord } from '../engine/GameState.js';
import { Bot } from './Bot.js';
import { OpponentTracker } from './OpponentTracker.js';
import { OPEN, parseRange, rangeShare } from './preflopCharts.js';
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

describe('preflop charts', () => {
  it('reads range notation', () => {
    assert.deepEqual([...parseRange('TT+').keys()], ['TT', 'JJ', 'QQ', 'KK', 'AA']);
    assert.deepEqual([...parseRange('22-44').keys()], ['22', '33', '44']);
    assert.deepEqual([...parseRange('K9s+').keys()], ['K9s', 'KTs', 'KJs', 'KQs']);
    assert.deepEqual([...parseRange('K9s-K7s').keys()], ['K7s', 'K8s', 'K9s']);
    assert.equal(parseRange('A5s:0.5, KQo').get('A5s'), 0.5);
    assert.equal(parseRange('A5s:0.5, KQo').get('KQo'), 1);
    assert.throws(() => parseRange('A5x'));
  });

  it('opens wider the later the seat', () => {
    const share = (seat: keyof typeof OPEN) => rangeShare(OPEN[seat]);
    assert.ok(share('UTG') > 0.15 && share('UTG') < 0.22, `UTG ${share('UTG')}`);
    assert.ok(share('UTG') < share('HJ') && share('HJ') < share('CO') && share('CO') < share('BTN'));
    assert.ok(share('BTN') > 0.4 && share('BTN') < 0.5, `BTN ${share('BTN')}`);
  });
});

describe('OpponentTracker', () => {
  it('learns preflop and postflop habits', () => {
    const tracker = new OpponentTracker();
    const hand: ActionRecord[] = [
      { playerId: 'a', street: 'preflop', kind: 'raise', amount: 50 }, // a opens
      { playerId: 'b', street: 'preflop', kind: 'raise', amount: 150 }, // b 3-bets
      { playerId: 'c', street: 'preflop', kind: 'fold', amount: 0 }, // c faced two raises: not "facing an open"
      { playerId: 'a', street: 'preflop', kind: 'call', amount: 100 },
      { playerId: 'a', street: 'flop', kind: 'check', amount: 0 },
      { playerId: 'b', street: 'flop', kind: 'bet', amount: 100 },
      { playerId: 'a', street: 'flop', kind: 'fold', amount: 0 }, // a folds to a bet
    ];
    for (let i = 0; i < 40; i++) tracker.recordHand(['a', 'b', 'c'], hand);
    const a = tracker.profile('a');
    const b = tracker.profile('b');
    assert.ok(a.pfr > 0.8 && b.pfr > 0.8, 'both raised every hand');
    assert.ok(b.threeBet > 0.7, `b 3-bets: ${b.threeBet}`);
    assert.ok(a.foldToBet > 0.7, `a folds to bets: ${a.foldToBet}`);
    assert.ok(b.aggression > 0.7, `b is aggressive: ${b.aggression}`);
    assert.ok(tracker.profile('c').vpip < 0.1, 'c never played');
    assert.equal(tracker.profile('nobody').vpip, 0.25, 'strangers look typical');
  });
});

/** A seeded random source, so the bot's mixed choices are repeatable in tests. */
function seeded(seed: number) {
  let x = seed;
  return (max: number) => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x % max;
  };
}

describe('Bot', () => {
  it('plays full games with only legal actions', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const state = new GameState({ smallBlind: 10, bigBlind: 20, startingChips: 500, maxPlayers: 8 });
      state.players = [0, 1, 2, 3, 4].map((i) => new Player({ id: `b${i}`, name: `B${i}`, chips: 500, kind: 'bot' }));
      const game = new Game(state, seeded(seed));
      const tracker = new OpponentTracker();
      const bots = new Map(state.players.map((p) => [p.id, new Bot(tracker, seeded(seed * 7), 60)]));
      for (let hand = 0; hand < 40 && game.canStartHand(); hand++) {
        game.startHand();
        while (state.handInProgress) {
          const p = state.toAct!;
          game.act(p.id, bots.get(p.id)!.decide(game, p)); // throws on an illegal action
        }
        tracker.recordHand(state.players.filter((p) => p.holeCards.length).map((p) => p.id), state.handActions);
      }
      assert.equal(state.players.reduce((s, p) => s + p.chips, 0), 2500);
    }
  });

  it('bluffs more against players who fold too much than against ones who call everything', () => {
    // Heads-up on the flop; the bot is first to act with nothing (no pair, no draw).
    const setUp = () => {
      const state = new GameState({ smallBlind: 10, bigBlind: 20, startingChips: 1000, maxPlayers: 8 });
      state.players = [
        new Player({ id: 'villain', name: 'V', chips: 1000, kind: 'human' }),
        new Player({ id: 'bot', name: 'B', chips: 1000, kind: 'bot' }),
      ];
      const game = new Game(state, seeded(3));
      game.startHand(); // villain deals, so the bot (big blind) acts first after the flop
      game.act('villain', { type: 'call' });
      game.act('bot', { type: 'check' });
      state.players[0]!.holeCards = cards('Ah Ad');
      state.players[1]!.holeCards = cards('7c 2d');
      state.board = cards('Ks Qh 9s');
      return { game, bot: state.players[1]! };
    };
    const betRate = (foldsToBets: boolean) => {
      const tracker = new OpponentTracker();
      const reply = foldsToBets ? 'fold' : 'call';
      for (let i = 0; i < 60; i++) {
        tracker.recordHand(['villain', 'bot'], [
          { playerId: 'bot', street: 'flop', kind: 'bet', amount: 20 },
          { playerId: 'villain', street: 'flop', kind: reply, amount: 0 },
        ]);
      }
      const { game, bot } = setUp();
      const brain = new Bot(tracker, seeded(11), 60);
      let bets = 0;
      for (let i = 0; i < 400; i++) if (brain.decide(game, bot).type === 'raise') bets++;
      return bets / 400;
    };
    const vsFolder = betRate(true);
    const vsCaller = betRate(false);
    assert.ok(vsFolder > vsCaller * 2, `bluffs vs folder ${vsFolder}, vs caller ${vsCaller}`);
  });
});
