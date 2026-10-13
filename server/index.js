#!/usr/bin/env node
/**
 * Odoo MCP server (Node.js, stdio transport).
 *
 * Talks to Odoo's BUILT-IN external API over JSON-RPC (POST /jsonrpc) using
 * Node's global fetch — no XML-RPC library, no server-side Odoo module, and
 * (once bundled as .mcpb) no Python. Connects as your user via an API key.
 * Works with Odoo 14–18. Odoo 19 introduced JSON/2; XML-RPC is slated for
 * removal in Odoo 20, but the /jsonrpc endpoint used here remains available.
 *
 * Several Odoo instances can be saved at once. They live in a JSON file whose
 * path comes from ODOO_PROFILES_FILE (the .mcpb "Profiles file" setting):
 *   { "<name>": { description, url, db, username, api_key, allow_write } }
 * No profile is a default: every tool takes a `profile` argument, required
 * once two or more are saved. The file is re-read on each call, so edits
 * apply without a restart.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Surface any startup/runtime failure to stderr so it appears in the
// Claude Desktop MCP log instead of failing silently.
process.on("uncaughtException", (err) => {
  console.error("[odoo-connector] uncaughtException:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[odoo-connector] unhandledRejection:", err);
});

// --- Configuration ---------------------------------------------------------
const PROFILES_FILE = process.env.ODOO_PROFILES_FILE || "";

const WRITE_METHOD_PREFIXES = ["create", "write", "unlink", "copy", "action_", "button_"];

// uid per credential set, so a changed key or a second profile never reuses a stale uid.
const uidCache = new Map();

// --- Profiles --------------------------------------------------------------
function loadProfiles() {
  if (!PROFILES_FILE) {
    throw new Error("Profiles file is not set. Fill it in the extension settings.");
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(PROFILES_FILE, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read profiles file ${PROFILES_FILE}: ${e.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${PROFILES_FILE} must be a JSON object keyed by profile name.`);
  }
  for (const [name, p] of Object.entries(raw)) {
    const missing = ["url", "db", "username", "api_key"].filter((k) => !p?.[k]);
    if (missing.length) {
      throw new Error(`Profile '${name}' is missing: ${missing.join(", ")}.`);
    }
  }
  return raw;
}

function saveProfiles(profiles) {
  mkdirSync(dirname(PROFILES_FILE), { recursive: true });
  const tmp = `${PROFILES_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(profiles, null, 2) + "\n");
  renameSync(tmp, PROFILES_FILE);
}

const normalize = (name, p) => ({
  ...p,
  name,
  url: p.url.replace(/\/+$/, ""),
  allow_write: p.allow_write === true,
});

// No default profile: with two or more saved, the caller must name one.
function resolveProfile(requested) {
  const profiles = loadProfiles();
  const names = Object.keys(profiles);
  if (!names.length) throw new Error(`No profiles saved in ${PROFILES_FILE}.`);
  let name = requested;
  if (!name) {
    if (names.length > 1) {
      throw new Error(
        `Several profiles are saved, so \`profile\` is required. Available: ${names.join(", ")}. ` +
          "Call odoo_list_profiles for details."
      );
    }
    name = names[0];
  }
  const p = profiles[name];
  if (!p) throw new Error(`Unknown profile '${name}'. Available: ${names.join(", ")}.`);
  return normalize(name, p);
}

// --- Odoo JSON-RPC helpers -------------------------------------------------
async function jsonrpc(p, service, method, args) {
  const res = await fetch(`${p.url}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: Date.now(),
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${p.url}/jsonrpc`);
  }
  const data = await res.json();
  if (data.error) {
    const e = data.error;
    const msg =
      (e.data && (e.data.message || e.data.debug)) || e.message || JSON.stringify(e);
    throw new Error(`Odoo error: ${msg}`);
  }
  return data.result;
}

async function authenticate(p) {
  const key = JSON.stringify([p.url, p.db, p.username, p.api_key]);
  if (uidCache.has(key)) return uidCache.get(key);
  const uid = await jsonrpc(p, "common", "authenticate", [p.db, p.username, p.api_key, {}]);
  if (!uid) {
    throw new Error(
      `Authentication failed for profile '${p.name}'. Check its db, username (login/email), and api_key.`
    );
  }
  uidCache.set(key, uid);
  return uid;
}

async function execute(p, model, method, args = [], kwargs = {}) {
  const uid = await authenticate(p);
  return jsonrpc(p, "object", "execute_kw", [p.db, uid, p.api_key, model, method, args, kwargs]);
}

function guardWrite(p, method) {
  if (p.allow_write) return;
  if (WRITE_METHOD_PREFIXES.some((prefix) => method === prefix || method.startsWith(prefix))) {
    throw new Error(
      `Write method '${method}' is blocked on profile '${p.name}'. Set "allow_write": true for it in the profiles file to permit it.`
    );
  }
}

// --- Tool definitions ------------------------------------------------------
const TOOLS = [
  {
    name: "odoo_list_profiles",
    noProfile: true,
    description:
      "List the saved Odoo profiles (name, description, url, db, username, allow_write; never keys). Call this first when several are saved and the user did not name one, then match their wording to a profile. If still ambiguous, ask the user.",
    inputSchema: { type: "object", properties: {} },
    handler: async () =>
      Object.entries(loadProfiles()).map(([name, p]) => ({
        name,
        description: p.description || "",
        url: p.url,
        db: p.db,
        username: p.username,
        allow_write: p.allow_write === true,
      })),
  },
  {
    name: "odoo_add_profile",
    noProfile: true,
    description:
      "Save a new Odoo profile after checking the credentials can log in (nothing is saved if they cannot). Cannot overwrite an existing name. Always saved read-only: allow_write can only be turned on by editing the profiles file by hand.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short id: letters, digits, '.', '_' or '-'." },
        url: { type: "string", description: "Base URL, e.g. https://example.odoo.com" },
        db: { type: "string" },
        username: { type: "string", description: "Login / email." },
        api_key: { type: "string" },
        description: { type: "string", description: "What this instance is; helps pick it later." },
      },
      required: ["name", "url", "db", "username", "api_key"],
    },
    handler: async ({ name, url, db, username, api_key, description = "" }) => {
      if (!/^[\w.-]+$/.test(name)) throw new Error("Profile name may only use letters, digits, '.', '_' and '-'.");
      if (!/^https?:\/\//.test(url)) throw new Error("url must start with http:// or https://.");
      const profiles = existsSync(PROFILES_FILE) ? loadProfiles() : {};
      if (profiles[name]) {
        throw new Error(`Profile '${name}' already exists. Use odoo_update_profile, or odoo_remove_profile first.`);
      }
      const entry = { description, url: url.replace(/\/+$/, ""), db, username, api_key, allow_write: false };
      const uid = await authenticate(normalize(name, entry));
      profiles[name] = entry;
      saveProfiles(profiles);
      return { saved: name, uid, url: entry.url, db, allow_write: false };
    },
  },
  {
    name: "odoo_update_profile",
    noProfile: true,
    description:
      "Change a saved profile's description, username or api_key (e.g. a rotated key; login is re-checked). url, db and allow_write cannot be changed here: remove and re-add for a new instance, edit the file by hand for allow_write.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        username: { type: "string" },
        api_key: { type: "string" },
      },
      required: ["name"],
    },
    handler: async ({ name, description, username, api_key, ...rest }) => {
      if (Object.keys(rest).length) {
        throw new Error(`Cannot change ${Object.keys(rest).join(", ")} here. Remove and re-add the profile, or edit the profiles file by hand.`);
      }
      const profiles = loadProfiles();
      if (!profiles[name]) throw new Error(`Unknown profile '${name}'. Available: ${Object.keys(profiles).join(", ")}.`);
      const next = { ...profiles[name] };
      if (description !== undefined) next.description = description;
      if (username) next.username = username;
      if (api_key) next.api_key = api_key;
      if (username || api_key) await authenticate(normalize(name, next));
      profiles[name] = next;
      saveProfiles(profiles);
      return { updated: name };
    },
  },
  {
    name: "odoo_remove_profile",
    noProfile: true,
    description:
      "Delete a saved profile, including its stored API key. Destructive: confirm with the user first.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    handler: async ({ name }) => {
      const profiles = loadProfiles();
      if (!profiles[name]) throw new Error(`Unknown profile '${name}'. Available: ${Object.keys(profiles).join(", ")}.`);
      delete profiles[name];
      saveProfiles(profiles);
      return { removed: name, remaining: Object.keys(profiles) };
    },
  },
  {
    name: "odoo_whoami",
    description:
      "Return the connected Odoo server version and authenticated user id. Use first to confirm the connection works.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, p) => {
      const version = await jsonrpc(p, "common", "version", []);
      const uid = await authenticate(p);
      return { profile: p.name, uid, url: p.url, db: p.db, server_version: version };
    },
  },
  {
    name: "odoo_find_models",
    description:
      "Find Odoo models whose technical name or label contains `name` (e.g. 'sale' -> sale.order).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Substring to match against model or label." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["name"],
    },
    handler: async ({ name, limit = 20 }, p) =>
      execute(
        p,
        "ir.model",
        "search_read",
        [["|", ["model", "ilike", name], ["name", "ilike", name]]],
        { fields: ["model", "name"], limit }
      ),
  },
  {
    name: "odoo_fields_get",
    description:
      "Introspect a model's fields. Returns an object keyed by technical field name. Use to look up a field's real technical name and type.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model, e.g. 'sale.order'." },
        attributes: {
          type: "array",
          items: { type: "string" },
          description: "Metadata to return (default: string,type,required,readonly,relation,store).",
        },
      },
      required: ["model"],
    },
    handler: async ({ model, attributes }, p) =>
      execute(p, model, "fields_get", [], {
        attributes: attributes || ["string", "type", "required", "readonly", "relation", "store"],
      }),
  },
  {
    name: "odoo_search_read",
    description:
      "Search records and read fields in one call. `domain` is an Odoo domain like [[\"state\",\"=\",\"sale\"]] (empty = all).",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        domain: { type: "array", description: "Odoo domain (array of conditions)." },
        fields: { type: "array", items: { type: "string" } },
        limit: { type: "number", description: "Default 50." },
        offset: { type: "number" },
        order: { type: "string", description: "e.g. 'date desc'." },
      },
      required: ["model"],
    },
    handler: async ({ model, domain, fields, limit = 50, offset = 0, order }, p) => {
      const kwargs = { fields: fields || [], limit, offset };
      if (order) kwargs.order = order;
      return execute(p, model, "search_read", [domain || []], kwargs);
    },
  },
  {
    name: "odoo_search_count",
    description: "Count records matching a domain without fetching them.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        domain: { type: "array" },
      },
      required: ["model"],
    },
    handler: async ({ model, domain }, p) => execute(p, model, "search_count", [domain || []]),
  },
  {
    name: "odoo_read",
    description: "Read specific fields for records by their ids.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        ids: { type: "array", items: { type: "number" } },
        fields: { type: "array", items: { type: "string" } },
      },
      required: ["model", "ids"],
    },
    handler: async ({ model, ids, fields }, p) =>
      execute(p, model, "read", [ids], { fields: fields || [] }),
  },
  {
    name: "odoo_execute",
    description:
      "Escape hatch: call any model method via execute_kw. Read methods always allowed; write methods require write permission enabled.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        method: { type: "string" },
        args: { type: "array", description: "Positional args array." },
        kwargs: { type: "object", description: "Keyword args object." },
      },
      required: ["model", "method"],
    },
    handler: async ({ model, method, args, kwargs }, p) => {
      guardWrite(p, method);
      return execute(p, model, method, args || [], kwargs || {});
    },
  },
  {
    name: "odoo_create",
    description: "Create a record. Requires write permission. Returns the new id.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        values: { type: "object" },
      },
      required: ["model", "values"],
    },
    handler: async ({ model, values }, p) => {
      guardWrite(p, "create");
      return execute(p, model, "create", [values]);
    },
  },
  {
    name: "odoo_write",
    description: "Update fields on existing records. Requires write permission.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        ids: { type: "array", items: { type: "number" } },
        values: { type: "object" },
      },
      required: ["model", "ids", "values"],
    },
    handler: async ({ model, ids, values }, p) => {
      guardWrite(p, "write");
      return execute(p, model, "write", [ids, values]);
    },
  },
  {
    name: "odoo_unlink",
    description: "Delete records. Requires write permission. Destructive — use with care.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        ids: { type: "array", items: { type: "number" } },
      },
      required: ["model", "ids"],
    },
    handler: async ({ model, ids }, p) => {
      guardWrite(p, "unlink");
      return execute(p, model, "unlink", [ids]);
    },
  },
];

const PROFILE_PROP = {
  type: "string",
  description:
    "Saved Odoo profile to use (see odoo_list_profiles). Required when two or more are saved; never guess, ask the user if unclear.",
};

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// --- Wire up the MCP server ------------------------------------------------
const server = new Server(
  { name: "odoo-connector", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema, noProfile }) => ({
    name,
    description,
    inputSchema: noProfile
      ? inputSchema
      : {
          ...inputSchema,
          properties: { profile: PROFILE_PROP, ...inputSchema.properties },
        },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOL_MAP.get(request.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
    };
  }
  try {
    const { profile, ...args } = request.params.arguments || {};
    const result = await tool.handler(
      args,
      tool.noProfile ? undefined : resolveProfile(profile)
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${err.message}` }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is reserved for the MCP protocol.
  console.error("Odoo MCP server running (stdio).");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
