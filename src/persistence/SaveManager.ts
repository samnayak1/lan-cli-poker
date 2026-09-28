import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GameSnapshot } from '../engine/GameState.js';

export interface SaveFile {
  id: string;
  tableName: string;
  createdAt: string;
  updatedAt: string;
  /** Seat the host reclaims on resume. */
  hostPlayerId: string;
  snapshot: GameSnapshot;
}

export function dataDir(): string {
  return process.env.POKER_LAN_HOME ?? join(homedir(), '.poker-lan-cli');
}

/** Hosted games are saved between hands to ~/.poker-lan-cli/saves/<id>.json. */
export class SaveManager {
  readonly dir: string;

  constructor(dir = join(dataDir(), 'saves')) {
    this.dir = dir;
  }

  private path(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid save id "${id}"`);
    return join(this.dir, `${id}.json`);
  }

  list(): SaveFile[] {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const saves: SaveFile[] = [];
    for (const f of files) {
      try {
        saves.push(JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as SaveFile);
      } catch {
        // Skip unreadable or partially written files.
      }
    }
    return saves.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  save(file: SaveFile): void {
    mkdirSync(this.dir, { recursive: true });
    const target = this.path(file.id);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...file, updatedAt: new Date().toISOString() }, null, 2));
    renameSync(tmp, target); // atomic replace: a crash mid-write never corrupts the save
  }

  delete(id: string): void {
    rmSync(this.path(id), { force: true });
  }
}
