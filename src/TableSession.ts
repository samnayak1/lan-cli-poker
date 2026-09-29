import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { BOT_ROSTER, Bot } from './ai/Bot.js';
import { Game } from './engine/Game.js';
import { DEFAULT_CONFIG, GameState, type GameConfig } from './engine/GameState.js';
import { Player } from './engine/Player.js';
import type { SaveFile, SaveManager } from './persistence/SaveManager.js';
import type { HostCommand, PlayerAction, SessionPhase, TableView } from './types.js';

export interface SessionOptions {
  mode: 'single' | 'host';
  tableName: string;
  /** The human sitting at this machine. */
  localName: string;
  config?: Partial<GameConfig>;
  /** Number of bots to seat (single player). */
  bots?: number;
  resume?: SaveFile;
  saves?: SaveManager;
  /** Auto check/fold a human who takes longer than this. null = wait forever. */
  turnTimeoutMs?: number | null;
  /** Deal the next hand automatically after this long. Unset: wait for the host to continue. */
  nextHandDelayMs?: number;
  botThinkMs?: [min: number, max: number];
}

const newId = () => randomBytes(4).toString('hex');

/** Most bots a table can seat, in single player and hosted games alike. */
export const MAX_BOTS = 4;

/**
 * Runs one table: owns the Game, seats humans and bots, drives bot turns and timeouts,
 * paces hands, and saves progress. Emits 'update' whenever any view may have changed.
 */
export class TableSession extends EventEmitter {
  readonly game: Game;
  readonly localId: string;
  phase: SessionPhase = 'lobby';
  /** LAN addresses shown in the lobby (set by HostServer). */
  addresses: string[] = [];
  private message: string | null = null;
  private turnDeadline: number | null = null;
  private nextHandAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly bots = new Map<string, Bot>();
  private readonly bustOrder: string[] = [];
  /** Hands won per player id, for the trophies next to their names. */
  private readonly handsWon = new Map<string, number>();
  private readonly savedIds = new Set<string>();
  private readonly saveId: string;
  private readonly createdAt: string;
  private stopped = false;

  constructor(private readonly opts: SessionOptions) {
    super();
    const config = { ...DEFAULT_CONFIG, ...opts.config };

    if (opts.resume) {
      const state = GameState.fromSnapshot(opts.resume.snapshot);
      this.game = new Game(state);
      this.saveId = opts.resume.id;
      this.createdAt = opts.resume.createdAt;
      this.localId = opts.resume.hostPlayerId;
      for (const p of state.players) {
        this.savedIds.add(p.id);
        if (p.isBot) this.bots.set(p.id, new Bot(p.personality ?? 'tag'));
        else if (p.id !== this.localId) {
          p.reserved = true;
          p.connected = false;
        }
      }
      const host = state.player(this.localId);
      if (host) host.name = opts.localName;
    } else {
      this.game = new Game(new GameState(config));
      this.saveId = `${new Date().toISOString().slice(0, 10)}-${newId()}`;
      this.createdAt = new Date().toISOString();
      this.localId = newId();
      this.state.players.push(new Player({ id: this.localId, name: opts.localName, chips: config.startingChips, kind: 'human' }));
      for (let i = 0; i < (opts.bots ?? 0); i++) this.addBot();
    }
  }

  get state(): GameState {
    return this.game.state;
  }

  get tableName(): string {
    return this.opts.tableName;
  }

  get maxPlayers(): number {
    return this.state.config.maxPlayers;
  }

  // ── Lobby ──────────────────────────────────────────────────────────────

  /** A human (re)joins by name. Reconnecting with the same name reclaims the seat. */
  join(rawName: string): { ok: true; playerId: string } | { ok: false; error: string } {
    const name = rawName.trim().slice(0, 16);
    if (!name) return { ok: false, error: 'Name is required' };
    const existing = this.state.players.find((p) => !p.isBot && p.name.toLowerCase() === name.toLowerCase());

    if (existing) {
      if (existing.connected && !existing.reserved) return { ok: false, error: `"${name}" is already at this table` };
      existing.connected = true;
      existing.reserved = false;
      this.state.addLog(`${existing.name} ${this.phase === 'lobby' ? 'joined' : 'reconnected'}`);
      this.refreshTurn(existing);
      return { ok: true, playerId: existing.id };
    }
    if (this.phase !== 'lobby') return { ok: false, error: 'Game already in progress' };
    if (this.state.players.length >= this.maxPlayers) return { ok: false, error: 'Table is full' };

    const player = new Player({ id: newId(), name, chips: this.state.config.startingChips, kind: 'human' });
    this.state.players.push(player);
    this.state.addLog(`${name} joined`);
    this.changed();
    return { ok: true, playerId: player.id };
  }

  disconnect(playerId: string): void {
    const p = this.state.player(playerId);
    if (!p || p.id === this.localId) return;
    if (this.phase === 'lobby') {
      if (this.savedIds.has(p.id)) p.reserved = true;
      else this.state.players.splice(this.state.players.indexOf(p), 1);
    }
    p.connected = false;
    this.state.addLog(`${p.name} disconnected`);
    this.refreshTurn(p);
  }

  /** Re-plan the current turn if `p` is the one we're waiting on (their connection changed). */
  private refreshTurn(p: Player): void {
    if (this.phase === 'playing' && this.state.toAct === p) this.afterAction();
    else this.changed();
  }

  private get botCount(): number {
    return this.state.players.filter((p) => p.isBot).length;
  }

  addBot(): void {
    if (this.phase !== 'lobby' || this.state.players.length >= this.maxPlayers) return;
    if (this.botCount >= MAX_BOTS) return this.flash(`A table can have at most ${MAX_BOTS} bots`);
    const taken = new Set(this.state.players.map((p) => p.name));
    const pick = BOT_ROSTER.find((b) => !taken.has(b.name)) ?? { name: `Bot ${this.state.players.length}`, personality: 'tag' };
    const bot = new Player({ id: newId(), name: pick.name, chips: this.state.config.startingChips, kind: 'bot', personality: pick.personality });
    this.state.players.push(bot);
    this.bots.set(bot.id, new Bot(pick.personality));
    this.changed();
  }

  removeBot(): void {
    if (this.phase !== 'lobby') return;
    const bot = [...this.state.players].reverse().find((p) => p.isBot && !this.savedIds.has(p.id));
    if (!bot) return;
    this.state.players.splice(this.state.players.indexOf(bot), 1);
    this.bots.delete(bot.id);
    this.changed();
  }

  /**
   * Resumed game: hand unclaimed seats (and their chips) to bots, up to MAX_BOTS.
   * Seats beyond the bot limit are closed.
   */
  fillReservedWithBots(): void {
    const s = this.state;
    for (const p of s.players.filter((x) => x.reserved)) {
      if (this.botCount < MAX_BOTS) {
        p.reserved = false;
        p.connected = true;
        p.kind = 'bot';
        p.personality = 'tag';
        this.bots.set(p.id, new Bot('tag'));
      } else {
        const idx = s.players.indexOf(p);
        s.players.splice(idx, 1);
        if (idx <= s.dealerIndex) s.dealerIndex--;
        this.savedIds.delete(p.id);
        s.addLog(`${p.name}'s seat was closed (bot limit is ${MAX_BOTS})`);
      }
    }
    this.changed();
  }

  canStart(): boolean {
    return this.phase === 'lobby' && !this.state.players.some((p) => p.reserved) && this.game.canStartHand();
  }

  start(): void {
    if (!this.canStart()) {
      this.flash(this.state.players.some((p) => p.reserved) ? 'Waiting for saved players — fill their seats with bots to start now' : 'Need at least 2 players');
      return;
    }
    this.phase = 'playing';
    this.startHand();
  }

  command(playerId: string, cmd: HostCommand): string | null {
    if (playerId !== this.localId) return 'Only the host can do that';
    switch (cmd) {
      case 'start':
        this.start();
        break;
      case 'addBot':
        this.addBot();
        break;
      case 'removeBot':
        this.removeBot();
        break;
      case 'fillBots':
        this.fillReservedWithBots();
        break;
      case 'nextHand':
        if (this.phase === 'handOver') this.startHand();
        break;
      case 'restart':
        this.restart();
        break;
    }
    return null;
  }

  /** After a game over: everyone gets a fresh stack and a new game starts at the same table. */
  private restart(): void {
    if (this.phase !== 'gameOver') return;
    const s = this.state;
    for (const p of s.players) {
      p.chips = s.config.startingChips;
      p.resetForHand();
    }
    this.bustOrder.length = 0;
    this.handsWon.clear();
    s.handNumber = 0;
    s.dealerIndex = -1;
    s.lastHand = null;
    s.addLog('── New game ──');
    this.startHand();
  }

  // ── Play ───────────────────────────────────────────────────────────────

  /** Returns an error message, or null if the action was applied. */
  act(playerId: string, action: PlayerAction): string | null {
    if (this.phase !== 'playing') return 'No hand in progress';
    try {
      this.game.act(playerId, action);
    } catch (err) {
      return (err as Error).message;
    }
    this.afterAction();
    return null;
  }

  private startHand(): void {
    this.clearTimer();
    this.nextHandAt = null;
    this.message = null;
    this.phase = 'playing';
    this.game.startHand();
    this.lastStreet = null; // the deal itself counts as a new street for pacing
    this.afterAction();
  }

  /** Street the last scheduled bot turn saw — a newly dealt street earns an extra pause. */
  private lastStreet: string | null = null;

  /** Schedules whatever has to happen next: a bot move, a timeout, or the end of the hand. */
  private afterAction(): void {
    this.clearTimer();
    this.turnDeadline = null;
    const s = this.state;

    if (!s.handInProgress) return this.onHandEnd();

    const p = s.toAct!;
    if (p.isBot) {
      // Bots take a human-looking moment to think, plus a beat after new cards so the deal is seen.
      const [min, max] = this.opts.botThinkMs ?? [450, 900];
      const dealPause = s.street !== this.lastStreet && !this.opts.botThinkMs ? 400 : 0;
      this.lastStreet = s.street;
      this.schedule(min + Math.random() * (max - min) + dealPause, () => {
        let err: string | null;
        try {
          err = this.act(p.id, this.bots.get(p.id)!.decide(this.game, p));
        } catch (e) {
          err = (e as Error).message;
        }
        // Never let a bot bug stall the table.
        if (err) this.autoAct(p, 'hesitates');
      });
    } else if (!p.connected) {
      this.schedule(800, () => this.autoAct(p, 'away'));
    } else if (this.opts.turnTimeoutMs) {
      this.turnDeadline = Date.now() + this.opts.turnTimeoutMs;
      this.schedule(this.opts.turnTimeoutMs, () => this.autoAct(p, 'timed out'));
    }
    this.changed();
  }

  private autoAct(p: Player, reason: string): void {
    const legal = this.game.legalActions(p.id);
    if (!legal) return;
    this.state.addLog(`${p.name} ${reason}`);
    this.act(p.id, legal.canCheck ? { type: 'check' } : { type: 'fold' });
  }

  private onHandEnd(): void {
    const s = this.state;
    this.phase = 'handOver';
    for (const p of s.players) if (p.chips === 0 && !this.bustOrder.includes(p.id)) this.bustOrder.push(p.id);
    const winners = new Set(s.lastHand?.pots.flatMap((pot) => pot.winners.map((w) => w.id)) ?? []);
    for (const id of winners) this.handsWon.set(id, (this.handsWon.get(id) ?? 0) + 1);

    const local = s.player(this.localId);
    const localBusted = this.opts.mode === 'single' && local && local.chips === 0;
    if (localBusted || !this.game.canStartHand()) return this.endGame();

    this.persist();
    const delay = this.opts.nextHandDelayMs;
    if (delay !== undefined) {
      this.nextHandAt = Date.now() + delay;
      this.schedule(delay, () => this.startHand());
    }
    this.changed();
  }

  private endGame(): void {
    const s = this.state;
    this.phase = 'gameOver';
    this.nextHandAt = null;
    const standings = this.standings();
    const winner = standings[0]!;
    const place = standings.findIndex((p) => p.id === this.localId) + 1;
    this.message =
      this.opts.mode === 'single' && winner.id !== this.localId
        ? `You finished #${place} of ${standings.length}. ${winner.name} leads with ${winner.chips.toLocaleString()} chips.`
        : `${winner.name} wins the game with ${winner.chips.toLocaleString()} chips!`;
    s.addLog(this.message);
    if (this.opts.saves) this.opts.saves.delete(this.saveId);
    this.changed();
  }

  /** Players with chips by stack size, then busted players, most recent bust first. */
  standings(): Player[] {
    const s = this.state;
    const alive = s.players.filter((p) => p.chips > 0).sort((a, b) => b.chips - a.chips);
    const busted = [...this.bustOrder].reverse().map((id) => s.player(id)!).filter((p) => p && p.chips === 0);
    return [...alive, ...busted];
  }

  // ── Views, saving, lifecycle ───────────────────────────────────────────

  viewFor(playerId: string): TableView {
    const s = this.state;
    const isLocal = playerId === this.localId;
    return {
      mode: isLocal ? this.opts.mode : 'client',
      phase: this.phase,
      tableName: this.opts.tableName,
      youId: playerId,
      handNumber: s.handNumber,
      street: s.street,
      board: s.board.map((c) => c.code),
      pot: s.pot,
      currentBet: s.currentBet,
      smallBlind: s.config.smallBlind,
      bigBlind: s.config.bigBlind,
      seats: s.seatViews(playerId).map((seat) => ({ ...seat, handsWon: this.handsWon.get(seat.id) ?? 0 })),
      toActId: s.toAct?.id ?? null,
      legal: this.phase === 'playing' ? this.game.legalActions(playerId) : null,
      turnDeadline: this.turnDeadline,
      nextHandAt: this.nextHandAt,
      log: s.log.slice(-40),
      lastHand: s.lastHand,
      lobby:
        this.phase === 'lobby'
          ? {
              isHost: isLocal,
              canStart: this.canStart(),
              addresses: this.addresses,
              resumed: !!this.opts.resume,
              maxPlayers: this.maxPlayers,
              maxBots: MAX_BOTS,
            }
          : null,
      message: this.message,
    };
  }

  /** Writes the save file (host mode). Mid-hand, stacks from the start of the hand are saved. */
  persist(): void {
    if (!this.opts.saves || this.phase === 'gameOver') return;
    if (this.phase === 'lobby' && !this.opts.resume) return;
    const snapshot = this.state.toSnapshot();
    this.opts.saves.save({
      id: this.saveId,
      tableName: this.opts.tableName,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      hostPlayerId: this.localId,
      snapshot,
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimer();
    this.persist();
    this.removeAllListeners();
  }

  flash(message: string): void {
    this.message = message;
    this.changed();
  }

  private changed(): void {
    this.emit('update');
  }

  private schedule(ms: number, fn: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) fn();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
