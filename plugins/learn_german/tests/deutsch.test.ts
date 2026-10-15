import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import { headline } from '../hooks/format'
import { LEVELS } from '../hooks/levels'
import { checkAnswer, grade, pickNext, DAY } from '../hooks/srs'
import { WORDS } from '../hooks/words'

const SEC = 1000

// The engine beneath the plugin: records pane opens and closes. The store
// starts empty unless a test gives its own.
function world(on: On, store: Record<string, unknown> = {}) {
  const clock = mock.clock(on)
  mock.store(on, store)
  const panes: string[] = []
  // Subagents the engine reports; a test sets their status.
  const agents: { id: string; description: string; type: string; status: string }[] = []
  on('session.start', () => ({ cwd: '/tmp' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('config.list', () => ({ value: [] }))
  on('agent.list', () => ({ value: agents.map(a => ({ ...a })) }) as never)
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('ui.open', () => {
    panes.push('open')
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => {
    panes.push('close')
    return { value: undefined }
  })
  on('ui.render', () => {
    throw new Error('the plugin did not draw its pane')
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }) as never)
  on('classic.PermissionRequest', () => ({}) as never)
  on('tool.check', () => ({ decision: 'ask' }) as never)
  return { clock, panes, agents }
}

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const done = (turnId: string) => ({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' }) as const
const read = { tool: 'Read', file_path: '/tmp/a' } as never
const edit = { tool: 'Edit', file_path: '/tmp/a', old_string: 'a', new_string: 'b' } as never

describe('when the pane opens', () => {
  test('a turn that only thinks and answers never opens it', async ($, on) => {
    const { clock, panes } = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'what do you think?', turnId: 't1' })
    await clock.advance(40 * SEC)
    await $.turn.complete(done('t1'))
    await clock.advance(5 * SEC)
    expect(panes).toEqual([])
  })

  test('a work turn opens it after 20 s and closes it 3 s after Claude is done', async ($, on) => {
    const { clock, panes } = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call(read)
    await clock.advance(10 * SEC)
    await $.tool.call(edit)
    expect(panes).toEqual([])
    await clock.advance(12 * SEC)
    expect(panes).toEqual(['open'])
    await $.turn.complete(done('t1'))
    await clock.advance(2 * SEC)
    expect(panes).toEqual(['open'])
    await clock.advance(1.5 * SEC)
    expect(panes).toEqual(['open', 'close'])
  })

  test('/german set stats changes how long the stats stay', async ($, on) => {
    const { clock, panes } = world(on)
    await $.session.start(START)
    await $.command.run({ command: 'german', args: 'set stats 5' } as never)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call(edit)
    await clock.advance(22 * SEC)
    await $.turn.complete(done('t1'))
    await clock.advance(4 * SEC)
    expect(panes).toEqual(['open'])
    await clock.advance(1.5 * SEC)
    expect(panes).toEqual(['open', 'close'])
  })

  test('reads alone open it only from the third tool call', async ($, on) => {
    const { clock, panes } = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'look around', turnId: 't1' })
    await clock.advance(25 * SEC)
    await $.tool.call(read)
    await $.tool.call(read)
    expect(panes).toEqual([])
    await $.tool.call(read)
    expect(panes).toEqual(['open'])
  })

  test('a permission dialog hides it until the tool call is answered', async ($, on) => {
    const { clock, panes } = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call(edit)
    await clock.advance(22 * SEC)
    expect(panes).toEqual(['open'])
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } } as never)
    expect(panes).toEqual(['open', 'close'])
    await clock.advance(4 * SEC)
    expect(panes).toEqual(['open', 'close'])
    await $.tool.call(edit)
    expect(panes).toEqual(['open', 'close', 'open'])
  })

  test('a work turn right after the pane closed opens it at once', async ($, on) => {
    const { clock, panes } = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call(edit)
    await clock.advance(22 * SEC)
    await $.turn.complete(done('t1'))
    await clock.advance(3.5 * SEC)
    expect(panes).toEqual(['open', 'close'])
    await $.turn.start({ text: 'and this', turnId: 't2' })
    await clock.advance(1 * SEC)
    await $.tool.call(edit)
    expect(panes).toEqual(['open', 'close', 'open'])
  })

  test('/german off keeps it closed', async ($, on) => {
    const { clock, panes } = world(on)
    await $.session.start(START)
    await $.command.run({ command: 'german', args: 'off' } as never)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call(edit)
    await clock.advance(30 * SEC)
    expect(panes).toEqual([])
  })
})

describe('studying', () => {
  test('an answer is kept as progress', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.command.run({ command: 'german', args: '' } as never)
    const ui = await $.ui.mount({
      plugin: 'learn_german',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'learn_german',
      props: { title: 'Deutsch', isFocused: true, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } as never,
    })
    await ui.press({ key: 'show' })
    await ui.press({ key: 'know' })
    await ui.press({ key: 'show' })
    await ui.press({ key: 'retire' })
    const stats = await $.command.run({ command: 'german', args: 'stats' } as never)
    expect(stats.text).toContain('1 learning')
    expect(stats.text).toContain('1 retired')
    await ui.unmount()
  })
  test('typing mode checks the answer and shows the right word', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.command.run({ command: 'german', args: 'type' } as never)
    await $.command.run({ command: 'german', args: '' } as never)
    const ui = await $.ui.mount({
      plugin: 'learn_german',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'learn_german',
      props: { title: 'Deutsch', isFocused: true, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } as never,
    })
    await ui.input({ key: 'answer', text: 'qqqq' })
    expect(await ui.find({ type: 'Text', text: /Not quite: qqqq/ })).toBeDefined()
    const stats = await $.command.run({ command: 'german', args: 'stats' } as never)
    expect(stats.text).toContain('1 learning')
    await ui.unmount()
  })
  test('undo takes back the last answer, a hidden word included', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.command.run({ command: 'german', args: '' } as never)
    const ui = await $.ui.mount({
      plugin: 'learn_german',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'learn_german',
      props: { title: 'Deutsch', isFocused: true, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
    })
    await ui.press({ key: 'show' })
    await ui.press({ key: 'know' })
    await ui.press({ key: 'show' })
    await ui.press({ key: 'retire' })
    await ui.press({ key: 'undo' })
    let stats = await $.command.run({ command: 'german', args: 'stats' } as never)
    expect(stats.text).toContain('1 learning, 0 mastered, 0 retired')
    expect(await ui.find({ key: 'retire' })).toBeDefined()
    await ui.press({ key: 'undo' })
    stats = await $.command.run({ command: 'german', args: 'stats' } as never)
    expect(stats.text).toContain('0 learning, 0 mastered, 0 retired')
    await ui.unmount()
  })

  test('"don\'t show again" after a typed answer replaces its grade', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.command.run({ command: 'german', args: 'type' } as never)
    await $.command.run({ command: 'german', args: '' } as never)
    const ui = await $.ui.mount({
      plugin: 'learn_german',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'learn_german',
      props: { title: 'Deutsch', isFocused: true, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
    })
    await ui.input({ key: 'answer', text: 'qqqq' })
    await ui.press({ key: 'retire' })
    let stats = await $.command.run({ command: 'german', args: 'stats' } as never)
    expect(stats.text).toContain('0 learning, 0 mastered, 1 retired')
    await ui.press({ key: 'undo' })
    stats = await $.command.run({ command: 'german', args: 'stats' } as never)
    expect(stats.text).toContain('0 learning, 0 mastered, 0 retired')
    await ui.unmount()
  })

  test('a word missed in one round comes back first when due in the next', async ($, on) => {
    const { clock } = world(on)
    const pane = () =>
      $.ui.mount({
        plugin: 'learn_german',
        surface: 'terminal',
        component: 'Pane',
        requestId: 'learn_german',
        props: { title: 'Deutsch', isFocused: true, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
      })
    await $.session.start(START)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call(edit)
    await clock.advance(22 * SEC)
    let ui = await pane()
    await ui.press({ key: 'show' })
    await ui.press({ key: 'dont' })
    await ui.unmount()
    await $.turn.complete(done('t1'))
    await clock.advance(11 * 60 * SEC)
    await $.turn.start({ text: 'and this', turnId: 't2' })
    await $.tool.call(edit)
    await clock.advance(22 * SEC)
    ui = await pane()
    expect(await ui.find({ type: 'Text', text: /^REVIEW/ })).toBeDefined()
    await ui.unmount()
  })

  test('q closes the pane for the rest of the turn', async ($, on) => {
    const { clock, panes } = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call(edit)
    await clock.advance(22 * SEC)
    const ui = await $.ui.mount({
      plugin: 'learn_german',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'learn_german',
      props: { title: 'Deutsch', isFocused: true, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never,
    })
    await ui.press({ key: 'quit' })
    await $.tool.call(edit)
    await clock.advance(10 * SEC)
    expect(panes).toEqual(['open', 'close'])
    await ui.unmount()
  })
})

const PANE_PROPS = { title: 'Deutsch', isFocused: true, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } }

describe('levels', () => {
  test('a new install learns A1 and the pane shows how to switch', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.command.run({ command: 'german', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'learn_german', surface: 'terminal', component: 'Pane', requestId: 'learn_german', props: PANE_PROPS as never })
    expect(await ui.find({ type: 'Text', text: /Goethe A1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /switch: \/german level a2\|b1/ })).toBeDefined()
    await ui.press({ key: 'show' })
    await ui.press({ key: 'know' })
    const stats = await $.command.run({ command: 'german', args: 'stats' } as never)
    expect(stats.text).toContain('German A1: 1 learning')
    expect(stats.text).toContain(`(of ${LEVELS.A1.length})`)
    await ui.unmount()
  })

  test('/german level switches the list and keeps progress per word', async ($, on) => {
    world(on, { settings: { level: 'B1' }, progress: { 5: [1, 0, 1, 0] } })
    await $.session.start(START)
    const reply = await $.command.run({ command: 'german', args: 'level a2' } as never)
    expect(reply.text).toContain(`Goethe A2, ${LEVELS.A2.length} words`)
    const stats = await $.command.run({ command: 'german', args: 'stats' } as never)
    // Row 5, "abfahren", is on both lists.
    expect(stats.text).toContain('German A2: 1 learning')
    const bad = await $.command.run({ command: 'german', args: 'level c1' } as never)
    expect(bad.text).toContain('Usage: /german level')
  })

  test('every level names existing rows, and row ids are unique', () => {
    const ids = new Set(WORDS.map(row => row[0]))
    expect(ids.size).toBe(WORDS.length)
    for (const list of Object.values(LEVELS)) for (const id of list) expect(ids.has(id)).toBe(true)
  })
})

describe('keys and card side', () => {
  const mount = ($: any) =>
    $.ui.mount({ plugin: 'learn_german', surface: 'terminal', component: 'Pane', requestId: 'learn_german', props: PANE_PROPS as never })
  // Claude's dialogs take digits, Enter, Esc, Tab, Space, arrows and y/n: the pane uses other letters.
  const isSafe = (key: unknown) => typeof key === 'string' && /^[a-z]$/.test(key) && !'yn'.includes(key)

  test('flip mode answers with k, d and h', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.command.run({ command: 'german', args: '' } as never)
    const ui = await mount($)
    await ui.press({ key: 'show' })
    expect((await ui.find({ key: 'know' }))?.props.hotkey).toBe('k')
    expect((await ui.find({ key: 'dont' }))?.props.hotkey).toBe('d')
    expect((await ui.find({ key: 'retire' }))?.props.hotkey).toBe('h')
    for (const one of await ui.findAll({ type: 'Button' })) expect(isSafe(one.props.hotkey)).toBe(true)
    await ui.unmount()
  })

  test('typing mode uses s, w and h', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.command.run({ command: 'german', args: 'type' } as never)
    await $.command.run({ command: 'german', args: '' } as never)
    const ui = await mount($)
    expect((await ui.find({ key: 'skip' }))?.props.hotkey).toBe('s')
    expect((await ui.find({ key: 'retire' }))?.props.hotkey).toBe('h')
    await ui.input({ key: 'answer', text: 'qqqq' })
    expect((await ui.find({ key: 'next' }))?.props.hotkey).toBe('w')
    for (const one of await ui.findAll({ type: 'Button' })) expect(isSafe(one.props.hotkey)).toBe(true)
    await ui.unmount()
  })

  test('/german show en puts the meaning first and the German word after reveal', async ($, on) => {
    world(on)
    await $.session.start(START)
    const reply = await $.command.run({ command: 'german', args: 'show en' } as never)
    expect(reply.text).toContain('EN/RU → DE')
    await $.command.run({ command: 'german', args: '' } as never)
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: /Recall the German word/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /EN\/RU → DE/ })).toBeDefined()
    await ui.press({ key: 'show' })
    expect(await ui.find({ key: 'know' })).toBeDefined()
    await ui.unmount()
  })

  test('/german show keeps the side in settings and rejects other values', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.command.run({ command: 'german', args: 'show mix' } as never)
    const help = await $.command.run({ command: 'german', args: 'help' } as never)
    expect(help.text).toContain('cards mix')
    const bad = await $.command.run({ command: 'german', args: 'show ru' } as never)
    expect(bad.text).toContain('Usage: /german show <de|en|mix>. Now: mix.')
  })

  test('saved settings without a side show German first', async ($, on) => {
    world(on, { settings: { level: 'A2' } })
    await $.session.start(START)
    await $.command.run({ command: 'german', args: '' } as never)
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: /Recall the meaning/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /DE → EN\/RU/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('reset', () => {
  const PROGRESS = { progress: { 5: [1, 0, 1, 0] } }
  const run = ($: any, args: string) => $.command.run({ command: 'german', args } as never)

  test('/german reset alone only asks, and keeps the progress', async ($, on) => {
    world(on, PROGRESS)
    await $.session.start(START)
    const asked = await run($, 'reset')
    expect(asked.text).toContain('/german reset confirm')
    expect((await run($, 'stats')).text).toContain('1 learning')
  })

  test('confirm without a reset request, or too late, keeps the progress', async ($, on) => {
    const { clock } = world(on, PROGRESS)
    await $.session.start(START)
    expect((await run($, 'reset confirm')).text).toContain('Nothing to confirm')
    await run($, 'reset')
    await clock.advance(61 * SEC)
    expect((await run($, 'reset confirm')).text).toContain('Nothing to confirm')
    expect((await run($, 'stats')).text).toContain('1 learning')
  })

  test('reset, then confirm in time, deletes the progress and keeps the settings', async ($, on) => {
    world(on, { ...PROGRESS, settings: { level: 'A2' } })
    await $.session.start(START)
    await run($, 'reset')
    expect((await run($, 'reset confirm')).text).toContain('all progress deleted')
    const stats = (await run($, 'stats')).text
    expect(stats).toContain('German A2: 0 learning')
    // A second confirm needs a new request.
    expect((await run($, 'reset confirm')).text).toContain('Nothing to confirm')
  })
})

describe('the word line', () => {
  const cases: [string, string, string][] = [
    ['die Entscheidung, -en', 'die Entscheidung', 'plural: die Entscheidungen'],
    ['der Apfel, ¨-', 'der Apfel', 'plural: die Äpfel'],
    ['das Haus, ¨-er', 'das Haus', 'plural: die Häuser'],
    ['das Konto, Konten', 'das Konto', 'plural: die Konten'],
    ['abbiegen, biegt ab, bog ab, ist abgebogen', 'abbiegen', 'biegt ab · bog ab · ist abgebogen'],
  ]
  for (const [head, title, sub] of cases) {
    test(`"${head}" shows "${title}" over "${sub}"`, () => {
      expect(headline(head)).toEqual({ title, sub })
    })
  }
})

describe('typed answers', () => {
  const cases: [string, string[], string][] = [
    ['die Abfahrt', ['die Abfahrt'], 'correct'],
    ['Die  abfahrt.', ['die Abfahrt'], 'correct'],
    ['die strasse', ['die Straße'], 'correct'],
    ['anziehen', ['(sich) anziehen'], 'correct'],
    ['die Lehrerin', ['der Lehrer', 'die Lehrerin'], 'correct'],
    ['Abfahrt', ['die Abfahrt'], 'almost'],
    ['der Abfahrt', ['die Abfahrt'], 'almost'],
    ['die Abfart', ['die Abfahrt'], 'almost'],
    ['der Bahnhof', ['die Abfahrt'], 'wrong'],
    ['', ['die Abfahrt'], 'wrong'],
  ]
  for (const [typed, answers, verdict] of cases) {
    test(`"${typed}" for ${answers.join(' / ')} is ${verdict}`, () => {
      expect(checkAnswer(typed, answers).verdict).toBe(verdict)
    })
  }
})

describe('scheduling', () => {
  test('known words wait longer each time, missed words come back soon', () => {
    const now = 0
    let card = grade(undefined, 'know', now)
    const waits = [card[1]]
    for (let i = 0; i < 5; i++) {
      card = grade(card, 'know', now)
      waits.push(card[1])
    }
    expect(waits).toEqual([1, 3, 7, 14, 30, 30].map(n => n * DAY))
    expect(grade(card, 'dontKnow', now)[1]).toBeLessThan(DAY)
  })

  test('due words come before new ones, and retired words never come back', () => {
    const now = 10 * DAY
    const progress = { 1: grade(undefined, 'know', 0), 2: grade(undefined, 'retire', 0) }
    expect(pickNext([1, 2, 3], progress, now, 0, [])).toBe(1)
    expect(pickNext([2, 3], progress, now, 0, [])).toBe(3)
    expect(pickNext([2], progress, now, 0, [])).toBeUndefined()
  })

  test('a missed word returns after a few other cards', () => {
    const progress = {}
    expect(pickNext([1, 2, 3], progress, 0, 1, [[1, 5]], 2)).toBe(3)
    expect(pickNext([1, 2, 3], progress, 0, 5, [[1, 5]], 3)).toBe(1)
  })
})

describe('when Claude asks the person', () => {
  const ask = { tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'u1' } as never

  async function workingPane($: Engine, clock: MockClock) {
    await $.session.start(START)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call(edit)
    await clock.advance(22 * SEC)
  }

  test('a focused pane shows a screen without keys for 1.5 s, then closes', async ($, on) => {
    const { clock, panes } = world(on)
    await workingPane($, clock)
    expect(panes).toEqual(['open'])
    const ui = await $.ui.mount({ plugin: 'learn_german', surface: 'terminal', component: 'Pane', requestId: 'learn_german', props: PANE_PROPS as never })
    const check = $.tool.check(ask)
    await clock.advance(0)
    expect(panes).toEqual(['open'])
    expect(await ui.find({ type: 'Text', text: /Claude needs your answer/ })).toBeDefined()
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await clock.advance(1.5 * SEC)
    expect((await check).decision).toBe('ask')
    expect(panes).toEqual(['open', 'close'])
    await ui.unmount()
  })

  test('a pane without focus closes at once', async ($, on) => {
    const { clock, panes } = world(on)
    await workingPane($, clock)
    await $.tool.check(ask)
    expect(panes).toEqual(['open', 'close'])
  })

  test('the pane opens again with the same tally after the answer', async ($, on) => {
    const { clock, panes } = world(on)
    await workingPane($, clock)
    const ui = await $.ui.mount({ plugin: 'learn_german', surface: 'terminal', component: 'Pane', requestId: 'learn_german', props: PANE_PROPS as never })
    await ui.press({ key: 'show' })
    await ui.press({ key: 'know' })
    const check = $.tool.check(ask)
    await clock.advance(1.5 * SEC)
    await check
    await $.tool.call(edit)
    expect(panes).toEqual(['open', 'close', 'open'])
    expect(await ui.find({ type: 'Text', text: /Claude needs your answer/ })).toBeUndefined()
    // The round's tally stayed: the footer still counts the answer.
    expect(await ui.find({ type: 'Text', text: /progress saved/ })).toBeDefined()
    await ui.unmount()
  })

  test('a check with no call behind it does not close the pane', async ($, on) => {
    const { clock, panes } = world(on)
    await workingPane($, clock)
    await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
    expect(panes).toEqual(['open'])
  })
})

describe('with subagents and auto mode', () => {
  test('a background subagent keeps the pane open after the main turn ends', async ($, on) => {
    const { clock, panes, agents } = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call(edit)
    agents.push({ id: 'a1', description: 'implement', type: 'general-purpose', status: 'running' })
    await clock.advance(22 * SEC)
    expect(panes).toEqual(['open'])
    await $.turn.complete(done('t1'))
    await clock.advance(30 * SEC)
    expect(panes).toEqual(['open'])
    agents[0]!.status = 'completed'
    await clock.advance(6 * SEC)
    expect(panes).toEqual(['open', 'close'])
  })

  test("a subagent's turn does not restart the main turn's clock", async ($, on) => {
    const { clock, panes } = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call(edit)
    await clock.advance(15 * SEC)
    await $.turn.start({ text: 'sub', turnId: 's1', agentId: 'a1' })
    await clock.advance(6 * SEC)
    expect(panes).toEqual(['open'])
  })

  test('in auto mode a classifier check does not close the pane', async ($, on) => {
    const { clock, panes } = world(on)
    await $.session.start(START)
    await $.classic.UserPromptSubmit({ prompt: 'fix it', permission_mode: 'auto' } as never)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call(edit)
    await clock.advance(22 * SEC)
    await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1' })
    expect(panes).toEqual(['open'])
    // The classifier hands it to the person: the dialog closes the pane.
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'auto' } as never)
    expect(panes).toEqual(['open', 'close'])
  })
})
