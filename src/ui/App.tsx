import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { userInfo } from 'node:os';
import { useEffect, useRef, useState } from 'react';
import { launchHost, launchJoin, launchSingle, type CliOptions, type LaunchedTable } from '../launch.js';
import { discoverHosts, type DiscoveredHost } from '../net/discovery.js';
import { DEFAULT_GAME_PORT } from '../net/protocol.js';
import { SaveManager, type SaveFile } from '../persistence/SaveManager.js';
import { KeyHint, SelectList, Title } from './components.js';
import { TableScreen } from './TableScreen.js';

export const CONTACT = 'Any problems or want to contribute? Contact ww-developer@protonmail.com';

type Screen =
  | { name: 'name' }
  | { name: 'menu' }
  | { name: 'host' }
  | { name: 'join' }
  | { name: 'loading'; text: string }
  | { name: 'table'; table: LaunchedTable };

function defaultName(): string {
  try {
    return userInfo().username.slice(0, 16);
  } catch {
    return 'Player';
  }
}

export function App({ opts }: { opts: CliOptions }) {
  const { exit } = useApp();
  const [name, setName] = useState(opts.name?.trim().slice(0, 16) || '');
  const [screen, setScreen] = useState<Screen>(name ? { name: 'menu' } : { name: 'name' });
  const [notice, setNotice] = useState<string | null>(null);
  const tableRef = useRef<LaunchedTable | null>(null);

  // Always shut servers down and save on exit (including Ctrl+C).
  useEffect(() => () => tableRef.current?.stop(), []);

  const launch = async (text: string, start: () => Promise<LaunchedTable>) => {
    setNotice(null);
    setScreen({ name: 'loading', text });
    try {
      const table = await start();
      tableRef.current = table;
      setScreen({ name: 'table', table });
    } catch (err) {
      setNotice((err as Error).message);
      setScreen({ name: 'menu' });
    }
  };

  const leaveTable = (message?: string) => {
    tableRef.current?.stop();
    tableRef.current = null;
    setNotice(message ?? null);
    setScreen({ name: 'menu' });
  };

  switch (screen.name) {
    case 'name':
      return (
        <NamePrompt
          initial={name || defaultName()}
          onSubmit={(n) => {
            setName(n);
            setScreen({ name: 'menu' });
          }}
        />
      );
    case 'menu':
      return (
        <Box flexDirection="column" paddingX={1}>
          <Title />
          <Text>
            Playing as <Text color="greenBright">{name}</Text>
          </Text>
          <Box marginY={1}>
            <SelectList
              items={[
                { label: 'Single Player', value: 'single', hint: 'you vs 4 bots' },
                { label: 'Host a LAN game', value: 'host', hint: 'new or resume a saved game' },
                { label: 'Join a LAN game', value: 'join' },
                { label: 'Change name', value: 'name' },
                { label: 'Quit', value: 'quit' },
              ]}
              onSelect={(v) => {
                if (v === 'single') void launch('Shuffling up…', () => launchSingle(name, opts));
                else if (v === 'host') setScreen({ name: 'host' });
                else if (v === 'join') setScreen({ name: 'join' });
                else if (v === 'name') setScreen({ name: 'name' });
                else exit();
              }}
              onCancel={() => exit()}
            />
          </Box>
          {notice && <Text color="yellow">{notice}</Text>}
          <Text color="gray">↑/↓ to move · Enter to select · Esc to quit</Text>
          <Box marginTop={1}>
            <Text color="gray">{CONTACT}</Text>
          </Box>
        </Box>
      );
    case 'host':
      return (
        <HostSetup
          onBack={() => setScreen({ name: 'menu' })}
          onStart={(resume) => void launch('Opening the table…', () => launchHost(name, opts, resume))}
        />
      );
    case 'join':
      return (
        <JoinScreen
          onBack={() => setScreen({ name: 'menu' })}
          onJoin={(address) => void launch(`Connecting to ${address}…`, () => launchJoin(name, address, opts))}
        />
      );
    case 'loading':
      return (
        <Box paddingX={1}>
          <Text color="yellow">{screen.text}</Text>
        </Box>
      );
    case 'table':
      return <TableScreen table={screen.table} onExit={leaveTable} />;
  }
}

function NamePrompt({ initial, onSubmit }: { initial: string; onSubmit: (name: string) => void }) {
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  return (
    <Box flexDirection="column" paddingX={1}>
      <Title />
      <Box gap={1}>
        <Text bold>Your name:</Text>
        <TextInput
          value={value}
          onChange={(v) => setValue(v.slice(0, 16))}
          onSubmit={() => trimmed && onSubmit(trimmed)}
        />
      </Box>
      <Text color="gray">Up to 16 characters · Enter to continue</Text>
    </Box>
  );
}

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function HostSetup({ onBack, onStart }: { onBack: () => void; onStart: (resume?: SaveFile) => void }) {
  const [saves, setSaves] = useState(() => new SaveManager().list());
  const items = [
    { label: 'New table', value: 'new', hint: '' },
    ...saves.map((s) => ({
      label: `Resume "${s.tableName}"`,
      value: s.id,
      hint: `hand #${s.snapshot.handNumber} · ${s.snapshot.players.length} players · ${timeAgo(s.updatedAt)}`,
    })),
    { label: 'Back', value: 'back', hint: '' },
  ];
  return (
    <Box flexDirection="column" paddingX={1}>
      <Title />
      <Text bold>Host a LAN game</Text>
      <Box marginY={1}>
        <SelectList
          items={items}
          onSelect={(v) => {
            if (v === 'back') onBack();
            else if (v === 'new') onStart();
            else onStart(saves.find((s) => s.id === v));
          }}
          onCancel={onBack}
          onKey={(input, v) => {
            if (input === 'd' && v !== 'new' && v !== 'back') {
              const manager = new SaveManager();
              manager.delete(v);
              setSaves(manager.list());
            }
          }}
        />
      </Box>
      {saves.length > 0 && (
        <Text color="gray">
          Saved games live in {new SaveManager().dir} · <Text color="cyanBright">[D]</Text> delete highlighted save
        </Text>
      )}
    </Box>
  );
}

function JoinScreen({ onBack, onJoin }: { onBack: () => void; onJoin: (address: string) => void }) {
  const [hosts, setHosts] = useState<DiscoveredHost[]>([]);
  const [manual, setManual] = useState<string | null>(null);

  useEffect(() => discoverHosts(setHosts), []);
  useInput(
    (_input, key) => {
      if (key.escape) setManual(null);
    },
    { isActive: manual !== null },
  );

  const items = [
    ...hosts.map((h) => ({
      label: h.tableName,
      value: `${h.address}:${h.port}`,
      hint: `${h.address}:${h.port} · ${h.players}/${h.maxPlayers} players${h.inProgress ? ' · in progress (rejoin only)' : ''}`,
    })),
    { label: 'Enter address manually…', value: 'manual', hint: '' },
    { label: 'Back', value: 'back', hint: '' },
  ];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Title />
      <Text bold>Join a LAN game</Text>
      <Text color="gray">{hosts.length ? `Found ${hosts.length} table(s) on your network:` : 'Searching your network for tables…'}</Text>
      <Box marginY={1}>
        <SelectList
          items={items}
          isActive={manual === null}
          onSelect={(v) => {
            if (v === 'back') onBack();
            else if (v === 'manual') setManual('');
            else onJoin(v);
          }}
          onCancel={onBack}
        />
      </Box>
      {manual !== null && (
        <Box flexDirection="column">
          <Box gap={1}>
            <Text bold>Host address:</Text>
            <TextInput
              value={manual}
              placeholder={`192.168.1.20:${DEFAULT_GAME_PORT}`}
              onChange={setManual}
              onSubmit={(v) => v.trim() && onJoin(v.trim())}
            />
          </Box>
          <Box gap={2}>
            <Text color="gray">Port defaults to {DEFAULT_GAME_PORT}</Text>
            <KeyHint k="Esc" label="cancel" color="gray" />
          </Box>
        </Box>
      )}
    </Box>
  );
}
