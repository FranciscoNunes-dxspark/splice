import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { knotRows, moodLine } from '../knot.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { VERSION } from '../version.js';
import { Row } from './parts.jsx';

export const KNOT_WIDTH = 16;
export const WELCOME_HEIGHT = 7;

/** Knot in pixels. While git works ("look") Knot glances from side to side. */
export function Knot({ mood }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (mood !== 'look') return;
    const t = setInterval(() => setTick((n) => n + 1), 450);
    return () => clearInterval(t);
  }, [mood]);
  const shown = mood === 'look' && tick % 2 ? 'idle' : mood;
  return knotRows(shown).map((segs, i) => <Row key={i} pointer={false} width={KNOT_WIDTH} segments={segs} />);
}

/** The box shown when Splice starts, like Claude Code's welcome. Esc or the first command clears it. */
// The welcome box's line about a newer release, by how far installing it has got.
const UPDATE_LINES = {
  out: (v) => `Splice ${v} is out (you have ${VERSION}). The link is below.`,
  installing: (v) => `Splice ${v} is out; downloading it in the background.`,
  installed: (v) => `Splice ${v} is installed and starts the next time you open Splice.`,
};

export function Welcome({ mood, data, width, update }) {
  const textW = Math.max(10, width - KNOT_WIDTH - 7);
  return (
    <Box borderStyle="round" borderColor={theme.accent} width={width} height={WELCOME_HEIGHT} paddingX={1}>
      <Box flexDirection="column" width={KNOT_WIDTH}>
        <Knot mood={mood} />
      </Box>
      <Box flexDirection="column" marginLeft={2} width={textW}>
        <Text wrap="truncate">
          <Text bold>Welcome to Splice</Text>
          <Text color={theme.dim}>{`  v${VERSION}`}</Text>
        </Text>
        <Text color={theme.dim} wrap="truncate">
          {fit(`Knot the otter here. ${moodLine(mood, data)}`, textW).trimEnd()}
        </Text>
        {update ? (
          <Text color={theme.warn} wrap="truncate">
            {fit(UPDATE_LINES[update.state ?? 'out'](update.latest), textW).trimEnd()}
          </Text>
        ) : (
          <Text> </Text>
        )}
        <Text color={theme.dim} wrap="truncate">
          {fit('/ commands · ! any git command · ? shortcuts · esc to put this away', textW).trimEnd()}
        </Text>
      </Box>
    </Box>
  );
}
