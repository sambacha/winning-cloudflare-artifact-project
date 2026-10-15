# Shared settings of every tape. Run the tapes from the tui/ directory:
#   vhs tape/demo.tape
#
# Font: the system's default monospace typeface (the generic CSS family
# "monospace": DejaVu Sans Mono on most Linux systems, Menlo or Courier on
# macOS), so no font has to be installed.
# Geometry: 1440x900 px at 15 px with 20 px padding gives a terminal of at
# least 140x40 cells with any common monospace font (advance about 0.6 em, so
# 140 columns take about 1260 of the 1400 usable pixels). The TUI is launched
# with --cols 140 --rows 40, so every frame is exactly 140x40 whatever the font
# metrics are (invariant I4).
Set Shell "bash"
Set FontFamily "monospace"
Set FontSize 15
Set Width 1440
Set Height 900
Set Padding 20
Set Framerate 30
Set TypingSpeed 40ms
Set WaitTimeout 30s
Set WaitPattern /\$\s*$/
Set Theme { "name": "fame-xga", "background": "#0d1117", "foreground": "#c9d1d9", "selection": "#264f78", "cursor": "#c9d1d9", "black": "#484f58", "red": "#ff7b72", "green": "#3fb950", "yellow": "#d29922", "blue": "#58a6ff", "magenta": "#bc8cff", "cyan": "#39c5cf", "white": "#b1bac4", "brightBlack": "#6e7681", "brightRed": "#ffa198", "brightGreen": "#56d364", "brightYellow": "#e3b341", "brightBlue": "#79c0ff", "brightMagenta": "#d2a8ff", "brightCyan": "#56d4dd", "brightWhite": "#f0f6fc" }
