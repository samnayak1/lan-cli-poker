# poker-lan-cli

No-limit Texas Hold'em in your terminal, built with [Ink](https://github.com/vadimdemedes/ink). Every game also opens a browser GUI on `localhost` that mirrors the table and lets you act from there. The GUI shows the table from above in a dimly lit Las Vegas casino: your poker room has an ornate red carpet, and through its doorways you can see the slots room, the blackjack room and the bar, with guests and staff (dealers, a bartender, waitresses, security). Every player at the table is a bald cartoon kid with glasses and a poker face.

- **Single Player** — you against 4 bots that decide with equity, pot odds and hand ranges
- **Host** — run a table other people on your LAN can join, plus up to 4 bots. Progress is saved so you can resume unfinished games
- **Join on LAN** — hosts on your network are found automatically, or you can type an address

```bash
npx poker-lan-cli
# or
npm install -g poker-lan-cli
poker-lan
```

Requires Node.js 22+.

## Options

```
-n, --name <name>     Your player name (skips the name prompt)
    --port <port>     Port to host LAN games on (default 47777)
    --web-port <port> Port for the local browser GUI (default 8347)
    --no-browser      Serve the browser GUI but don't open it automatically
    --no-gui          Terminal only
```

## Controls

There are only three actions, in the terminal and in the browser:

| Key | Action |
| --- | --- |
| `F` | Fold |
| `C` | Call (this checks when there's nothing to call) |
| `R` | Raise. Type an amount or use ←/→ (±1 BB) and ↑/↓ (±5 BB), then Enter. Raising your whole stack is going all in |

`Q` quits to the menu (hosts: the game is saved) and `O` reopens the browser GUI. The next hand is dealt automatically a few seconds after the last one ends.

In the lobby the host presses `B` to add a bot (at most 4), `X` to remove one, and `S` to start.

## LAN play

1. One person picks **Host a LAN game**. The lobby shows addresses such as `192.168.1.20:47777`.
2. Everyone else picks **Join a LAN game**. Tables on the network are found through UDP broadcast on port 47778. If none appears, choose *Enter address manually*.
3. The host can add bots to fill seats and then starts the game.

The host's machine is the source of truth. Clients only ever receive their own hole cards, so a modified client can't see other players' hands. If a player's connection drops, their seat checks or folds until they rejoin with the same name. Each turn has a 60-second limit.

**Firewall:** the host must allow inbound TCP 47777 (game) and UDP 47778 (discovery). On WSL2, LAN broadcast usually doesn't reach Linux, so joiners should type the Windows host's IP. The host may also need to set up port forwarding or mirrored networking.

## Saved games

Hosted games are saved to `~/.poker-lan-cli/saves/` after every hand and when the host quits. You can change the location with `POKER_LAN_HOME`. If a game is closed mid-hand, that hand is replayed from its starting stacks.

To resume, choose **Host → Resume "…"**. Saved players get their seats and chips back when they rejoin **with the same name**. The host can press `F` to give unclaimed seats to bots. Seats beyond the 4-bot limit are closed. A save is deleted when its game finishes. Press `D` in the host menu to delete one manually.

## The bots

Each bot has a personality: Tight-Aggressive, Loose-Aggressive, Tight-Passive (rock) or Calling Station. Every decision uses only information a real player would have:

- **Hand ranges:** starting hands are ranked by the Chen formula into percentiles. A bot opens only the top X% of hands for its personality, widened in late position and tightened in early position. It re-raises with the top of that range.
- **Opponent ranges:** the bot narrows each opponent's likely range from their actions this hand. For example, a preflop raise means roughly the top 20%, a 3-bet the top 7%, and each postflop bet or raise narrows it further and shifts it toward made hands and draws.
- **Equity:** a Monte Carlo simulation (about 700 run-outs) of the bot's hand against hands drawn from those ranges.
- **Pot odds:** the bot calls when equity ≥ `toCall / (pot + toCall)` plus a personality margin. It bets and raises for value above thresholds that scale with the number of opponents, and it bluffs at a personality-specific rate.

## Architecture

```
src/
  engine/            pure game rules, no I/O
    Card.ts          rank/suit, codes like "As"
    Deck.ts          shuffle (crypto RNG), draw
    HandEvaluator.ts best 5 of 7 → comparable score + name
    Player.ts        stack and per-hand betting state
    Pot.ts           main/side pot construction
    GameState.ts     all table data, per-viewer views, snapshots for saving
    Game.ts          betting rounds, streets, showdown (a state machine)
  ai/                ranges.ts · equity.ts · Bot.ts
  TableSession.ts    runs a table: seats, bot turns, timeouts, pacing, saving
  net/               protocol, HostServer (WebSocket), RemoteConnection, UDP discovery
  web/WebServer.ts   localhost GUI server (token-protected WebSocket)
  persistence/       SaveManager
  ui/                Ink screens
public/index.html    the browser GUI (vanilla JS, no build step)
```

The terminal UI and the browser GUI both talk to a `TableConnection`. That connection is either local (single player or host, where the table runs in this process) or remote (join, over WebSocket), so each screen is written only once.

## Development

```bash
npm install
npm run dev        # run from source with tsx
npm test           # engine, AI, and network integration tests
npm run build      # compile to dist/
npm publish        # runs typecheck + tests + build first
```

## Contributing

Any problems or want to contribute? Contact ww-developer@protonmail.com

## License

MIT for the code. The faces in `public/people/` are cropped from CC0 photos on Wikimedia Commons; the bodies are drawn. See [public/people/CREDITS.md](public/people/CREDITS.md) for each source and photographer.
