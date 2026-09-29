import type { CardCode } from './engine/Card.js';

/** `raise` covers both betting and raising: `amount` is the total "raise to" for this street. */
export type PlayerAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'raise'; amount: number }
  | { type: 'allin' };

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  /** Chips the player will actually put in to call (capped at their stack). */
  callAmount: number;
  canRaise: boolean;
  /** Min/max "raise to" totals for this street. max = all-in. */
  minRaiseTo: number;
  maxRaiseTo: number;
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
export type SessionPhase = 'lobby' | 'playing' | 'handOver' | 'gameOver';
export type GameMode = 'single' | 'host' | 'client';

export interface PotResult {
  amount: number;
  winners: { id: string; name: string; amount: number }[];
  handName?: string;
}

export interface HandSummary {
  handNumber: number;
  board: CardCode[];
  pots: PotResult[];
  shown: { id: string; name: string; cards: CardCode[]; handName: string }[];
  uncontested: boolean;
}

export interface SeatView {
  id: string;
  name: string;
  chips: number;
  streetBet: number;
  folded: boolean;
  allIn: boolean;
  isBot: boolean;
  botStyle?: string;
  isYou: boolean;
  connected: boolean;
  eliminated: boolean;
  /** Reserved seat from a resumed save that nobody has claimed yet. */
  reserved: boolean;
  isDealer: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  isTurn: boolean;
  /** Your own cards always; others only at showdown. `null` = face-down card. */
  holeCards: (CardCode | null)[];
  lastAction: string | null;
  handName?: string;
  isWinner?: boolean;
  /** Hands this player has won (or split) in this game. */
  handsWon?: number;
}

export interface LobbyInfo {
  isHost: boolean;
  canStart: boolean;
  addresses: string[];
  resumed: boolean;
  maxPlayers: number;
  maxBots: number;
}

export interface TableView {
  mode: GameMode;
  phase: SessionPhase;
  tableName: string;
  youId: string;
  handNumber: number;
  street: Street;
  board: CardCode[];
  pot: number;
  currentBet: number;
  smallBlind: number;
  bigBlind: number;
  seats: SeatView[];
  toActId: string | null;
  /** Present only when it's your turn. */
  legal: LegalActions | null;
  /** Epoch ms when the current player's turn auto-expires (LAN only). */
  turnDeadline: number | null;
  /** Epoch ms when the next hand starts (during handOver). */
  nextHandAt: number | null;
  log: string[];
  lastHand: HandSummary | null;
  lobby: LobbyInfo | null;
  message: string | null;
}

export type HostCommand = 'start' | 'addBot' | 'removeBot' | 'fillBots' | 'nextHand' | 'restart';
