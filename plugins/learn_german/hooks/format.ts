// Splits a Wortliste headword ("der Abfall, ¨-e", "abbiegen, biegt ab, …")
// into the word to show big and the line under it (plural or verb forms).

const UMLAUT: Record<string, string> = { a: 'ä', o: 'ö', u: 'ü', A: 'Ä', O: 'Ö', U: 'Ü' }

function umlaut(word: string): string {
  const au = word.lastIndexOf('au')
  const vowel = Math.max(...['a', 'o', 'u', 'A', 'O', 'U'].map(v => word.lastIndexOf(v)))
  if (au >= 0 && au >= vowel - 1) return word.slice(0, au) + 'äu' + word.slice(au + 2)
  if (vowel < 0) return word
  return word.slice(0, vowel) + (UMLAUT[word[vowel] ?? ''] ?? '') + word.slice(vowel + 1)
}

// The plural of a noun from its list notation: "-en", "¨-e", "-", "Konten".
export function plural(noun: string, spec: string): string {
  const first = (spec.split('/')[0] ?? '').trim()
  if (!/^¨?-/.test(first)) return first
  const stem = first.startsWith('¨') ? umlaut(noun) : noun
  return stem + first.replace(/^¨?-/, '')
}

const ARTICLE = /^(der|die|das)\s+(\S+)$/

export function headline(head: string): { title: string; sub: string } {
  const alternatives = head.split(' / ')
  const parts = (alternatives[0] ?? head).split(',').map(part => part.trim())
  const lemma = parts[0] ?? head
  const rest = parts.slice(1).filter(part => part !== '')
  const title = alternatives.map(alt => (alt.split(',')[0] ?? alt).trim()).join(' / ')
  if (/\((nur )?Pl(\.|ural)\)/.test(lemma)) return { title: lemma.replace(/\s*\((nur )?Pl(\.|ural)\)/, ''), sub: 'plural only' }
  const noun = lemma.match(ARTICLE)
  if (noun !== null) {
    const spec = rest[0]
    return { title, sub: spec === undefined ? '' : `plural: die ${plural(noun[2] ?? '', spec)}` }
  }
  return { title, sub: rest.join(' · ') }
}
