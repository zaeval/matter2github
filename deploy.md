# Deploy Guide

This guide covers the Mattermost outgoing webhook callback server, the approval
queue page, GitHub direct/proxy modes, attachments, and Docker deployment.

## 1. Required Mattermost Outgoing Webhook Settings

Use this callback URL:

```text
http://<server-host>:3000/hooks/mattermost/github-issue
```

Recommended Mattermost settings:

```text
Title: GitHub Issue Queue
Content Type: application/json
Trigger Words: !issue
Callback URLs: http://<server-host>:3000/hooks/mattermost/github-issue
```

Messages should start with the trigger word:

```text
!issue Case12 title
Details on the following lines
```

## 2. Queue And Approval Page

Queue mode is enabled by default:

```env
QUEUE_ENABLED=true
QUEUE_FILE=data/queue.json
PUBLIC_BASE_URL=http://<server-host>:3000
```

On first run, create the first admin:

```text
http://<server-host>:3000/setup
```

Then sign in:

```text
http://<server-host>:3000/login
```

Open the approval page after login:

```text
http://<server-host>:3000/queue
```

Session and local account storage:

```env
USERS_FILE=data/users.json
SESSIONS_FILE=data/sessions.json
SESSION_COOKIE_NAME=mmgh_session
SESSION_TTL_SECONDS=604800
```

Only logged-in users can view the queue and approve/deny items. Admin users can
open `/admin` to add accounts and manage GitHub token settings.

## 3. GitHub Direct Mode

Use this when the server can reach `https://api.github.com` directly:

```env
GITHUB_MODE=direct
GITHUB_TOKEN=replace_with_github_token
GITHUB_OWNER=your-github-owner
GITHUB_REPO=your-github-repo
```

In direct mode, `GITHUB_API_BASE_URL`, `GH_PROXY_URL`, and `GH_PROXY_TOKEN` are
ignored.

Admins can also switch to direct mode from:

```text
http://<server-host>:3000/admin
```

## 4. GitHub Proxy Mode

Use this when direct access to GitHub is blocked and a GitHub-compatible proxy
should be used:

```env
GITHUB_MODE=proxy
GITHUB_API_BASE_URL=https://github-proxy.example.com/api/v3
GH_PROXY_TOKEN=proxy_token
GITHUB_TOKEN=replace_with_github_token
GITHUB_OWNER=your-github-owner
GITHUB_REPO=your-github-repo
```

The server sends the proxy token as both:

```text
X-Proxy-Token: <token>
Proxy-Authorization: Bearer <token>
```

The GitHub token is still sent to GitHub as:

```text
Authorization: Bearer <github token>
```

Admins can update `GITHUB_TOKEN`, `GH_PROXY_TOKEN`, owner, repo, and mode from
`/admin`. Saved values go to:

```env
SETTINGS_FILE=data/settings.json
```

Values in `data/settings.json` override `.env`.

## 5. Mattermost Tokens

Outgoing webhook verification token:

```env
MATTERMOST_TOKEN=mattermost_outgoing_webhook_token
```

Mattermost file download token, needed only for attachments:

```env
MATTERMOST_ACCESS_TOKEN=mattermost_personal_or_bot_access_token
```

`MATTERMOST_ACCESS_TOKEN` must be able to read the channel where files are
posted.

Result notifications (approve / deny / failure) are posted back to Mattermost
through an incoming webhook:

```env
MATTERMOST_WEBHOOK_URL=http://<mattermost-host>:8065/hooks/xxxxxxxxxxxxxxxxxx
```

When set, after a reviewer approves, denies, or an approval fails, the server
posts a message to the channel the original `!issue` message came from
(`channel_name` from the outgoing webhook). Leave it empty to disable. Notes:

- The target Mattermost incoming webhook must have "channel override" enabled to
  post into the original channel; otherwise it posts to the webhook's default
  channel.
- Incoming webhooks cannot reply inside a thread (no `root_id`); messages are
  posted as new channel messages.
- Failure notifications include the underlying cause (for example
  `fetch failed (ENOTFOUND)`), which is useful for diagnosing GitHub/proxy
  connectivity problems.

## 6. Attachments

When a queued item is approved, attachments are copied from Mattermost into the
GitHub repository before the issue is created.

```env
ATTACHMENT_STORAGE=github
ATTACHMENT_REPO_PATH=.mattermost-issue-attachments
ATTACHMENT_MAX_BYTES=10485760
ATTACHMENT_MAX_COUNT=10
GITHUB_ATTACHMENT_BRANCH=
```

If `GITHUB_ATTACHMENT_BRANCH` is empty, the repository default branch is used.

## 7. Labels And Assignees

```env
DEFAULT_LABELS=mattermost,bug
DEFAULT_ASSIGNEES=
ISSUE_TITLE_PREFIX=
```

Labels must already exist in the GitHub repository.

## 8. Docker Compose

Create `.env` from `.env.example`, then set secrets.

```powershell
copy .env.example .env
notepad .env
docker compose up -d --build
```

Check health:

```powershell
curl http://127.0.0.1:3000/health
```

View logs:

```powershell
docker compose logs -f
```

Stop:

```powershell
docker compose down
```

Runtime state is mounted on the host:

```text
./data
./logs
```

## 9. Windows Scheduled Task

For the existing Windows setup, `start-server.ps1` starts the server and the
scheduled task `MattermostGithubIssueCallback` runs it at logon.

Manual restart:

```powershell
Stop-Process -Name node -Force
Start-ScheduledTask -TaskName MattermostGithubIssueCallback
```

## 10. Verification Checklist

```powershell
npm.cmd test
curl http://127.0.0.1:3000/health
curl http://<server-host>:3000/health
```

Then send a Mattermost message:

```text
!issue Queue smoke test
```

Open:

```text
http://<server-host>:3000/queue
```

Approve the item and confirm the GitHub issue link appears in the approved row.
