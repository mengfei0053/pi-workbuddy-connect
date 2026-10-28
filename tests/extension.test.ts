import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Provider, RefreshModelsContext } from '@earendil-works/pi-ai'
import workbuddyConnect from '../src/index.ts'
import { AI_VARIANT, CN_VARIANT } from '../src/variants.ts'

/** One captured native provider registration. */
interface Registration {
  id: string
  provider: Provider
}

/** Register the extension against a captured fake `ExtensionAPI`. */
function register(): { registrations: Registration[]; commands: string[] } {
  const registrations: Registration[] = []
  const commands: string[] = []
  workbuddyConnect({
    registerProvider(provider: Provider) {
      registrations.push({ id: provider.id, provider })
    },
    registerCommand(name: string) {
      commands.push(name)
    },
  } as never)
  return { registrations, commands }
}

/** The native provider for one variant. */
function providerFor(registrations: readonly Registration[], id: string): Provider {
  const provider = registrations.find(entry => entry.id === id)?.provider
  assert.ok(provider !== undefined, `no native provider registered for ${id}`)
  return provider
}

/** Run the provider's catalog refresh the way Pi does, applying `publish`. */
async function refreshRoster(provider: Provider, allowNetwork: boolean): Promise<void> {
  const refresh = provider.refreshModels
  assert.ok(refresh !== undefined, `provider ${provider.id} has no refreshModels`)
  const context: RefreshModelsContext = {
    allowNetwork,
    signal: new AbortController().signal,
    publish: async (publication) => {
      publication.update?.()
      return true
    },
  }
  await refresh(context)
}

/** The live catalog shape the CN gateway returns for a CLI identity. */
function cnCatalog(): unknown {
  return {
    code: 0,
    msg: 'OK',
    data: {
      agents: [{ name: 'cli', models: ['alpha', 'beta'] }],
      models: [
        { id: 'alpha', name: 'Alpha', maxInputTokens: 200000, maxOutputTokens: 8192, supportsImages: false, credits: 'x0.25 credits' },
        { id: 'beta', name: 'Beta', maxInputTokens: 1000000, maxOutputTokens: 64000, supportsImages: true },
      ],
    },
  }
}

/**
 * Run one callback with `fetch` stubbed and both auth-file env vars pointed
 * into a temp dir, so the real machine's sign-in never leaks into a test.
 *
 * A signed-in document is written unless `signedIn` is false: the signed-out
 * cases need an app that genuinely has no credential.
 */
async function withStubbedFetch(
  answer: () => Response,
  run: () => Promise<void>,
  options: { signedIn?: boolean } = {},
): Promise<void> {
  const originalFetch = globalThis.fetch
  const originalEnv = { ...process.env }
  const dir = await mkdtemp(join(tmpdir(), 'pi-workbuddy-ext-'))
  const cnFile = join(dir, CN_VARIANT.desktopFilename)
  const aiFile = join(dir, AI_VARIANT.desktopFilename)
  if (options.signedIn !== false) {
    const document = (domain: string): string => JSON.stringify({
      auth: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3_600_000,
        domain,
      },
      account: { uid: 'account-1' },
    })
    await writeFile(cnFile, document('www.workbuddy.cn'))
    await writeFile(aiFile, document('www.workbuddy.ai'))
  }
  process.env[CN_VARIANT.authFileEnv] = cnFile
  process.env[AI_VARIANT.authFileEnv] = aiFile
  process.env['PI_CODING_AGENT_DIR'] = dir
  globalThis.fetch = (async () => answer()) as typeof globalThis.fetch
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
    process.env = originalEnv
    await rm(dir, { recursive: true, force: true })
  }
}

test('each variant registers one native provider with a replacing refresh, and one command', () => {
  const { registrations, commands } = register()
  assert.deepEqual(registrations.map(entry => entry.id), [CN_VARIANT.id, AI_VARIANT.id])
  assert.ok(providerFor(registrations, CN_VARIANT.id).refreshModels !== undefined)
  assert.deepEqual(commands, ['workbuddy'])
})

test('a provider starts from the built-in table before any fetch', () => {
  const { registrations } = register()
  const cn = providerFor(registrations, CN_VARIANT.id)
  assert.ok(cn.getModels().length > 0)
  for (const model of cn.getModels()) {
    assert.equal(model.provider, CN_VARIANT.id)
    assert.equal(model.api, 'openai-completions')
    assert.equal(model.baseUrl, 'https://copilot.tencent.com/v2')
  }
  assert.ok(cn.auth.apiKey !== undefined)
})

test('a live refresh replaces the built-in table instead of merging into it', async () => {
  await withStubbedFetch(() => new Response(JSON.stringify(cnCatalog()), { status: 200 }), async () => {
    const { registrations } = register()
    const provider = providerFor(registrations, CN_VARIANT.id)
    const builtinIds = provider.getModels().map(model => model.id)
    await refreshRoster(provider, false)
    assert.deepEqual(provider.getModels().map(model => model.id), builtinIds)
    await refreshRoster(provider, true)
    const models = provider.getModels()
    assert.deepEqual(models.map(model => model.id), ['alpha', 'beta'])
    assert.deepEqual(models.map(model => model.name), ['Alpha · x0.25', 'Beta'])
    assert.deepEqual(models.find(model => model.id === 'alpha')?.input, ['text'])
    assert.equal(models[0]?.baseUrl, 'https://copilot.tencent.com/v2')
    assert.ok(builtinIds.every(id => !models.some(model => model.id === id)))
  })
})

test('a failed live refresh throws and keeps the previous roster', async () => {
  await withStubbedFetch(() => new Response('{"code":4001,"msg":"expired"}', { status: 401 }), async () => {
    const { registrations } = register()
    const provider = providerFor(registrations, CN_VARIANT.id)
    const before = provider.getModels().map(model => model.id)
    await assert.rejects(
      refreshRoster(provider, true),
      /workbuddy upstream rejected the request/u,
    )
    assert.deepEqual(provider.getModels().map(model => model.id), before)
  })
})

test('a signed-out app reports no configured auth, so the group stays hidden', async () => {
  await withStubbedFetch(() => new Response('{}', { status: 200 }), async () => {
    const { registrations } = register()
    for (const id of [CN_VARIANT.id, AI_VARIANT.id]) {
      const check = await providerFor(registrations, id).auth.apiKey!.check!({
        ctx: { env: async () => undefined, fileExists: async () => false },
        signal: new AbortController().signal,
      })
      assert.equal(check, undefined)
    }
  }, { signedIn: false })
})

test('a signed-in app resolves its access token as the request credential', async () => {
  await withStubbedFetch(() => new Response(JSON.stringify(cnCatalog()), { status: 200 }), async () => {
    const { registrations } = register()
    const resolved = await providerFor(registrations, CN_VARIANT.id).auth.apiKey!.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      signal: new AbortController().signal,
    })
    assert.equal(resolved?.auth.apiKey, 'access-token')
  })
})
