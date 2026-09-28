import type { Card } from './Card.js';

export enum HandCategory {
  HighCard = 0,
  Pair,
  TwoPair,
  ThreeOfAKind,
  Straight,
  Flush,
  FullHouse,
  FourOfAKind,
  StraightFlush,
}

export interface HandResult {
  category: HandCategory;
  /** Totally ordered: higher score wins, equal score splits. */
  score: number;
  /** Ranks that define the hand, most significant first (length 5). */
  ranks: number[];
  name: string;
}

const RANK_NAMES = ['', '', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const plural = (r: number) => (r === 6 ? 'Sixes' : RANK_NAMES[r] + 's');
const single = (r: number) => RANK_NAMES[r]!;

/** Highest straight in a rank bitmask (bit n = rank n, ace also at bit 1), or 0. */
function straightHigh(mask: number): number {
  for (let high = 14; high >= 5; high--) {
    const run = 0b11111 << (high - 4);
    if ((mask & run) === run) return high;
  }
  return 0;
}

function encode(category: HandCategory, ranks: number[]): number {
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 16 + (ranks[i] ?? 0);
  return score;
}

/**
 * Evaluates the best 5-card hand from 5–7 cards without enumerating combinations.
 * Fast enough to run thousands of times per bot decision.
 */
export function evaluateHand(cards: readonly Card[]): HandResult {
  const counts = new Array<number>(15).fill(0);
  const suitCount: Record<string, number> = { c: 0, d: 0, h: 0, s: 0 };
  const suitMask: Record<string, number> = { c: 0, d: 0, h: 0, s: 0 };
  let mask = 0;

  for (const c of cards) {
    counts[c.rank]!++;
    suitCount[c.suit]!++;
    suitMask[c.suit]! |= 1 << c.rank;
    mask |= 1 << c.rank;
  }
  const withLowAce = (m: number) => (m & (1 << 14) ? m | 0b10 : m);

  let flushSuit: string | null = null;
  for (const s of ['c', 'd', 'h', 's']) if (suitCount[s]! >= 5) flushSuit = s;

  if (flushSuit) {
    const sf = straightHigh(withLowAce(suitMask[flushSuit]!));
    if (sf) {
      const ranks = [sf, sf - 1, sf - 2, sf - 3, sf === 5 ? 1 : sf - 4];
      return result(HandCategory.StraightFlush, ranks, sf === 14 ? 'Royal Flush' : `Straight Flush, ${single(sf)} high`);
    }
  }

  const quads: number[] = [];
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let r = 14; r >= 2; r--) {
    if (counts[r] === 4) quads.push(r);
    else if (counts[r] === 3) trips.push(r);
    else if (counts[r] === 2) pairs.push(r);
  }
  const kickers = (exclude: number[], n: number): number[] => {
    const out: number[] = [];
    for (let r = 14; r >= 2 && out.length < n; r--) {
      if (counts[r]! > 0 && !exclude.includes(r)) out.push(r);
    }
    return out;
  };

  if (quads.length) {
    const q = quads[0]!;
    return result(HandCategory.FourOfAKind, [q, q, q, q, ...kickers([q], 1)], `Four of a Kind, ${plural(q)}`);
  }

  if (trips.length && (trips.length > 1 || pairs.length)) {
    const t = trips[0]!;
    const p = Math.max(trips[1] ?? 0, pairs[0] ?? 0);
    return result(HandCategory.FullHouse, [t, t, t, p, p], `Full House, ${plural(t)} full of ${plural(p)}`);
  }

  if (flushSuit) {
    const ranks: number[] = [];
    for (let r = 14; r >= 2 && ranks.length < 5; r--) if (suitMask[flushSuit]! & (1 << r)) ranks.push(r);
    return result(HandCategory.Flush, ranks, `Flush, ${single(ranks[0]!)} high`);
  }

  const st = straightHigh(withLowAce(mask));
  if (st) {
    const ranks = [st, st - 1, st - 2, st - 3, st === 5 ? 1 : st - 4];
    return result(HandCategory.Straight, ranks, `Straight, ${single(st)} high`);
  }

  if (trips.length) {
    const t = trips[0]!;
    return result(HandCategory.ThreeOfAKind, [t, t, t, ...kickers([t], 2)], `Three of a Kind, ${plural(t)}`);
  }

  if (pairs.length >= 2) {
    const [a, b] = [pairs[0]!, pairs[1]!];
    return result(HandCategory.TwoPair, [a, a, b, b, ...kickers([a, b], 1)], `Two Pair, ${plural(a)} and ${plural(b)}`);
  }

  if (pairs.length === 1) {
    const p = pairs[0]!;
    return result(HandCategory.Pair, [p, p, ...kickers([p], 3)], `Pair of ${plural(p)}`);
  }

  const high = kickers([], 5);
  return result(HandCategory.HighCard, high, `High Card, ${single(high[0]!)}`);
}

function result(category: HandCategory, ranks: number[], name: string): HandResult {
  return { category, ranks, name, score: encode(category, ranks) };
}
