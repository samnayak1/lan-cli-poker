import { mathRng, type Rng } from '../engine/Deck.js';
import type { Game } from '../engine/Game.js';
import type { Player } from '../engine/Player.js';
import type { LegalActions, PlayerAction } from '../types.js';
import { estimateEquity, type RangeModel } from './equity.js';
import { preflopPercentile } from './ranges.js';

export interface Personality {
  label: string;
  /** Fraction of starting hands played voluntarily. */
  vpip: number;
  /** Fraction of starting hands open-raised. */
  pfr: number;
  /** Chance to bet/raise when holding a strong hand (vs. slow-playing). */
  aggression: number;
  /** Chance to bet as a bluff when checked to. */
  bluff: number;
  /** Extra equity demanded above pot odds before calling (negative = calls too much). */
  callMargin: number;
}

export const PERSONALITIES: Record<string, Personality> = {
  tag: { label: 'Tight-Aggressive', vpip: 0.22, pfr: 0.16, aggression: 0.75, bluff: 0.1, callMargin: 0.03 },
  lag: { label: 'Loose-Aggressive', vpip: 0.38, pfr: 0.26, aggression: 0.85, bluff: 0.2, callMargin: 0 },
  rock: { label: 'Tight-Passive', vpip: 0.15, pfr: 0.07, aggression: 0.35, bluff: 0.03, callMargin: 0.06 },
  station: { label: 'Calling Station', vpip: 0.5, pfr: 0.08, aggression: 0.3, bluff: 0.05, callMargin: -0.07 },
};

export const BOT_ROSTER: { name: string; personality: string }[] = [
  { name: 'Viktor', personality: 'tag' },
  { name: 'Luna', personality: 'lag' },
  { name: 'Rocco', personality: 'rock' },
  { name: 'Maggie', personality: 'station' },
  { name: 'Dex', personality: 'tag' },
  { name: 'Ivy', personality: 'lag' },
  { name: 'Otto', personality: 'rock' },
];

/**
 * Decides actions from what a real player could see: its own cards, the board, the pot,
 * and opponents' actions this hand (used to narrow their hand ranges).
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
    const s = game.state;
    const opponents = s.players.filter((p) => p !== me && p.inHand);
    const models = opponents.map((o) => this.modelOpponent(game, o));
    const equity = estimateEquity(me.holeCards, s.board, models, this.iterations, this.rng);
    const toCall = legal.callAmount;
    const potOdds = toCall > 0 ? toCall / (s.pot + toCall) : 0;

    return s.street === 'preflop'
      ? this.preflop(game, me, legal, equity, potOdds)
      : this.postflop(game, legal, equity, potOdds, opponents.length);
  }

  private preflop(game: Game, me: Player, legal: LegalActions, equity: number, potOdds: number): PlayerAction {
    const s = game.state;
    const bb = s.config.bigBlind;
    const pct = preflopPercentile(me.holeCards[0]!, me.holeCards[1]!);
    const pos = this.positionFactor(game, me);
    const raises = s.handActions.filter((a) => a.street === 'preflop' && a.kind === 'raise').length;
    const limpers = s.handActions.filter((a) => a.street === 'preflop' && a.kind === 'call').length;
    const { vpip, pfr, callMargin } = this.style;

    if (raises === 0) {
      if (pct <= pfr * pos && legal.canRaise) {
        return this.raiseTo(legal, bb * (2.5 + this.rng(3) * 0.5) + limpers * bb);
      }
      if (pct <= vpip * pos) return legal.canCheck ? { type: 'check' } : { type: 'call' };
      return legal.canCheck ? { type: 'check' } : { type: 'fold' };
    }

    // Facing a raise: re-raise with the top of our range, otherwise call on equity + odds.
    const reraiseRange = pfr * (raises === 1 ? 0.3 : 0.1);
    if (pct <= reraiseRange && legal.canRaise) return this.raiseTo(legal, s.currentBet * 3);
    const playable = pct <= vpip * (raises === 1 ? 0.7 : 0.35) || pct <= 0.03;
    if (playable && equity >= potOdds + callMargin) return legal.canCheck ? { type: 'check' } : { type: 'call' };
    return legal.canCheck ? { type: 'check' } : { type: 'fold' };
  }

  private postflop(game: Game, legal: LegalActions, equity: number, potOdds: number, opponents: number): PlayerAction {
    const s = game.state;
    const fairShare = 1 / (opponents + 1);
    const valueThreshold = fairShare + 0.12;
    const raiseThreshold = fairShare + 0.28;
    const roll = () => this.rng(1000) / 1000;
    const { aggression, bluff, callMargin } = this.style;

    if (legal.canCheck) {
      if (legal.canRaise && equity >= valueThreshold && roll() < aggression) {
        return this.raiseTo(legal, s.pot * (0.5 + roll() * 0.3));
      }
      // Bluff mostly heads-up, and less often on the river where nobody folds draws.
      const bluffChance = bluff * (opponents === 1 ? 1 : 0.4) * (s.street === 'river' ? 0.6 : 1);
      if (legal.canRaise && roll() < bluffChance) return this.raiseTo(legal, s.pot * 0.55);
      return { type: 'check' };
    }

    if (legal.canRaise && equity >= raiseThreshold && roll() < aggression) {
      return this.raiseTo(legal, s.currentBet + (s.pot + legal.callAmount) * 0.75);
    }
    if (equity >= potOdds + callMargin) return { type: 'call' };
    return { type: 'fold' };
  }

  /** Clamp a desired "raise to" into the legal window; commit fully when most of the stack is going in. */
  private raiseTo(legal: LegalActions, target: number): PlayerAction {
    const amount = Math.round(Math.max(legal.minRaiseTo, Math.min(target, legal.maxRaiseTo)));
    if (amount >= legal.maxRaiseTo * 0.6) return { type: 'raise', amount: legal.maxRaiseTo };
    return { type: 'raise', amount };
  }

  /** Late position plays looser, early position tighter. */
  private positionFactor(game: Game, me: Player): number {
    const s = game.state;
    const dealt = s.players.filter((p) => p.holeCards.length > 0);
    const n = dealt.length;
    // 0 = small blind, n-1 = button
    const seatsAfterDealer = s.players.slice(s.dealerIndex + 1).concat(s.players.slice(0, s.dealerIndex + 1));
    const pos = seatsAfterDealer.filter((p) => p.holeCards.length > 0).indexOf(me);
    if (n <= 3 || pos >= n - 2) return 1.3; // short-handed, cutoff, button
    if (pos <= 1) return 1; // blinds
    return pos <= 3 ? 0.8 : 1; // early vs middle position
  }

  /** Narrow an opponent's range from how they've played this hand. */
  private modelOpponent(game: Game, opp: Player): RangeModel {
    let pct = 1;
    let aggressivePostflop = false;
    let raisesSeen = 0;

    for (const a of game.state.handActions) {
      const mine = a.playerId === opp.id;
      if (a.street === 'preflop') {
        if (mine && a.kind === 'raise') pct = Math.min(pct, raisesSeen === 0 ? 0.2 : 0.07);
        else if (mine && a.kind === 'call') pct = Math.min(pct, raisesSeen === 0 ? 0.5 : 0.3);
        if (a.kind === 'raise') raisesSeen++;
      } else if (mine) {
        if (a.kind === 'bet' || a.kind === 'raise') {
          pct *= 0.75;
          aggressivePostflop = true;
        } else if (a.kind === 'call') pct *= 0.9;
      }
    }
    return { maxPercentile: Math.max(0.04, pct), aggressivePostflop };
  }
}
