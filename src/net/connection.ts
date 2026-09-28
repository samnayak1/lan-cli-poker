import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { TableSession } from '../TableSession.js';
import type { HostCommand, PlayerAction, TableView } from '../types.js';
import { PROTOCOL_VERSION, parseMessage, type ClientMessage, type ServerMessage } from './protocol.js';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface ConnectionEvents {
  view: [TableView];
  error: [string];
  status: [ConnectionStatus];
}

/**
 * What a UI (terminal or browser) talks to. Hides whether the table runs in this
 * process (single player / host) or on another machine (join).
 */
export abstract class TableConnection extends EventEmitter<ConnectionEvents> {
  view: TableView | null = null;
  status: ConnectionStatus = 'connecting';

  abstract act(action: PlayerAction): void;
  abstract command(cmd: HostCommand): void;
  abstract close(): void;

  protected setView(view: TableView): void {
    this.view = view;
    this.emit('view', view);
  }

  protected setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.emit('status', status);
  }

  protected fail(message: string): void {
    // 'error' is special on EventEmitter (throws when unhandled) — only emit if someone listens.
    if (this.listenerCount('error') > 0) this.emit('error', message);
  }
}

/** Seat at a table running in this process. */
export class LocalConnection extends TableConnection {
  private readonly onUpdate = () => this.setView(this.session.viewFor(this.playerId));

  constructor(
    private readonly session: TableSession,
    private readonly playerId: string,
  ) {
    super();
    this.session.on('update', this.onUpdate);
    this.status = 'connected';
    this.view = session.viewFor(playerId);
  }

  act(action: PlayerAction): void {
    const err = this.session.act(this.playerId, action);
    if (err) this.fail(err);
  }

  command(cmd: HostCommand): void {
    const err = this.session.command(this.playerId, cmd);
    if (err) this.fail(err);
  }

  close(): void {
    this.session.off('update', this.onUpdate);
    this.setStatus('closed');
  }
}

/** Seat at a table hosted elsewhere on the LAN, over WebSocket. Reconnects on drops. */
export class RemoteConnection extends TableConnection {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private retries = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  playerId: string | null = null;

  constructor(
    readonly url: string,
    private readonly name: string,
  ) {
    super();
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(this.url, { handshakeTimeout: 5000 });
    this.ws = ws;

    ws.on('open', () => {
      this.send({ type: 'hello', name: this.name, version: PROTOCOL_VERSION });
    });

    ws.on('message', (data) => {
      const msg = parseMessage<ServerMessage>(data);
      if (!msg) return;
      if (msg.type === 'welcome') {
        this.playerId = msg.playerId;
        this.retries = 0;
        this.setStatus('connected');
      } else if (msg.type === 'view') {
        this.setView(msg.view);
      } else if (msg.type === 'error') {
        this.fail(msg.message);
        if (msg.fatal) {
          this.closedByUser = true; // don't retry a rejected join
          this.setStatus('closed');
        }
      }
    });

    ws.on('close', () => this.onDrop());
    ws.on('error', () => {
      /* 'close' follows; handled there */
    });
  }

  private onDrop(): void {
    if (this.closedByUser) return this.setStatus('closed');
    // Only retry if we had a seat — a host that never answered is just unreachable.
    if (this.playerId && this.retries < 10) {
      this.retries++;
      this.setStatus('reconnecting');
      this.retryTimer = setTimeout(() => this.connect(), 1500);
    } else {
      this.fail(this.playerId ? 'Lost connection to host' : `Could not connect to ${this.url}`);
      this.setStatus('closed');
    }
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  act(action: PlayerAction): void {
    this.send({ type: 'action', action });
  }

  command(cmd: HostCommand): void {
    this.send({ type: 'command', command: cmd });
  }

  close(): void {
    this.closedByUser = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.setStatus('closed');
  }
}
