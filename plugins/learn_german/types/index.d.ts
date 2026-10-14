export type Mode = 'flip' | 'type'

// A Goethe-Zertifikat word list.
export type Level = 'A1' | 'A2' | 'B1'

export type Tally = { shown: number; known: number; missed: number; almost: number; retired: number; fresh: number }

export type Typed = { text: string; verdict: 'correct' | 'almost' | 'wrong'; note?: string }

export type View = {
  // 'setup': the first open, before a level is chosen.
  phase: 'setup' | 'card' | 'stats' | 'empty'
  level: Level | null
  wordId: number
  isRevealed: boolean
  isFresh: boolean
  // "NEW", "REVIEW · last seen 3 days ago", "AGAIN · missed this round".
  label: string
  // What "know" does: "next: 7 days".
  nextLabel: string
  due: number
  mode: Mode
  typed?: Typed
  tally: Tally
  overall: { learning: number; mastered: number; retired: number; unseen: number }
  isDark: boolean
  // Opened with /german, not by Claude's work.
  isStudy: boolean
  canUndo: boolean
  // The stats screen's countdown.
  secondsLeft?: number
}

declare module 'claude-code' {
  interface PluginState {
    'learn_german': { view: View | null }
  }
}
