export type Mode = 'flip' | 'type'

// Flip mode: which side a card shows first. 'mix' picks one per card.
export type Direction = 'de' | 'en' | 'mix'

// A Goethe-Zertifikat word list.
export type Level = 'A1' | 'A2' | 'B1'

export type Tally = { shown: number; known: number; missed: number; almost: number; retired: number; fresh: number }

export type Typed = { text: string; verdict: 'correct' | 'almost' | 'wrong'; note?: string }

export type View = {
  phase: 'card' | 'stats' | 'empty' | 'asking'
  level: Level
  wordId: number
  isRevealed: boolean
  isFresh: boolean
  // "NEW", "REVIEW · last seen 3 days ago", "AGAIN · missed this round".
  label: string
  // What "know" does: "next: 7 days".
  nextLabel: string
  due: number
  mode: Mode
  // Flip mode: the side this card shows first.
  front?: 'de' | 'en'
  direction?: Direction
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
