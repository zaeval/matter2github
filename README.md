# Mattermost GitHub Issue Queue

This project receives Mattermost outgoing webhook messages, stores them in a
local approval queue, and creates GitHub issues only after a reviewer approves
them from the web page.

## Project Structure

```text
.
├── src/server.js          # HTTP server, webhook receiver, queue UI, GitHub API client
├── test/server.test.js    # Node test suite for parsing, queue, and config behavior
├── data/queue.json        # Runtime queue storage, created automatically
├── logs/audit.log         # Runtime audit events, created automatically
├── start-server.ps1       # Windows scheduled-task launcher
├── Dockerfile             # Container image for the callback server
├── docker-compose.yml     # Local/container deployment with data/log volumes
├── deploy.md              # Configuration and deployment guide
├── .env.example           # Example configuration
└── .env                   # Local secrets and runtime settings, not committed
```

## Flow

```text
Mattermost outgoing webhook
→ POST /hooks/mattermost/github-issue
→ data/queue.json pending item
→ /queue reviewer login, then approve or deny
→ GitHub issue created on approve
```

The callback URL for Mattermost is:

```text
http://10.1.19.57:3000/hooks/mattermost/github-issue
```

The approval page is:

```text
http://10.1.19.57:3000/queue
```

On the first run, create the first admin account:

```text
http://10.1.19.57:3000/setup
```

After setup, sign in:

```text
http://10.1.19.57:3000/login
```

Admins can add reviewer/admin users and manage GitHub token settings:

```text
http://10.1.19.57:3000/admin
```

## Runtime Endpoints

```text
GET  /health
GET  /setup
GET  /login
GET  /queue
GET  /admin
GET  /api/queue?status=pending
POST /api/queue/:id/approve
POST /api/queue/:id/deny
POST /api/login
POST /api/logout
POST /api/setup
GET  /api/admin/users
POST /api/admin/users
GET  /api/admin/github-settings
POST /api/admin/github-settings
POST /hooks/mattermost/github-issue
```

## GitHub Modes

The server supports both direct GitHub API access and the `ucut.in` GitHub
proxy. Admin users can update these values from `/admin`; saved values are
stored in `data/settings.json` and override `.env`.

Direct GitHub:

```env
GITHUB_MODE=direct
GITHUB_TOKEN=...
```

Proxy GitHub:

```env
GITHUB_MODE=proxy
GITHUB_API_BASE_URL=https://ucut.in/proxy/gh/api/v3
GH_PROXY_TOKEN=...
GITHUB_TOKEN=...
```

## Local Run

```powershell
npm.cmd start
```

Tests:

```powershell
npm.cmd test
```

Docker:

```powershell
docker compose up -d --build
```

See [deploy.md](./deploy.md) for full configuration.
