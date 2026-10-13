// Offline check: spawns the real server against two fake Odoo instances.
// Run: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));

// Fake Odoo: uid and execute_kw reply identify the instance, so routing is visible.
function fakeOdoo(uid, calls) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { params } = JSON.parse(body);
        calls.push({ uid, ...params });
        let result;
        if (params.method === "version") result = { server_version: `fake-${uid}` };
        else if (params.method === "authenticate") result = params.args[2] === "bad" ? false : uid;
        else result = [{ answered_by: uid, db: params.args[0], method: params.args[4] }];
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

async function connect(profilesFile) {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(here, "..", "server", "index.js")],
      env: { ...process.env, ODOO_PROFILES_FILE: profilesFile },
    })
  );
  return client;
}

const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
const text = (r) => r.content[0].text;

test("profiles route independently, none is a default", async () => {
  const calls = [];
  const a = await fakeOdoo(11, calls);
  const b = await fakeOdoo(22, calls);
  const url = (s) => `http://127.0.0.1:${s.address().port}/`;
  const dir = mkdtempSync(join(tmpdir(), "odoo-profiles-"));
  const file = join(dir, "profiles.json");
  const profiles = {
    prod: { description: "production", url: url(a), db: "prod_db", username: "u", api_key: "k1" },
    test: { description: "staging", url: url(b), db: "test_db", username: "u", api_key: "k2", allow_write: true },
  };
  writeFileSync(file, JSON.stringify(profiles));
  const client = await connect(file);
  try {
    // every non-list tool exposes `profile`; list does not
    const tools = (await client.listTools()).tools;
    assert.ok(!tools.find((t) => t.name === "odoo_list_profiles").inputSchema.properties.profile);
    assert.ok(tools.find((t) => t.name === "odoo_search_read").inputSchema.properties.profile);

    // list: no keys leaked
    const listed = text(await call(client, "odoo_list_profiles"));
    assert.ok(listed.includes("production") && listed.includes("staging"));
    assert.ok(!listed.includes("k1") && !listed.includes("api_key"));

    // two profiles + no `profile` => refuse, never pick
    const none = await call(client, "odoo_search_count", { model: "res.partner" });
    assert.equal(none.isError, true);
    assert.match(text(none), /profile` is required.*prod, test/);

    // unknown name => refuse
    const bad = await call(client, "odoo_whoami", { profile: "nope" });
    assert.equal(bad.isError, true);
    assert.match(text(bad), /Unknown profile 'nope'/);

    // each profile hits its own server, db and uid
    const ra = JSON.parse(text(await call(client, "odoo_whoami", { profile: "prod" })));
    const rb = JSON.parse(text(await call(client, "odoo_whoami", { profile: "test" })));
    assert.deepEqual([ra.uid, ra.db, ra.profile], [11, "prod_db", "prod"]);
    assert.deepEqual([rb.uid, rb.db, rb.profile], [22, "test_db", "test"]);

    // writes: blocked on prod (no network call), allowed on test
    const before = calls.length;
    const blocked = await call(client, "odoo_create", { profile: "prod", model: "res.partner", values: {} });
    assert.equal(blocked.isError, true);
    assert.match(text(blocked), /blocked on profile 'prod'/);
    assert.equal(calls.length, before);
    const ok = await call(client, "odoo_create", { profile: "test", model: "res.partner", values: {} });
    assert.notEqual(ok.isError, true);
    assert.equal(JSON.parse(text(ok))[0].answered_by, 22);

    // edit file at runtime: drop to one profile => `profile` becomes optional
    writeFileSync(file, JSON.stringify({ prod: profiles.prod }));
    const solo = JSON.parse(text(await call(client, "odoo_whoami")));
    assert.equal(solo.profile, "prod");
  } finally {
    await client.close();
    a.close();
    b.close();
  }
});

test("bad profiles file gives a clear error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odoo-profiles-"));
  const file = join(dir, "profiles.json");
  writeFileSync(file, JSON.stringify({ x: { url: "http://h" } }));
  const client = await connect(file);
  try {
    const r = await call(client, "odoo_list_profiles");
    assert.equal(r.isError, true);
    assert.match(text(r), /Profile 'x' is missing: db, username, api_key/);
  } finally {
    await client.close();
  }
});

test("profiles can be managed through tools, with guards", async () => {
  const calls = [];
  const a = await fakeOdoo(33, calls);
  const url = `http://127.0.0.1:${a.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "odoo-profiles-"));
  const file = join(dir, "sub", "profiles.json"); // dir and file do not exist yet
  const client = await connect(file);
  const onDisk = () => JSON.parse(readFileSync(file, "utf8"));
  try {
    // add creates the file; saved read-only; key is not echoed
    const added = await call(client, "odoo_add_profile", { name: "new", url: url + "/", db: "d", username: "u", api_key: "good", description: "fresh" });
    assert.notEqual(added.isError, true);
    assert.ok(!text(added).includes("good"));
    assert.deepEqual(onDisk().new, { description: "fresh", url, db: "d", username: "u", api_key: "good", allow_write: false });

    // duplicate refused; bad login refused and not saved; bad name refused
    assert.match(text(await call(client, "odoo_add_profile", { name: "new", url, db: "d", username: "u", api_key: "good" })), /already exists/);
    const badLogin = await call(client, "odoo_add_profile", { name: "other", url, db: "d", username: "u", api_key: "bad" });
    assert.equal(badLogin.isError, true);
    assert.match(text(badLogin), /Authentication failed/);
    assert.ok(!onDisk().other);
    assert.match(text(await call(client, "odoo_add_profile", { name: "a b", url, db: "d", username: "u", api_key: "good" })), /may only use/);

    // update: description alone; guarded fields refused; bad new key refused and not saved
    await call(client, "odoo_update_profile", { name: "new", description: "renamed" });
    assert.equal(onDisk().new.description, "renamed");
    for (const field of [{ url: "http://evil" }, { db: "x" }, { allow_write: true }]) {
      const r = await call(client, "odoo_update_profile", { name: "new", ...field });
      assert.equal(r.isError, true);
      assert.match(text(r), /Cannot change/);
    }
    assert.equal(onDisk().new.allow_write, false);
    assert.equal(onDisk().new.url, url);
    const badKey = await call(client, "odoo_update_profile", { name: "new", api_key: "bad" });
    assert.equal(badKey.isError, true);
    assert.equal(onDisk().new.api_key, "good");

    // remove
    assert.deepEqual(JSON.parse(text(await call(client, "odoo_remove_profile", { name: "new" }))), { removed: "new", remaining: [] });
    assert.deepEqual(onDisk(), {});
    assert.match(text(await call(client, "odoo_remove_profile", { name: "new" })), /Unknown profile/);
  } finally {
    await client.close();
    a.close();
  }
});
