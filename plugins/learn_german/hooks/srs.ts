// Leitner-style spaced repetition and answer checking. Pure functions only:
// the hooks module owns $.store and the clock.

export const DAY = 24 * 60 * 60 * 1000

// Box -> wait before the next review. Box 0 is "relearn": back in this session.
export const INTERVALS = [10 * 60 * 1000, 1 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY]
export const MAX_BOX = INTERVALS.length - 1
export const RETIRED = -1

function wait(box: number): number {
  return INTERVALS[box] ?? DAY
}

// One word's record: [box, due timestamp, times seen, last seen timestamp].
export type Card = [number, number, number, number?]
export type Progress = Record<string, Card>

export type Grade = 'know' | 'dontKnow' | 'almost' | 'retire'

export function grade(card: Card | undefined, g: Grade, now: number): Card {
  const seen = (card?.[2] ?? 0) + 1
  if (g === 'retire') return [RETIRED, 0, seen, now]
  const box = card?.[0] ?? -2 // -2: never seen
  if (g === 'dontKnow') return [0, now + wait(0), seen, now]
  if (g === 'almost') {
    const kept = Math.max(0, box)
    return [kept, now + Math.min(wait(kept), DAY), seen, now]
  }
  const next = Math.min(Math.max(box, 0) + 1, MAX_BOX)
  return [next, now + wait(next), seen, now]
}

// Words whose review is due now.
export function dueCount(progress: Progress, now: number): number {
  let count = 0
  for (const card of Object.values(progress)) if (card[0] >= 0 && card[1] <= now) count += 1
  return count
}

// "today", "yesterday", "3 days ago".
export function ago(then: number, now: number): string {
  const days = Math.floor((now - then) / DAY)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
}

// "1 day", "7 days".
export function days(ms: number): string {
  const n = Math.round(ms / DAY)
  return n === 1 ? '1 day' : `${n} days`
}

// Stable pseudo-random order for new words, so the list is not alphabetical.
export function newOrder(id: number): number {
  let x = (id + 1) * 2654435761
  x = (x ^ (x >>> 15)) >>> 0
  return x
}

// A missed word comes back in this session after RELEARN_GAP other cards.
export const RELEARN_GAP = 5

// [word id, the session's card count at which it may come back]
export type Relearn = [number, number]

// Picks the next word id: a missed word whose gap has passed, then the most
// overdue review, then a new word. `shown` counts this session's cards.
export function pickNext(
  ids: readonly number[],
  progress: Progress,
  now: number,
  shown: number,
  relearn: readonly Relearn[],
  current?: number,
): number | undefined {
  const ready = relearn.find(([id, at]) => at <= shown && id !== current)
  if (ready !== undefined) return ready[0]

  const avoid = new Set(relearn.map(([id]) => id))
  if (current !== undefined) avoid.add(current)
  let bestDue: number | undefined
  let bestDueAt = Infinity
  let bestNew: number | undefined
  let bestNewOrder = Infinity
  for (const id of ids) {
    if (avoid.has(id)) continue
    const card = progress[id]
    if (card === undefined) {
      const order = newOrder(id)
      if (order < bestNewOrder) {
        bestNewOrder = order
        bestNew = id
      }
    } else if (card[0] >= 0 && card[1] <= now && card[1] < bestDueAt) {
      bestDueAt = card[1]
      bestDue = id
    }
  }
  return bestDue ?? bestNew ?? relearn.find(([id]) => id !== current)?.[0]
}

export type Verdict = 'correct' | 'almost' | 'wrong'

const ARTICLE = /^(der|die|das)\s+/

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\(sich\)|\bsich\b/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[.,!?;:"'„“”]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim()
}

function withoutUmlauts(text: string): string {
  return text.replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u')
}

export function distance(a: string, b: string): number {
  const row = Uint16Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] ?? 0
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j] ?? 0
      row[j] = Math.min(cur + 1, (row[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return row[b.length] ?? 0
}

export type Check = { verdict: Verdict; note?: string }

// Checks a typed German answer against the accepted forms of one word.
export function checkAnswer(typed: string, answers: readonly string[]): Check {
  const got = normalize(typed)
  if (got === '') return { verdict: 'wrong' }
  let best: Check = { verdict: 'wrong' }
  for (const answer of answers) {
    const want = normalize(answer)
    if (got === want) return { verdict: 'correct' }
    const wantArticle = want.match(ARTICLE)?.[1]
    const gotArticle = got.match(ARTICLE)?.[1]
    const wantWord = want.replace(ARTICLE, '')
    const gotWord = got.replace(ARTICLE, '')
    const tolerance = wantWord.length > 8 ? 2 : 1
    const isWordClose = gotWord === wantWord || distance(gotWord, wantWord) <= tolerance
    if (!isWordClose && withoutUmlauts(gotWord) !== withoutUmlauts(wantWord)) continue
    if (wantArticle !== undefined && gotArticle === undefined) {
      best = { verdict: 'almost', note: `article: ${wantArticle}` }
    } else if (wantArticle !== undefined && gotArticle !== wantArticle) {
      best = { verdict: 'almost', note: `article: ${wantArticle}, not ${gotArticle}` }
    } else if (best.verdict === 'wrong') {
      best = { verdict: 'almost', note: 'spelling' }
    }
  }
  return best
}

// Counts for the stats screen.
export function summary(progress: Progress, total: number) {
  let learning = 0
  let mastered = 0
  let retired = 0
  for (const card of Object.values(progress)) {
    if (card[0] === RETIRED) retired += 1
    else if (card[0] >= 4) mastered += 1
    else learning += 1
  }
  return { learning, mastered, retired, unseen: total - learning - mastered - retired }
}
