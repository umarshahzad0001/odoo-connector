# Odoo Connector

A Claude Desktop extension that lets Claude read and edit your Odoo data through Odoo's built-in JSON-RPC API. Nothing gets installed on the Odoo server. The connector runs on your machine and logs in as you, with an API key, so it can only do what your Odoo user is allowed to do.

You can save several Odoo instances at once (production, staging, a client's database) and choose one per request. No profile is the default. If more than one is saved and Claude doesn't say which, the call is refused instead of guessing.

Built and used against Odoo 18 Enterprise. Earlier versions that still serve `/jsonrpc` should work, but I haven't tried them, and I haven't tried 19 or later.

## Install

You need Claude Desktop and an Odoo user with an API key.

**1. Get an API key from Odoo.** In Odoo, open your user menu, then Preferences, then Account Security, then New API Key. Copy it somewhere; Odoo only shows it once.

**2. Get the extension file.** Build `odoo-connector-0.2.0.mcpb` yourself (see [Build from source](#build-from-source)), or download it if you've published a release.

**3. Install it.** Double-click the `.mcpb` file, or drag it into Claude Desktop's Settings, Extensions page, and click Install.

**4. Create a profiles file.** This is a JSON file that holds your Odoo logins. Put it somewhere outside any git repository or synced folder, because the API keys are stored in it as plain text. On Windows, `%APPDATA%\odoo-connector\profiles.json` works well:

```json
{
  "production": {
    "description": "Main company database",
    "url": "https://mycompany.odoo.com",
    "db": "mycompany",
    "username": "me@mycompany.com",
    "api_key": "paste-the-key-here",
    "allow_write": false
  },
  "staging": {
    "description": "Copy of production for testing",
    "url": "https://staging.mycompany.com",
    "db": "mycompany_staging",
    "username": "me@mycompany.com",
    "api_key": "paste-the-other-key-here",
    "allow_write": true
  }
}
```

`db` is the exact database name from Odoo's login screen. `username` is your login, usually an email address. `allow_write` is optional and defaults to `false`.

**5. Point the extension at the file.** In Claude Desktop, open the extension's settings and set **Profiles file** to the full path of the file you just made.

**6. Start a new chat and try it.** Ask Claude to "list my Odoo profiles", then "who am I logged in as on staging?". If a login fails, the error names the profile.

If you used 0.1.x, note that its URL, database, login and key settings are gone. Move them into a profile in the file above.

### Other MCP clients

The server is a plain stdio MCP server, so it isn't tied to Claude Desktop. Point any client at it with the profiles path in an environment variable:

```json
{
  "mcpServers": {
    "odoo": {
      "command": "node",
      "args": ["/path/to/odoo-connector/server/index.js"],
      "env": { "ODOO_PROFILES_FILE": "/path/to/profiles.json" }
    }
  }
}
```

## Using it

Tell Claude which instance you mean ("count open invoices on production") and it passes the profile name along. The data tools (everything from `odoo_whoami` down in the table below) take a `profile` argument. It's required once two or more profiles are saved. With exactly one saved profile it can be left out. The four profile tools at the top of the table don't take it.

| Tool | What it does |
| --- | --- |
| `odoo_list_profiles` | Lists saved profiles (name, description, URL, db, login, write flag). Never returns keys. |
| `odoo_add_profile` | Saves a new profile after checking that the login works. Always saved read-only. Won't overwrite an existing name. |
| `odoo_update_profile` | Changes a profile's description, login or API key. Can't change the URL, db or write flag. |
| `odoo_remove_profile` | Deletes a profile and its key. |
| `odoo_whoami` | Shows the server version and the user you're logged in as. |
| `odoo_find_models` | Finds models by technical name or label. |
| `odoo_fields_get` | Lists a model's fields and types. |
| `odoo_search_read` | Searches records and reads fields in one call. |
| `odoo_search_count` | Counts records matching a domain. |
| `odoo_read` | Reads records by id. |
| `odoo_execute` | Calls any model method (`execute_kw`). Write-style methods are blocked unless the profile allows writes. |
| `odoo_create`, `odoo_write`, `odoo_unlink` | Create, update and delete records. Need `allow_write` on the profile. |

The profiles file is re-read on every call, so you can edit it without restarting anything.

## Safety

Profiles are read-only unless you turn writes on. A profile with `allow_write: false` blocks any method whose name starts with `create`, `write`, `unlink`, `copy`, `action_` or `button_`, whichever tool tries to call it. The check runs before any request leaves your machine.

Claude can add, update and remove profiles through the tools above, but it can't turn writes on, and it can't change the URL or database of a saved profile (which would let a stored key be sent somewhere else). To enable writes, edit `allow_write` in the file yourself, or use the pane described below.

API keys live in `profiles.json` in plain text. Keep that file private. If you paste a key into the chat so Claude can add a profile, the key ends up in the conversation transcript; for anything sensitive, put it in the file directly.

## Profile pane for Claude Code (optional)

[`claude-mod/odoo-profiles`](claude-mod/odoo-profiles) is a small Claude Code mod that adds a `/odoo-profiles` pane for adding, editing, removing and write-enabling profiles without touching the JSON by hand. It also prints a line for every Odoo tool call showing which profile, instance and mode it used, with a warning marker when a write tool runs against a writable profile.

It uses Claude Code's function-hook mod API, which is early access and may change between releases. Load it from a checkout with:

```
claude --plugin-dir claude-mod/odoo-profiles
```

If your session can't take that flag, set `CLAUDE_CODE_PLUGIN_DIRS` to the folder instead. On Windows it edits `%APPDATA%\odoo-connector\profiles.json` by default; set the mod's `profiles_file` option if yours lives elsewhere (and on any other system). The call lines only appear for tools named `mcp__Odoo_Connector__*`, which is what Claude Desktop calls this extension.

## Build from source

You need Node.js 18 or newer.

```
npm install
npm test
```

The tests start the real server against two fake Odoo instances and check profile routing, the "profile required" refusal, the write guard and the add/update/remove tools. They don't need a real Odoo.

To produce the `.mcpb` file, use Anthropic's packer:

```
npx @anthropic-ai/mcpb pack
```

Run it in this folder. The file it writes is what you install in step 3 above.

## License

MIT. See [LICENSE](LICENSE).
