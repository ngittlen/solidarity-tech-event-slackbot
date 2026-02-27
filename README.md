# Solidarity Tech Event Slackbot

A GitHub Actions workflow that pulls upcoming events from the [solidarity.tech](https://solidarity.tech) API and posts a daily digest to one or more Slack channels — one post per configured chapter.

## How it works

Every day at 9 AM ET, the workflow runs `scripts/post-daily-events.ts`, which:

1. **Fetches events** from the solidarity.tech API for each configured chapter (paginated, 100 events per page)
2. **Filters** to events that have a public event page URL and at least one session starting within the configured lookahead window (default: 3 days)
3. **Sorts** events chronologically by their earliest upcoming session
4. **Builds a Slack Block Kit message** with a header, date range subtitle, and one section per event showing the title (linked to the event page), session time(s), location, and event type (in-person / virtual / hybrid)
5. **Posts** the message to the mapped Slack channel for each chapter

If there are no upcoming events, a "no upcoming events" message is posted instead. If more than 23 events fall in the window, the first 23 are shown with a note indicating how many were omitted (Slack has a 50-block-per-message limit).

### Example Slack message

```
📅 Upcoming Events — Washtenaw County
Next 7 days · Feb 27 – Mar 6

*<https://solidarity.tech/events/123|Monthly Organizing Meeting>*
📅 *Sat, Mar 1 · 10:00–11:30 AM ET*   📍 _123 Main St, Ann Arbor, MI_   🏢 In Person

────────────────────────────────

*<https://solidarity.tech/events/456|New Member Orientation>*
📅 *Wed, Mar 5 · 7:00–8:00 PM ET*   💻 Virtual
```

## Setup

### Prerequisites

- A [solidarity.tech](https://solidarity.tech) account with API access
- A Slack app with the `chat:write` bot scope installed to your workspace
- A GitHub repository to host the workflow

### 1. Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Under **OAuth & Permissions**, add the `chat:write` bot scope
3. Install the app to your workspace
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`)
5. Invite the bot to each channel it should post to: `/invite @your-bot-name`

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

**Channel ID**: right-click a channel in Slack → "Copy link" — the ID is the last path segment (e.g. `C0123456789`)

### 3. Configure GitHub Actions secrets

In your repository, go to **Settings → Secrets and variables → Actions** and add:

| Secret | Description |
|---|---|
| `SOLIDARITY_TECH_API_KEY` | Your solidarity.tech API key |
| `SLACK_BOT_TOKEN` | The Slack bot token (`xoxb-...`) |
| `CHAPTER_CHANNEL_MAPPING` | JSON array mapping chapters to channels (see below) |

#### `CHAPTER_CHANNEL_MAPPING` format

A JSON array where each object has:

```json
[
  { "chapterId": 123, "channelId": "C0123456789", "name": "Washtenaw County" },
  { "chapterId": 456, "channelId": "C9876543210", "name": "Wayne County" }
]
```

- `chapterId` — numeric ID of the solidarity.tech chapter
- `channelId` — Slack channel ID to post to
- `name` — display name used in the message header

### 4. (Optional) Adjust the lookahead window

The `EVENTS_DAYS_AHEAD` variable in `.github/workflows/daily-events.yml` controls how many days ahead to look for events. It defaults to `7`. Change it directly in the workflow file, or make it a secret/variable if you want to configure it without a code change.

### 5. (Optional) Adjust the posting time

The cron schedule in `.github/workflows/daily-events.yml` defaults to `0 14 * * *` (9 AM ET / UTC-5). Adjust for your timezone or daylight saving time as needed.

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
CHAPTER_CHANNEL_MAPPING=[{"chapterId":123,"channelId":"C0123456789","name":"Washtenaw County"}]
EVENTS_DAYS_AHEAD=3
```

### Run the script

```bash
npx tsx scripts/post-daily-events.ts
```

This will post to the real Slack channels configured in `CHAPTER_CHANNEL_MAPPING`, so point `channelId` to a test channel if you don't want to post to production.

## Project structure

```
.
├── scripts/
│   └── post-daily-events.ts   # Main script
├── .github/
│   └── workflows/
│       └── daily-events.yml   # Scheduled GitHub Actions workflow
├── .env.sample                # Environment variable template
├── package.json
└── tsconfig.json
```

## License

MIT
