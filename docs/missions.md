# Missions

Missions routes small, focused asks to the teammate with the right expertise, turns their answer into shipped work through an ordinary QM session, and rewards them with QM Points on a weekly leaderboard. The design notes are in [`adrs/missions.md`](../adrs/missions.md).

## Run it locally

Requirements: Node 24.15 or newer, npm 11, Docker, and a model credential (a ChatGPT login in `~/.codex/auth.json` works with `HARNESS=codex`).

```bash
npm ci
HARNESS=codex npm run dev-instance:web
npm run sandbox:local:build
```

Open the portal URL the dev instance prints (for example `http://localhost:8129`), then:

1. Settings → Profile picture → Upload photo.
2. Open `/missions?demo=1`. This shows the demo controls at the bottom of the Missions page (`?demo=0` hides them).
3. Reset demo seeds a team, a week of points and chat, and three open missions (PR review, support ticket, internal docs).
4. Send mission in 8 s creates an app review mission, which shows as a toast and a sidebar badge.
5. Open a mission, write notes, send them, then Watch QM apply your notes.
6. Ask QM to find missions starts a scout session that creates missions from what it can see.

The app review mission points at an app published at `/d/acme-pricing/`. Ask QM to build and publish a deliberately rough pricing page with that name first, or change the URL in the demo seed.

## API

Agents find these routes through `GET /v1/apis`.

| Method   | Path                        | What it does                                                                                                                         |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| GET      | `/v1/missions`              | Board for the caller: their missions, all missions, the weekly leaderboard, and the feed                                             |
| POST     | `/v1/missions`              | Send a mission: `{kind, title, question, reason, assigneeName, assignee?, app:{name, owner, url?}, context?, minutes, points, from}` |
| POST     | `/v1/missions/:id/answer`   | Record the answer and award the points: `{answer}`                                                                                   |
| POST     | `/v1/missions/:id/skip`     | Skip an open mission: `{reason?}`                                                                                                    |
| POST     | `/v1/missions/:id/score`    | Bonus for specific, actionable notes: `{bonus: 0-30, reason}`                                                                        |
| POST     | `/v1/missions/:id/complete` | Report the result: `{note, url?}`                                                                                                    |
| POST     | `/v1/missions/chat`         | Post to the weekly chat: `{text}` or `{gif}` (GIPHY media URL)                                                                       |
| GET/POST | `/v1/profile-photo`         | Read or set the caller's photo: `{photo: data URL or null}`                                                                          |

Kinds with dedicated panels: `app` (live preview of `app.url`), `pr` (`context: {repo, number, author, url, title, body, additions, deletions, fileCount, files, diffFile, diff}`), `ticket` (`context: {customer, company, plan, subject, waiting, messages:[{from, at, text}]}`), `doc` (`context: {title, owner, updated, markdown}`). Any other kind falls back to the app layout.

## Configuration

| Variable                     | Default                 | Purpose                                                                                                        |
| ---------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`               | none                    | Stores the board (`mission_boards`) and photos (`profile_photos`) in Postgres. Without it they live in memory. |
| `MISSIONS_SLACK_WEBHOOK_URL` | none                    | Slack incoming webhook for new missions and completed improvements                                             |
| `PUBLIC_WEB_URL`             | `http://localhost:8129` | Base URL for "Open mission" links (QM's public web URL)                                                        |

Weeks follow ISO weeks in the server's time zone. When a new week starts, seeded points reset to zero, the feed starts over, and only missions answered during the week count.
