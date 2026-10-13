import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const prod = { description: 'production', url: 'https://coolx.example.com', db: 'coolx', username: 'admin', api_key: 'K1', allow_write: false }
const staging = { description: 'staging', url: 'https://stg.example.com', db: 'stg', username: 'admin', api_key: 'K2', allow_write: true }

// The world beneath the plugin: an in-memory profiles file and a fake Odoo login.
function world(on: On, start: unknown, login = { ok: true }) {
  const w = { disk: start === undefined ? undefined : JSON.stringify(start), statuses: [] as (string | undefined)[], logs: [] as string[] }
  mock.env(on, { APPDATA: 'C:\\Users\\t\\AppData\\Roaming' })
  on('fs.exists', () => ({ value: w.disk !== undefined }))
  on('fs.read', () => ({ value: w.disk ?? '' }))
  on('fs.write', (_$, e) => {
    w.disk = e.text
    return { value: undefined }
  })
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ result: login.ok ? 7 : false }) } }))
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'ok' }) as never)
  return { w, saved: () => JSON.parse(w.disk ?? '{}') }
}

const CALL = 'mcp__Odoo_Connector__'

test('every Odoo call shows its profile, instance and mode', async ($, on) => {
  const { w } = world(on, { prod, staging })

  await $.tool.call({ tool: `${CALL}odoo_search_read`, tool_use_id: 't1', profile: 'prod', model: 'res.partner' } as never)
  expect(w.logs.at(-1)).toBe('Odoo ▸ prod · coolx@coolx.example.com · read-only · odoo_search_read res.partner')

  await $.tool.call({ tool: `${CALL}odoo_write`, tool_use_id: 't2', profile: 'staging', model: 'res.partner' } as never)
  expect(w.logs.at(-1)).toBe('⚠ Odoo ▸ staging · stg@stg.example.com · writes ON · odoo_write res.partner')
  expect(w.statuses.at(-1)).toBe(w.logs.at(-1))

  await $.tool.call({ tool: `${CALL}odoo_whoami`, tool_use_id: 't3' } as never)
  expect(w.logs.at(-1)).toContain('NO PROFILE, will be refused')

  const before = w.logs.length
  await $.tool.call({ tool: 'Bash', tool_use_id: 't4', command: 'ls' } as never)
  expect(w.logs.length).toBe(before)
})

test('a lone profile is named even when the call omits it', async ($, on) => {
  const { w } = world(on, { prod })
  await $.tool.call({ tool: `${CALL}odoo_whoami`, tool_use_id: 't1' } as never)
  expect(w.logs.at(-1)).toContain('Odoo ▸ prod · coolx@coolx.example.com · read-only')
})

test('pane: writes toggle, remove needs two presses', async ($, on) => {
  const { w, saved } = world(on, { prod, staging })
  const ui = await $.ui.mount({ plugin: 'odoo-profiles', surface: 'desktop', component: 'Pane', requestId: 'odoo-profiles', props: {} as never })

  await ui.press({ key: 'write:prod' })
  expect(saved().prod.allow_write).toBe(true)
  await ui.press({ key: 'write:prod' })
  expect(saved().prod.allow_write).toBe(false)

  await ui.press({ key: 'remove:prod' })
  expect(saved().prod).toBeDefined()
  await ui.press({ key: 'remove:prod' })
  expect(saved().prod).toBeUndefined()
  expect(saved().staging.api_key).toBe('K2')
  expect(w.disk).not.toContain('"prod"')
  await ui.unmount()
})

test('pane: save checks the login first and keeps a profile read-only', async ($, on) => {
  const login = { ok: false }
  const { saved } = world(on, undefined, login)
  const ui = await $.ui.mount({ plugin: 'odoo-profiles', surface: 'desktop', component: 'Pane', requestId: 'odoo-profiles', props: {} as never })
  const fill = async () => {
    for (const [key, text] of [['name', 'new'], ['url', 'https://x.example.com/'], ['db', 'xdb'], ['username', 'me'], ['api_key', 'SECRET'], ['description', 'fresh']] as const) {
      await ui.input({ key, text, kind: 'change' })
    }
  }

  await fill()
  await ui.press({ key: 'save' })
  expect(saved().new).toBeUndefined()
  expect((await ui.findAll({ type: 'Text', text: /Login failed/ })).length).toBe(1)

  login.ok = true
  await ui.press({ key: 'save' })
  expect(saved().new).toEqual({ description: 'fresh', url: 'https://x.example.com', db: 'xdb', username: 'me', api_key: 'SECRET', allow_write: false })
  await ui.unmount()
})
