import { mathRng, type Rng } from '../engine/Deck.js';
import type { Game } from '../engine/Game.js';
import type { ActionRecord, GameState } from '../engine/GameState.js';
import type { Player } from '../engine/Player.js';
import type { LegalActions, PlayerAction } from '../types.js';
import { estimateEquity, hasFlushDraw, hasStraightDraw, type RangeModel } from './equity.js';
import { OpponentTracker, type Profile } from './OpponentTracker.js';
import {
  BB_ISO, COLD_VS_3BET, OPEN, TIGHTER, VS_3BET, VS_4BET, VS_5BET, VS_OPEN, WIDER,
  frequencyOf, type OpenSeat, type Response,
} from './preflopCharts.js';
import { handClass, preflopPercentile } from './ranges.js';

/*
 * How a bot decides, in plain terms. Every bot plays the same strong ("GTO-inspired")
 * strategy, then bends it toward whatever its opponents do wrong:
 *
 *   Before the flop  Solver-style charts (preflopCharts.ts) say which hands to raise, call or fold
 *                    for each seat and situation, including mixed "raise 60% / call 40%" hands.
 *   After the flop   Work out equity against what each opponent likely holds (equity.ts), then:
 *                      - facing a bet: call whenever equity beats the pot odds, so bluffing it rarely pays
 *                      - otherwise: bet good hands at mixed sizes, semi-bluff draws, bluff rivers at a
 *                        measured rate, and sometimes slow-play a monster
 *   Exploiting       OpponentTracker watches everyone. The bot bluffs more into players who fold
 *                    too much, value-bets thinner against players who call too much, calls lighter
 *                    against players who bet a lot, and widens or tightens its preflop charts to match.
 */

export const BOT_ROSTER: string[] = ['Martin', 'Ablett', 'Ashcroft', 'Franklin', 'Selwood', 'Bontempelli', 'Daicos'];

// ── Tuning ───────────────────────────────────────────────────────────────

/** Opening raise in big blinds (plus one big blind for every player who just called). */
const OPEN_SIZE_BB = 2.5;
const SB_OPEN_SIZE_BB = 3;
/** Re-raise sizes, as multiples of the bet we're raising. Out of position we raise bigger. */
const THREE_BET_IN_POSITION = 3;
const THREE_BET_OUT_OF_POSITION = 4;
const FOUR_BET = 2.3;

/** Facing a raise bigger than this many big blinds before the flop, we decide on equity instead of charts. */
const DEEP_COMMITMENT_BB = 25;

/** After the flop: bet for value with this much more equity than an even share of the pot... */
const VALUE_BET_EDGE = 0.1;
/** ...and raise for value with this much more. */
const RAISE_EDGE = 0.3;
/** Equity that counts as a "monster" we might slow-play. */
const MONSTER = 0.85;

/** Base bluffing frequencies when checked to (heads-up; much less into several players). */
const SEMI_BLUFF = 0.45; // with a flush or straight draw
const AIR_BLUFF = 0.12; // with nothing on the flop or turn
const RIVER_BLUFF = 0.22; // with nothing on the river (draws have missed; bluffs are what balance value bets)
const MULTIWAY_BLUFF_FACTOR = 0.35;

/** Going all in once a raise would put at least this share of our stack in anyway. */
const COMMIT_THRESHOLD = 0.6;

/** A typical player folds to a bet this often; we bluff more or less as opponents fold more or less. */
const TYPICAL_FOLD_TO_BET = 0.45;
/** A typical player raises 18% of hands preflop and bets/raises on 35% of postflop actions. */
const TYPICAL_PFR = 0.18;
const TYPICAL_AGGRESSION = 0.35;

// ── Small helpers ────────────────────────────────────────────────────────

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const checkOrCall = (legal: LegalActions): PlayerAction => (legal.canCheck ? { type: 'check' } : { type: 'call' });
const checkOrFold = (legal: LegalActions): PlayerAction => (legal.canCheck ? { type: 'check' } : { type: 'fold' });

/** Equity needed to call: the share of the final pot that calling puts in. */
const potOdds = (pot: number, toCall: number) => (toCall > 0 ? toCall / (pot + toCall) : 0);

type Seat = OpenSeat | 'BB';

/** Everyone dealt in, in preflop acting order after the blinds: small blind first, dealer last. */
function actingOrder(table: GameState): Player[] {
  const afterDealer = [...table.players.slice(table.dealerIndex + 1), ...table.players.slice(0, table.dealerIndex + 1)];
  return afterDealer.filter((p) => p.holeCards.length > 0);
}

/** A player's seat name, counted back from the button (dealer). */
function seatOf(table: GameState, player: Player): Seat {
  const order = actingOrder(table);
  const position = order.indexOf(player);
  if (order.length === 2) return player === table.players[table.dealerIndex] ? 'HU' : 'BB';
  if (position === 0) return 'SB';
  if (position === 1) return 'BB';
  const fromButton = order.length - 1 - position;
  return fromButton === 0 ? 'BTN' : fromButton === 1 ? 'CO' : fromButton === 2 ? 'HJ' : 'UTG';
}

/**
 * Decides actions from what a real player could see: its own cards, the board, the pot,
 * how everyone has bet this hand, and how they've played in earlier hands (the tracker).
 */
export class Bot {
  constructor(
    private readonly tracker: OpponentTracker = new OpponentTracker(),
    private readonly rng: Rng = mathRng,
    private readonly iterations = 700,
  ) {}

  decide(game: Game, me: Player): PlayerAction {
    const legal = game.legalActions(me.id);
    if (!legal) throw new Error(`${me.name} asked to act out of turn`);
    return game.state.street === 'preflop' ? this.playPreflop(game, me, legal) : this.playPostflop(game, me, legal);
  }

  // ── Before the flop: charts ───────────────────────────────────────────

  private playPreflop(game: Game, me: Player, legal: LegalActions): PlayerAction {
    const table = game.state;
    const bigBlind = table.config.bigBlind;
    const hand = handClass(me.holeCards[0]!, me.holeCards[1]!);
    const mySeat = seatOf(table, me);
    const preflop = table.handActions.filter((a) => a.street === 'preflop');
    const raises = preflop.filter((a) => a.kind === 'raise');
    const callers = preflop.filter((a) => a.kind === 'call').length;

    // Facing a huge raise (often an all-in): charts assume deep stacks, so decide on equity.
    if (legal.callAmount > DEEP_COMMITMENT_BB * bigBlind) return this.callOnEquity(game, me, legal);

    // Nobody has raised yet.
    if (raises.length === 0) {
      if (mySeat === 'BB') {
        // Everyone just called (or folded) to us: raise our best hands, check the rest for free.
        return this.chance(frequencyOf(BB_ISO, hand)) && legal.canRaise
          ? this.raiseTo(legal, bigBlind * (OPEN_SIZE_BB + 1 + callers))
          : checkOrFold(legal);
      }
      const chart = OPEN[this.openSeatAdjustedForBlinds(table, me, mySeat)];
      if (this.chance(frequencyOf(chart, hand)) && legal.canRaise) {
        const size = mySeat === 'SB' ? SB_OPEN_SIZE_BB : OPEN_SIZE_BB;
        return this.raiseTo(legal, bigBlind * (size + callers));
      }
      return checkOrFold(legal);
    }

    const opener = table.player(raises[0]!.playerId)!;
    const lastRaiser = table.player(raises[raises.length - 1]!.playerId)!;
    const iOpened = raises[0]!.playerId === me.id;
    const inPosition = mySeat !== 'SB' && mySeat !== 'BB';

    // Facing one raise: re-raise, call or fold by seat; looser openers get played back at harder.
    if (raises.length === 1) {
      const openerProfile = this.tracker.profile(opener.id);
      const openerSeat = seatOf(table, opener);
      const openerIsLoose = openerProfile.pfr >= 0.28 || (openerSeat !== 'UTG' && openerSeat !== 'HJ');
      const openerIsTight = openerProfile.pfr <= 0.1;
      const late = openerIsLoose && !openerIsTight;
      const response =
        mySeat === 'BB' ? (late ? VS_OPEN.bbLate : VS_OPEN.bbEarly) : mySeat === 'SB' ? VS_OPEN.sb : late ? VS_OPEN.late : VS_OPEN.early;
      const raiseSize = table.currentBet * (inPosition ? THREE_BET_IN_POSITION : THREE_BET_OUT_OF_POSITION) + callers * table.currentBet;
      // The charts assume a typical opener. Against someone who raises far more often, folding
      // most hands just hands them the blinds, so keep playing in proportion to how wide they open.
      const pfr = openerProfile.pfr;
      const defendShare = mySeat === 'BB' ? pfr * 0.85 : mySeat === 'SB' ? pfr * 0.5 : pfr * 0.45;
      const widen = pfr > TYPICAL_PFR ? { reraise: clamp(pfr * 0.2, 0, 0.18), call: clamp(defendShare, 0, 0.75) } : undefined;
      return this.respond(legal, hand, response, raiseSize, 1, widen && { me, ...widen });
    }

    // Facing a re-raise (3-bet). If we opened, defend wider against players who 3-bet a lot.
    if (raises.length === 2) {
      const threeBetRate = this.tracker.profile(lastRaiser.id).threeBet;
      const widen = threeBetRate > 0.1 ? { me, reraise: clamp(threeBetRate * 0.12, 0, 0.08), call: clamp(threeBetRate * 0.5, 0, 0.35) } : undefined;
      if (!iOpened) {
        const cold = threeBetRate > 0.1 ? { me, reraise: 0, call: clamp(threeBetRate * 0.15, 0, 0.1) } : undefined;
        return this.respond(legal, hand, COLD_VS_3BET, table.currentBet * FOUR_BET, 1, cold);
      }
      const looseness = clamp(threeBetRate / 0.08, 0.6, 1.6); // typical 3-bet rate is ~8%
      return this.respond(legal, hand, VS_3BET, table.currentBet * FOUR_BET, inPosition ? looseness : looseness * 0.8, widen);
    }

    // Facing a 4-bet or more: only premium hands, unless the raiser re-raises with almost anything.
    const raiserPfr = this.tracker.profile(lastRaiser.id).pfr;
    const widen = raiserPfr > 0.3 ? { me, reraise: 0, call: clamp((raiserPfr - 0.3) * 0.3, 0, 0.15) } : undefined;
    if (raises.length === 3) return this.respond(legal, hand, VS_4BET, legal.maxRaiseTo, 1, widen);
    return this.respond(legal, hand, VS_5BET, legal.maxRaiseTo, 1, widen);
  }

  /**
   * Opens wider when the players still to act fold to raises a lot, tighter when they rarely do.
   * (Mostly matters on the button and in the blinds, where stealing the blinds is the point.)
   */
  private openSeatAdjustedForBlinds(table: GameState, me: Player, seat: Seat): OpenSeat {
    if (seat === 'BB') return 'BTN';
    const order = actingOrder(table);
    const stillToAct = order.slice(order.indexOf(me) + 1);
    if (stillToAct.length === 0) return seat;
    const foldRate = stillToAct.reduce((sum, p) => sum + this.tracker.profile(p.id).foldVsOpen, 0) / stillToAct.length;
    if (foldRate >= 0.78) return WIDER[seat];
    if (foldRate <= 0.45) return TIGHTER[seat];
    return seat;
  }

  /**
   * Raise with the chart's raising hands, else call with its calling hands, else fold (mixed by frequency).
   * `widen` stretches the charts against over-aggressive players: also re-raise with our top
   * `reraise` share of hands and call with our top `call` share (by preflop strength).
   */
  private respond(
    legal: LegalActions,
    hand: string,
    response: Response,
    raiseTo: number,
    callLooseness = 1,
    widen?: { me: Player; reraise: number; call: number },
  ): PlayerAction {
    if (legal.canRaise && this.chance(frequencyOf(response.raise, hand))) return this.raiseTo(legal, raiseTo);
    if (this.chance(clamp(frequencyOf(response.call, hand) * callLooseness, 0, 1))) return checkOrCall(legal);
    // A hand we'd re-raise but can't (not enough chips behind to raise) is still worth a call.
    if (!legal.canRaise && frequencyOf(response.raise, hand) > 0) return checkOrCall(legal);
    if (widen) {
      const strength = preflopPercentile(widen.me.holeCards[0]!, widen.me.holeCards[1]!); // 0.05 = a top-5% hand
      if (legal.canRaise && strength <= widen.reraise) return this.raiseTo(legal, raiseTo);
      if (strength <= widen.call) return checkOrCall(legal);
    }
    return checkOrFold(legal);
  }

  /** For huge preflop bets: call if our equity against their likely range beats the price. */
  private callOnEquity(game: Game, me: Player, legal: LegalActions): PlayerAction {
    const table = game.state;
    const opponents = table.players.filter((p) => p !== me && p.inHand);
    const ranges = opponents.map((o) => this.guessRange(table.handActions, o));
    const equity = estimateEquity(me.holeCards, table.board, ranges, this.iterations, this.rng);
    return equity >= potOdds(table.pot, legal.callAmount) ? checkOrCall(legal) : checkOrFold(legal);
  }

  // ── After the flop: equity, balance and exploits ──────────────────────

  private playPostflop(game: Game, me: Player, legal: LegalActions): PlayerAction {
    const table = game.state;
    const opponents = table.players.filter((p) => p !== me && p.inHand);
    const profiles = opponents.map((o) => this.tracker.profile(o.id));
    const ranges = opponents.map((o) => this.guessRange(table.handActions, o));
    const equity = estimateEquity(me.holeCards, table.board, ranges, this.iterations, this.rng);

    const river = table.street === 'river';
    const drawing = !river && (hasFlushDraw(me.holeCards, table.board) || hasStraightDraw(me.holeCards, table.board));
    const evenShare = 1 / (opponents.length + 1);
    const headsUp = opponents.length === 1;

    // Exploits. A bluff only works if everyone folds, so plan around the stickiest opponent.
    const stickiest = Math.min(...profiles.map((p) => p.foldToBet));
    const bluffMultiplier = clamp(stickiest / TYPICAL_FOLD_TO_BET, 0.25, 1.8);
    // Against players who call too much, bet thinner for value (and vice versa).
    const valueEdge = VALUE_BET_EDGE - clamp((TYPICAL_FOLD_TO_BET - stickiest) * 0.3, -0.04, 0.06);
    const mostAggressive = Math.max(...profiles.map((p) => p.aggression));

    // ── Nobody has bet yet ──
    if (legal.canCheck) {
      if (legal.canRaise && equity >= evenShare + valueEdge) {
        // Slow-play some monsters heads-up, more against players who like to bet for us.
        const slowPlay = equity >= MONSTER && headsUp && !river ? 0.12 + 0.25 * mostAggressive : 0;
        if (this.chance(slowPlay)) return { type: 'check' };
        const size = equity >= MONSTER ? this.pick(river ? [0.75, 1.1] : [0.66, 0.75]) : this.pick([0.33, 0.5, 0.66]);
        return this.raiseTo(legal, table.pot * size);
      }
      if (legal.canRaise && equity < evenShare) {
        const base = drawing ? SEMI_BLUFF : river ? RIVER_BLUFF : AIR_BLUFF;
        const bluffChance = base * (headsUp ? 1 : MULTIWAY_BLUFF_FACTOR) * bluffMultiplier;
        // Bluffs use the same big sizes as strong value bets, so a big bet doesn't give the hand away.
        if (this.chance(bluffChance)) return this.raiseTo(legal, table.pot * (drawing ? this.pick([0.5, 0.66]) : this.pick([0.66, 0.75])));
      }
      return { type: 'check' };
    }

    // ── Someone has bet ──
    if (legal.canRaise && equity >= evenShare + RAISE_EDGE && this.chance(0.7)) {
      return this.raiseTo(legal, table.currentBet + (table.pot + legal.callAmount) * 0.8);
    }
    // Semi-bluff raise with a strong draw now and then (the draw is the backup plan when called).
    if (legal.canRaise && drawing && equity >= 0.3 && this.chance(0.2 * bluffMultiplier)) {
      return this.raiseTo(legal, table.currentBet + (table.pot + legal.callAmount) * 0.75);
    }
    // Call whenever the price is right. The bettor's range includes bluffs at the rate they've
    // shown us, so players who bet too much get called down lighter.
    return equity >= potOdds(table.pot, legal.callAmount) ? { type: 'call' } : { type: 'fold' };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** True with the given probability (0–1). */
  private chance(probability: number): boolean {
    return this.rng(1000) / 1000 < probability;
  }

  private pick<T>(options: T[]): T {
    return options[this.rng(options.length)]!;
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
   * Guesses an opponent's range from this hand's bets, sized by how they've played before:
   * someone who raises 40% of hands gets a 40% raising range, not the typical 18%.
   */
  private guessRange(actions: ActionRecord[], opponent: Player): RangeModel {
    const profile: Profile = this.tracker.profile(opponent.id);
    let range = 1;
    let aggressivePostflop = false;
    let raisesSoFar = 0;
    // A typical player's bet narrows their range to 75%. Someone who bets constantly tells us
    // much less with each bet, so their range barely narrows (down to 97% per bet).
    const betNarrowing = clamp(1 - 0.25 * (TYPICAL_AGGRESSION / Math.max(profile.aggression, 0.05)), 0.75, 0.97);

    for (const action of actions) {
      const theirs = action.playerId === opponent.id;
      if (action.street === 'preflop') {
        if (theirs && action.kind === 'raise') {
          range = Math.min(range, raisesSoFar === 0 ? clamp(profile.pfr, 0.05, 1) : clamp(profile.threeBet, 0.03, 0.8));
        } else if (theirs && action.kind === 'call') {
          range = Math.min(range, raisesSoFar === 0 ? clamp(profile.vpip, 0.1, 1) : clamp(profile.vpip * 0.6, 0.06, 0.8));
        }
        if (action.kind === 'raise') raisesSoFar++;
      } else if (theirs && (action.kind === 'bet' || action.kind === 'raise')) {
        range *= betNarrowing;
        aggressivePostflop = true;
      } else if (theirs && action.kind === 'call') {
        range *= 0.9;
      }
    }

    return {
      maxPercentile: Math.max(0.04, range),
      aggressivePostflop,
      // How often their bets are bluffs: in line with how aggressive they've been.
      bluffShare: clamp(profile.aggression, 0.1, 0.95),
    };
  }
}
