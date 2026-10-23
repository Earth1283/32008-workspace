import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { openDb } from "../server/db.js";
import { listUsers, resetPassword, backup } from "../server/admin.js";

const post = (base, path, body, cookie = "", extra = {}) => fetch(base + path, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Client": "t", ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: JSON.stringify(body),
});

test("admin CLI: reset a lost password, then back up the live database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "008-"));
  const dbPath = join(dir, "008.db");
  const app = createApp({ dbPath, publicDir: dir });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const setup = await post(base, "/api/setup", { team: { num: "32008", name: "Innovators" }, admin: { name: "Joseph", username: "joseph", password: "forgotten pw" } });
    const oldCookie = setup.headers.get("set-cookie").split(";")[0];

    // the CLI opens the same file while the server is running
    const cli = openDb(dbPath);
    assert.deepEqual(listUsers(cli).map((u) => [u.username, u.access, u.name]), [["joseph", "Admin", "Joseph"]]);
    const temp = resetPassword(cli, "Joseph");
    assert.throws(() => resetPassword(cli, "nobody"), /No user named/);

    const out = join(dir, "copy.db");
    backup(cli, out);
    assert.throws(() => backup(cli, out), /already exists/);
    cli.close();

    const state = await fetch(base + "/api/state", { headers: { Cookie: oldCookie } });
    assert.equal(state.status, 401, "old session ended");
    assert.equal((await post(base, "/api/login", { username: "joseph", password: "forgotten pw" })).status, 401);
    const login = await post(base, "/api/login", { username: "joseph", password: temp });
    assert.equal((await login.json()).user.mustChange, true);

    const copy = openDb(out);
    assert.equal(listUsers(copy).length, 1);
    copy.close();
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TRUST_PROXY: lockout follows the forwarded client, not the proxy", async () => {
  const mk = async (trustProxy) => {
    const app = createApp({ dbPath: ":memory:", publicDir: ".", trustProxy });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    await post(base, "/api/setup", { team: { num: "1", name: "T" }, admin: { name: "A", username: "alice", password: "correct horse" } });
    return { app, base };
  };
  const fail = (base, ip) => post(base, "/api/login", { username: "alice", password: "nope" }, "", { "X-Forwarded-For": ip });

  const trusted = await mk(true);
  for (let i = 0; i < 5; i++) await fail(trusted.base, "10.0.0.1");
  assert.equal((await fail(trusted.base, "10.0.0.1")).status, 429, "attacker is locked out");
  assert.equal((await post(trusted.base, "/api/login", { username: "alice", password: "correct horse" }, "", { "X-Forwarded-For": "10.0.0.2" })).status, 200, "another client is not");
  await trusted.app.close();

  const direct = await mk(false);
  for (let i = 0; i < 5; i++) await fail(direct.base, `10.0.0.${i}`);
  assert.equal((await fail(direct.base, "10.9.9.9")).status, 429, "spoofed headers are ignored without TRUST_PROXY");
  await direct.app.close();
});
