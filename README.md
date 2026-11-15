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
| **Practice** | Log full runs, auto-only runs, scrimmages and matches on the season's score sheet. Compares routines and drivers, tracks how often you reach ranking point targets, and turns a problem into an issue in one click |
| **Scouting** | Find events from four providers, save rosters, rankings and matches, shortlist teams, and share pit and match observations offline |
| **Meetings** | Agenda, notes, attendees and action items. An action item becomes an issue in one click |
| **Pit board** | Large type for glancing at from across the pit: countdown, subsystem health, blockers |
| **Settings** | Profile, team identity and logo, theme and accent color, density, which notifications you get, members and access, GitHub |

Changes show up on teammates' screens within a moment, with no refresh. The app keeps working when the connection drops (see [Working offline](#working-offline)).

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
| `FIRST_API_USERNAME`, `FIRST_API_TOKEN` | unset | FIRST Events scouting credentials. Also configurable in Scouting, Sources |
| `TOA_API_KEY` | unset | The Orange Alliance scouting key |
| `FTC_SCOREKEEPER_URL`, `FTC_SCOREKEEPER_KEY` | unset | Venue scoring server address (without `/api`) and optional Bearer API key |

## Ask the workspace

Type a question that starts with "what's" in Ctrl K, for example `what's blocking the lift`. After 1.5 seconds without typing, the server asks a small Gemini model and the answer appears below the normal matches, with the issues it mentions as rows you can open.

- Set `GEMINI_API_KEY` in `.env` (copy `.env.example`) and restart. Use a key from a billing-enabled Google project: on the free tier Google may train on prompts and let reviewers read them. The calls use no Search grounding, caching or file upload, the features Google's zero data retention page says to avoid.
- Sent: issue titles, status, owners, due dates and blocked reasons; people's first names and roles; parts; milestones; practice runs; meeting titles and action items; notebook titles. Never sent: comments, issue descriptions, notebook text, passwords or tokens.
- Limits: 12 questions a minute and 300 a day per person. An admin can switch it off in Settings, Integrations.
- The wording is yours to change. On first run the server writes `config/ask-system.md` and `config/ask-prompt.md`; edit and save, and the next question uses them, no restart. Delete a file to get the original back. `config/` is not in git, so a `git pull` never conflicts with your edits. With Docker it is mounted from `./config` next to the compose file.

## Practice runs and the score sheet

**Log a run** scores a run on the current season's sheet: the point values, the most each item can count, and the ranking point targets. The sheets live in `public/scoring.js`, and each run remembers which one it used, so adding next season's game leaves old runs correct.

The 2026–27 sheet is BIOBUZZ, from Competition Manual tables 10-2, 10-3 and 10-4. Ranking point targets are the ones for regular events; Regional and FIRST Championship targets haven't been announced, so check Team Updates when they are. SWARM counts your alliance's LEAVE and PARK points, so one robot alone can only reach 13 of 16.

## Importing from Excel

Settings, Workspace, Import brings in parts or issues, and the Parts page has the same button. Choose a CSV file (in Excel: File, Save As, CSV) or copy the cells and paste them. The columns are matched by name and you can change the matches. Rows with the same part name or issue title as something already here are left out, and the preview says why each row was skipped. Nothing is saved until you press Import, and one bad row stops the whole import.

Imported issues don't send notifications.

## Scouting

Open **Scouting** in the sidebar, or press **G then A**. Choose a source and the season's starting year (2026 for 2026–27), find an event, and press **Load event**. FTCScout and FIRST Events can also find events by team number. Switch between saved events with the dropdown.

| Source | Setup | Data |
|---|---|---|
| [FTCScout](https://ftcscout.org) | No key | Event search, team event history, roster, rankings, event OPR and auto OPR, matches |
| [FIRST Events](https://ftc-events.firstinspires.org/services/API) | API username and token | Official events, rosters, rankings and match results |
| [The Orange Alliance](https://theorangealliance.org) | X-TOA-Key | Events, rosters, rankings, available OPR and matches |
| [Venue scorekeeper](https://github.com/FIRST-Tech-Challenge/scorekeeper/wiki/API-Documentation) | Server address; Bearer key if required | Event list and the v2 full-event API: roster, rankings and qualification matches. Requires a compatible scorekeeper version |

Admins connect sources under **Scouting, Sources**, or set the environment variables above. Keys stay on the server and are excluded from state responses and JSON exports. SQLite backups contain them. Blank fields keep existing values; **Disconnect this source** clears its saved configuration, overriding environment defaults. The server must be able to reach the venue scoring computer; a tablet's connection alone is not enough.

Each event snapshot shows its source and fetch time. Refreshing is manual, with a 30-second cache to avoid duplicate requests. A failed match, roster or rankings request keeps the previous section and shows a warning. OPR is a provider's estimate of a team's contribution; match scores are alliance totals. Missing values show a dash. Sources and seasons stay separate; choosing another provider creates a separate snapshot rather than mixing rankings. Use the same event code in observations to share notes across snapshots; TOA keys may differ from FIRST codes.

Click a team for its matches and observations. Record autonomous paths, TeleOp, endgame, reliability, notes and an optional 1–5 partner-fit rating. Use the star or the observation's checkbox to shortlist a team. You can add observations by hand before loading an event. Observations without a selected event are shown for the search form's season.

Saved events can be read offline. Pit visits, match observations and shortlist edits use the same offline queue as the rest of the app. Searching, fetching events and configuring sources need a connection. Viewers can browse and search, but only members, mentors and admins can load events or change observations. **Export observations** downloads the selected event's notes as CSV, or all notes for the selected season when no event is selected.

## Working offline

Teams can't run Wi-Fi or hotspots at events (rule E301), and venue connections fail, so the app doesn't depend on one.

- Each device keeps a copy of the team's data. Without a connection you can read everything and change issues, notebook entries, practice runs, scouting observations, parts and meetings, and mark inbox items read. The pill in the corner shows how many changes are waiting.
- Changes go out in order when the server is back. New issues get their real number then, and until that point they show as FTC-new. If a teammate edited the same issue, each field you didn't both change is kept; where you both changed a field, your version wins and you're told. Anything that can't be applied, such as an edit to something a teammate deleted, stays in the list to retry or discard.
- Settings, members, GitHub, imports and asking the workspace need a connection.
- **Reopening the app with no connection needs HTTPS.** Browsers only allow the service worker that stores the app on secure addresses. On plain HTTP an open tab still works and syncs later, but closing it or reloading ends the session until you're back online. See [HTTPS](DEPLOYMENT.md#https-with-a-reverse-proxy).
- Waiting changes belong to the person who made them, so a shared tablet won't send them under someone else's name. Signing out erases the saved copy of the team's data from that device, and waits until you're online. While you stay signed in, that copy sits in the browser's storage, so anyone using that browser profile can read it.

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
| **Member**, **Mentor** | Create and edit issues, notebook entries, parts, practice sessions, scouting observations and meetings; fetch scouting events |
| **Viewer** | Read everything, change nothing |

Passwords are hashed with scrypt. Sessions are random tokens in an HttpOnly cookie that lasts 30 days. Five failed sign-ins lock that username and address for a minute.

## Keyboard

| Keys | |
|---|---|
| `Ctrl K` or `Cmd K` | Search issues, jump to a page, run an action |
| `C` | New issue |
| `J` / `K` | Next or previous issue in the list |
| `1` to `5` | Set the open issue to To do, In progress, In review, Blocked, Done |
| `G` then `H` `I` `S` `N` `P` `R` `A` `M` `B` `,` | Go to Home, Issues, Season, Notebook, Parts, Practice, Scouting, Meetings, Pit board, Settings |
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
          scouting.js external event providers and saved scouting snapshots
          admin.js    operator commands
          demo.js     sample data loader
public/   the app, with no build step: index.html, app.js, data.js, style.css, theme.js
          scoring.js  season score sheets, also used by the server
          csv.js      reading spreadsheets
          offline.js  the saved copy and the queue of waiting changes
          scouting.js scouting page, team profiles and observation forms
          sw.js       keeps the app's own files on the device
test/     API tests and end-to-end UI tests
data/     SQLite files (git-ignored)
```

Each collection (issues, notebook, parts, practice, scouting, meetings, milestones, phases, and fetched scoutEvents) is stored as JSON documents in one table. The frontend is plain JavaScript with no framework and no bundler. The server uses only Node's standard library plus its built-in `node:sqlite`. `jsdom` is the single dev dependency, used by the UI tests.

### API

All routes are under `/api` and need a session, except `session`, `login` and `setup`. Writes must carry an `X-Client` header and come from the same site.

| Route | |
|---|---|
| `GET /session`, `POST /login`, `POST /logout`, `POST /setup`, `POST /password` | Sessions and first-run setup |
| `GET /state` | Everything the app needs, in one response |
| `POST /<collection>`, `PUT /<collection>/<id>`, `DELETE /<collection>/<id>` | Create, replace, delete. A `POST` may carry a client-made `cid`, and repeating it returns the first result instead of creating a second record. Collections: `issues`, `notebook`, `practice`, `scouting`, `meetings`, `parts`, `milestones`, `phases`. Every record carries a `rev`. Send it back with a `PUT` and the save is refused with `409` and the current copy if someone saved first; leave it out and last write wins |
| `GET /scouting/search?source=…&season=…&q=…&team=…` | Find events. Sources: `ftcscout`, `first`, `toa`, `venue`; team filtering is supported by FTCScout and FIRST |
| `POST /scouting/sync` | Save or refresh `{ "source": "ftcscout", "season": 2026, "key": "CNHAQ1" }` (member). Snapshots come with `/state` as `scoutEvents` |
| `PUT /scouting/config` | Update source credentials (admin). Returns configuration status only; omitted fields keep their values |
| `PUT /meta/team`, `PUT /meta/settings` | Team identity and settings (admin) |
| `PATCH /people/<id>` | Your own name and role, or anyone's if admin |
| `POST /users`, `PATCH /users/<id>`, `POST /users/<id>/reset` | Members and access (admin) |
| `GET /events` | Server-sent events: tells other clients something changed, and tells you when your inbox changed |
| `PUT /prefs` | Your notification choices |
| `POST /notifications/read` | Mark `{ "ids": [...] }` or `{ "all": true }` as read. Your inbox comes with `GET /state` |
| `POST /github/sync`, `PUT /github/token`, `DELETE /github/token` | Check GitHub now, save or remove the access token (admin) |
| `POST /import` | `{ "coll": "parts" or "issues", "rows": [...], "cid": "..." }`. All rows or none, up to 2000 |
| `GET /export` | JSON backup (admin) |

## Development

```sh
npm install        # only needed for the UI tests (jsdom)
npm test           # API, admin tools, scoring, CSV, the offline queue, and the real UI driven against the real server
```

The tests start the server in-process on a random port with an in-memory database, so they never touch `data/`.

## Known limits

- **Plain HTTP** unless you put a reverse proxy with TLS in front of it.
- **Simultaneous edits merge** field by field, and comments, attendees, agenda and action items merge item by item. Only when two people change the same field at the same moment does the later save win, and that person is told.
- **GitHub** sync is up to a few minutes behind, and reads the 50 most recently updated pull requests on each check.
- **Notifications** appear in the app only. Nothing is emailed or pushed to phones.
- **Accounts can't be deleted**, because their names appear on past work. Set them to Viewer instead.
- **No restore from the JSON export.** It's for reading and archiving. Recover from database backups. CSV import covers parts and issues only.
- **Subsystems are fixed** in `server/validate.js` and `public/data.js`.
- Fonts load from Google Fonts and fall back to system fonts offline.

## License

GNU Affero General Public License, version 3 or later (`AGPL-3.0-or-later`). The full text is in [LICENSE](LICENSE).

You can use, study, change and share this freely. If you modify it and let other people use your modified version over a network, the AGPL requires you to offer those users the source code of your version. Running an unmodified copy for your own team asks nothing extra of you.
