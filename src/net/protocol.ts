import type { HostCommand, PlayerAction, TableView } from '../types.js';

export const PROTOCOL_VERSION = 1;
export const APP_ID = 'poker-lan-cli';
/** TCP port for the host's WebSocket game server. */
export const DEFAULT_GAME_PORT = 47777;
/** UDP port for LAN discovery beacons. */
export const DISCOVERY_PORT = 47778;

export type ClientMessage =
  | { type: 'hello'; name: string; version: number }
  | { type: 'action'; action: PlayerAction }
  | { type: 'command'; command: HostCommand };

export type ServerMessage =
  | { type: 'welcome'; playerId: string }
  | { type: 'view'; view: TableView }
  | { type: 'error'; message: string; fatal?: boolean };

export interface Beacon {
  app: typeof APP_ID;
  version: number;
  tableName: string;
  port: number;
  players: number;
  maxPlayers: number;
  inProgress: boolean;
}

export function parseMessage<T>(data: unknown): T | null {
  try {
    const msg = JSON.parse(String(data));
    return msg && typeof msg === 'object' && typeof msg.type === 'string' ? (msg as T) : null;
  } catch {
    return null;
  }
}
