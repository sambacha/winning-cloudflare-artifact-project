/** Block logo "FAME-XGA" (6 rows). Each glyph's rows are padded to a common width. */
const GLYPHS: Record<string, ReadonlyArray<string>> = {
  F: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "██║     ", "╚═╝     "],
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  M: ["███╗   ███╗", "████╗ ████║", "██╔████╔██║", "██║╚██╔╝██║", "██║ ╚═╝ ██║", "╚═╝     ╚═╝"],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  "-": ["      ", "      ", "█████╗", "╚════╝", "      ", "      "],
  X: ["██╗  ██╗", "╚██╗██╔╝", " ╚███╔╝ ", " ██╔██╗ ", "██╔╝ ██╗", "╚═╝  ╚═╝"],
  G: [" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "]
}

const widthOf = (rows: ReadonlyArray<string>): number => Math.max(...rows.map((r) => [...r].length))

/** The logo rows for `word` (letters missing from the font are skipped). */
export const logoRows = (word: string): string[] => {
  const glyphs = [...word].flatMap((ch) => (GLYPHS[ch] ? [GLYPHS[ch]!] : []))
  return Array.from({ length: LOGO_ROWS }, (_, i) => glyphs.map((g) => (g[i] ?? "").padEnd(widthOf(g), " ")).join(" "))
}

/** Rows of the block logo. */
export const LOGO_ROWS = 6

export const LOGO_WIDTH = (word: string): number => [...(logoRows(word)[0] ?? "")].length
