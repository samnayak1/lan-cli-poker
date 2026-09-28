import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Card } from './Card.js';
import { Game } from './Game.js';
import { GameState } from './GameState.js';
import { HandCategory, evaluateHand } from './HandEvaluator.js';
import { Player } from './Player.js';
import { buildPots } from './Pot.js';

const cards = (s: string) => s.split(' ').map(Card.fromCode);
const ev = (s: string) => evaluateHand(cards(s));

describe('evaluateHand', () => {
  const cases: [string, HandCategory, string][] = [
    ['As Ks Qs Js Ts 2d 3c', HandCategory.StraightFlush, 'Royal Flush'],
    ['5h 4h 3h 2h Ah Kd Kc', HandCategory.StraightFlush, 'Straight Flush, Five high'],
    ['9c 9d 9h 9s 2c 3d 4h', HandCategory.FourOfAKind, 'Four of a Kind, Nines'],
    ['Kc Kd Kh 7s 7c 2d 3h', HandCategory.FullHouse, 'Full House, Kings full of Sevens'],
    ['Kc Kd Kh 7s 7c 7d 3h', HandCategory.FullHouse, 'Full House, Kings full of Sevens'],
    ['2c 8c Tc Jc Kc Ad Ah', HandCategory.Flush, 'Flush, King high'],
    ['Ad 2c 3h 4s 5d Kc Qh', HandCategory.Straight, 'Straight, Five high'],
    ['6d 7c 8h 9s Td Jc 2h', HandCategory.Straight, 'Straight, Jack high'],
    ['Qc Qd Qh 2s 5c 8d Th', HandCategory.ThreeOfAKind, 'Three of a Kind, Queens'],
    ['Jc Jd 4h 4s 6c 6d Ah', HandCategory.TwoPair, 'Two Pair, Jacks and Sixes'],
    ['6c 6d 2h 9s Tc Kd Ah', HandCategory.Pair, 'Pair of Sixes'],
    ['2c 5d 7h 9s Jc Kd Ah', HandCategory.HighCard, 'High Card, Ace'],
  ];
  for (const [hand, category, name] of cases) {
    it(`${hand} → ${name}`, () => {
      const r = ev(hand);
      assert.equal(r.category, category);
      assert.equal(r.name, name);
    });
  }

  it('orders hands correctly', () => {
    assert.ok(ev('Ah Kd 9c 7s 2d').score > ev('Ah Qd Jc 9s 8d').score);
    assert.ok(ev('Ad 2c 3h 4s 5d').score < ev('2d 3c 4h 5s 6d').score); // wheel is lowest straight
    assert.ok(ev('Jc Jd 4h 4s Ac').score > ev('Jc Jd 4h 4s Kc').score); // kicker
    assert.equal(ev('As Kd Qc Js 9d').score, ev('Ac Kh Qd Jh 9s').score); // split
    // two pair kicker picks the best remaining card, including a third pair
    assert.deepEqual(ev('Kc Kd 8h 8s 5c 5d 2h').ranks, [13, 13, 8, 8, 5]);
  });
});

describe('buildPots', () => {
  it('creates side pots for short all-ins', () => {
    const pots = buildPots([
      { id: 'a', amount: 50, folded: false },
      { id: 'b', amount: 200, folded: false },
      { id: 'c', amount: 200, folded: false },
      { id: 'd', amount: 100, folded: true },
    ]);
    assert.deepEqual(pots, [
      { amount: 200, eligible: ['a', 'b', 'c'] },
      { amount: 350, eligible: ['b', 'c'] },
    ]);
  });
});

function makeGame(stacks: number[], seed = 1) {
  let x = seed;
  const rng = (max: number) => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x % max;
  };
  const state = new GameState({ smallBlind: 10, bigBlind: 20, startingChips: 1000, maxPlayers: 8 });
  state.players = stacks.map((chips, i) => new Player({ id: `p${i}`, name: `P${i}`, chips, kind: 'bot' }));
  return { game: new Game(state, rng), state, rng };
}

describe('Game', () => {
  it('posts blinds and gives action to UTG', () => {
    const { game, state } = makeGame([1000, 1000, 1000, 1000]);
    game.startHand();
    assert.equal(state.dealerIndex, 0);
    assert.equal(state.players[1]!.streetBet, 10);
    assert.equal(state.players[2]!.streetBet, 20);
    assert.equal(state.toAct!.id, 'p3');
  });

  it('heads-up: dealer posts small blind and acts first preflop', () => {
    const { game, state } = makeGame([1000, 1000]);
    game.startHand();
    assert.equal(state.smallBlindIndex, state.dealerIndex);
    assert.equal(state.toAct!.id, state.players[state.dealerIndex]!.id);
  });

  it('awards the pot when everyone folds', () => {
    const { game, state } = makeGame([1000, 1000, 1000]);
    game.startHand();
    game.act('p0', { type: 'fold' });
    game.act('p1', { type: 'fold' });
    assert.equal(state.handInProgress, false);
    assert.equal(state.players[2]!.chips, 1010);
  });

  it('gives big blind the option when limped to', () => {
    const { game, state } = makeGame([1000, 1000, 1000]);
    game.startHand();
    game.act('p0', { type: 'call' });
    game.act('p1', { type: 'call' });
    assert.equal(state.toAct!.id, 'p2');
    assert.equal(game.legalActions('p2')!.canCheck, true);
    game.act('p2', { type: 'check' });
    assert.equal(state.street, 'flop');
    assert.equal(state.board.length, 3);
  });

  it('runs out the board when all players are all-in', () => {
    const { game, state } = makeGame([500, 1000, 300]);
    game.startHand();
    game.act('p0', { type: 'allin' });
    game.act('p1', { type: 'allin' });
    game.act('p2', { type: 'allin' });
    assert.equal(state.handInProgress, false);
    assert.equal(state.lastHand!.board.length, 5);
    assert.equal(state.players.reduce((s, p) => s + p.chips, 0), 1800);
  });

  it('conserves chips over many random hands', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { game, state, rng } = makeGame([1000, 400, 1500, 250, 1000, 60], seed);
      const total = 4210;
      for (let hand = 0; hand < 60 && game.canStartHand(); hand++) {
        game.startHand();
        let guard = 0;
        while (state.handInProgress) {
          if (++guard > 200) throw new Error('hand did not terminate');
          const p = state.toAct!;
          const legal = game.legalActions(p.id)!;
          const roll = rng(10);
          if (roll < 2 && !legal.canCheck) game.act(p.id, { type: 'fold' });
          else if (roll < 5 && legal.canRaise) {
            const amount = legal.minRaiseTo + rng(legal.maxRaiseTo - legal.minRaiseTo + 1);
            game.act(p.id, { type: 'raise', amount });
          } else if (roll === 9) game.act(p.id, { type: 'allin' });
          else game.act(p.id, legal.canCheck ? { type: 'check' } : { type: 'call' });
          const inPlay = state.players.reduce((s, x) => s + x.chips + x.totalBet, 0);
          assert.equal(inPlay, total);
        }
        assert.equal(state.players.reduce((s, x) => s + x.chips, 0), total);
        assert.equal(state.players.every((x) => x.chips >= 0), true);
      }
    }
  });

  it('restores stacks from before the hand when snapshotted mid-hand', () => {
    const { game, state } = makeGame([1000, 1000, 1000]);
    game.startHand();
    game.act('p0', { type: 'raise', amount: 100 });
    const snap = state.toSnapshot();
    assert.deepEqual(snap.players.map((p) => p.chips), [1000, 1000, 1000]);
    assert.equal(snap.handNumber, 0);
  });
});
