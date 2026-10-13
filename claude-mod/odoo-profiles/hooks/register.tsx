import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Form, Profile, Profiles } from '../types'

const PANE = 'odoo-profiles'
const MCP = 'mcp__Odoo_Connector__'
const NO_PROFILE_TOOLS = ['odoo_list_profiles', 'odoo_add_profile', 'odoo_update_profile', 'odoo_remove_profile']
const WRITE_TOOLS = ['odoo_create', 'odoo_write', 'odoo_unlink', 'odoo_execute']
const EMPTY: Form = { name: '', url: '', db: '', username: '', api_key: '', description: '' }

const form = atom({ plugin: 'odoo-profiles', key: 'form' } as const, EMPTY)
const msg = atom({ plugin: 'odoo-profiles', key: 'msg' } as const, '')
const confirm = atom({ plugin: 'odoo-profiles', key: 'confirm' } as const, null)
const rev = atom({ plugin: 'odoo-profiles', key: 'rev' } as const, 0)

// Set by register() from the userConfig option; empty means the default path.
let profilesFile = ''

// shortcut: the file is rewritten in place, not atomically; the connector re-reads per call, so a read racing a save costs one call an error.
async function profilesPath($: EngineInterface): Promise<string> {
  if (profilesFile !== '') return profilesFile
  return `${await $.env.get('APPDATA')}\\odoo-connector\\profiles.json`
}

async function load($: EngineInterface): Promise<Profiles> {
  const file = await profilesPath($)
  if (!(await $.fs.exists(file))) return {}
  return JSON.parse(String(await $.fs.read(file)))
}

async function save($: EngineInterface, profiles: Profiles): Promise<void> {
  await $.fs.write(await profilesPath($), JSON.stringify(profiles, null, 2) + '\n')
}

// The same login check the connector runs, so a typo is caught before it is saved.
async function canLogin($: EngineInterface, p: Profile): Promise<boolean> {
  const res = await $.http.fetch(`${p.url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      id: 1,
      params: { service: 'common', method: 'authenticate', args: [p.db, p.username, p.api_key, {}] },
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${p.url}`)
  const data = JSON.parse(res.text)
  if (data.error) throw new Error(data.error.data?.message ?? data.error.message ?? 'Odoo error')
  return Boolean(data.result)
}

// Runs one pane action: shows its result (or error) and redraws.
async function act($: EngineInterface, run: () => Promise<string>): Promise<void> {
  let text: string
  try {
    text = await run()
  } catch (err) {
    text = `Error: ${err instanceof Error ? err.message : String(err)}`
  }
  await update($, msg, () => text)
  await update($, rev, n => (n ?? 0) + 1)
}

function toggle($: EngineInterface, name: string): Promise<void> {
  return act($, async () => {
    const profiles = await load($)
    const p = profiles[name]
    if (!p) throw new Error(`No profile '${name}'.`)
    p.allow_write = p.allow_write !== true
    await save($, profiles)
    return `${name}: writes ${p.allow_write ? 'ON' : 'off'}.`
  })
}

// Two presses: the first arms, the second deletes the profile and its key.
function remove($: EngineInterface, name: string): Promise<void> {
  return act($, async () => {
    if ((await read($, confirm)) !== name) {
      await update($, confirm, () => name)
      return `Press Remove again to delete '${name}' and its API key.`
    }
    const profiles = await load($)
    delete profiles[name]
    await save($, profiles)
    await update($, confirm, () => null)
    return `Removed ${name}.`
  })
}

// Loads a profile into the form without its key, which stays out of the pane.
function edit($: EngineInterface, name: string): Promise<void> {
  return act($, async () => {
    const p = (await load($))[name]
    if (!p) throw new Error(`No profile '${name}'.`)
    await update($, form, () => ({
      name,
      url: p.url,
      db: p.db,
      username: p.username,
      api_key: '',
      description: p.description ?? '',
    }))
    return `Editing ${name}: type the API key again, then Save.`
  })
}

// Save adds a profile or, for an existing name, replaces it and keeps its allow_write.
function submit($: EngineInterface): Promise<void> {
  return act($, async () => {
    const f = await read($, form)
    const missing = (['name', 'url', 'db', 'username', 'api_key'] as const).filter(k => f[k].trim() === '')
    if (missing.length) throw new Error(`Fill in: ${missing.join(', ')}.`)
    const name = f.name.trim()
    if (!/^[\w.-]+$/.test(name)) throw new Error("Name may only use letters, digits, '.', '_' and '-'.")
    if (!/^https?:\/\//.test(f.url.trim())) throw new Error('URL must start with http:// or https://.')
    const entry: Profile = {
      description: f.description.trim(),
      url: f.url.trim().replace(/\/+$/, ''),
      db: f.db.trim(),
      username: f.username.trim(),
      api_key: f.api_key.trim(),
    }
    if (!(await canLogin($, entry))) throw new Error('Login failed: check db, username and API key. Nothing saved.')
    const profiles = await load($)
    const existed = name in profiles
    profiles[name] = { ...entry, allow_write: profiles[name]?.allow_write === true }
    await save($, profiles)
    await update($, form, () => EMPTY)
    return `${existed ? 'Updated' : 'Saved'} ${name}${existed ? '' : ' (read-only; allow writes below if needed)'}.`
  })
}

// One line saying which profile, instance and mode an Odoo Connector call uses.
async function describeCall($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<string> {
  if (NO_PROFILE_TOOLS.includes(tool)) return `Odoo ▸ ${tool}`
  const profiles = await load($)
  const names = Object.keys(profiles)
  const asked = typeof args.profile === 'string' ? args.profile : undefined
  const name = asked ?? (names.length === 1 ? names[0] : undefined)
  const p = name === undefined ? undefined : profiles[name]
  const isWrite = WRITE_TOOLS.includes(tool) && p?.allow_write === true
  const mode = p === undefined ? 'NO PROFILE, will be refused' : p.allow_write ? 'writes ON' : 'read-only'
  const detail = [args.model, args.method].filter(x => typeof x === 'string').join(' ')
  return (
    `${isWrite ? '⚠ ' : ''}Odoo ▸ ${name ?? '?'}` +
    (p ? ` · ${p.db}@${new URL(p.url).host}` : '') +
    ` · ${mode} · ${tool}${detail ? ` ${detail}` : ''}`
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export const register: Register = (on, options) => {
  profilesFile = typeof options.profiles_file === 'string' ? options.profiles_file : ''

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'odoo-profiles', description: 'Manage Odoo Connector profiles' })
    return next(e)
  })

  on('command.run', { command: 'odoo-profiles' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Odoo profiles', focus: true })
    return { text: opened.isPlaced ? 'Odoo profiles pane opened.' : `Pane not shown yet: ${opened.reason}` }
  })

  on('tool.call', async ($, e, next) => {
    if (!e.tool.startsWith(MCP)) return next(e)
    try {
      const line = await describeCall($, e.tool.slice(MCP.length), e as unknown as Record<string, unknown>)
      $.ui.status(line)
      $.ui.log(line)
    } catch {
      // display only: never block the call over a display failure
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const f = await read($, form)
    const note = await read($, msg)
    const pending = await read($, confirm)
    await read($, rev)

    let profiles: Profiles = {}
    let error = ''
    try {
      profiles = await load($)
    } catch (err) {
      error = `Cannot read the profiles file: ${err instanceof Error ? err.message : String(err)}`
    }

    const field = (k: keyof Form) => (v: string) => {
      void update($, form, cur => ({ ...cur, [k]: v }))
    }
    const file = await profilesPath($)
    const entries = Object.entries(profiles)
    const noteColor = note.startsWith('Error') ? 'error' : note.startsWith('Press Remove') ? 'warning' : 'success'
    const labelled = (k: keyof Form, label: string, hint = '', placeholder = '') => (
      <Box key={`field:${k}`} flexDirection="column">
        <Box gap={1}>
          <Text bold>{label}</Text>
          {hint !== '' && <Text dimColor>{hint}</Text>}
        </Box>
        <Input key={k} placeholder={placeholder} value={f[k]} onInput={field(k)} onSubmit={() => void submit($)} />
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text dimColor>
          {entries.length} saved · {file}
        </Text>
        {note !== '' && (
          <Text bold color={noteColor}>
            {note}
          </Text>
        )}
        {error !== '' && <Text color="error">{error}</Text>}
        {entries.length === 0 && error === '' && <Text dimColor>No profiles saved yet. Add one below.</Text>}
        {entries.map(([name, p]) => (
          <Box key={name} flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
            <Box gap={2}>
              <Text bold>{name}</Text>
              <Text bold color={p.allow_write ? 'warning' : 'success'}>
                {p.allow_write ? 'WRITES ON' : 'READ-ONLY'}
              </Text>
            </Box>
            {p.description !== undefined && p.description !== '' && <Text>{p.description}</Text>}
            <Text dimColor>
              {hostOf(p.url)} · {p.db} · {p.username}
            </Text>
            <Box gap={1} marginTop={1} flexWrap="wrap">
              <Button
                key={`write:${name}`}
                label={p.allow_write ? 'Turn writes off' : 'Allow writes'}
                onPress={() => void toggle($, name)}
              />
              <Button key={`edit:${name}`} label="Edit" onPress={() => void edit($, name)} />
              <Button
                key={`remove:${name}`}
                label={pending === name ? 'Click again to delete' : 'Remove'}
                onPress={() => void remove($, name)}
              />
            </Box>
          </Box>
        ))}
        <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1} gap={1}>
          <Box flexDirection="column">
            <Text bold>Add or replace a profile</Text>
            <Text dimColor>Same name replaces it. New profiles start read-only.</Text>
          </Box>
          {labelled('name', 'Name', 'letters, digits . _ -', 'coolx-test')}
          {labelled('url', 'URL', '', 'https://example.odoo.com')}
          {labelled('db', 'Database')}
          {labelled('username', 'Login', 'usually your email')}
          {labelled('api_key', 'API key', 'visible while typing')}
          {labelled('description', 'Description', 'optional', 'what this instance is')}
          <Box>
            <Button key="save" variant="primary" label="Save (checks login first)" onPress={() => void submit($)} />
          </Box>
        </Box>
      </Box>
    )
  })
}
