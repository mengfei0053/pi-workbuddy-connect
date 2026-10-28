/**
 * WorkBuddy models for Pi, reusing the desktop apps' sign-in.
 *
 * One provider per product variant — `workbuddy` for the CN app and
 * `workbuddy-ai` for the international one — assembled by the same factory and
 * differing only in their {@link WorkBuddyVariant} descriptor. Neither
 * variant's startup, catalog fetch, or credential state can stop the other
 * from registering, so a user with only one app installed sees only that
 * group.
 *
 * Requests are *not* proxied. The extension registers ordinary
 * OpenAI-completions models pointed at the real gateway, and pi-ai's own
 * implementation performs the streaming; the extension supplies the
 * credential, the headers the gateway requires, and the three payload shapes
 * it rejects (see `payload.ts`).
 *
 * @module pi-workbuddy-connect
 */

import { openAICompletionsApi } from '@earendil-works/pi-ai/compat'
import { createProvider, lazyStream } from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessageEventStream,
  Model,
  Provider,
  ProviderAuth,
  ProviderStreams,
  SimpleStreamOptions,
  StreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { resolveAgentDir, WorkBuddyCredentialStore } from './auth.ts'
import { FALLBACK_AI_MODELS, FALLBACK_CN_MODELS, type WorkBuddyModelInfo } from './catalog.ts'
import { clearProtectorKeyCache } from './desktop-credential.ts'
import { toPiModels } from './models.ts'
import { normalizeChatBody, type ChatBody } from './payload.ts'
import {
  chatHeaders,
  resolveIdentity,
  WorkBuddyUpstream,
  type WorkBuddyCatalogResult,
  type WorkBuddyIdentity,
} from './upstream.ts'
import { WORKBUDDY_VARIANTS, type WorkBuddyVariant } from './variants.ts'

export { parseWorkBuddyAuth, WorkBuddyCredentialStore, type WorkBuddyCredential } from './auth.ts'
export {
  buildAuthenticatedContextAad,
  classifyDesktopAuthDocument,
  clearProtectorKeyCache,
  openAuthField,
  parseAtRestPayload,
  type WorkBuddyEnvelope,
} from './desktop-credential.ts'
export { parseModelCatalog, type WorkBuddyModelInfo } from './catalog.ts'
export { normalizeCredits, reasoningFields } from './models.ts'
export { normalizeChatBody } from './payload.ts'
export { chatUserAgent, parseCycleEndTime, validAppVersion, WorkBuddyUpstream } from './upstream.ts'
export { AI_VARIANT, CN_VARIANT, WORKBUDDY_VARIANTS, regionOf, type WorkBuddyVariant } from './variants.ts'

/** Catalog freshness window; a startup refresh inside it does no network work. */
const CATALOG_TTL_MS = 10 * 60 * 1000

/** The chat base URL for one variant; pi appends `/chat/completions`. */
function chatBaseUrl(variant: WorkBuddyVariant): string {
  return variant.region === 'global'
    ? 'https://www.workbuddy.ai/v2'
    : 'https://copilot.tencent.com/v2'
}

/** Everything one variant needs while it is loaded. */
interface VariantRuntime {
  variant: WorkBuddyVariant
  store: WorkBuddyCredentialStore
  upstream: WorkBuddyUpstream
  identity: () => Promise<WorkBuddyIdentity>
  /** The models the provider currently advertises. */
  models: () => readonly WorkBuddyModelInfo[]
  /** The last catalog answer, fetched at most once per TTL. */
  catalog: () => Promise<WorkBuddyCatalogResult>
  /** Force a live catalog fetch. */
  refresh: () => Promise<WorkBuddyCatalogResult>
  /** Set when registration itself failed, so the command can report it. */
  registrationError?: string
}

/**
 * Memoize identity resolution: it reads the app bundle at most once.
 *
 * `resolveIdentity` never rejects (unreadable metadata degrades to the
 * compiled-in version), so there is no failure branch to cache here.
 */
function memoizedIdentity(variant: WorkBuddyVariant): () => Promise<WorkBuddyIdentity> {
  let pending: Promise<WorkBuddyIdentity> | undefined
  return () => {
    pending ??= resolveIdentity(variant)
    return pending
  }
}

/** Build the runtime for one variant. */
function createVariantRuntime(variant: WorkBuddyVariant): VariantRuntime {
  const identity = memoizedIdentity(variant)
  const upstream = new WorkBuddyUpstream({ variant, resolveIdentity: identity })
  const store = new WorkBuddyCredentialStore({
    variant,
    ownDir: resolveAgentDir(),
    refresh: credential => upstream.refreshToken(credential),
  })
  const fallback = variant.region === 'global' ? FALLBACK_AI_MODELS : FALLBACK_CN_MODELS
  let cached: WorkBuddyCatalogResult | undefined

  const state: VariantRuntime = {
    variant,
    store,
    upstream,
    identity,
    models() {
      return cached?.models ?? fallback
    },
    async catalog() {
      if (cached !== undefined && Date.now() - cached.fetchedAtMs < CATALOG_TTL_MS) return cached
      return await state.refresh()
    },
    async refresh() {
      // A signed-out app yields the fallback, and the card says so; the
      // provider is still registered so signing in later needs no reload.
      const credential = await store.current().catch(() => undefined)
      cached = await upstream.catalog(credential, fallback)
      return cached
    },
  }
  return state
}

/**
 * The provider's auth plane.
 *
 * Availability uses the read-only path: listing models must not rotate the
 * refresh token, and a signed-out app simply hides the group. Request-time
 * resolution returns the current access token, which pi-ai sends as the
 * bearer; the streams below never read `options.apiKey` back, so a token
 * refreshed between availability and the request still applies.
 */
function providerAuth(variant: WorkBuddyVariant, store: WorkBuddyCredentialStore): ProviderAuth {
  return {
    apiKey: {
      name: `${variant.appName} app sign-in`,
      async check() {
        const status = await store.status()
        return status.state === 'signed-in'
          ? { type: 'api_key', source: `${variant.appName} sign-in` }
          : undefined
      },
      async resolve() {
        const credential = await store.current().catch(() => undefined)
        return credential === undefined
          ? undefined
          : { auth: { apiKey: credential.accessToken }, source: variant.displayName }
      },
    },
  }
}

/**
 * One stream call.
 *
 * The credential and identity are resolved per request, so a token refreshed
 * by the store applies immediately, and pi-ai receives the gateway headers
 * plus a payload normalizer that runs *after* any caller `onPayload`.
 */
function streamFor(
  state: VariantRuntime,
  model: Model<Api>,
  context: TranscriptContext,
  options: StreamOptions | SimpleStreamOptions | undefined,
  simple: boolean,
): AssistantMessageEventStream {
  const api = openAICompletionsApi()
  return lazyStream(model, async () => {
    const credential = await state.store.resolve()
    const callerOnPayload = options?.onPayload
    const merged = {
      ...options,
      // The store's answer wins over pi's: pi resolved the provider auth
      // *before* streaming, so `options.apiKey` may be a token this call just
      // refreshed past. A caller-supplied key cannot be more authoritative
      // here — the app's sign-in is the only credential this provider accepts.
      apiKey: credential.accessToken,
      headers: { ...chatHeaders(credential, await state.identity()), ...options?.headers },
      onPayload: async (payload: unknown, target: Model<Api>) => {
        const replaced = await callerOnPayload?.(payload, target)
        return normalizeChatBody((replaced ?? payload) as ChatBody, state.variant.region === 'global')
      },
    }
    return simple
      ? api.streamSimple(model, context, merged as SimpleStreamOptions)
      : api.stream(model, context, merged as StreamOptions)
  })
}

/** The provider streams for one variant. */
function providerStreams(state: VariantRuntime): ProviderStreams {
  return {
    stream: (model, context, options) => streamFor(state, model, context, options, false),
    streamSimple: (model, context, options) => streamFor(state, model, context, options, true),
  }
}

/** Human-readable status for the `/workbuddy` command. */
async function report(runtimes: readonly VariantRuntime[], action: string): Promise<string> {
  const lines: string[] = []
  for (const state of runtimes) {
    const { variant, store } = state
    lines.push(`${variant.displayName} (${variant.id})`)
    if (state.registrationError !== undefined) {
      lines.push(`  registration failed: ${state.registrationError}`)
      lines.push('')
      continue
    }
    const status = await store.status()
    if (status.state === 'signed-out') {
      lines.push(`  signed out: ${status.reason ?? 'no credential'}`)
      lines.push(`  sign in once in the ${variant.appName} desktop app, then run /workbuddy again`)
      lines.push('')
      continue
    }
    lines.push(`  account: ${status.nickname ?? status.domain ?? '(unnamed)'}${status.nickname === undefined || status.domain === undefined ? '' : ` · ${status.domain}`}`)
    if (status.expiresAtMs !== undefined) {
      lines.push(`  access token expires: ${new Date(status.expiresAtMs).toISOString()} (refresh is automatic)`)
    }
    lines.push(`  credential source: ${status.source === 'own' ? 'plugin copy' : 'app auth file'}`)
    const catalog = await state.catalog()
    lines.push(`  models: ${catalog.models.length} (${catalog.source === 'live' ? 'live' : 'built-in fallback'})`)
    if (catalog.error !== undefined) lines.push(`  catalog error: ${catalog.error}`)
    if (action === 'models') {
      for (const model of catalog.models) {
        const traits = [
          `${formatTokens(model.contextWindow)} ctx`,
          `${formatTokens(model.maxTokens)} out`,
          ...model.supportsImages ? ['image'] : [],
          ...model.reasoning?.supportedEfforts === undefined
            ? []
            : [`effort ${model.reasoning.supportedEfforts.join('/')}`],
        ]
        lines.push(`    ${model.id} — ${model.name} · ${traits.join(' · ')}`)
      }
    }
    if (action === 'credits') {
      const credential = await store.current()
      if (credential !== undefined) {
        try {
          const credits = await state.upstream.fetchCredits(credential)
          lines.push(`  remaining credit: ${credits.total}`)
          for (const account of credits.accounts) {
            lines.push(`    ${account.packageName}: ${account.remain}/${account.size}`)
          }
        } catch (error: unknown) {
          lines.push(`  remaining credit: unavailable (${error instanceof Error ? error.message : String(error)})`)
        }
      }
    }
    lines.push('')
  }
  lines.push('Usage: /workbuddy [models|credits|refresh]')
  return lines.join('\n')
}

/** `1000000` renders as `1M`, `131072` as `131K`, and small values stay exact. */
function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`
  return `${count}`
}

/**
 * Hang the live catalog off the one native provider.
 *
 * Pi 1.4 flushes config overlays before native providers, then drops an
 * overlay when the native provider for the same id is registered. A second
 * `registerProvider` therefore never replaces the startup snapshot.
 * `createProvider`'s `fetchModels` is also the wrong hook: it merges into
 * that snapshot, so a model the upstream retired would stay in the picker.
 * Replacing `getModels` here keeps a single registration and still swaps the
 * whole roster. A failed fetch throws before `publish`, so the previous
 * roster stays.
 */
function attachLiveRoster(
  provider: Provider,
  state: VariantRuntime,
  variant: WorkBuddyVariant,
  baseUrl: string,
): void {
  let roster = toPiModels(state.models(), variant, baseUrl)
  provider.getModels = () => roster
  provider.getAllModels = () => roster
  provider.refreshModels = async (context) => {
    if (!context.allowNetwork || context.signal.aborted) return
    const result = await state.refresh()
    if (context.signal.aborted) return
    if (result.source !== 'live') throw new Error(result.error ?? 'catalog unavailable')
    const next = toPiModels(result.models, variant, baseUrl)
    await context.publish({
      update: () => {
        roster = next
      },
    })
  }
}

/** Send command output through the UI when there is one, else stdout. */
function notify(ctx: ExtensionCommandContext, text: string): void {
  if (ctx.hasUI) ctx.ui.notify(text, 'info')
  else process.stdout.write(`${text}\n`)
}

/**
 * Register both variants.
 *
 * Each registration is isolated: a variant whose setup throws records the
 * error for `/workbuddy` and leaves the other variant working.
 */
export default function workbuddyConnect(pi: ExtensionAPI): void {
  const runtimes: VariantRuntime[] = []

  for (const variant of WORKBUDDY_VARIANTS) {
    const state = createVariantRuntime(variant)
    runtimes.push(state)
    const baseUrl = chatBaseUrl(variant)
    try {
      const provider: Provider = createProvider({
        id: variant.id,
        name: variant.displayName,
        baseUrl,
        auth: providerAuth(variant, state.store),
        models: toPiModels(state.models(), variant, baseUrl),
        api: providerStreams(state),
      })
      attachLiveRoster(provider, state, variant, baseUrl)
      pi.registerProvider(provider)
    } catch (error: unknown) {
      state.registrationError = error instanceof Error ? error.message : String(error)
    }
  }

  pi.registerCommand('workbuddy', {
    description: 'WorkBuddy sign-in, models, and remaining credit',
    handler: async (args, ctx) => {
      const action = args.trim().split(/\s+/u)[0] ?? ''
      if (action === '') {
        notify(ctx, await report(runtimes, 'status'))
        return
      }
      if (action !== 'models' && action !== 'credits' && action !== 'refresh') {
        notify(ctx, 'Usage: /workbuddy [models|credits|refresh]')
        return
      }
      if (action === 'refresh') {
        // The manual recovery path after signing in or switching accounts: drop
        // the cached decryption key and let Pi re-run each provider's catalog
        // refresh, which replaces the published model list.
        clearProtectorKeyCache()
        await ctx.modelRegistry.refresh({ providers: WORKBUDDY_VARIANTS.map(variant => variant.id) })
        notify(ctx, await report(runtimes, 'status'))
        return
      }
      notify(ctx, await report(runtimes, action))
    },
  })
}
