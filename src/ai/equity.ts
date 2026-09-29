import type { Card } from '../engine/Card.js';
import { Deck, mathRng, type Rng } from '../engine/Deck.js';
import { HandCategory, evaluateHand } from '../engine/HandEvaluator.js';
import { preflopPercentile } from './ranges.js';

/*
 * Equity: the share of the pot we'd win on average if the hand were played out to the end.
 *
 * We can't see the opponents' cards, so we estimate it by simulation ("Monte Carlo"):
 *   1. Give each opponent a random hand that fits what we believe about them (their range).
 *   2. Deal the rest of the board at random.
 *   3. See who wins.
 * Repeat that hundreds of times and average the results.
 */

/** What we believe an opponent could be holding. */
export interface RangeModel {
  /** Their hand is in the top `maxPercentile` of starting hands (1 = any two cards). */
  maxPercentile: number;
  /** They've bet or raised since the flop, so they probably connected with the board. */
  aggressivePostflop: boolean;
}

/** How many random hands we try before accepting any hand for an opponent. */
const MAX_DEAL_ATTEMPTS = 40;

/** Someone betting after the flop with nothing (no pair, no draw) gets through 1 time in 3. */
const BLUFF_ODDS = 3;

/**
 * Our expected share of the pot, from 0 (never win) to 1 (always win).
 * A split pot counts as a fraction of a win.
 */
export function estimateEquity(
  hole: Card[],
  board: Card[],
  opponents: RangeModel[],
  iterations = 800,
  rng: Rng = mathRng,
): number {
  if (opponents.length === 0) return 1;

  const unseenCards = new Deck().remove([...hole, ...board]).toArray();
  let totalShare = 0;
  for (let i = 0; i < iterations; i++) {
    totalShare += playOutOnce(hole, board, opponents, unseenCards, rng);
  }
  return totalShare / iterations;
}

/** One random run-out. Returns our share of the pot: 1 = win, 0 = lose, 1/n = split n ways. */
function playOutOnce(hole: Card[], board: Card[], opponents: RangeModel[], unseenCards: Card[], rng: Rng): number {
  const deck = [...unseenCards];

  const opponentHands = opponents.map((range) => dealHandFromRange(deck, board, range, rng));

  const fullBoard = [...board];
  while (fullBoard.length < 5) fullBoard.push(takeRandomCard(deck, rng));

  const ourScore = evaluateHand([...hole, ...fullBoard]).score;
  const theirScores = opponentHands.map((hand) => evaluateHand([...hand, ...fullBoard]).score);
  const bestOpponent = Math.max(...theirScores);

  if (ourScore > bestOpponent) return 1;
  if (ourScore < bestOpponent) return 0;
  const tiedOpponents = theirScores.filter((score) => score === ourScore).length;
  return 1 / (tiedOpponents + 1);
}

/**
 * Deals two cards that fit the opponent's range: draw a random pair; if it doesn't fit,
 * put it back and try again. After MAX_DEAL_ATTEMPTS we accept whatever comes.
 */
function dealHandFromRange(deck: Card[], board: Card[], range: RangeModel, rng: Rng): Card[] {
  for (let attempt = 1; ; attempt++) {
    const hand = [takeRandomCard(deck, rng), takeRandomCard(deck, rng)];
    if (attempt >= MAX_DEAL_ATTEMPTS || handFitsRange(hand, board, range, rng)) return hand;
    deck.push(...hand);
  }
}

function takeRandomCard(deck: Card[], rng: Rng): Card {
  const index = rng(deck.length);
  return deck.splice(index, 1)[0]!;
}

/** Could this opponent, given how they've played, be holding `hand`? */
function handFitsRange(hand: Card[], board: Card[], range: RangeModel, rng: Rng): boolean {
  const strongEnoughPreflop = preflopPercentile(hand[0]!, hand[1]!) <= range.maxPercentile;
  if (!strongEnoughPreflop) return false;

  const flopIsOut = board.length >= 3;
  if (!range.aggressivePostflop || !flopIsOut) return true;

  // They've been betting since the flop: they usually have a pair or better, or a draw...
  if (hasMadeHand(hand, board) || hasFlushDraw(hand, board) || hasStraightDraw(hand, board)) return true;
  // ...but sometimes they're bluffing.
  return rng(BLUFF_ODDS) === 0;
}

/** At least a pair using the board. */
function hasMadeHand(hand: Card[], board: Card[]): boolean {
  return evaluateHand([...hand, ...board]).category > HandCategory.HighCard;
}

/** Four cards of one suit: one more makes a flush. */
function hasFlushDraw(hand: Card[], board: Card[]): boolean {
  const countBySuit = new Map<string, number>();
  for (const card of [...hand, ...board]) countBySuit.set(card.suit, (countBySuit.get(card.suit) ?? 0) + 1);
  return [...countBySuit.values()].some((count) => count >= 4);
}

/** Four of the five ranks of some straight: one more card makes it. */
function hasStraightDraw(hand: Card[], board: Card[]): boolean {
  const ranks = new Set([...hand, ...board].map((card) => card.rank));
  if (ranks.has(14)) ranks.add(1); // an ace also plays low, in A-2-3-4-5

  for (let lowest = 1; lowest <= 10; lowest++) {
    let ranksWeHave = 0;
    for (let rank = lowest; rank < lowest + 5; rank++) if (ranks.has(rank)) ranksWeHave++;
    if (ranksWeHave >= 4) return true;
  }
  return false;
}
