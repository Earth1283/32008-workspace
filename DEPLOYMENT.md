# Deploying 008 Workspace

This guide gets the workspace running on a machine your team can reach, keeps it safe, and keeps your data backed up. Plan on about 30 minutes the first time.

## Choose a setup

| | Docker Compose | Node and systemd |
|---|---|---|
| Best for | Most teams. One command to start, update and roll back | A machine where you'd rather not run Docker |
| You need | Docker with the Compose plugin | Node 22.13 or newer |
| Data lives in | A Docker volume | A directory you choose |

Both run the same server, which listens on port 9000. Pick one and follow its section, then do [First run](#first-run), [Reach it from other devices](#reach-it-from-other-devices) and [Backups](#backups). Those last three matter no matter which you pick.

---

## Option A: Docker Compose

```sh
git clone <your repo> 008-workspace && cd 008-workspace
docker compose up -d --build
docker compose ps              # STATUS should say "healthy" after a few seconds
docker compose logs -f         # Ctrl+C to leave the log
```

Open `http://<machine-ip>:9000`.

The database is stored in a Docker volume named `workspace-data`, so rebuilding the image never touches your data.

**Update**

```sh
git pull
docker compose up -d --build
```

**Stop and start**

```sh
docker compose stop            # data is kept
docker compose start
docker compose down            # removes the container, keeps the volume
```

Never run `docker compose down -v`. The `-v` deletes the volume, and with it everything you've entered.

**Run an admin command** (see [Operations](#operations)):

```sh
docker compose exec workspace node server/admin.js list-users
```

---

## Option B: Node and systemd

Check the Node version first. It must be 22.13 or newer, and installed system-wide (a per-user install such as nvm won't work for a service):

```sh
node -v
command -v node        # note this path for the unit file below
```

Install the app and a dedicated user:

```sh
sudo useradd --system --home /opt/008-workspace --shell /usr/sbin/nologin workspace
sudo mkdir -p /opt/008-workspace /var/lib/008-workspace
sudo cp -r package.json server public /opt/008-workspace/
sudo chown -R workspace: /var/lib/008-workspace
```

Create `/etc/systemd/system/008-workspace.service`. Change the `node` path if `command -v node` printed something else:

```ini
[Unit]
Description=008 Workspace
After=network.target

[Service]
User=workspace
WorkingDirectory=/opt/008-workspace
Environment=NODE_ENV=production PORT=9000 DB_PATH=/var/lib/008-workspace/008.db
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/008-workspace

[Install]
WantedBy=multi-user.target
```

Start it:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now 008-workspace
systemctl status 008-workspace
journalctl -u 008-workspace -f        # the log
```

**Update**

```sh
sudo cp -r package.json server public /opt/008-workspace/
sudo systemctl restart 008-workspace
```

**Run an admin command.** Always run these as the `workspace` user, so the database files keep the right owner:

```sh
sudo -u workspace env DB_PATH=/var/lib/008-workspace/008.db node /opt/008-workspace/server/admin.js list-users
```

---

## First run

1. Open the site. A fresh install shows **Set up your workspace**. Enter your team number, name, short name (008), season and, if you know it, the qualifier date. Create your admin account with a strong password.
2. Don't set `DEMO=1` on a real install. It fills the database with sample data.
3. Go to **Settings, Workspace**. Check the identity fields, upload the logo, set the qualifier date and the parts budget.
4. Go to **Settings, Members, Add member** for each person. Each account gets a one-time temporary password. Give it to them in person or a private message. They must choose their own at first sign-in.
5. Give mentors **Mentor** access and anyone who should only watch **Viewer**.
6. Add at least one more **Admin** so you're not the only person who can manage accounts.
7. Open **Season** and add your phases and milestones.

---

## Reach it from other devices

Everyone needs to open `http://<machine-ip>:9000` on the same network as the server.

- **Find the address.** The server prints a LAN address when it starts (`docker compose logs workspace`, or the journal). Or run `hostname -I`.
- **Firewall.** If the machine has one, allow the port from your network only. With `ufw`, for a 192.168.1.x network:

  ```sh
  sudo ufw allow from 192.168.1.0/24 to any port 9000 proto tcp
  ```
- **Docker host behind another machine or VM.** Make sure port 9000 is published all the way through. The compose file already publishes it from the container.
- **Don't put it on the open internet over plain HTTP.** Passwords and session cookies would travel unencrypted. On a trusted LAN that's an accepted risk. Anywhere else, use HTTPS as below.

---

## HTTPS with a reverse proxy

You only need this if people connect over the internet, or you don't trust the network. A reverse proxy on the same machine adds HTTPS and forwards to the app.

**Three settings that must be right**

1. Start the app with **`TRUST_PROXY=1`** so login lockouts follow each real client instead of lumping everyone behind the proxy together.
2. Keep the app off the public network. Publish it on loopback only: set `HOST=127.0.0.1` (systemd), or change the compose port line to `"127.0.0.1:9000:9000"`.
3. **The proxy must pass the original `Host` header through.** The server rejects any write whose `Origin` doesn't match `Host` ("Cross-site request blocked"). A proxy that rewrites `Host` breaks every save.

In Docker Compose, add under the service:

```yaml
    environment:
      TRUST_PROXY: "1"
    ports:
      - "127.0.0.1:9000:9000"
```

For systemd, add `TRUST_PROXY=1 HOST=127.0.0.1` to the `Environment=` line.

**Caddy** (needs a domain name pointing at the machine and ports 80 and 443 open; certificates are automatic):

```
workspace.example.org {
    reverse_proxy 127.0.0.1:9000
}
```

**nginx** (the live-update stream needs buffering off):

```nginx
server {
    listen 443 ssl;
    server_name workspace.example.org;
    # ssl_certificate and ssl_certificate_key lines go here (for example from certbot)

    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_set_header Host              $http_host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/events {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $http_host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
```

When the proxy sends `X-Forwarded-Proto: https`, the server marks the session cookie `Secure` automatically.

Tunnels (Cloudflare Tunnel, Tailscale) also work. Just make sure the `Host` header isn't rewritten, and set `TRUST_PROXY=1` only if the tunnel adds `X-Forwarded-For`.

---

## Backups

Your data is one SQLite file. Back it up before every update and on a schedule.

**Make a backup.** This is safe while the server is running:

```sh
# Docker
docker compose exec workspace node server/admin.js backup /app/data/backup-$(date +%F).db
docker compose cp workspace:/app/data/backup-$(date +%F).db ./

# systemd
sudo -u workspace env DB_PATH=/var/lib/008-workspace/008.db \
  node /opt/008-workspace/server/admin.js backup /var/lib/008-workspace/backup-$(date +%F).db
```

The command refuses to overwrite an existing file, so add the date or a counter to the name.

**Schedule it.** For example nightly at 3:00, in the crontab of a user who can run the command above (note the escaped `%`):

```
0 3 * * * cd /srv/008-workspace && docker compose exec -T workspace node server/admin.js backup /app/data/backup-$(date +\%F).db
```

Old backup files pile up. Clean them out now and then, and **copy them off the machine**. A backup on the same disk won't survive that disk failing. A USB drive, a cloud folder or another computer all work.

**A second kind of backup.** Settings, Workspace, Download backup gives a readable JSON export. It's good for archiving or inspecting your data, but there's no import tool, so don't rely on it for recovery.

**Restore**

```sh
# Docker: stop, put the backup in place, start
docker compose stop
docker compose run --rm --no-deps --user root -v "$PWD:/restore:ro" workspace sh -c \
  'rm -f /app/data/008.db-wal /app/data/008.db-shm && cp /restore/backup-2026-10-23.db /app/data/008.db && chown node:node /app/data/008.db'
docker compose start

# systemd
sudo systemctl stop 008-workspace
sudo -u workspace sh -c 'rm -f /var/lib/008-workspace/008.db-wal /var/lib/008-workspace/008.db-shm'
sudo -u workspace cp /path/to/backup.db /var/lib/008-workspace/008.db
sudo systemctl start 008-workspace
```

Test a restore once, before you need it.

---

## Operations

**Health check.** `GET /api/session` returns 200 when the server is up. Docker uses it already. An uptime monitor can poll it too.

**Logs.** `docker compose logs -f`, or `journalctl -u 008-workspace -f`.

**Time zone.** Set `TZ` to the team's time zone, for example `America/New_York`. For Docker, uncomment it in `docker-compose.yml`. For systemd, add it to the `Environment=` line. It decides which day "due tomorrow" reminders and the Sunday digest go out.

**GitHub.** Sync needs outgoing HTTPS to `api.github.com` and nothing incoming. If it fails, Settings, Integrations shows why.

**Admin commands**

| Command | What it does |
|---|---|
| `node server/admin.js list-users` | Shows every account and its access level |
| `node server/admin.js reset-password <username>` | Prints a new temporary password and ends that person's sessions |
| `node server/admin.js backup <file>` | Writes a consistent copy of the database |

**Locked out of the only admin account?** Run `reset-password` for that username on the server. You can't do it from the web page, so it needs access to the machine.

**Someone left the team.** Settings, Members: set their access to **Viewer**, or reset their password and don't share the new one. Accounts can't be deleted yet, because their name appears on past issues and notebook entries.

**Disk use.** A season of team data is a few megabytes. Uploaded logos are stored in the database, capped at 300 KB.

---

## Security notes

- Passwords are hashed with scrypt and never stored in plain text. Sessions last 30 days, and changing or resetting a password ends the other sessions.
- Five failed sign-ins lock that username and address for a minute.
- Viewers are read-only, enforced by the server. Only admins can change settings, members, the season, or delete issues.
- Every write must come from the same site and carry a custom header, which blocks cross-site request forgery.
- It uses plain HTTP unless you add a proxy. See [HTTPS](#https-with-a-reverse-proxy).
- Edits to the same field of the same record at the same moment: the later save wins.
- There's no email, so temporary passwords have to be handed over by you.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Other devices can't open the site | Firewall, or the port isn't published. Test from the server itself with `curl http://127.0.0.1:9000/api/session`, then from another device with the LAN address |
| Every save fails with "Cross-site request blocked" | The proxy is rewriting `Host`. Pass it through (`proxy_set_header Host $http_host;`) |
| "Too many attempts" at sign-in | Five wrong passwords. Wait a minute. Behind a proxy without `TRUST_PROXY=1`, one person's mistakes can lock everyone out of that username |
| Changes from teammates only appear after a refresh | The proxy is buffering the live-update stream. Use the nginx `/api/events` block above |
| Fails to start with a `node:sqlite` error | Node is older than 22.13. Upgrade it, or use the Docker setup |
| "unable to open database file" or "readonly database" | The data directory isn't writable by the app's user. Docker bind mounts need to be owned by uid 1000. systemd needs `ReadWritePaths` and `chown workspace` |
| The page looks plain, with a different font | The browser can't reach Google Fonts. The app works fine; it just uses system fonts |
| Sessions end unexpectedly | A password was changed or reset, or the server's database was replaced by a restore. Sign in again |
