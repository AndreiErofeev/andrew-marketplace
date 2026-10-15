import { atom, read } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { Direction, Level, Mode, Tally, View } from '../types'
import { headline } from './format'
import { LEVELS, LEVEL_NAMES } from './levels'
import { INTERVALS, MAX_BOX, RELEARN_GAP, ago, checkAnswer, days, dueCount, grade, pickNext, summary } from './srs'
import type { Card, Grade, Progress, Relearn } from './srs'
import { WORDS } from './words'

const PANE = 'learn_german'
const VIEW = { plugin: 'learn_german', key: 'view' } as const
const view = atom(VIEW, null)

const BY_ID = new Map(WORDS.map(row => [row[0], row]))
const LEVEL_HINT: Record<Level, string> = { A1: 'beginner', A2: 'elementary', B1: 'intermediate' }
const DIRECTIONS: readonly Direction[] = ['de', 'en', 'mix']
const DIRECTION_HINT: Record<Direction, string> = { de: 'DE → EN/RU', en: 'EN/RU → DE', mix: 'mixed' }

// Tool calls that mean Claude is doing real work, not only reading.
const ACTION_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent', 'Task'])
// Tool calls that wait for the person: the pane gets out of the way.
const ASKS_PERSON = new Set(['AskUserQuestion', 'ExitPlanMode'])
// When Claude asks the person, a focused pane waits this long before it closes,
// so keys meant for a card cannot answer Claude's dialog.
const ASK_GRACE_MS = 1500

export type Settings = {
  isEnabled: boolean
  mode: Mode
  level: Level
  direction: Direction
  minSeconds: number
  minTools: number
  reopenSeconds: number
  statsSeconds: number
}

const DEFAULTS: Settings = {
  isEnabled: true,
  mode: 'flip',
  level: 'A1',
  direction: 'de',
  minSeconds: 20,
  minTools: 3,
  reopenSeconds: 10,
  statsSeconds: 3,
}

// Beige/milk on dark terminals, warm brown on light ones.
const PALETTE = {
  dark: { text: '#E8DCC4', accent: '#D7B377', dim: '#9A8F7D', line: '#5C554B', good: '#A3BE8C', warn: '#E0B97A', bad: '#D08770' },
  light: { text: '#3E342A', accent: '#8A5A2B', dim: '#7A6F60', line: '#BDB3A3', good: '#4F7A3A', warn: '#8A6A1E', bad: '#A6492E' },
}

const PANE_ARGS = { id: PANE, title: 'Deutsch', columns: 64 }

// Below this many body columns the three answer boxes stack.
const WIDE = 60
const UNDO_DEPTH = 20
// /german reset waits this long for /german reset confirm.
const RESET_WINDOW = 60 * 1000

type Ops = {
  load: () => Promise<void>
  preparePane: (isStudy: boolean) => Promise<void>
  closePane: () => Promise<void>
  finish: () => Promise<void>
  suspend: (signal?: AbortSignal) => Promise<void>
  resume: () => Promise<void>
  tick: () => Promise<void>
  answer: (g: Grade, typed?: View['typed']) => Promise<void>
  undo: () => Promise<void>
  quit: () => Promise<void>
  advance: () => Promise<void>
  reveal: () => Promise<void>
  setMode: (mode: Mode) => Promise<void>
  setDirection: (direction: Direction) => Promise<void>
  chooseLevel: (level: Level) => Promise<void>
  resetProgress: () => Promise<void>
  overall: () => View['overall']
  saveSettings: () => Promise<void>
}

type Undo = { id: number; card: Card | undefined; relearn: Relearn[]; view: View }

const EMPTY_TALLY: Tally = { shown: 0, known: 0, missed: 0, almost: 0, retired: 0, fresh: 0 }

function answered(t: Tally): number {
  return t.known + t.missed + t.almost + t.retired
}

export const register: Register = on => {
  // Module state. A hot reload starts it over; progress is reloaded from $.store.
  // Engine-backed operations, built in session.start where `$` is in scope.
  let ops: Ops | undefined
  let settings: Settings = DEFAULTS
  let progress: Progress = {}
  let isLoaded = false
  let relearn: Relearn[] = []
  let history: Undo[] = []
  let isOpen = false
  let isManual = false
  let isDismissed = false
  // Set by the pane's last render: only a focused pane gets keys.
  let isFocused = false
  let lastClosedAt = -Infinity
  let resetAskedAt = -Infinity
  let closeTimer: Timer | undefined
  const turn = { isActive: false, startedAt: 0, actions: 0, calls: 0, isSuspended: false }

  on('session.start', async ($, e, next) => {
    async function load() {
      if (isLoaded) return
      progress = ((await $.store.get('progress')) as Progress | undefined) ?? {}
      settings = { ...DEFAULTS, ...((await $.store.get('settings')) as Partial<Settings> | undefined) }
      if (!DIRECTIONS.includes(settings.direction)) settings = { ...settings, direction: DEFAULTS.direction }
      isLoaded = true
    }

    // Only the values changed from the defaults are kept, so new defaults reach old installs.
    async function saveSettings() {
      const changed = Object.fromEntries(
        Object.entries(settings).filter(([key, value]) => DEFAULTS[key as keyof Settings] !== value),
      )
      await $.store.set('settings', changed)
    }

    async function isDarkTheme(): Promise<boolean> {
      try {
        const row = (await $.config.list()).find(one => one.key === 'theme')
        return !String(row?.value ?? 'dark').includes('light')
      } catch {
        return true
      }
    }

    async function getView(): Promise<View | null> {
      return (await $.state.get(VIEW)).value ?? null
    }

    function levelIds(): readonly number[] {
      return LEVELS[settings.level]
    }

    // The records of the chosen level's words: counts and cards stay within its list.
    function levelProgress(): Progress {
      const out: Progress = {}
      for (const id of levelIds()) {
        const card = progress[id]
        if (card !== undefined) out[id] = card
      }
      return out
    }

    function overall() {
      return summary(levelProgress(), levelIds().length)
    }

    // The side a new card shows first. 'mix' alternates by a hash of the word and the time.
    function frontFor(id: number, now: number): 'de' | 'en' {
      if (settings.direction !== 'mix') return settings.direction
      return (id * 31 + Math.floor(now / 1000)) % 2 === 0 ? 'de' : 'en'
    }

    // The next card, or the "empty" screen when every word is retired.
    function nextView(prev: View, tally: Tally, now: number): View {
      const id = pickNext(levelIds(), progress, now, tally.shown, relearn, prev.wordId)
      const base = {
        ...prev,
        level: settings.level,
        direction: settings.direction,
        tally,
        due: dueCount(levelProgress(), now),
        overall: overall(),
        canUndo: history.length > 0,
      }
      if (id === undefined) return { ...base, phase: 'empty' }
      const card = progress[id]
      const isFresh = card === undefined
      const isAgain = relearn.some(([one]) => one === id)
      const lastSeen = card?.[3]
      const label = isFresh
        ? 'NEW'
        : isAgain
          ? 'AGAIN · missed this round'
          : `REVIEW${lastSeen === undefined ? '' : ` · last seen ${ago(lastSeen, now)}`}`
      const nextBox = Math.min(Math.max(card?.[0] ?? 0, 0) + 1, MAX_BOX)
      return {
        ...base,
        phase: 'card',
        wordId: id,
        front: frontFor(id, now),
        isRevealed: false,
        isFresh,
        label,
        nextLabel: `next: ${days(INTERVALS[nextBox] ?? 0)}`,
        typed: undefined,
        secondsLeft: undefined,
        tally: { ...tally, shown: tally.shown + 1, fresh: tally.fresh + (isFresh ? 1 : 0) },
      }
    }

    async function preparePane(isStudy: boolean) {
      closeTimer?.cancel()
      closeTimer = undefined
      await load()
      const current = await getView()
      const isDark = await isDarkTheme()
      const isCard = current !== null && (current.phase === 'card' || current.phase === 'asking')
      if (current === null || !isCard || !isOpen) {
        const keepTally = isCard
        if (!keepTally) {
          history = []
          relearn = []
        }
        const base: View = current ?? {
          phase: 'card',
          level: settings.level,
          wordId: -1,
          isRevealed: false,
          isFresh: false,
          label: '',
          nextLabel: '',
          due: 0,
          mode: settings.mode,
          tally: EMPTY_TALLY,
          overall: overall(),
          isDark,
          isStudy,
          canUndo: false,
        }
        const tally = keepTally ? base.tally : EMPTY_TALLY
        await $.state.set(VIEW, nextView({ ...base, mode: settings.mode, isDark, isStudy }, tally, await $.clock.now()))
      } else if (current.isStudy !== isStudy) {
        await $.state.set(VIEW, { ...current, isStudy })
      }
      isOpen = true
    }

    async function openPane() {
      await preparePane(false)
      await $.ui.open(PANE_ARGS)
    }

    async function closePane() {
      closeTimer?.cancel()
      closeTimer = undefined
      if (!isOpen) return
      isOpen = false
      isManual = false
      isFocused = false
      lastClosedAt = await $.clock.now()
      await $.ui.close({ id: PANE })
    }

    async function closeAfterStats() {
      await closePane()
      // The next round counts cards from 0: a missed word returns by its due time.
      history = []
      relearn = []
      const last = await getView()
      if (last !== null) await $.state.set(VIEW, { ...last, phase: 'card', wordId: -1, tally: EMPTY_TALLY, canUndo: false })
    }

    // Claude is done: show this round's stats with a countdown, then close.
    async function finish() {
      if (!isOpen || isManual) return
      const current = await getView()
      let left = Math.ceil(settings.statsSeconds)
      if (current !== null) await $.state.set(VIEW, { ...current, phase: 'stats', secondsLeft: left, overall: overall() })
      if (left <= 0) {
        await closeAfterStats()
        return
      }
      closeTimer = $.clock.every(1000, () => {
        left -= 1
        if (left <= 0) {
          void closeAfterStats()
          return
        }
        void (async () => {
          const shown = await getView()
          if (shown !== null && shown.phase === 'stats') await $.state.set(VIEW, { ...shown, secondsLeft: left })
        })()
      })
    }

    function isWorkTurn(now: number): boolean {
      if (!settings.isEnabled || !turn.isActive || turn.isSuspended || isDismissed || isOpen) return false
      const elapsed = now - turn.startedAt
      const isQuickReturn = turn.startedAt - lastClosedAt < settings.reopenSeconds * 1000 && turn.actions >= 1
      const isLongWork = elapsed >= settings.minSeconds * 1000 && (turn.actions >= 1 || turn.calls >= settings.minTools)
      return isQuickReturn || isLongWork
    }

    async function tick() {
      if (isWorkTurn(await $.clock.now())) await openPane()
    }

    // Claude asks the person: a focused pane first shows a screen without keys,
    // then closes, so keys pressed for a card do not reach Claude's dialog.
    async function suspend(signal?: AbortSignal) {
      turn.isSuspended = true
      if (!isOpen || isManual) return
      if (isFocused) {
        const current = await getView()
        if (current !== null && current.phase === 'card') await $.state.set(VIEW, { ...current, phase: 'asking' })
        try {
          await $.clock.sleep(ASK_GRACE_MS, { signal })
        } catch {
          // Aborted: close now.
        }
        if (!isOpen || isManual) return
      }
      isOpen = false
      isFocused = false
      await $.ui.close({ id: PANE })
    }

    async function resume() {
      if (!turn.isSuspended) return
      turn.isSuspended = false
      await tick()
    }

    // Puts back a word's record as it was before one answer.
    function restore(last: Undo) {
      if (last.card === undefined) delete progress[last.id]
      else progress[last.id] = last.card
      relearn = last.relearn
    }

    async function answer(g: Grade, typed?: View['typed']) {
      let current = await getView()
      if (current === null || current.phase !== 'card') return
      // A typed answer is graded already: "don't show again" replaces that grade.
      if (current.typed !== undefined) {
        const last = history.at(-1)
        if (g !== 'retire' || last === undefined || last.id !== current.wordId) return
        history = history.slice(0, -1)
        restore(last)
        current = last.view
      }
      const id = current.wordId
      const now = await $.clock.now()
      history = [...history, { id, card: progress[id], relearn, view: current }].slice(-UNDO_DEPTH)
      progress[id] = grade(progress[id], g, now)
      relearn = relearn.filter(([one]) => one !== id)
      if (g === 'dontKnow' || g === 'almost') relearn = [...relearn, [id, current.tally.shown + RELEARN_GAP]]
      await $.store.set('progress', progress)
      const t = current.tally
      const tally: Tally = {
        ...t,
        known: t.known + (g === 'know' ? 1 : 0),
        missed: t.missed + (g === 'dontKnow' ? 1 : 0),
        almost: t.almost + (g === 'almost' ? 1 : 0),
        retired: t.retired + (g === 'retire' ? 1 : 0),
      }
      // Type mode shows the result first; the person presses Next.
      if (typed !== undefined) {
        await $.state.set(VIEW, { ...current, typed, isRevealed: true, tally, overall: overall(), canUndo: true })
        return
      }
      await $.state.set(VIEW, nextView(current, tally, now))
    }

    // Puts back the word, its record and the screen as they were before the last answer.
    async function undo() {
      const last = history.at(-1)
      if (last === undefined) return
      history = history.slice(0, -1)
      restore(last)
      await $.store.set('progress', progress)
      const current = await getView()
      await $.state.set(VIEW, {
        ...last.view,
        isDark: current?.isDark ?? last.view.isDark,
        canUndo: history.length > 0,
        overall: overall(),
      })
    }

    // q: progress is already saved; close and stay away for this turn.
    async function quit() {
      isDismissed = true
      await closePane()
    }

    async function advance() {
      const current = await getView()
      if (current !== null) await $.state.set(VIEW, nextView(current, current.tally, await $.clock.now()))
    }

    async function reveal() {
      const current = await getView()
      if (current !== null) await $.state.set(VIEW, { ...current, isRevealed: true })
    }

    async function setMode(mode: Mode) {
      settings = { ...settings, mode }
      await saveSettings()
      const current = await getView()
      if (current !== null) await $.state.set(VIEW, { ...current, mode, isRevealed: false, typed: undefined })
    }

    // A card not yet revealed turns to the new side; 'mix' keeps its side.
    async function setDirection(direction: Direction) {
      settings = { ...settings, direction }
      await saveSettings()
      const current = await getView()
      if (current === null) return
      const front = direction === 'mix' || current.isRevealed ? current.front : direction
      await $.state.set(VIEW, { ...current, direction, front })
    }

    // A new list: the missed words of the old one do not come back in this round.
    async function chooseLevel(level: Level) {
      settings = { ...settings, level }
      await saveSettings()
      relearn = []
      history = []
      const current = await getView()
      if (current !== null && current.phase !== 'stats') {
        await $.state.set(VIEW, nextView({ ...current, level }, current.tally, await $.clock.now()))
      }
    }

    // Every level's records go; settings stay.
    async function resetProgress() {
      progress = {}
      relearn = []
      history = []
      await $.store.set('progress', progress)
      const current = await getView()
      if (current !== null && current.phase !== 'stats') {
        await $.state.set(VIEW, nextView({ ...current, canUndo: false }, EMPTY_TALLY, await $.clock.now()))
      }
    }

    ops = {
      load,
      preparePane,
      closePane,
      finish,
      suspend,
      resume,
      tick,
      answer,
      undo,
      quit,
      advance,
      reveal,
      setMode,
      setDirection,
      chooseLevel,
      resetProgress,
      overall,
      saveSettings,
    }
    await load()
    await $.command.register({
      name: 'german',
      description:
        'German flashcards (Goethe A1, A2, B1): open now, level, on|off, flip|type, show de|en|mix, stats, reset, set <seconds|tools|reopen|stats> <n>',
      argumentHint: '[level a1|a2|b1|on|off|flip|type|show de|en|mix|stats|reset|set …]',
    })
    $.clock.every(2000, () => void tick())
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    Object.assign(turn, { isActive: true, startedAt: await $.clock.now(), actions: 0, calls: 0, isSuspended: false })
    isDismissed = false
    if (closeTimer !== undefined) {
      // A new turn began while the stats showed: keep studying.
      closeTimer.cancel()
      closeTimer = undefined
      void ops?.advance()
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!turn.isActive) return next(e)
    turn.calls += 1
    if (ACTION_TOOLS.has(String(e.tool))) turn.actions += 1
    if (ASKS_PERSON.has(String(e.tool))) await ops?.suspend(next.signal)
    else await ops?.tick()
    const ran = await next(e)
    await ops?.resume()
    return ran
  }).catch(($, e, next) => next(e))

  // A permission dialog opens after this verdict: the pane goes first.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id !== undefined && e.agentId === undefined && turn.isActive) {
      await ops?.suspend(next.signal)
    }
    return verdict
  }).catch(($, e, next) => next(e))

  // Fallback: closes the pane at once if tool.check did not.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (turn.isActive) await ops?.suspend()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    turn.isActive = false
    const done = await next(e)
    await ops?.finish()
    return done
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      // Closed by hand: stay away for the rest of this turn.
      isOpen = false
      isManual = false
      isDismissed = true
      isFocused = false
      lastClosedAt = await $.clock.now()
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'german' }, async ($, e) => {
    if (ops === undefined) return { text: 'German cards are still loading.' }
    await ops.load()
    const [word = '', key = '', raw = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (word === '') {
      if (isOpen) {
        await ops.closePane()
        return { text: 'German pane closed.' }
      }
      isManual = true
      await ops.preparePane(true)
      await $.ui.open({ ...PANE_ARGS, focus: true })
      return { text: 'German pane open. Press ctrl+x tab to focus it, Esc to return.' }
    }
    if (word === 'on' || word === 'off') {
      settings = { ...settings, isEnabled: word === 'on' }
      await ops.saveSettings()
      if (word === 'off') await ops.closePane()
      return { text: `German cards ${word === 'on' ? 'on' : 'off'}.` }
    }
    if (word === 'flip' || word === 'type') {
      await ops.setMode(word)
      return { text: `German cards: ${word} mode.` }
    }
    if (word === 'show') {
      const direction = DIRECTIONS.find(one => one === key)
      if (direction === undefined) {
        return { text: `Usage: /german show <de|en|mix>. Now: ${settings.direction}.` }
      }
      await ops.setDirection(direction)
      const what = direction === 'mix' ? 'German or EN/RU first, mixed' : `${DIRECTION_HINT[direction]}`
      return { text: `German cards: flip cards show ${what}.` }
    }
    if (word === 'level') {
      const level = LEVEL_NAMES.find(one => one.toLowerCase() === key)
      if (level === undefined) {
        return { text: `Usage: /german level <a1|a2|b1>. Now: ${settings.level}.` }
      }
      await ops.chooseLevel(level)
      return { text: `German cards: Goethe ${level}, ${LEVELS[level].length} words.` }
    }
    if (word === 'stats') {
      const s = ops.overall()
      return {
        text: `German ${settings.level}: ${s.learning} learning, ${s.mastered} mastered, ${s.retired} retired, ${s.unseen} not seen yet (of ${LEVELS[settings.level].length}).`,
      }
    }
    // Two steps, so a typo cannot delete progress.
    if (word === 'reset') {
      const now = await $.clock.now()
      if (key === 'confirm') {
        if (now - resetAskedAt > RESET_WINDOW) {
          return { text: 'Nothing to confirm. Run /german reset first.' }
        }
        resetAskedAt = -Infinity
        await ops.resetProgress()
        return { text: 'German cards: all progress deleted. Settings are kept.' }
      }
      resetAskedAt = now
      const seen = Object.keys(progress).length
      return {
        text:
          `This deletes your progress for all levels (${seen} words seen). Settings are kept.\n` +
          'To confirm, run /german reset confirm within 60 seconds.',
      }
    }
    if (word === 'set') {
      const fields: Record<string, keyof Settings> = {
        seconds: 'minSeconds',
        tools: 'minTools',
        reopen: 'reopenSeconds',
        stats: 'statsSeconds',
      }
      const field = fields[key]
      const n = Number(raw)
      if (field === undefined || !Number.isFinite(n) || n < 0) {
        return { text: 'Usage: /german set <seconds|tools|reopen|stats> <number>' }
      }
      settings = { ...settings, [field]: n }
      await ops.saveSettings()
      return { text: `German cards: ${key} = ${n}.` }
    }
    const s = settings
    return {
      text:
        `German cards are ${s.isEnabled ? 'on' : 'off'}, level ${s.level}, ${s.mode} mode, cards ${s.direction} (${DIRECTION_HINT[s.direction]}). ` +
        `The pane opens after ${s.minSeconds}s of work ` +
        `(an edit/command, or ${s.minTools}+ tool calls); again at once within ${s.reopenSeconds}s; ` +
        `stats show ${s.statsSeconds}s before it closes.\n` +
        'Usage: /german [level <a1|a2|b1>|on|off|flip|type|show <de|en|mix>|stats|reset|set <seconds|tools|reopen|stats> <n>]',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await read($, view)
    const { Box, Text, Button } = $.ui.resolve(e)
    if (v === null) return <Text dimColor>Loading…</Text>
    isFocused = e.props.isFocused
    const c = v.isDark ? PALETTE.dark : PALETTE.light
    const width = Math.max(10, e.props.bodyColumns - 2)
    const isWide = e.props.bodyColumns >= WIDE
    const t = v.tally

    const rule = <Text color={c.line}>{'─'.repeat(width)}</Text>
    const spread = (left: JSX.Element, right: JSX.Element) => (
      <Box flexDirection="row" justifyContent="space-between">
        {left}
        {right}
      </Box>
    )
    const title = (
      <Text color={c.text}>
        Deutsch · Goethe {v.level}
        {v.mode === 'flip' ? ` · ${DIRECTION_HINT[v.direction ?? 'de']}` : ''}
      </Text>
    )

    // No buttons and no input: keys do nothing until the pane closes.
    if (v.phase === 'asking') {
      return (
        <Box flexDirection="column" paddingX={1}>
          {title}
          {rule}
          <Text> </Text>
          <Text color={c.warn} bold>
            Claude needs your answer — returning…
          </Text>
        </Box>
      )
    }

    if (v.phase === 'stats') {
      const n = answered(t)
      return (
        <Box flexDirection="column" paddingX={1}>
          {spread(title, <Text color={c.dim}>✓ Claude Code finished</Text>)}
          {rule}
          <Text> </Text>
          <Text color={c.text} bold>
            {n === 0 ? 'No words this time.' : 'A little further along.'}
          </Text>
          <Text> </Text>
          {spread(<Text color={c.text}>Words reviewed</Text>, <Text color={c.text}>{n}</Text>)}
          {spread(
            <Text color={c.text}>Know / don't know / hidden</Text>,
            <Text color={c.text}>
              {t.known} / {t.missed + t.almost} / {t.retired}
            </Text>,
          )}
          {spread(<Text color={c.text}>Progress</Text>, <Text color={c.good}>saved ✓</Text>)}
          <Text> </Text>
          {rule}
          <Text color={c.dim}>Returning to Claude Code in {v.secondsLeft ?? 0}s…</Text>
        </Box>
      )
    }

    const footer = (
      <Box flexDirection="column">
        {rule}
        {spread(
          <Text color={c.dim}>{v.isStudy ? 'Studying' : 'Claude Code is working…'}</Text>,
          <Text color={c.dim}>{answered(t) > 0 ? '✓ progress saved' : ''}</Text>,
        )}
        {spread(
          <Button key="undo" plain hotkey="u" dimColor onPress={() => void ops?.undo()}>
            {v.canUndo ? 'undo last answer' : 'nothing to undo'}
          </Button>,
          <Button key="quit" plain hotkey="q" dimColor onPress={() => void ops?.quit()}>
            save & exit
          </Button>,
        )}
        {spread(
          <Button key="mode" plain hotkey="t" dimColor onPress={() => void ops?.setMode(v.mode === 'flip' ? 'type' : 'flip')}>
            {v.mode === 'flip' ? 'typing mode' : 'card mode'}
          </Button>,
          e.props.isFocused ? <Text> </Text> : <Text color={c.dim}>ctrl+x tab to answer</Text>,
        )}
      </Box>
    )
    const header = (
      <Box flexDirection="column">
        {spread(title, <Text color={c.dim}>
          {v.due} due · {t.fresh} new
        </Text>)}
        <Text color={c.dim}>
          {LEVEL_HINT[v.level]} · switch: /german level{' '}
          {LEVEL_NAMES.filter(one => one !== v.level).map(one => one.toLowerCase()).join('|')}
        </Text>
        {rule}
        <Text> </Text>
      </Box>
    )
    const row = BY_ID.get(v.wordId)

    if (v.phase === 'empty' || row === undefined) {
      return (
        <Box flexDirection="column" paddingX={1}>
          {header}
          <Text color={c.good}>Nothing to review right now. Sehr gut!</Text>
          <Text> </Text>
          {footer}
        </Box>
      )
    }

    const [, de, answers, en, ru, examples] = row
    const word = headline(de)
    const exampleLines = examples.map(text => (
      <Text color={c.dim} italic>
        {text}
      </Text>
    ))
    const option = (key: string, hotkey: string, label: string, hint: string, g: Grade) => (
      <Box
        key={`box-${key}`}
        borderStyle="round"
        borderColor={c.line}
        paddingX={1}
        flexDirection="column"
        flexGrow={1}
      >
        <Button key={key} plain hotkey={hotkey} onPress={() => void ops?.answer(g)}>
          {label}
        </Button>
        <Text color={c.dim}>{hint}</Text>
      </Box>
    )

    if (v.mode === 'type') {
      const typed = v.typed
      const table = $.ui.resolve(e)
      const Input = 'Input' in table ? table.Input : undefined
      const field =
        typed === undefined && Input !== undefined ? (
          <Input
            key="answer"
            autoFocus
            placeholder="auf Deutsch, mit Artikel"
            submitLabel="check"
            onSubmit={(text: string) => {
              const check = checkAnswer(text, answers)
              const g: Grade = check.verdict === 'correct' ? 'know' : check.verdict === 'almost' ? 'almost' : 'dontKnow'
              void ops?.answer(g, { text, ...check })
            }}
          />
        ) : null
      const verdict =
        typed === undefined ? null : typed.verdict === 'correct' ? (
          <Text color={c.good} bold>
            ✓ Richtig
          </Text>
        ) : typed.verdict === 'almost' ? (
          <Text color={c.warn} bold>
            ≈ Fast — {typed.note}
          </Text>
        ) : (
          <Text color={c.bad} bold>
            ✗ {typed.text.trim() === '' ? 'Skipped' : `Not quite: ${typed.text}`}
          </Text>
        )
      return (
        <Box flexDirection="column" paddingX={1}>
          {header}
          <Text color={c.dim}>{v.label}</Text>
          <Text color={c.text} bold>
            {en}
          </Text>
          <Text color={c.accent}>{ru}</Text>
          <Text> </Text>
          {field}
          {verdict}
          {typed !== undefined && (
            <Text color={c.text} bold>
              {word.title}
            </Text>
          )}
          {typed !== undefined && word.sub !== '' && <Text color={c.dim}>{word.sub}</Text>}
          {typed !== undefined && exampleLines}
          <Text> </Text>
          <Box flexDirection="row" gap={3}>
            {typed === undefined ? (
              <Button key="skip" plain hotkey="s" onPress={() => void ops?.answer('dontKnow', { text: '', verdict: 'wrong' })}>
                show answer
              </Button>
            ) : (
              <Button key="next" plain hotkey="w" onPress={() => void ops?.advance()}>
                next word
              </Button>
            )}
            <Button key="retire" plain hotkey="h" dimColor onPress={() => void ops?.answer('retire')}>
              don't show again
            </Button>
          </Box>
          <Text> </Text>
          {footer}
        </Box>
      )
    }

    const german = [
      <Text color={c.text} bold>
        {word.title}
      </Text>,
      word.sub !== '' && <Text color={c.dim}>{word.sub}</Text>,
    ]
    const meaning = [
      <Text color={c.text} bold>
        {en}
      </Text>,
      <Text color={c.accent}>{ru}</Text>,
    ]
    const isGermanFront = v.front !== 'en'
    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        <Text color={c.dim}>{v.label}</Text>
        {isGermanFront ? german : meaning}
        <Text> </Text>
        {v.isRevealed ? (
          <Box flexDirection="column">
            {isGermanFront ? meaning : german}
            <Text> </Text>
            {exampleLines}
            <Box flexDirection={isWide ? 'row' : 'column'} columnGap={1}>
              {option('know', 'k', 'Know', v.nextLabel, 'know')}
              {option('dont', 'd', "Don't know", 'repeat this session', 'dontKnow')}
              {option('retire', 'h', "Don't show again", 'remove from reviews', 'retire')}
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text color={c.dim}>
              {isGermanFront ? 'Recall the meaning before revealing.' : 'Recall the German word (with article) before revealing.'}
            </Text>
            <Text> </Text>
            <Box flexDirection="row">
              <Box borderStyle="round" borderColor={c.line} paddingX={1}>
                <Button key="show" plain hotkey="s" onPress={() => void ops?.reveal()}>
                  {isGermanFront ? 'Reveal meaning' : 'Reveal German'}
                </Button>
              </Box>
            </Box>
          </Box>
        )}
        <Text color={c.dim}>Your progress saves after every answer.</Text>
        <Text> </Text>
        {footer}
      </Box>
    )
  })
}
