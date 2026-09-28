import type { Card } from '../engine/Card.js';
import { Deck, mathRng, type Rng } from '../engine/Deck.js';
import { HandCategory, evaluateHand } from '../engine/HandEvaluator.js';
import { preflopPercentile } from './ranges.js';

/** What we believe about one opponent's holding. */
export interface RangeModel {
  /** Opponent's hand is within the top `maxPercentile` of starting hands (1 = any two). */
  maxPercentile: number;
  /** Opponent has bet/raised after the flop — weights their range toward made hands. */
  aggressivePostflop: boolean;
}

const MAX_REJECTIONS = 40;

/**
 * Monte Carlo equity of `hole` against opponents drawn from their estimated ranges.
 * Returns the expected share of the pot in [0, 1] (ties count fractionally).
 */
export function estimateEquity(
  hole: Card[],
  board: Card[],
  opponents: RangeModel[],
  iterations = 800,
  rng: Rng = mathRng,
): number {
  if (opponents.length === 0) return 1;
  const base = new Deck().remove([...hole, ...board]).toArray();
  let share = 0;

  for (let iter = 0; iter < iterations; iter++) {
    const pool = base.slice();
    let n = pool.length;
    const draw = (): Card => {
      const i = rng(n);
      const c = pool[i]!;
      pool[i] = pool[--n]!;
      return c;
    };
    const putBack = (c: Card) => {
      pool[n++] = c;
    };

    const oppHands: Card[][] = [];
    for (const model of opponents) {
      let hand: Card[] = [];
      for (let attempt = 0; attempt <= MAX_REJECTIONS; attempt++) {
        hand = [draw(), draw()];
        if (attempt === MAX_REJECTIONS || fitsRange(hand, board, model, rng)) break;
        putBack(hand[1]!);
        putBack(hand[0]!);
      }
      oppHands.push(hand);
    }

    const fullBoard = board.slice();
    while (fullBoard.length < 5) fullBoard.push(draw());

    const heroScore = evaluateHand([...hole, ...fullBoard]).score;
    let best = true;
    let ties = 0;
    for (const hand of oppHands) {
      const s = evaluateHand([...hand, ...fullBoard]).score;
      if (s > heroScore) {
        best = false;
        break;
      }
      if (s === heroScore) ties++;
    }
    if (best) share += 1 / (ties + 1);
  }
  return share / iterations;
}

function fitsRange(hand: Card[], board: Card[], model: RangeModel, rng: Rng): boolean {
  if (preflopPercentile(hand[0]!, hand[1]!) > model.maxPercentile) return false;
  if (!model.aggressivePostflop || board.length < 3) return true;
  // Aggressors postflop mostly have something: let pure air through only a third of the time.
  const made = evaluateHand([...hand, ...board]).category > HandCategory.HighCard;
  return made || hasDraw(hand, board) || rng(3) === 0;
}

function hasDraw(hand: Card[], board: Card[]): boolean {
  const cards = [...hand, ...board];
  const suits = new Map<string, number>();
  for (const c of cards) suits.set(c.suit, (suits.get(c.suit) ?? 0) + 1);
  if ([...suits.values()].some((v) => v >= 4)) return true;
  let mask = 0;
  for (const c of cards) mask |= 1 << c.rank;
  if (mask & (1 << 14)) mask |= 2;
  for (let low = 1; low <= 11; low++) {
    let run = 0;
    for (let r = low; r < low + 5; r++) if (mask & (1 << r)) run++;
    if (run >= 4) return true;
  }
  return false;
}
