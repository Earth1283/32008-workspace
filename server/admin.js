/* Operator commands. Run on the machine (or inside the container) that holds the database.
     node server/admin.js list-users
     node server/admin.js reset-password <username>
     node server/admin.js backup <file>
*/
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { openDb } from "./db.js";
import { hashPassword, tempPassword } from "./auth.js";

export function listUsers(db) {
  return db.prepare(`SELECT u.username, u.access, json_extract(d.data, '$.name') AS name
    FROM users u LEFT JOIN docs d ON d.coll = 'people' AND d.id = u.id ORDER BY u.created_at`).all();
}

/** Sets a new temporary password, forces a change at next sign-in, and ends the user's sessions. */
export function resetPassword(db, username) {
  const row = db.prepare("SELECT id FROM users WHERE username = ?").get(String(username).toLowerCase());
  if (!row) throw new Error(`No user named "${username}"`);
  const password = tempPassword();
  db.prepare("UPDATE users SET pass = ?, must_change = 1 WHERE id = ?").run(hashPassword(password), row.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.id);
  return password;
}

/** Consistent copy of the live database, safe while the server is running. */
export function backup(db, file) {
  const out = resolve(file);
  if (existsSync(out)) throw new Error(`${out} already exists. Pick a new file name.`);
  db.prepare("VACUUM INTO ?").run(out);
  return out;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const [cmd, arg] = process.argv.slice(2);
  const usage = "Usage: node server/admin.js list-users | reset-password <username> | backup <file>";
  if (!["list-users", "reset-password", "backup"].includes(cmd) || (cmd !== "list-users" && !arg)) {
    console.error(usage);
    process.exit(2);
  }
  const path = resolve(process.env.DB_PATH ?? join(root, "data", "008.db"));
  if (!existsSync(path)) { console.error(`No database at ${path}. Set DB_PATH if it lives elsewhere.`); process.exit(1); }
  const db = openDb(path);
  try {
    if (cmd === "list-users") {
      for (const u of listUsers(db)) console.log(`${u.username.padEnd(20)} ${u.access.padEnd(8)} ${u.name ?? ""}`);
    } else if (cmd === "reset-password") {
      const pw = resetPassword(db, arg);
      console.log(`New temporary password for ${arg}: ${pw}`);
      console.log("They will be asked to choose their own at next sign-in. Their other sessions were ended.");
    } else {
      console.log(`Backup written to ${backup(db, arg)}`);
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
