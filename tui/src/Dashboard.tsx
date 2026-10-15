/**
 * The interactive root component: draws a frame (exact `rows` × `cols`)
 * as Ink `<Text>` lines and forwards keys to the reducer via `useInput`.
 */
import type { Line } from "./ansi.ts"
import { Box, type Key, Text, useInput } from "./ink/index.ts"
import type { Color } from "./ink/types.ts"

/** The raw key sequence the reducer understands, from Ink's `(input, key)`. */
export const rawKey = (input: string, key: Key): string => {
  if (key.upArrow) return "\x1b[A"
  if (key.downArrow) return "\x1b[B"
  if (key.rightArrow) return "\x1b[C"
  if (key.leftArrow) return "\x1b[D"
  if (key.pageUp) return "\x1b[5~"
  if (key.pageDown) return "\x1b[6~"
  if (key.escape) return "\x1b"
  if (key.ctrl && input === "c") return "\x03"
  if (key.ctrl && input === "q") return "\x11"
  return input
}

export const Dashboard = (p: { readonly lines: ReadonlyArray<Line>; readonly onKey: (raw: string) => void }) => {
  useInput((input, key) => p.onKey(rawKey(input, key)))
  return (
    <Box flexDirection="column">
      {p.lines.map((l) => (
        <Text>
          {l.map((g) => (
            <Text color={g.style?.fg as Color | undefined} backgroundColor={g.style?.bg as Color | undefined} bold={g.style?.bold} dimColor={g.style?.dim} underline={g.style?.underline}>
              {g.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}
