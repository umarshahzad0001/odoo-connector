export type Profile = {
  description?: string
  url: string
  db: string
  username: string
  api_key: string
  allow_write?: boolean
}

export type Profiles = Record<string, Profile>

export type Form = {
  name: string
  url: string
  db: string
  username: string
  api_key: string
  description: string
}

declare module 'claude-code' {
  interface PluginState {
    'odoo-profiles': {
      form: Form
      msg: string
      confirm: string | null
      rev: number
    }
  }
}
