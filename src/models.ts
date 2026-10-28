/**
 * Translation between the WorkBuddy catalog and pi-ai model descriptors.
 *
 * One model descriptor points at the real gateway with the real credential;
 * nothing here proxies requests, so streaming, tool calls, images, retries and
 * cancellation stay owned by pi-ai's OpenAI-completions implementation.
 *
 * @module pi-workbuddy-connect/models
 */

import type { Model, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyVariant } from './variants.ts'

/** No per-token pricing is knowable for a credit subscription; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** Separator between a model's name and its credit multiplier. */
const RATE_SEPARATOR = ' · '

/**
 * Reduce an upstream credits string to its language-neutral display form.
 *
 * Some rows report a bare multiplier (`x0.79`) and others append a unit word
 * (`x0.79 credits`); the unit word would pin the display to English.
 */
export function normalizeCredits(credits: string | undefined): string | undefined {
  if (credits === undefined) return undefined
  const trimmed = credits.trim()
  if (trimmed === '' || /^credits?$/iu.test(trimmed)) return undefined
  const bare = trimmed.replace(/\s+credits?$/iu, '').trim()
  return bare === '' ? undefined : bare
}

/**
 * Resolve a model's reasoning capability into pi-ai's `thinkingLevelMap`,
 * every level pinned to its wire spelling or `null`.
 *
 * A level is offered only when the upstream declares it. Undeclared rows get
 * no thinking control at all: their selectable set is client-side knowledge
 * the catalog does not carry, and inventing one would offer levels the
 * upstream may reject.
 *
 * `off` is never offered. The only spelling that would ask the gateway to
 * disable thinking is `reasoning_effort: "off"`, which it rejects with HTTP
 * 400 / code 11133; omission is the one form measured good everywhere, and
 * an `Off` entry that silently omits the field would claim a behavior the
 * extension cannot request. The request normalizer strips the spelling as a
 * second gate.
 */
export function reasoningFields(
  info: WorkBuddyModelInfo,
): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  const reasoning = info.reasoning
  if (reasoning === undefined || !reasoning.supports) return { reasoning: false }
  const efforts = reasoning.supportedEfforts
  if (efforts === undefined || efforts.length === 0) return { reasoning: false }
  const map: Record<ModelThinkingLevel, string | null> = {
    off: null,
    // `minimal` is not in the upstream effort vocabulary, so no declared set
    // can contain it.
    minimal: null,
    low: efforts.includes('low') ? 'low' : null,
    medium: efforts.includes('medium') ? 'medium' : null,
    high: efforts.includes('high') ? 'high' : null,
    xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
    max: efforts.includes('max') ? 'max' : null,
  }
  return { reasoning: true, thinkingLevelMap: map as ThinkingLevelMap }
}

/**
 * The catalog display name: the upstream name plus its credit multiplier.
 *
 * The multiplier rides the *name* because that is the field both the `/model`
 * picker and the footer render. It is display-only: the wire request is built
 * from `model.id`, and nothing resolves a model by name.
 */
export function displayName(info: WorkBuddyModelInfo): string {
  const credits = normalizeCredits(info.credits)
  return credits === undefined ? info.name : `${info.name}${RATE_SEPARATOR}${credits}`
}

/**
 * Compatibility flags for the WorkBuddy gateway, measured rather than assumed.
 *
 * The gateway rejects a `developer` role with HTTP 400, and pi-ai would send
 * one for any reasoning model whose compat allows it, so the flag is pinned
 * off. `store` and the prompt-cache fields are likewise not part of this API.
 */
const COMPAT = {
  supportsDeveloperRole: false,
  supportsStore: false,
  maxTokensField: 'max_tokens',
} as const

/** The fields a catalog row contributes to either registration form. */
function catalogFields(info: WorkBuddyModelInfo) {
  return {
    id: info.id,
    name: displayName(info),
    input: info.supportsImages ? ['text', 'image'] as const : ['text'] as const,
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    compat: COMPAT,
    ...reasoningFields(info),
  }
}

/** Build one pi-ai model descriptor for a catalog row. */
export function toPiModel(
  info: WorkBuddyModelInfo,
  variant: Pick<WorkBuddyVariant, 'id'>,
  baseUrl: string,
): Model<'openai-completions'> {
  const fields = catalogFields(info)
  return {
    ...fields,
    input: [...fields.input],
    api: 'openai-completions',
    provider: variant.id,
    baseUrl,
  }
}

/** Build the full descriptor list for one catalog snapshot. */
export function toPiModels(
  models: readonly WorkBuddyModelInfo[],
  variant: Pick<WorkBuddyVariant, 'id'>,
  baseUrl: string,
): Model<'openai-completions'>[] {
  return models.map(model => toPiModel(model, variant, baseUrl))
}
