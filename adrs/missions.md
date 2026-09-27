# Missions: route small asks to the right expert, and keep score

Agus here, from the Own Your Intelligence hackathon. With QM, everyone at a company ships apps, automations and docs. Quality varies, and the people with the taste to fix it (a designer, the engineer who owns a subsystem, whoever set up SSO for three customers) can't review everything. Missions is a loop inside QM that finds those moments, asks the right person one focused question, turns their answer into shipped work, and rewards them.

How it works

- QM sends a teammate a mission: one concrete question, one sentence on why they were picked, a time estimate, and QM Points scaled to effort. A mission has a kind (app review, PR review, support ticket, internal docs, or anything else) and kind-specific context, so the task page shows the live app, the diff, the customer thread, or the current doc next to the question.
- The expert answers in plain words in a composer that looks like QM's own. They can also skip a mission; skipping costs nothing.
- Answering awards the mission's points at once. "Watch QM apply your notes" starts an ordinary QM session with the mission, the context and the notes. The agent applies them (republishes the app, drafts the review or the customer reply, rewrites the doc), grades how specific and actionable the notes were for a bonus of up to 30 points, and completes the mission through the API.
- Missions are weekly. The Missions page shows your points and rank, the week's mission as a card with a countdown to Sunday midnight, more missions, a podium, and a chat where every points award shows up next to messages and GIFs. When a new ISO week starts, points and the feed start over.
- "Ask QM to find missions" starts a scout session: the agent looks at recently shipped apps, sessions and files, picks up to three things a specific teammate would clearly do better, and sends the missions itself. The same instructions work as a weekly cron.
- Profile pictures: anyone can upload one in Settings. It shows in the sidebar and on the leaderboard.

What the change adds

- `src/api/routes/missions.ts`: `GET /v1/missions` and `POST /v1/missions`, plus `/:id/answer`, `/:id/skip`, `/:id/score`, `/:id/complete`, `/chat`, and demo seeding (`/people`, `/feed`, `/reset`). Routes accept the web surface (source auth, with the viewer as `principalId`) and agents (capability tokens). The board is one document per org in a `DurableMap` (`mission_boards`), so it lives in Postgres wherever the deployment has `DATABASE_URL`; requests are serialized per instance and every write lands before the response.
- `src/api/routes/profile-photos.ts`: `GET/POST /v1/profile-photo` and `GET /v1/profile-photos`, stored in a `profile_photos` `DurableMap`. Photos are square JPEGs resized to 256 px in the browser, capped at about 300 KB.
- An agent API catalog entry, so any QM agent can send, score, complete and skip missions.
- `plugins/web-ui/src/missions.ts` and `profile-photo.ts`: the Missions view (sidebar item with an open-count badge, Browse tile, toast for new missions), the task page, the Settings row, and the web server routes that forward `/api/missions*` and `/api/profile-photo*` to core.
- Optional Slack: `MISSIONS_SLACK_WEBHOOK_URL` posts a new mission with an "Open mission" button, and tells the owner when their work was improved. QM's `PUBLIC_WEB_URL` sets the link base.

What it does not do yet

- The org chart is whatever the board knows: people come from the seeded list plus anyone who received a mission. There is no link to the directory yet, so the "why you" line is written by the agent, not computed from history.
- One board per org. Rooms and projects don't have their own leaderboards.
- The web page polls every 3 seconds instead of using the delivery stream.
- The GIF picker is a fixed set of GIPHY reactions; search needs a GIPHY API key.
- Slack delivery was not exercised end to end at the hackathon.
- The demo endpoints (`/reset`, `/people`, `/feed`) are open to any signed-in member. They exist to seed a local demo and should be admin-only or removed before a shared deployment. Scoring and completing are open to any caller with an answered mission; in practice that is the assignee's own agent session.
- App previews fetch the app and render it in a sandboxed `srcdoc` frame. That works for same-origin apps with inline or absolute assets; apps on other origins show an "Open app" link instead.
- Leaderboard rows are keyed by display name, so the same person under two names gets two rows.
- The board is one document per org behind a per-instance queue. Slack calls happen inside the queue, and missions are never pruned; both need attention before heavy use.
- Weeks use the core server's time zone while the countdown uses the browser's.
