# 008 Workspace

A self-hosted issue tracker and team workspace for FTC team 32008 Innovators. It replaces the pile of Word documents and Excel sheets with one fast, minimal app that the whole team shares: build and code issues, the season timeline, the engineering notebook, parts, practice results and meetings.

It runs as a single Node process with a SQLite file. There is nothing to install beyond Node itself.

## What's in it

| Page | What it does |
|---|---|
| **Inbox** | Your notifications: assignments, comments, @mentions, blockers, due dates, GitHub review requests and an optional Sunday digest. The sidebar shows how many are unread |
| **Home** | Days to the qualifier, robot health by subsystem, what's blocked or overdue, your issues. The layout adapts to Captain, Programmer or Builder view |
| **Issues** | List or board, with a detail panel. Status, priority, assignee, subsystem, due date, blocked-by note, comments and a suggested Git branch name. Drag cards between columns on desktop |
| **Notebook** | Finishing an issue offers to draft an engineering notebook entry (Problem, What we tried, Result, Next step), pre-filled from the issue and its comments. The sidebar counts finished issues that still have no entry |
| **Season** | Timeline of phases and milestones with a today marker |
| **Parts** | Have, ordered and needed counts, spend against a budget |
| **Practice** | Log auto success and cycle times, with trend charts |
| **Meetings** | Agenda, notes, attendees and action items. An action item becomes an issue in one click |
| **Pit board** | Large type for glancing at from across the pit: countdown, subsystem health, blockers |
| **Settings** | Profile, team identity and logo, theme and accent color, density, which notifications you get, members and access, GitHub |

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
| `TZ` | the system's | The team's time zone, for example `America/New_York`. Decides when "due tomorrow" and the Sunday digest go out. Docker containers default to UTC |
| `GITHUB_POLL_SECONDS` | `180` | How often to check GitHub for pull requests. At least 60. `0` turns the timer off (Check now in Settings still works) |
| `GEMINI_API_KEY` | unset | Turns on "ask the workspace" (see below). Put it in `.env`, which the server reads at start |
| `GEMINI_MODEL` | `gemini-flash-lite-latest` | Any Gemini model id that supports structured output |
| `CONFIG_DIR` | `config/` | Where the ask prompts live |

## Ask the workspace

Type a question that starts with "what's" in Ctrl K, for example `what's blocking the lift`. After 1.5 seconds without typing, the server asks a small Gemini model and the answer appears below the normal matches, with the issues it mentions as rows you can open.

- Set `GEMINI_API_KEY` in `.env` (copy `.env.example`) and restart. Use a key from a billing-enabled Google project: on the free tier Google may train on prompts and let reviewers read them. The calls use no Search grounding, caching or file upload, the features Google's zero data retention page says to avoid.
- Sent: issue titles, status, owners, due dates and blocked reasons; people's first names and roles; parts; milestones; practice runs; meeting titles and action items; notebook titles. Never sent: comments, issue descriptions, notebook text, passwords or tokens.
- Limits: 12 questions a minute and 300 a day per person. An admin can switch it off in Settings, Integrations.
- The wording is yours to change. On first run the server writes `config/ask-system.md` and `config/ask-prompt.md`; edit and save, and the next question uses them, no restart. Delete a file to get the original back. `config/` is not in git, so a `git pull` never conflicts with your edits. With Docker it is mounted from `./config` next to the compose file.

## GitHub

An admin connects the repository in Settings, Integrations. The server then checks its pull requests every few minutes. There's no webhook, so it works on a server the internet can't reach. It only needs to make outgoing requests to `api.github.com`.

- A pull request links to an issue when its branch uses the suggested name (`ftc-42-...`) or its title contains `FTC-42`.
- With **Move issues with pull requests** on, opening a PR sets the issue to In review and merging sets it to Done. This happens only when the PR changes, so moving an issue back by hand sticks.
- People who add their GitHub username in Settings, Profile get review requests in their inbox.
- A public repo needs no token. For a private one, create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) for that repository with read-only **Pull requests** access and paste it into Settings. It is stored on the server and never sent to browsers or included in the JSON export. Database backups do contain it.

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
          notify.js   the inbox: who hears about what, due-date and digest checks
          github.js   pull request sync
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
| `POST /<collection>`, `PUT /<collection>/<id>`, `DELETE /<collection>/<id>` | Create, replace, delete. Collections: `issues`, `notebook`, `practice`, `meetings`, `parts`, `milestones`, `phases`. Every record carries a `rev`. Send it back with a `PUT` and the save is refused with `409` and the current copy if someone saved first; leave it out and last write wins |
| `PUT /meta/team`, `PUT /meta/settings` | Team identity and settings (admin) |
| `PATCH /people/<id>` | Your own name and role, or anyone's if admin |
| `POST /users`, `PATCH /users/<id>`, `POST /users/<id>/reset` | Members and access (admin) |
| `GET /events` | Server-sent events: tells other clients something changed, and tells you when your inbox changed |
| `PUT /prefs` | Your notification choices |
| `POST /notifications/read` | Mark `{ "ids": [...] }` or `{ "all": true }` as read. Your inbox comes with `GET /state` |
| `POST /github/sync`, `PUT /github/token`, `DELETE /github/token` | Check GitHub now, save or remove the access token (admin) |
| `GET /export` | JSON backup (admin) |

## Development

```sh
npm install        # only needed for the UI tests (jsdom)
npm test           # 25 tests: API, admin tools, and the real UI driven against the real server
```

The tests start the server in-process on a random port with an in-memory database, so they never touch `data/`.

## Known limits

- **Plain HTTP** unless you put a reverse proxy with TLS in front of it.
- **Simultaneous edits merge** field by field, and comments, attendees, agenda and action items merge item by item. Only when two people change the same field at the same moment does the later save win, and that person is told.
- **GitHub** sync is up to a few minutes behind, and reads the 50 most recently updated pull requests on each check.
- **Notifications** appear in the app only. Nothing is emailed or pushed to phones.
- **Accounts can't be deleted**, because their names appear on past work. Set them to Viewer instead.
- **No import.** The JSON export is for reading and archiving. Recover from database backups.
- Fonts load from Google Fonts and fall back to system fonts offline.

## License

GNU Affero General Public License, version 3 or later (`AGPL-3.0-or-later`). The full text is in [LICENSE](LICENSE).

You can use, study, change and share this freely. If you modify it and let other people use your modified version over a network, the AGPL requires you to offer those users the source code of your version. Running an unmodified copy for your own team asks nothing extra of you.
