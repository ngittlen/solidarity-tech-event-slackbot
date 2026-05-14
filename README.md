# Solidarity Tech Event Slackbot

A GitHub Actions workflow that pulls upcoming events from the [solidarity.tech](https://solidarity.tech) API and posts them to one or more Slack channels — one post per configured chapter.

## How it works

### Nightly preview (9 PM ET)

Every night at 9 PM ET, the workflow runs `scripts/preview-scope-events.ts`. It fetches events for a single configurable scope and posts a plain-text list to a designated review channel. The preview is anchored to the next digest's run time and uses the same window the digest will use — Sunday-night previews mirror Monday's weekly digest (next 7 days), while Monday–Saturday-night previews mirror the next morning's "new events" alert (rest of the current week). The message header makes the mode explicit so reviewers know whether they're previewing a weekly digest or a mid-week alert.

This gives reviewers a chance to move misclassified events to the correct chapter or add the `slack-exclude` tag before the digest runs.

### Daily digest (9 AM ET)

Every day at 9 AM ET, the workflow runs `scripts/post-daily-events.ts`. The behavior depends on the day of the week:

### Monday — weekly digest

On Mondays the script posts a full digest of all events for the coming 7 days to each configured channel.

### Tuesday–Sunday — new events only

On other days the script checks whether any events were added to the current week's schedule *after* Monday's digest was posted. It does this by:

1. Reading the channel's Slack message history since Monday
2. Extracting all event URLs from messages that this bot has already posted (identified by `bot_id` from `auth.test`, so other bots in the channel don't interfere)
3. Filtering the current event list down to events whose URLs have **not** been posted yet

If no new events are found, nothing is posted to that channel. If new events are found, a short "🆕 New Events This Week" message is posted containing only those events.

### Common steps (both modes)

1. **Fetches events** from the solidarity.tech API for each configured chapter (paginated, 100 events per page)
2. **Filters** to events that have a public event page URL, are not tagged `slack-exclude`, do not match any phrase in `EXCLUDE_PHRASES` (title), and have at least one session within the posting window whose location does not match any entry in `EXCLUDE_LOCATIONS`. The posting window is `[now, now + 7 days]` on Mondays and `[now, end-of-current-week]` Tuesday–Sunday.
3. **Rate limits** requests to the solidarity.tech API at 1 request per second (well within the 2 req/s limit) with a delay between each chapter to avoid throttling
4. **Sorts** events chronologically by their earliest upcoming session
5. **Builds a Slack Block Kit message** with a header, week date range, and one section per event showing the title (linked to the event page, with mrkdwn-special characters in the title escaped), session time(s), location, and event type (in-person / virtual / hybrid)
6. **Posts** the message to the mapped Slack channel for each chapter, skipping the channel if the bot can't read or post to it

Re-running the workflow on the same day is always safe:

- **On Mondays**, the script checks each channel for an existing post from this bot today (matched by `bot_id`) and skips the chapter if the weekly digest has already been delivered.
- **Tuesday–Sunday**, idempotency falls out of the URL-dedup step: every event URL this bot has posted since Monday is collected, and the filter drops events whose URLs are already in that set — so a second mid-week run on the same day ends up with nothing to post and exits early.

If more than 23 events fall in the window, the first 23 are shown with a note indicating how many were omitted (Slack has a 50-block-per-message limit).

### Example Slack messages

**Monday digest:**
```
📅 Upcoming Events — Washtenaw County
This week · Mar 10 – Mar 16 · All Events ↗

*<https://solidarity.tech/events/123|Monthly Organizing Meeting>*
📅 *Sat, Mar 15 · 10:00 AM–11:30 AM EDT*   📍 _123 Main St, Ann Arbor, MI_   🏢 In Person

────────────────────────────────

*<https://solidarity.tech/events/456|New Member Orientation>*
📅 *Wed, Mar 12 · 7:00 PM–8:00 PM EDT*   💻 Virtual
```

**Mid-week new event alert:**
```
🆕 New Events This Week — Washtenaw County
New this week · Mar 10 – Mar 16 · All Events ↗

*<https://solidarity.tech/events/789|Emergency Town Hall>*
📅 *Thu, Mar 13 · 6:00 PM–7:30 PM EDT*   💻 Virtual
```

## Setup

### Prerequisites

- A [solidarity.tech](https://solidarity.tech) account with API access
- A Slack app with the `chat:write` and `channels:history` (or `groups:history` for private channels) bot scopes installed to your workspace
- A GitHub repository to host the workflow

### 1. Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Under **OAuth & Permissions**, add the following bot scopes:
   - `chat:write` — to post messages
   - `channels:history` — to read history in public channels (used to detect already-posted events)
   - `groups:history` — add this too if any target channels are private
3. Install the app to your workspace
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`)
5. Invite the bot to each channel it should post to (including the review channel): `/invite @your-bot-name`

### 2. Find your chapter IDs and channel IDs

**Chapter ID**: Query the solidarity.tech API using your API key:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  "https://api.solidarity.tech/v1/chapters?_limit=100"
```

The response is a paginated JSON object. Each chapter in the `data` array has an `id` and `name`:

```json
{
  "data": [
    { "id": 123, "name": "Washtenaw County", ... },
    { "id": 456, "name": "Wayne County", ... }
  ],
  "meta": { "total_count": 2, "limit": 100, "offset": 0 }
}
```

Use the `id` field as the `chapterId` in your mapping. If you have more than 100 chapters, paginate using the `_offset` parameter (e.g. `?_limit=100&_offset=100`).

**Channel ID**: look in the channel details or right-click a channel in Slack → "Copy link" — the ID is the last path segment (e.g. `C0123456789`)

### 3. Configure GitHub Actions secrets

In your repository, go to **Settings → Secrets and variables → Actions** and add:

| Secret | Description |
|---|---|
| `SOLIDARITY_TECH_API_KEY` | Your solidarity.tech API key |
| `SLACK_BOT_TOKEN` | The Slack bot token (`xoxb-...`) |
| `CHAPTER_CHANNEL_MAPPING` | JSON array mapping chapters to channels (see below) |
| `REVIEW_CHANNEL_ID` | Slack channel ID for the nightly scope preview (e.g. `C0123456789`) |
| `PREVIEW_SCOPE_ID` | Scope ID to preview the night before the digest (e.g. `1008`) |
| `EXCLUDE_PHRASES` | Optional. JSON array of case-insensitive substrings; events whose title contains any are excluded (e.g. `["test event","internal only"]`) |
| `EXCLUDE_LOCATIONS` | Optional. JSON array of case-insensitive substrings matched against each session's `location_name` and `location_address` (e.g. `["zoom","HQ"]`) |

#### `CHAPTER_CHANNEL_MAPPING` format

A JSON array where each object has:

```json
[
  { "chapterId": 123, "channelId": "C0123456789", "name": "Washtenaw County", "pageUrl": "https://example.com/washtenaw-county-chapter" },
  { "chapterId": 456, "channelId": "C9876543210", "name": "Wayne County", "pageUrl": "https://example.com/wayne-county-chapter" }
]
```

- `chapterId` — numeric ID of the solidarity.tech chapter
- `channelId` — Slack channel ID to post to
- `name` — display name used in the message header
- `pageUrl` — URL for the "All Events" link shown in the message subtitle

### 4. (Optional) Adjust the posting times

- **Nightly preview**: `.github/workflows/preview-scope-events.yml` defaults to `0 1 * * *` (9 PM ET / UTC-4 EDT)
- **Daily digest**: `.github/workflows/daily-events.yml` defaults to `0 14 * * *` (9 AM ET / UTC-5 EST)

Adjust both cron expressions for your timezone or daylight saving time as needed.

## Local development

### Install dependencies

```bash
npm install
```

### Configure environment

Copy `.env.sample` to `.env.local` and fill in your values:

```bash
cp .env.sample .env.local
```

```
SLACK_BOT_TOKEN=xoxb-...
SOLIDARITY_TECH_API_KEY=your-api-key
CHAPTER_CHANNEL_MAPPING=[{"chapterId":123,"channelId":"C0123456789","name":"Washtenaw County","pageUrl":"https://example.com/washtenaw-county-chapter"}]
REVIEW_CHANNEL_ID=C0123456789
PREVIEW_SCOPE_ID=1008
EXCLUDE_PHRASES=["test event","internal only"]
EXCLUDE_LOCATIONS=["zoom","HQ"]
```

### Run the scripts

**Daily digest:**
```bash
npx tsx scripts/post-daily-events.ts
```

The script automatically detects whether today is Monday and runs in the appropriate mode. This will post to the real Slack channels configured in `CHAPTER_CHANNEL_MAPPING`, so point `channelId` to a test channel if you don't want to post to production.

**Nightly scope preview:**
```bash
npx tsx scripts/preview-scope-events.ts
```

Posts a plain-text list of upcoming events for `PREVIEW_SCOPE_ID` to `REVIEW_CHANNEL_ID`.

### Run the tests

```bash
npm test        # one-shot
npm run test:watch  # watch mode
```

The suite (vitest) covers the filter, pagination, formatters/escape helpers, exclusion parsing, and the digest-window logic. Tests live next to the modules they cover under `scripts/lib/*.test.ts`.

## Project structure

```
.
├── scripts/
│   ├── post-daily-events.ts       # Daily digest script
│   ├── preview-scope-events.ts    # Nightly scope preview script
│   └── lib/                       # Shared code used by both scripts (plus colocated *.test.ts)
│       ├── env.ts                 # Loads .env.local (side effect)
│       ├── types.ts               # solidarity.tech response types
│       ├── solidarity-api.ts      # Paginated event fetch + rate-limit delay
│       ├── exclusions.ts          # EXCLUDE_PHRASES / EXCLUDE_LOCATIONS parsing + predicates
│       ├── filters.ts             # Shared event-window filter
│       ├── formatters.ts          # Date/time Intl formatters (America/New_York) + Slack mrkdwn escape
│       └── week.ts                # Week + digest-window helpers shared by both scripts
├── .github/
│   └── workflows/
│       ├── daily-events.yml           # Daily digest workflow (9 AM ET)
│       └── preview-scope-events.yml   # Nightly preview workflow (9 PM ET)
├── .env.sample                # Environment variable template
├── package.json
└── tsconfig.json
```

## License

MIT
