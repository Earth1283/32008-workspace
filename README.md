# 008 Workspace

A self-hosted issue tracker and team workspace for FTC team 32008 Innovators. It replaces the pile of Word documents and Excel sheets with one fast, minimal app that the whole team shares: build and code issues, the season timeline, the engineering notebook, parts, practice results and meetings.

It runs as a single Node process with a SQLite file. There is nothing to install beyond Node itself.

## What's in it

| Page | What it does |
|---|---|
| **Home** | Days to the qualifier, robot health by subsystem, what's blocked or overdue, your issues. The layout adapts to Captain, Programmer or Builder view |
| **Issues** | List or board, with a detail panel. Status, priority, assignee, subsystem, due date, blocked-by note, comments and a suggested Git branch name. Drag cards between columns on desktop |
| **Notebook** | Finishing an issue offers to draft an engineering notebook entry (Problem, What we tried, Result, Next step), pre-filled from the issue and its comments. The sidebar counts finished issues that still have no entry |
| **Season** | Timeline of phases and milestones with a today marker |
| **Parts** | Have, ordered and needed counts, spend against a budget |
| **Practice** | Log auto success and cycle times, with trend charts |
| **Meetings** | Agenda, notes, attendees and action items. An action item becomes an issue in one click |
| **Pit board** | Large type for glancing at from across the pit: countdown, subsystem health, blockers |
| **Settings** | Profile, team identity and logo, theme and accent color, density, members and access, GitHub |

Changes show up on teammates' screens within a moment, with no refresh.

## Quick start

You need Node 22.13 or newer.

```sh
npm run demo       # sample data, sign in as joseph / innovators
npm start          # a real, empty workspace
```

Then open `http://localhost:9000` (or the machine's address). A fresh database shows a setup screen where you enter the team details and create the first admin account. Everyone else is added from Settings, Members.

Prefer Docker?

```sh
docker compose up -d --build
```

For a real install on a team machine (firewall, HTTPS, backups, restores, troubleshooting), read **[DEPLOYMENT.md](DEPLOYMENT.md)**.

## Configuration

Set these as environment variables.

| Variable | Default | |
|---|---|---|
| `PORT` | `9000` | |
| `HOST` | `0.0.0.0` | Use `127.0.0.1` behind a reverse proxy |
| `DB_PATH` | `data/008.db` | |
| `DEMO` | unset | `1` seeds sample data into an empty database |
| `TRUST_PROXY` | unset | `1` behind a reverse proxy, so login lockouts follow each real client |

## People and access

Admins create accounts (Settings, Members, Add member). Each gets a one-time temporary password and must choose their own at first sign-in.

| Access | Can do |
|---|---|
| **Admin** | Everything, including settings, members, the season and deleting issues |
| **Member**, **Mentor** | Create and edit issues, notebook entries, parts, practice sessions and meetings |
| **Viewer** | Read everything, change nothing |

Passwords are hashed with scrypt. Sessions are random tokens in an HttpOnly cookie that lasts 30 days. Five failed sign-ins lock that username and address for a minute.

## Keyboard

| Keys | |
|---|---|
| `Ctrl K` or `Cmd K` | Search issues, jump to a page, run an action |
| `C` | New issue |
| `J` / `K` | Next or previous issue in the list |
| `1` to `5` | Set the open issue to To do, In progress, In review, Blocked, Done |
| `G` then `H` `I` `S` `N` `P` `R` `M` `B` `,` | Go to Home, Issues, Season, Notebook, Parts, Practice, Meetings, Pit board, Settings |
| `Esc` | Close a panel, dialog or the pit board |

## Operating it

```sh
node server/admin.js list-users
node server/admin.js reset-password <username>   # lost password, including the only admin's
node server/admin.js backup <file>               # safe while the server is running
```

Settings, Workspace, Download backup also gives a readable JSON export. See [DEPLOYMENT.md](DEPLOYMENT.md) for scheduling backups and restoring.

## How it's built

```
server/   server.js   entry point
          app.js      HTTP routes, sessions, permissions, live updates
          db.js       SQLite schema and document store
          validate.js the data schema: only listed fields are kept, each type- and length-checked
          auth.js     password hashing, tokens, login throttle
          admin.js    operator commands
          demo.js     sample data loader
public/   the app: index.html, app.js, data.js, style.css, theme.js (no build step)
test/     API tests and end-to-end UI tests
data/     SQLite files (git-ignored)
```

Each collection (issues, notebook, parts, practice, meetings, milestones, phases) is stored as JSON documents in one table. The frontend is plain JavaScript with no framework and no bundler. The server uses only Node's standard library plus its built-in `node:sqlite`. `jsdom` is the single dev dependency, used by the UI tests.

### API

All routes are under `/api` and need a session, except `session`, `login` and `setup`. Writes must carry an `X-Client` header and come from the same site.

| Route | |
|---|---|
| `GET /session`, `POST /login`, `POST /logout`, `POST /setup`, `POST /password` | Sessions and first-run setup |
| `GET /state` | Everything the app needs, in one response |
| `POST /<collection>`, `PUT /<collection>/<id>`, `DELETE /<collection>/<id>` | Create, replace, delete. Collections: `issues`, `notebook`, `practice`, `meetings`, `parts`, `milestones`, `phases` |
| `PUT /meta/team`, `PUT /meta/settings` | Team identity and settings (admin) |
| `PATCH /people/<id>` | Your own name and role, or anyone's if admin |
| `POST /users`, `PATCH /users/<id>`, `POST /users/<id>/reset` | Members and access (admin) |
| `GET /events` | Server-sent events: tells other clients something changed |
| `GET /export` | JSON backup (admin) |

## Development

```sh
npm install        # only needed for the UI tests (jsdom)
npm test           # 17 tests: API, admin tools, and the real UI driven against the real server
```

The tests start the server in-process on a random port with an in-memory database, so they never touch `data/`.

## Known limits

- **Plain HTTP** unless you put a reverse proxy with TLS in front of it.
- **Last write wins** when two people change the same field of the same record at the same moment.
- **GitHub** support is limited to saving the repo name and suggesting branch names. Live branch and pull request sync isn't built.
- **Notifications** are saved as per-device preferences. Nothing is sent yet.
- **Accounts can't be deleted**, because their names appear on past work. Set them to Viewer instead.
- **No import.** The JSON export is for reading and archiving. Recover from database backups.
- Fonts load from Google Fonts and fall back to system fonts offline.

## License

GNU Affero General Public License, version 3 or later (`AGPL-3.0-or-later`). The full text is in [LICENSE](LICENSE).

You can use, study, change and share this freely. If you modify it and let other people use your modified version over a network, the AGPL requires you to offer those users the source code of your version. Running an unmodified copy for your own team asks nothing extra of you.
