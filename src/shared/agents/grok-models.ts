/**
 * Native Grok CLI models (`grok --model` / `-m`).
 *
 * Not the Bifrost/LiteLLM gateway catalogue — grok is not in MODEL_SWITCH_CAPABLE
 * because that list also means "we know how to configure this harness's gateway
 * protocol". Grok talks to xAI directly. The flag is still real: measured on the
 * shipped binary (`grok --help` → `-m, --model <MODEL>`).
 *
 * `grok models` on 2026-09-09 listed `grok-4.6` as the account default. Extra ids
 * are the public grok.com names; an unknown id is the CLI's error, not ours to
 * guess around.
 */
export const GROK_MODELS = [
  { id: 'grok-4.6', label: 'Grok 4.6' },
  { id: 'grok-4', label: 'Grok 4' },
  { id: 'grok-3', label: 'Grok 3' },
  { id: 'grok-3-mini', label: 'Grok 3 Mini' }
] as const

export const DEFAULT_GROK_MODEL = 'grok-4.6'

export type GrokModelId = (typeof GROK_MODELS)[number]['id']
