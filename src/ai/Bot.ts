import { mathRng, type Rng } from '../engine/Deck.js';
import type { Game } from '../engine/Game.js';
import type { ActionRecord } from '../engine/GameState.js';
import type { Player } from '../engine/Player.js';
import type { LegalActions, PlayerAction } from '../types.js';
import { estimateEquity, type RangeModel } from './equity.js';
import { preflopPercentile } from './ranges.js';

/*
 * How a bot decides, in plain terms:
 *
 *   1. Guess each opponent's range: which hands they could have, given how they've bet.
 *   2. Work out our equity: how often we'd win against those ranges (see equity.ts).
 *   3. Work out the pot odds: how much of the final pot we have to put in to call.
 *   4. Before the flop, mostly play by starting-hand ranges; after it, compare equity with
 *      pot odds: call when the price is right, bet or raise when we're well ahead.
 *
 * A personality sets how loose, aggressive and bluff-happy each bot is.
 */

export interface Personality {
  label: string;
  /** Share of starting hands the bot plays at all ("voluntarily put money in pot"). */
  vpip: number;
  /** Share of starting hands the bot opens with a raise ("pre-flop raise"). */
  pfr: number;
  /** Chance to bet or raise with a strong hand, rather than just checking or calling. */
  aggression: number;
  /** Chance to bet with a weak hand when nobody has bet yet. */
  bluff: number;
  /** Extra equity the bot wants on top of the pot odds before calling (negative = calls too much). */
  callMargin: number;
}

export const PERSONALITIES: Record<string, Personality> = {
  tag: { label: 'Tight-Aggressive', vpip: 0.22, pfr: 0.16, aggression: 0.75, bluff: 0.1, callMargin: 0.03 },
  lag: { label: 'Loose-Aggressive', vpip: 0.38, pfr: 0.26, aggression: 0.85, bluff: 0.2, callMargin: 0 },
  rock: { label: 'Tight-Passive', vpip: 0.15, pfr: 0.07, aggression: 0.35, bluff: 0.03, callMargin: 0.06 },
  station: { label: 'Calling Station', vpip: 0.5, pfr: 0.08, aggression: 0.3, bluff: 0.05, callMargin: -0.07 },
};

export const BOT_ROSTER: { name: string; personality: string }[] = [
  { name: 'Martin', personality: 'tag' },
  { name: 'Ablett', personality: 'lag' },
  { name: 'Ashcroft', personality: 'rock' },
  { name: 'Franklin', personality: 'station' },
  { name: 'Selwood', personality: 'tag' },
  { name: 'Bontempelli', personality: 'lag' },
  { name: 'Daicos', personality: 'rock' },
];

// ── Tuning ───────────────────────────────────────────────────────────────

/** Opening raise: 2.5–3.5 big blinds, plus one big blind for every player who just called. */
const OPEN_RAISE_BIG_BLINDS = 2.5;

/** When re-raising before the flop, raise to this many times the current bet. */
const RERAISE_MULTIPLIER = 3;

/** Hands this strong (top 3%) are always worth continuing with before the flop. */
const PREMIUM_HAND = 0.03;

/** After the flop: bet for value with this much more equity than an even share of the pot... */
const VALUE_BET_EDGE = 0.12;
/** ...and raise with this much more. */
const RAISE_EDGE = 0.28;

/** Going all in once a raise would put at least this share of our stack in anyway. */
const COMMIT_THRESHOLD = 0.6;

/** Position: late seats can play more hands, early seats should play fewer. */
const LATE_POSITION_LOOSENESS = 1.3;
const EARLY_POSITION_LOOSENESS = 0.8;

/** What an opponent's betting tells us about their range (share of starting hands). */
const RANGE_IF_THEY = {
  openRaised: 0.2,
  reRaised: 0.07,
  limped: 0.5,
  calledARaise: 0.3,
};
/** Each bet or raise after the flop narrows the range to this fraction; each call to this. */
const NARROWING_PER_POSTFLOP_BET = 0.75;
const NARROWING_PER_POSTFLOP_CALL = 0.9;
/** We never assume a range tighter than this. */
const TIGHTEST_RANGE = 0.04;

// ── Small helpers ────────────────────────────────────────────────────────

const checkOrCall = (legal: LegalActions): PlayerAction => (legal.canCheck ? { type: 'check' } : { type: 'call' });
const checkOrFold = (legal: LegalActions): PlayerAction => (legal.canCheck ? { type: 'check' } : { type: 'fold' });

/** Of the final pot if we call, the share we'd be putting in. We need at least this much equity. */
function potOdds(pot: number, toCall: number): number {
  return toCall > 0 ? toCall / (pot + toCall) : 0;
}

/** Everything a decision needs, worked out once. */
interface Situation {
  game: Game;
  me: Player;
  legal: LegalActions;
  /** Our chance of winning against the opponents' guessed ranges (0–1). */
  equity: number;
  /** Equity needed to call profitably (0–1). */
  potOdds: number;
  opponentsInHand: number;
}

/**
 * Decides actions from what a real player could see: its own cards, the board, the pot,
 * and how the opponents have bet this hand.
 */
export class Bot {
  private readonly style: Personality;

  constructor(
    personality: string,
    private readonly rng: Rng = mathRng,
    private readonly iterations = 700,
  ) {
    this.style = PERSONALITIES[personality] ?? PERSONALITIES.tag!;
  }

  decide(game: Game, me: Player): PlayerAction {
    const legal = game.legalActions(me.id);
    if (!legal) throw new Error(`${me.name} asked to act out of turn`);
    const table = game.state;

    // 1. Guess what each opponent still in the hand could be holding.
    const opponents = table.players.filter((p) => p !== me && p.inHand);
    const opponentRanges = opponents.map((opponent) => guessRange(table.handActions, opponent));

    // 2 & 3. How often we'd win against those hands, and what the pot is offering us.
    const situation: Situation = {
      game,
      me,
      legal,
      equity: estimateEquity(me.holeCards, table.board, opponentRanges, this.iterations, this.rng),
      potOdds: potOdds(table.pot, legal.callAmount),
      opponentsInHand: opponents.length,
    };

    // 4. Choose.
    return table.street === 'preflop' ? this.playPreflop(situation) : this.playPostflop(situation);
  }

  // ── Before the flop: mostly starting-hand ranges ──────────────────────

  private playPreflop({ game, me, legal, equity, potOdds }: Situation): PlayerAction {
    const table = game.state;
    const bigBlind = table.config.bigBlind;
    const { vpip, pfr, callMargin } = this.style;

    const handPercentile = preflopPercentile(me.holeCards[0]!, me.holeCards[1]!); // 0.05 = a top-5% hand
    const looseness = this.positionLooseness(game, me);
    const preflopActions = table.handActions.filter((a) => a.street === 'preflop');
    const raisesSoFar = preflopActions.filter((a) => a.kind === 'raise').length;
    const callersSoFar = preflopActions.filter((a) => a.kind === 'call').length;

    // Nobody has raised: raise with our best hands, just call with playable ones, fold the rest.
    if (raisesSoFar === 0) {
      const inRaisingRange = handPercentile <= pfr * looseness;
      const inPlayingRange = handPercentile <= vpip * looseness;
      if (inRaisingRange && legal.canRaise) {
        const size = bigBlind * (OPEN_RAISE_BIG_BLINDS + this.rng(3) * 0.5) + callersSoFar * bigBlind;
        return this.raiseTo(legal, size);
      }
      return inPlayingRange ? checkOrCall(legal) : checkOrFold(legal);
    }

    // Someone raised: re-raise with the very top of our range...
    const reRaiseRange = pfr * (raisesSoFar === 1 ? 0.3 : 0.1);
    if (handPercentile <= reRaiseRange && legal.canRaise) {
      return this.raiseTo(legal, table.currentBet * RERAISE_MULTIPLIER);
    }

    // ...otherwise call only with a hand worth continuing with, at a fair price.
    const continueRange = vpip * (raisesSoFar === 1 ? 0.7 : 0.35);
    const worthContinuing = handPercentile <= continueRange || handPercentile <= PREMIUM_HAND;
    const priceIsRight = equity >= potOdds + callMargin;
    return worthContinuing && priceIsRight ? checkOrCall(legal) : checkOrFold(legal);
  }

  // ── After the flop: equity against pot odds ───────────────────────────

  private playPostflop({ game, legal, equity, potOdds, opponentsInHand }: Situation): PlayerAction {
    const table = game.state;
    const { aggression, bluff, callMargin } = this.style;

    // With 3 players in the hand, an even share of the pot is 1/3; a good hand beats that comfortably.
    const evenShare = 1 / (opponentsInHand + 1);
    const goodEnoughToBet = equity >= evenShare + VALUE_BET_EDGE;
    const goodEnoughToRaise = equity >= evenShare + RAISE_EDGE;

    // Nobody has bet yet.
    if (legal.canCheck) {
      if (legal.canRaise && goodEnoughToBet && this.chance(aggression)) {
        return this.raiseTo(legal, table.pot * (0.5 + this.rng(300) / 1000)); // half to 80% of the pot
      }
      // Bluffs work best against one opponent, and less on the river where draws have missed or hit.
      const bluffChance = bluff * (opponentsInHand === 1 ? 1 : 0.4) * (table.street === 'river' ? 0.6 : 1);
      if (legal.canRaise && this.chance(bluffChance)) return this.raiseTo(legal, table.pot * 0.55);
      return { type: 'check' };
    }

    // Someone has bet.
    if (legal.canRaise && goodEnoughToRaise && this.chance(aggression)) {
      return this.raiseTo(legal, table.currentBet + (table.pot + legal.callAmount) * 0.75);
    }
    const priceIsRight = equity >= potOdds + callMargin;
    return priceIsRight ? { type: 'call' } : { type: 'fold' };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** True with the given probability (0–1). */
  private chance(probability: number): boolean {
    return this.rng(1000) / 1000 < probability;
  }

  /**
   * Turns a wished-for raise into a legal one. If it would put most of our stack in anyway,
   * we go all in instead of leaving a few chips behind.
   */
  private raiseTo(legal: LegalActions, target: number): PlayerAction {
    const amount = Math.round(Math.min(Math.max(target, legal.minRaiseTo), legal.maxRaiseTo));
    const nearlyAllIn = amount >= legal.maxRaiseTo * COMMIT_THRESHOLD;
    return { type: 'raise', amount: nearlyAllIn ? legal.maxRaiseTo : amount };
  }

  /**
   * Players who act last see more before deciding, so they can play more hands.
   * Returns a multiplier for our ranges: >1 in late position, <1 in early position.
   */
  private positionLooseness(game: Game, me: Player): number {
    const table = game.state;
    // Everyone dealt in, in the order they act: small blind first, the dealer (button) last.
    const afterDealer = [...table.players.slice(table.dealerIndex + 1), ...table.players.slice(0, table.dealerIndex + 1)];
    const actingOrder = afterDealer.filter((p) => p.holeCards.length > 0);
    const position = actingOrder.indexOf(me);
    const playersDealt = actingOrder.length;

    const shortHanded = playersDealt <= 3;
    const cutoffOrButton = position >= playersDealt - 2;
    const blinds = position <= 1;
    const earlySeat = position <= 3;

    if (shortHanded || cutoffOrButton) return LATE_POSITION_LOOSENESS;
    if (blinds) return 1;
    return earlySeat ? EARLY_POSITION_LOOSENESS : 1;
  }
}

/**
 * Guesses an opponent's range from their bets this hand. Everyone starts on "any two cards";
 * each strong action narrows it:
 *   - before the flop: open raise → top 20%, re-raise → top 7%, call → top 50% (30% if facing a raise)
 *   - after the flop: every bet or raise → 75% of what it was, every call → 90%
 */
function guessRange(actions: ActionRecord[], opponent: Player): RangeModel {
  let range = 1;
  let aggressivePostflop = false;
  let raisesSoFar = 0;

  for (const action of actions) {
    const theirs = action.playerId === opponent.id;

    if (action.street === 'preflop') {
      if (theirs && action.kind === 'raise') {
        range = Math.min(range, raisesSoFar === 0 ? RANGE_IF_THEY.openRaised : RANGE_IF_THEY.reRaised);
      } else if (theirs && action.kind === 'call') {
        range = Math.min(range, raisesSoFar === 0 ? RANGE_IF_THEY.limped : RANGE_IF_THEY.calledARaise);
      }
      if (action.kind === 'raise') raisesSoFar++;
    } else if (theirs && (action.kind === 'bet' || action.kind === 'raise')) {
      range *= NARROWING_PER_POSTFLOP_BET;
      aggressivePostflop = true;
    } else if (theirs && action.kind === 'call') {
      range *= NARROWING_PER_POSTFLOP_CALL;
    }
  }

  return { maxPercentile: Math.max(TIGHTEST_RANGE, range), aggressivePostflop };
}
