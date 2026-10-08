import { searchTerminalHistory, validHistoryQuery, type HistorySearch } from '../core/terminal-history'

interface RetainedGeneration {
  generation: string
  exited: boolean
  retiring: boolean
  historyText(): Promise<string>
}

/** The additive history extension refuses absent/replaced generations instead of empty success. */
export async function searchRetainedGeneration(resolve: () => RetainedGeneration | undefined, generation: string, query: string): Promise<HistorySearch> {
  if (!validHistoryQuery(query)) throw new Error('Enter a single-line search of 1–256 characters.')
  const current = resolve()
  if (!current || current.exited || current.retiring || current.generation !== generation) throw new Error('This retained terminal generation is no longer available.')
  const text = await current.historyText()
  if (resolve() !== current || current.exited || current.retiring) throw new Error('The retained terminal changed while its history was captured.')
  return searchTerminalHistory(text, query)
}
