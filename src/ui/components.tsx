import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { Card } from '../engine/Card.js';

export function Title() {
  return (
    <Box marginBottom={1}>
      <Text bold>
        <Text color="white">♠ </Text>
        <Text color="red">♥ </Text>
        <Text color="greenBright">C L I   L A N   P O K E R</Text>
        <Text color="red"> ♦</Text>
        <Text color="white"> ♣</Text>
      </Text>
    </Box>
  );
}

/** One playing card, 5 columns wide. `null` = face down, `undefined` = empty board slot. */
export function CardView({ code }: { code: string | null | undefined }) {
  if (code === undefined) return <Text color="gray"> ··· </Text>;
  if (code === null) {
    return (
      <Text backgroundColor="blue" color="cyan">
        {' ▒▒▒ '}
      </Text>
    );
  }
  const pretty = Card.pretty(code);
  const red = code[1] === 'h' || code[1] === 'd';
  return (
    <Text backgroundColor="white" color={red ? 'red' : 'black'} bold>
      {' ' + pretty.padStart(3) + ' '}
    </Text>
  );
}

export function Cards({ codes, slots = 0 }: { codes: (string | null)[]; slots?: number }) {
  const all: (string | null | undefined)[] = [...codes];
  while (all.length < slots) all.push(undefined);
  return (
    <Box gap={1}>
      {all.map((c, i) => (
        <CardView key={i} code={c} />
      ))}
    </Box>
  );
}

export interface SelectItem<T> {
  label: string;
  value: T;
  hint?: string;
}

export function SelectList<T>({
  items,
  onSelect,
  onCancel,
  onKey,
  isActive = true,
}: {
  items: SelectItem<T>[];
  onSelect: (value: T) => void;
  onCancel?: () => void;
  /** Extra per-item shortcuts, e.g. "d" to delete the highlighted save. */
  onKey?: (input: string, value: T) => void;
  isActive?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const current = Math.min(index, Math.max(0, items.length - 1));

  useEffect(() => {
    if (index >= items.length && items.length > 0) setIndex(items.length - 1);
  }, [items.length, index]);

  useInput(
    (input, key) => {
      if (!items.length) {
        if (key.escape) onCancel?.();
        return;
      }
      if (key.upArrow || input === 'k') setIndex((current - 1 + items.length) % items.length);
      else if (key.downArrow || input === 'j') setIndex((current + 1) % items.length);
      else if (key.return) onSelect(items[current]!.value);
      else if (key.escape) onCancel?.();
      else if (/^[1-9]$/.test(input) && Number(input) <= items.length) onSelect(items[Number(input) - 1]!.value);
      else if (onKey) onKey(input, items[current]!.value);
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Box key={i}>
          <Text color={i === current ? 'cyanBright' : undefined} bold={i === current}>
            {i === current ? '❯ ' : '  '}
            {i + 1}. {item.label}
          </Text>
          {item.hint && <Text color="gray">  {item.hint}</Text>}
        </Box>
      ))}
    </Box>
  );
}

export function KeyHint({ k, label, color }: { k: string; label: string; color?: string }) {
  return (
    <Text>
      <Text color={color ?? 'cyanBright'} bold>
        [{k}]
      </Text>
      <Text> {label}</Text>
    </Text>
  );
}
