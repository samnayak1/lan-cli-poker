#!/usr/bin/env node
import { render } from 'ink';
import { parseArgs } from 'node:util';
import type { CliOptions } from './launch.js';
import { VERSION as version } from './generated/assets.js';
import { DEFAULT_GAME_PORT } from './net/protocol.js';
import { App } from './ui/App.js';


const HELP = `
poker-lan — Texas Hold'em in your terminal, with a browser GUI.

Usage
  $ poker-lan [options]

Options
  -n, --name <name>     Your player name (skips the name prompt)
      --port <port>     Port to host LAN games on (default ${DEFAULT_GAME_PORT})
      --web-port <port> Port for the local browser GUI (default 8347)
      --no-browser      Serve the browser GUI but don't open it automatically
      --no-gui          Terminal only — don't start the browser GUI
  -h, --help            Show this help
  -v, --version         Show the version

In game: F fold · C call · R raise · Q quit · O open GUI

Any problems or want to contribute? Contact ww-developer@protonmail.com
`;

function main(): void {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        name: { type: 'string', short: 'n' },
        port: { type: 'string' },
        'web-port': { type: 'string' },
        'no-browser': { type: 'boolean', default: false },
        'no-gui': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    }));
  } catch (err) {
    console.error((err as Error).message + '\nRun `poker-lan --help` for usage.');
    process.exit(1);
  }

  if (values.help) return void console.log(HELP);
  if (values.version) return void console.log(version);

  const port = (raw: string | undefined, fallback: number) => {
    const n = Number(raw ?? fallback);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      console.error(`Invalid port: ${raw}`);
      process.exit(1);
    }
    return n;
  };

  if (!process.stdin.isTTY) {
    console.error('poker-lan needs an interactive terminal.');
    process.exit(1);
  }

  const opts: CliOptions = {
    name: values.name,
    gui: !values['no-gui'],
    browser: !values['no-browser'] && !values['no-gui'],
    port: port(values.port, DEFAULT_GAME_PORT),
    webPort: port(values['web-port'], 8347),
  };

  const app = render(<App opts={opts} />);
  // Servers are stopped on unmount; exit explicitly so no stray socket keeps the process alive.
  void app.waitUntilExit().then(() => process.exit(0));
}

main();
