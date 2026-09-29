import { Box, Text, useInput } from 'ink';
import open from 'open';
import { useEffect, useState } from 'react';
import type { LaunchedTable } from '../launch.js';
import type { ConnectionStatus } from '../net/connection.js';
import type { HandSummary, SeatView, TableView } from '../types.js';
import { Cards, KeyHint } from './components.js';

const STYLE_TAGS: Record<string, string> = { tag: 'TAG', lag: 'LAG', rock: 'ROCK', station: 'STATION' };
const fmt = (n: number) => n.toLocaleString();

function useTableView(table: LaunchedTable) {
  const [view, setView] = useState<TableView | null>(table.conn.view);
  const [status, setStatus] = useState<ConnectionStatus>(table.conn.status);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const conn = table.conn;
    let clear: NodeJS.Timeout | undefined;
    const onError = (msg: string) => {
      setError(msg);
      clearTimeout(clear);
      clear = setTimeout(() => setError(null), 3500);
    };
    conn.on('view', setView);
    conn.on('status', setStatus);
    conn.on('error', onError);
    return () => {
      conn.off('view', setView);
      conn.off('status', setStatus);
      conn.off('error', onError);
      clearTimeout(clear);
    };
  }, [table]);

  return { view, status, error };
}

/** Re-renders every 250ms while a countdown is visible. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function TableScreen({ table, onExit }: { table: LaunchedTable; onExit: (notice?: string) => void }) {
  const { view, status, error } = useTableView(table);
  const [raise, setRaise] = useState<string | null>(null);
  /** False while the raise box still shows a prefilled amount the next digit should replace. */
  const [raiseTyped, setRaiseTyped] = useState(false);
  const [confirmQuit, setConfirmQuit] = useState(false);
  /** Keep your own cards face down on screen (H toggles). */
  const [hideCards, setHideCards] = useState(false);
  const now = useNow(!!(view?.turnDeadline || view?.nextHandAt));
  const legal = view?.legal ?? null;

  useEffect(() => {
    if (!legal?.canRaise) setRaise(null);
  }, [legal?.canRaise, view?.handNumber, view?.street]);

  const leave = () => onExit(view?.mode === 'host' && view.phase !== 'gameOver' ? 'Game saved — resume it from Host → Resume.' : undefined);

  useInput((input, key) => {
    if (!view) return;
    const k = input.toLowerCase();

    if (confirmQuit) {
      if (k === 'y') leave();
      else if (k === 'n' || key.escape) setConfirmQuit(false);
      return;
    }

    if (raise !== null && legal) {
      const bb = view.bigBlind;
      const current = Number(raise) || 0;
      const clamp = (n: number) => String(Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(n))));
      if (key.escape) setRaise(null);
      else if (key.return) {
        table.conn.act({ type: 'raise', amount: Number(clamp(current)) });
        setRaise(null);
      } else if (key.backspace || key.delete) {
        setRaise(raiseTyped ? raise.slice(0, -1) : '');
        setRaiseTyped(true);
      } else if (/^\d$/.test(input)) {
        // The first digit replaces the prefilled amount; later digits append.
        setRaise(((raiseTyped ? raise : '') + input).replace(/^0+/, '').slice(0, 9));
        setRaiseTyped(true);
      } else {
        let next: number | null = null;
        if (key.rightArrow) next = current + bb;
        else if (key.leftArrow) next = current - bb;
        else if (key.upArrow) next = current + bb * 5;
        else if (key.downArrow) next = current - bb * 5;
        if (next !== null) {
          setRaise(clamp(next));
          setRaiseTyped(false);
        }
      }
      return;
    }

    if (k === 'q') return setConfirmQuit(true);
    if (k === 'h') return setHideCards((h) => !h);
    if (k === 'o' && table.guiUrl) return void open(table.guiUrl).catch(() => {});

    if (view.phase === 'gameOver' || (status === 'closed' && view.mode === 'client')) {
      if (key.return) onExit();
      else if (k === 'r' && view.phase === 'gameOver' && view.mode !== 'client') table.conn.command('restart');
      return;
    }
    // Between hands the host (or single player) deals the next one with any key.
    if (view.phase === 'handOver') {
      if (view.mode !== 'client') table.conn.command('nextHand');
      return;
    }
    if (view.phase === 'lobby' && view.lobby?.isHost) {
      if (k === 'b') table.conn.command('addBot');
      else if (k === 'x') table.conn.command('removeBot');
      else if (k === 'f') table.conn.command('fillBots');
      else if (k === 's') table.conn.command('start');
      return;
    }
    if (legal) {
      if (k === 'f') table.conn.act({ type: 'fold' });
      else if (k === 'c') table.conn.act(legal.canCheck ? { type: 'check' } : { type: 'call' });
      else if (k === 'r' && legal.canRaise) {
        setRaise(String(legal.minRaiseTo));
        setRaiseTyped(false);
      }
    }
  });

  if (!view) return <Text color="yellow">Waiting for table…</Text>;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header view={view} status={status} guiUrl={table.guiUrl} />
      {view.phase === 'lobby' ? (
        <Lobby view={view} />
      ) : (
        <>
          <Seats view={view} now={now} hideCards={hideCards} />
          <Box marginTop={1} gap={2}>
            <Text bold>Board</Text>
            <Cards codes={view.board} slots={5} />
            <Text bold color="yellowBright">
              Pot {fmt(view.pot)}
            </Text>
          </Box>
          {view.phase !== 'playing' && view.lastHand && <Winners hand={view.lastHand} />}
          <Log lines={view.log} />
          <Box marginTop={1} flexDirection="column">
            {view.phase === 'gameOver' ? (
              <GameOver view={view} />
            ) : (
              <ActionBar view={view} raise={raise} now={now} />
            )}
          </Box>
        </>
      )}
      {status === 'reconnecting' && <Text color="yellow">Connection lost — reconnecting…</Text>}
      {status === 'closed' && view.mode === 'client' && <Text color="red">Disconnected from host. Press Enter to return to the menu.</Text>}
      {error && <Text color="red">✖ {error}</Text>}
      {view.message && view.phase !== 'gameOver' && <Text color="yellow">{view.message}</Text>}
      <Box marginTop={1} gap={2}>
        {confirmQuit ? (
          <Text color="yellow" bold>
            {view.mode === 'host' ? 'Close the table? Progress is saved for later. (y/n)' : 'Leave the table? (y/n)'}
          </Text>
        ) : (
          <>
            <KeyHint k="Q" label={view.mode === 'client' ? 'leave' : 'quit to menu'} color="gray" />
            <KeyHint k="H" label={hideCards ? 'show my cards' : 'hide my cards'} color="gray" />
            {table.guiUrl && <KeyHint k="O" label="open browser GUI" color="gray" />}
          </>
        )}
      </Box>
    </Box>
  );
}

function Header({ view, status, guiUrl }: { view: TableView; status: ConnectionStatus; guiUrl: string | null }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} marginBottom={1}>
      <Box gap={2}>
        <Text bold color="greenBright">
          ♠ CLI LAN POKER
        </Text>
        <Text>{view.tableName}</Text>
        {view.phase !== 'lobby' && <Text color="gray">Hand #{view.handNumber}</Text>}
        <Text color="gray">
          Blinds {view.smallBlind}/{view.bigBlind}
        </Text>
        {view.mode === 'client' && <Text color={status === 'connected' ? 'green' : 'yellow'}>● {status}</Text>}
      </Box>
      {guiUrl && <Text color="gray">GUI: {guiUrl}</Text>}
    </Box>
  );
}

function Lobby({ view }: { view: TableView }) {
  const lobby = view.lobby!;
  const reserved = view.seats.some((s) => s.reserved);
  return (
    <Box flexDirection="column">
      {lobby.isHost ? (
        lobby.addresses.length ? (
          <Text>
            Friends on your network can join at <Text color="yellowBright">{lobby.addresses.join('  or  ')}</Text>
          </Text>
        ) : (
          <Text color="yellow">No LAN address found — check your network connection.</Text>
        )
      ) : (
        <Text color="gray">Waiting for the host to start the game…</Text>
      )}
      <Box flexDirection="column" marginY={1}>
        <Text bold>
          Players ({view.seats.length}/{lobby.maxPlayers})
        </Text>
        {view.seats.map((s) => (
          <Box key={s.id} gap={1}>
            <Text>{s.isYou ? '★' : '•'}</Text>
            <Box width={18}>
              <Text color={s.reserved ? 'gray' : undefined}>{s.name}</Text>
            </Box>
            {s.isBot && <Text color="magenta">bot · {STYLE_TAGS[s.botStyle ?? ''] ?? ''}</Text>}
            {s.reserved && <Text color="gray">saved seat — waiting to rejoin</Text>}
            {lobby.resumed && <Text color="yellow">{fmt(s.chips)}</Text>}
          </Box>
        ))}
      </Box>
      {lobby.isHost && (
        <Box gap={2}>
          <KeyHint k="B" label={`add bot (${view.seats.filter((s) => s.isBot).length}/${lobby.maxBots})`} />
          <KeyHint k="X" label="remove bot" />
          {reserved && <KeyHint k="F" label="bots take empty saved seats" />}
          <KeyHint k="S" label={lobby.canStart ? 'start game' : 'start (need 2+ players)'} color={lobby.canStart ? 'greenBright' : 'gray'} />
        </Box>
      )}
    </Box>
  );
}

function Seats({ view, now, hideCards }: { view: TableView; now: number; hideCards: boolean }) {
  return (
    <Box flexDirection="column">
      {view.seats.map((s) => (
        <SeatRow key={s.id} seat={s} view={view} now={now} hideCards={hideCards} />
      ))}
    </Box>
  );
}

function SeatRow({ seat: s, view, now, hideCards }: { seat: SeatView; view: TableView; now: number; hideCards: boolean }) {
  const dim = s.folded || s.eliminated;
  const badge = s.isDealer ? 'D' : s.isSmallBlind ? 'SB' : s.isBigBlind ? 'BB' : '';
  const winner = view.phase !== 'playing' && s.isWinner && view.lastHand;
  const secondsLeft = s.isTurn && view.turnDeadline ? Math.max(0, Math.ceil((view.turnDeadline - now) / 1000)) : null;
  const nameColor = winner ? 'yellowBright' : s.isTurn ? 'cyanBright' : s.isYou ? 'greenBright' : undefined;

  return (
    <Box gap={1}>
      <Box width={2}>
        <Text color="cyanBright">{s.isTurn ? '▶' : winner ? '★' : ' '}</Text>
      </Box>
      <Box width={3}>
        <Text color="white" bold>
          {badge}
        </Text>
      </Box>
      <Box width={17}>
        <Text color={nameColor} dimColor={dim} bold={s.isTurn || s.isYou} wrap="truncate">
          {s.name}
          {s.isYou ? ' (you)' : ''}
          {!s.connected && !s.isBot ? ' ⚠' : ''}
          {s.handsWon ? ` 🏆${s.handsWon > 1 ? s.handsWon : ''}` : ''}
        </Text>
      </Box>
      <Box width={8}>
        <Text color="magenta" dimColor={dim}>
          {s.isBot ? (STYLE_TAGS[s.botStyle ?? ''] ?? 'BOT') : ''}
        </Text>
      </Box>
      <Box width={9} justifyContent="flex-end">
        <Text color="yellow" dimColor={dim}>
          {s.eliminated ? 'out' : fmt(s.chips)}
        </Text>
      </Box>
      <Box width={12}>
        {s.holeCards.length ? (
          <Cards codes={s.isYou && hideCards ? s.holeCards.map(() => null) : s.holeCards} />
        ) : (
          <Text color="gray">{s.folded ? '  folded' : ''}</Text>
        )}
      </Box>
      <Box width={8} justifyContent="flex-end">
        <Text color="yellowBright">{s.streetBet > 0 ? fmt(s.streetBet) : ''}</Text>
      </Box>
      <Text color={s.allIn ? 'redBright' : 'gray'} bold={s.allIn}>
        {s.handName ?? (s.allIn ? 'ALL-IN' : (s.lastAction ?? ''))}
        {secondsLeft !== null ? ` ⏱ ${secondsLeft}s` : ''}
      </Text>
    </Box>
  );
}

function Winners({ hand }: { hand: HandSummary }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {hand.pots.map((p, i) => (
        <Text key={i} color="yellowBright" bold>
          🏆 {p.winners.map((w) => w.name).join(' & ')} {p.winners.length > 1 ? 'split' : 'wins'} {fmt(p.amount)}
          {!hand.uncontested && p.handName ? ` with ${p.handName}` : ''}
        </Text>
      ))}
    </Box>
  );
}

function Log({ lines }: { lines: string[] }) {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
      {lines.slice(-6).map((line, i) =>
        / (wins|split) /.test(line) ? (
          <Text key={i} color="yellowBright" bold wrap="truncate">
            🏆 {line}
          </Text>
        ) : (
          <Text key={i} color="gray" wrap="truncate">
            {line}
          </Text>
        ),
      )}
    </Box>
  );
}

function ActionBar({ view, raise, now }: { view: TableView; raise: string | null; now: number }) {
  const legal = view.legal;

  if (view.phase === 'handOver') {
    if (view.nextHandAt) {
      return <Text color="gray">Next hand in {Math.max(0, Math.ceil((view.nextHandAt - now) / 1000))}s</Text>;
    }
    return view.mode === 'client' ? (
      <Text color="gray">Waiting for the host to deal the next hand…</Text>
    ) : (
      <Text backgroundColor="white" color="black" bold>
        {' Press any key to continue '}
      </Text>
    );
  }

  if (!legal) {
    const me = view.seats.find((s) => s.isYou);
    const turn = view.seats.find((s) => s.isTurn);
    if (me?.eliminated) return <Text color="gray">You're out of chips — spectating.</Text>;
    return <Text color="gray">{turn ? `Waiting for ${turn.name}…` : ''}</Text>;
  }

  if (raise !== null) {
    const amount = Number(raise) || 0;
    const valid = amount >= legal.minRaiseTo && amount <= legal.maxRaiseTo;
    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text bold>Raise to:</Text>
          <Text backgroundColor={valid ? 'cyan' : 'red'} color="black" bold>
            {' '}
            {raise || '0'}
            {' '}
          </Text>
          <Text color="gray">
            (min {fmt(legal.minRaiseTo)}, max {fmt(legal.maxRaiseTo)})
          </Text>
        </Box>
        <Text color="gray">type an amount · ←/→ ±1 BB · ↑/↓ ±5 BB · Enter confirm · Esc cancel</Text>
      </Box>
    );
  }

  const secs = view.turnDeadline ? Math.max(0, Math.ceil((view.turnDeadline - now) / 1000)) : null;
  // Hard to miss: a bright banner inside a double yellow border.
  return (
    <Box borderStyle="double" borderColor="yellowBright" paddingX={1} gap={2} alignItems="center">
      <Text backgroundColor="yellowBright" color="black" bold>
        {' ▶ YOUR TURN ◀ '}
      </Text>
      <KeyHint k="F" label="fold" color="red" />
      <KeyHint k="C" label={legal.canCheck ? 'check' : `call ${fmt(legal.callAmount)}`} />
      {legal.canRaise && <KeyHint k="R" label="raise" />}
      {secs !== null && <Text color={secs <= 10 ? 'red' : 'gray'}>⏱ {secs}s</Text>}
    </Box>
  );
}

function GameOver({ view }: { view: TableView }) {
  const standings = [...view.seats].sort((a, b) => b.chips - a.chips);
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
      <Text bold color="yellowBright">
        GAME OVER
      </Text>
      <Text>{view.message}</Text>
      {standings.map((s, i) => (
        <Text key={s.id} color={s.isYou ? 'greenBright' : undefined}>
          #{i + 1} {s.name.padEnd(16)} {fmt(s.chips)}
        </Text>
      ))}
      <Text color="gray">{view.mode === 'client' ? 'Press Enter to return to the menu.' : 'Press R to play again, or Enter to return to the menu.'}</Text>
    </Box>
  );
}
