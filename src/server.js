const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URLSearchParams } = require("node:url");

const PROJECT_ROOT = path.join(__dirname, "..");

loadDotEnv(path.join(PROJECT_ROOT, ".env"));

const GITHUB_MODE = getGitHubMode();

const CONFIG = {
  projectRoot: PROJECT_ROOT,
  port: parseInteger(process.env.PORT, 3000),
  publicBaseUrl: trimTrailingSlash(process.env.PUBLIC_BASE_URL || ""),
  queueEnabled: parseBoolean(process.env.QUEUE_ENABLED, true),
  queueFilePath: resolveProjectPath(process.env.QUEUE_FILE || "data/queue.json"),
  usersFilePath: resolveProjectPath(process.env.USERS_FILE || "data/users.json"),
  sessionsFilePath: resolveProjectPath(process.env.SESSIONS_FILE || "data/sessions.json"),
  settingsFilePath: resolveProjectPath(process.env.SETTINGS_FILE || "data/settings.json"),
  sessionCookieName: process.env.SESSION_COOKIE_NAME || "mmgh_session",
  sessionTtlSeconds: parseInteger(process.env.SESSION_TTL_SECONDS, 7 * 24 * 60 * 60),
  approvalToken: process.env.APPROVAL_TOKEN || "",
  githubMode: GITHUB_MODE,
  githubToken: process.env.GITHUB_TOKEN || "",
  githubOwner: process.env.GITHUB_OWNER || "your-github-owner",
  githubRepo: process.env.GITHUB_REPO || "your-github-repo",
  githubApiBaseUrl: getGitHubApiBaseUrl(GITHUB_MODE),
  ghProxyToken: process.env.GH_PROXY_TOKEN || process.env.GITHUB_PROXY_TOKEN || "",
  mattermostToken: process.env.MATTERMOST_TOKEN || "",
  mattermostAccessToken:
    process.env.MATTERMOST_ACCESS_TOKEN || process.env.MATTERMOST_BOT_TOKEN || "",
  mattermostAllowedChannels: splitCsv(process.env.MATTERMOST_ALLOWED_CHANNELS),
  mattermostBaseUrl: trimTrailingSlash(process.env.MATTERMOST_BASE_URL || ""),
  triggerWords: splitCsv(process.env.TRIGGER_WORDS || "!issue,#issue"),
  defaultLabels: splitCsv(process.env.DEFAULT_LABELS || "mattermost,bug"),
  defaultAssignees: splitCsv(process.env.DEFAULT_ASSIGNEES),
  issueTitlePrefix: process.env.ISSUE_TITLE_PREFIX || "",
  attachmentStorage: (process.env.ATTACHMENT_STORAGE || "github").toLowerCase(),
  attachmentRepoPath: trimSlashes(
    process.env.ATTACHMENT_REPO_PATH || ".mattermost-issue-attachments",
  ),
  attachmentMaxBytes: parseInteger(process.env.ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024),
  attachmentMaxCount: parseInteger(process.env.ATTACHMENT_MAX_COUNT, 10),
  githubAttachmentBranch: process.env.GITHUB_ATTACHMENT_BRANCH || "",
  bodyLimitBytes: parseInteger(process.env.REQUEST_BODY_LIMIT_BYTES, 128 * 1024),
  auditLogPath: resolveProjectPath(process.env.AUDIT_LOG_FILE || "logs/audit.log"),
};

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = stripQuotes(rawValue);
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function splitCsv(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function trimSlashes(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function resolveProjectPath(value) {
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.join(PROJECT_ROOT, value);
}

function getGitHubMode(env = process.env) {
  const mode = String(env.GITHUB_MODE || "").trim().toLowerCase();
  if (mode === "direct" || mode === "proxy") {
    return mode;
  }

  if (env.GITHUB_API_BASE_URL || env.GH_PROXY_URL || env.GH_PROXY_TOKEN || env.GITHUB_PROXY_TOKEN) {
    return "proxy";
  }

  return "direct";
}

function getGitHubApiBaseUrl(mode = getGitHubMode(), env = process.env) {
  if (mode === "direct") {
    return "https://api.github.com";
  }

  if (env.GITHUB_API_BASE_URL) {
    return trimTrailingSlash(env.GITHUB_API_BASE_URL);
  }

  if (env.GH_PROXY_URL) {
    const proxyUrl = trimTrailingSlash(env.GH_PROXY_URL);
    return proxyUrl.endsWith("/api/v3") ? proxyUrl : `${proxyUrl}/api/v3`;
  }

  return "https://github-proxy.example.com/api/v3";
}

function createServer(config = CONFIG) {
  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, "http://localhost");
    const pathname = requestUrl.pathname;

    try {
      const currentUser = getCurrentUser(req, config);

      if (req.method === "GET" && pathname === "/health") {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "GET" && pathname === "/setup") {
        if (hasUsers(config)) {
          return redirect(res, "/login");
        }
        return sendHtml(res, 200, renderSetupPage());
      }

      if (req.method === "POST" && pathname === "/api/setup") {
        const body = await parseRequestBody(req, config.bodyLimitBytes);
        const result = createInitialAdmin(body, config);
        if (!result.ok) {
          return sendJson(res, result.statusCode, result.body);
        }

        const session = createSession(result.user, config);
        setSessionCookie(res, session.id, config);
        return sendJson(res, 200, { ok: true, user: toPublicUser(result.user) });
      }

      if (req.method === "GET" && pathname === "/login") {
        if (!hasUsers(config)) {
          return redirect(res, "/setup");
        }
        if (currentUser) {
          return redirect(res, "/queue");
        }
        return sendHtml(res, 200, renderLoginPage());
      }

      if (req.method === "POST" && pathname === "/api/login") {
        const body = await parseRequestBody(req, config.bodyLimitBytes);
        const result = loginUser(body, config);
        if (!result.ok) {
          return sendJson(res, result.statusCode, result.body);
        }

        const session = createSession(result.user, config);
        setSessionCookie(res, session.id, config);
        return sendJson(res, 200, { ok: true, user: toPublicUser(result.user) });
      }

      if (req.method === "POST" && pathname === "/api/logout") {
        clearCurrentSession(req, config);
        clearSessionCookie(res, config);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "GET" && pathname === "/api/me") {
        return sendJson(res, 200, {
          ok: true,
          authenticated: Boolean(currentUser),
          user: currentUser ? toPublicUser(currentUser) : null,
        });
      }

      if (req.method === "GET" && (pathname === "/" || pathname === "/queue")) {
        if (!currentUser) {
          return redirect(res, hasUsers(config) ? "/login" : "/setup");
        }
        return sendHtml(res, 200, renderQueuePage(getRuntimeConfig(config), currentUser));
      }

      if (req.method === "GET" && pathname === "/api/queue") {
        if (!requireUser(currentUser, res)) {
          return;
        }
        return sendJson(res, 200, {
          ok: true,
          items: listQueueItems(requestUrl.searchParams.get("status"), config),
        });
      }

      const queueItemMatch = pathname.match(/^\/api\/queue\/([^/]+)$/);
      if (req.method === "GET" && queueItemMatch) {
        if (!requireUser(currentUser, res)) {
          return;
        }

        const item = getQueueItem(queueItemMatch[1], config);
        if (!item) {
          return sendJson(res, 404, { ok: false, error: "Queue item not found" });
        }

        return sendJson(res, 200, { ok: true, item: toPublicQueueItem(item) });
      }

      const approveMatch = pathname.match(/^\/api\/queue\/([^/]+)\/approve$/);
      if (req.method === "POST" && approveMatch) {
        if (!requireUser(currentUser, res)) {
          return;
        }

        const body = await parseRequestBody(req, config.bodyLimitBytes);
        const result = await approveQueueItem(approveMatch[1], body, config, currentUser);
        return sendJson(res, result.statusCode, result.body);
      }

      const denyMatch = pathname.match(/^\/api\/queue\/([^/]+)\/deny$/);
      if (req.method === "POST" && denyMatch) {
        if (!requireUser(currentUser, res)) {
          return;
        }

        const body = await parseRequestBody(req, config.bodyLimitBytes);
        const result = denyQueueItem(denyMatch[1], body, config, currentUser);
        return sendJson(res, result.statusCode, result.body);
      }

      if (req.method === "GET" && pathname === "/admin") {
        if (!requireAdmin(currentUser, res, true)) {
          return;
        }
        return sendHtml(res, 200, renderAdminPage(getRuntimeConfig(config), currentUser));
      }

      if (req.method === "GET" && pathname === "/api/admin/users") {
        if (!requireAdmin(currentUser, res)) {
          return;
        }
        return sendJson(res, 200, { ok: true, users: listUsers(config) });
      }

      if (req.method === "POST" && pathname === "/api/admin/users") {
        if (!requireAdmin(currentUser, res)) {
          return;
        }
        const body = await parseRequestBody(req, config.bodyLimitBytes);
        const result = createUser(body, config);
        return sendJson(res, result.statusCode, result.body);
      }

      if (req.method === "GET" && pathname === "/api/admin/github-settings") {
        if (!requireAdmin(currentUser, res)) {
          return;
        }
        return sendJson(res, 200, {
          ok: true,
          settings: getPublicGitHubSettings(getRuntimeConfig(config)),
        });
      }

      if (req.method === "POST" && pathname === "/api/admin/github-settings") {
        if (!requireAdmin(currentUser, res)) {
          return;
        }
        const body = await parseRequestBody(req, config.bodyLimitBytes);
        const result = updateGitHubSettings(body, config);
        return sendJson(res, result.statusCode, result.body);
      }

      if (req.method === "POST" && pathname === "/hooks/mattermost/github-issue") {
        await handleMattermostWebhook(req, res, config);
        return;
      }

      return sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      console.error(error);
      writeAuditLog(config, {
        event: "request_error",
        path: pathname,
        status: error.statusCode || 500,
        error: toShortErrorMessage(error),
      });
      return sendJson(res, error.statusCode || 500, {
        ok: false,
        text: error.publicMessage || "Request failed. Check callback server logs.",
      });
    }
  });
}

async function handleMattermostWebhook(req, res, config) {
  const payload = await parseRequestBody(req, config.bodyLimitBytes);
  const requestLog = getMattermostRequestLog(payload);
  writeAuditLog(config, {
    event: "mattermost_webhook_received",
    ...requestLog,
  });

  const verification = verifyMattermostPayload(payload, config);
  if (!verification.ok) {
    writeAuditLog(config, {
      event: "mattermost_webhook_rejected",
      status: verification.status,
      reason: verification.message,
      ...requestLog,
    });
    return sendJson(res, verification.status, {
      ok: false,
      text: verification.message,
    });
  }

  const issueInput = buildIssueInput(payload, config);
  if (!issueInput.ok) {
    writeAuditLog(config, {
      event: "issue_input_invalid",
      reason: issueInput.message,
      ...requestLog,
    });
    return sendJson(res, 200, {
      ok: false,
      text: issueInput.message,
    });
  }

  if (config.queueEnabled) {
    const item = createQueueItem(payload, issueInput, requestLog, config);
    const reviewUrl = getReviewUrl(config);
    writeAuditLog(config, {
      event: "queue_item_created",
      queueId: item.id,
      title: item.issue.title,
      ...requestLog,
    });

    return sendJson(res, 200, {
      ok: true,
      text: `Queued for approval: ${item.issue.title}${reviewUrl ? `\nReview: ${reviewUrl}` : ""}`,
    });
  }

  const issue = await processIssueCreation(payload, issueInput, config);
  writeAuditLog(config, {
    event: "github_issue_created",
    issueNumber: issue.number,
    issueUrl: issue.html_url,
    title: issueInput.issue.title,
    ...requestLog,
  });

  return sendJson(res, 200, {
    ok: true,
    text: `GitHub issue created: #${issue.number} ${issue.html_url}`,
  });
}

async function parseRequestBody(req, limitBytes) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > limitBytes) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      error.publicMessage = "Request body is too large.";
      throw error;
    }
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  if (!rawBody) {
    return {};
  }

  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return JSON.parse(rawBody);
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(rawBody));
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return Object.fromEntries(new URLSearchParams(rawBody));
  }
}

function verifyMattermostPayload(payload, config) {
  if (config.mattermostToken && payload.token !== config.mattermostToken) {
    return {
      ok: false,
      status: 401,
      message: "Mattermost webhook token is invalid.",
    };
  }

  if (config.mattermostAllowedChannels.length > 0) {
    const channelCandidates = [payload.channel_id, payload.channel_name].filter(Boolean);
    const allowed = channelCandidates.some((channel) =>
      config.mattermostAllowedChannels.includes(channel),
    );

    if (!allowed) {
      return {
        ok: false,
        status: 403,
        message: "This Mattermost channel is not allowed to create GitHub issues.",
      };
    }
  }

  return { ok: true };
}

function buildIssueInput(payload, config) {
  const originalText = String(payload.text || "").trim();
  const issueText = stripLeadingTriggerWord(originalText, [
    payload.trigger_word,
    ...config.triggerWords,
  ]);

  if (!issueText) {
    return {
      ok: false,
      message: "Usage: !issue <issue title> followed by optional details on new lines.",
    };
  }

  const lines = issueText.split(/\r?\n/);
  const firstNonEmptyIndex = lines.findIndex((line) => line.trim());
  if (firstNonEmptyIndex === -1) {
    return {
      ok: false,
      message: "Usage: !issue <issue title> followed by optional details on new lines.",
    };
  }

  const title = formatTitle(lines[firstNonEmptyIndex], config.issueTitlePrefix);
  const details = lines.slice(firstNonEmptyIndex + 1).join("\n").trim();
  const body = buildIssueBody({
    details,
    originalText,
    payload,
    mattermostBaseUrl: config.mattermostBaseUrl,
  });

  return {
    ok: true,
    issue: {
      title,
      body,
      labels: config.defaultLabels,
      assignees: config.defaultAssignees,
    },
  };
}

function stripLeadingTriggerWord(text, triggerWords) {
  const trimmed = text.trim();
  const uniqueTriggerWords = [...new Set(triggerWords.filter(Boolean))];

  for (const triggerWord of uniqueTriggerWords) {
    const trigger = String(triggerWord).trim();
    if (!trigger) {
      continue;
    }

    const lowerTrimmed = trimmed.toLowerCase();
    const lowerTrigger = trigger.toLowerCase();
    if (lowerTrimmed === lowerTrigger) {
      return "";
    }

    if (
      lowerTrimmed.startsWith(`${lowerTrigger} `) ||
      lowerTrimmed.startsWith(`${lowerTrigger}\n`) ||
      lowerTrimmed.startsWith(`${lowerTrigger}\r\n`)
    ) {
      return trimmed.slice(trigger.length).trim();
    }
  }

  return trimmed;
}

function formatTitle(title, prefix) {
  const cleanTitle = title.trim().replace(/\s+/g, " ").slice(0, 240);
  if (!prefix) {
    return cleanTitle;
  }

  return `${prefix}${cleanTitle}`.slice(0, 255);
}

function buildIssueBody({ details, originalText, payload, mattermostBaseUrl }) {
  const metadata = [];

  if (payload.user_name) {
    metadata.push(`- Mattermost user: ${payload.user_name}`);
  }

  if (payload.channel_name || payload.channel_id) {
    metadata.push(`- Mattermost channel: ${payload.channel_name || payload.channel_id}`);
  }

  if (payload.post_id && payload.team_domain && mattermostBaseUrl) {
    metadata.push(`- Mattermost post: ${mattermostBaseUrl}/${payload.team_domain}/pl/${payload.post_id}`);
  } else if (payload.post_id) {
    metadata.push(`- Mattermost post id: ${payload.post_id}`);
  }

  const parts = [];
  if (details) {
    parts.push(details);
  }

  if (metadata.length > 0) {
    parts.push(["Created from Mattermost:", ...metadata].join("\n"));
  } else {
    parts.push("Created from Mattermost.");
  }

  if (originalText) {
    parts.push(`Original message:\n\n\`\`\`text\n${originalText}\n\`\`\``);
  }

  return parts.join("\n\n");
}

function createQueueItem(payload, issueInput, requestLog, config) {
  const queue = readQueue(config);
  const now = new Date().toISOString();
  const item = {
    id: crypto.randomUUID(),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    payload: sanitizePayloadForQueue(payload),
    issue: cloneJson(issueInput.issue),
    requestLog: cloneJson(requestLog || getMattermostRequestLog(payload)),
    githubIssue: null,
    review: null,
    error: null,
  };

  queue.items.unshift(item);
  writeQueue(queue, config);
  return item;
}

async function approveQueueItem(id, body, config, actor = null) {
  const queue = readQueue(config);
  const item = queue.items.find((candidate) => candidate.id === id);
  if (!item) {
    return { statusCode: 404, body: { ok: false, error: "Queue item not found" } };
  }

  if (item.status === "approved") {
    return { statusCode: 200, body: { ok: true, item: toPublicQueueItem(item) } };
  }

  if (item.status === "processing") {
    return { statusCode: 409, body: { ok: false, error: "Queue item is already processing" } };
  }

  if (item.status === "denied") {
    return { statusCode: 409, body: { ok: false, error: "Denied queue item cannot be approved" } };
  }

  item.status = "processing";
  item.updatedAt = new Date().toISOString();
  item.review = {
    action: "approve",
    reviewer: actor ? actor.username : String(body.reviewer || "").slice(0, 120),
    comment: String(body.comment || "").slice(0, 1000),
    startedAt: item.updatedAt,
  };
  item.error = null;
  writeQueue(queue, config);

  try {
    const issue = await processIssueCreation(item.payload, { issue: cloneJson(item.issue) }, config);
    item.status = "approved";
    item.updatedAt = new Date().toISOString();
    item.review.completedAt = item.updatedAt;
    item.githubIssue = {
      number: issue.number,
      htmlUrl: issue.html_url,
    };
    item.error = null;
    writeQueue(queue, config);
    writeAuditLog(config, {
      event: "queue_item_approved",
      queueId: item.id,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      title: item.issue.title,
    });
    return { statusCode: 200, body: { ok: true, item: toPublicQueueItem(item) } };
  } catch (error) {
    item.status = "failed";
    item.updatedAt = new Date().toISOString();
    item.error = toShortErrorMessage(error);
    writeQueue(queue, config);
    writeAuditLog(config, {
      event: "queue_item_failed",
      queueId: item.id,
      title: item.issue.title,
      error: item.error,
    });
    return {
      statusCode: error.statusCode || 500,
      body: { ok: false, error: item.error, item: toPublicQueueItem(item) },
    };
  }
}

function denyQueueItem(id, body, config, actor = null) {
  const queue = readQueue(config);
  const item = queue.items.find((candidate) => candidate.id === id);
  if (!item) {
    return { statusCode: 404, body: { ok: false, error: "Queue item not found" } };
  }

  if (item.status === "approved") {
    return { statusCode: 409, body: { ok: false, error: "Approved queue item cannot be denied" } };
  }

  if (item.status === "processing") {
    return { statusCode: 409, body: { ok: false, error: "Processing queue item cannot be denied" } };
  }

  const now = new Date().toISOString();
  item.status = "denied";
  item.updatedAt = now;
  item.review = {
    action: "deny",
    reviewer: actor ? actor.username : String(body.reviewer || "").slice(0, 120),
    reason: String(body.reason || body.comment || "").slice(0, 1000),
    completedAt: now,
  };
  item.error = null;
  writeQueue(queue, config);
  writeAuditLog(config, {
    event: "queue_item_denied",
    queueId: item.id,
    title: item.issue.title,
    reason: item.review.reason,
  });
  return { statusCode: 200, body: { ok: true, item: toPublicQueueItem(item) } };
}

async function processIssueCreation(payload, issueInput, config) {
  const runtimeConfig = getRuntimeConfig(config);

  if (!runtimeConfig.githubToken) {
    const error = new Error("GITHUB_TOKEN is not configured on the callback server.");
    error.statusCode = 500;
    throw error;
  }

  const attachmentSection = await collectAttachmentSection(payload, runtimeConfig);
  if (attachmentSection) {
    issueInput.issue.body = [issueInput.issue.body, attachmentSection].filter(Boolean).join("\n\n");
  }

  return createGitHubIssue(issueInput.issue, runtimeConfig);
}

function readQueue(config) {
  const queuePath = config.queueFilePath;
  if (!fs.existsSync(queuePath)) {
    return { version: 1, items: [] };
  }

  const parsed = JSON.parse(fs.readFileSync(queuePath, "utf8"));
  if (Array.isArray(parsed)) {
    return { version: 1, items: parsed };
  }

  return {
    version: parsed.version || 1,
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}

function writeQueue(queue, config) {
  const queuePath = config.queueFilePath;
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  const tempPath = `${queuePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(queue, null, 2), "utf8");
  if (fs.existsSync(queuePath)) {
    fs.unlinkSync(queuePath);
  }
  fs.renameSync(tempPath, queuePath);
}

function listQueueItems(status, config) {
  const queue = readQueue(config);
  const normalizedStatus = String(status || "all").toLowerCase();
  return queue.items
    .filter((item) => normalizedStatus === "all" || item.status === normalizedStatus)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(toPublicQueueItem);
}

function getQueueItem(id, config) {
  return readQueue(config).items.find((item) => item.id === id) || null;
}

function toPublicQueueItem(item) {
  return {
    id: item.id,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    issue: item.issue,
    requestLog: item.requestLog,
    githubIssue: item.githubIssue,
    review: item.review,
    error: item.error,
  };
}

function sanitizePayloadForQueue(payload) {
  const cleanPayload = cloneJson(payload);
  delete cleanPayload.token;
  return cleanPayload;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function getReviewUrl(config) {
  if (!config.publicBaseUrl) {
    return "";
  }
  return `${config.publicBaseUrl}/queue`;
}

function hasUsers(config) {
  return readUsers(config).users.length > 0;
}

function readUsers(config) {
  return readJsonFile(config.usersFilePath, { version: 1, users: [] });
}

function writeUsers(users, config) {
  writeJsonFile(config.usersFilePath, users);
}

function readSessions(config) {
  return readJsonFile(config.sessionsFilePath, { version: 1, sessions: [] });
}

function writeSessions(sessions, config) {
  writeJsonFile(config.sessionsFilePath, sessions);
}

function readSettings(config) {
  return readJsonFile(config.settingsFilePath, { version: 1 });
}

function writeSettings(settings, config) {
  writeJsonFile(config.settingsFilePath, settings);
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return cloneJson(fallback);
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return cloneJson(fallback);
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  fs.renameSync(tempPath, filePath);
}

function createInitialAdmin(body, config) {
  if (hasUsers(config)) {
    return { ok: false, statusCode: 409, body: { ok: false, error: "Initial admin already exists." } };
  }

  const username = normalizeUsername(body.username || "admin");
  const password = String(body.password || "");
  const validation = validateNewUser(username, password);
  if (!validation.ok) {
    return validation;
  }

  const user = {
    id: crypto.randomUUID(),
    username,
    role: "admin",
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeUsers({ version: 1, users: [user] }, config);
  return { ok: true, user };
}

function createUser(body, config) {
  const users = readUsers(config);
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  const role = String(body.role || "reviewer").toLowerCase() === "admin" ? "admin" : "reviewer";
  const validation = validateNewUser(username, password);
  if (!validation.ok) {
    return validation;
  }

  if (users.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
    return { statusCode: 409, body: { ok: false, error: "Username already exists." } };
  }

  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    username,
    role,
    passwordHash: hashPassword(password),
    createdAt: now,
    updatedAt: now,
  };
  users.users.push(user);
  writeUsers(users, config);
  return { statusCode: 201, body: { ok: true, user: toPublicUser(user) } };
}

function validateNewUser(username, password) {
  if (!username || username.length < 3) {
    return {
      ok: false,
      statusCode: 400,
      body: { ok: false, error: "Username must be at least 3 characters." },
    };
  }

  if (!password || password.length < 8) {
    return {
      ok: false,
      statusCode: 400,
      body: { ok: false, error: "Password must be at least 8 characters." },
    };
  }

  return { ok: true };
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function listUsers(config) {
  return readUsers(config).users.map(toPublicUser);
}

function toPublicUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function loginUser(body, config) {
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  const user = readUsers(config).users.find(
    (candidate) => candidate.username.toLowerCase() === username.toLowerCase(),
  );

  if (!user || !verifyPassword(password, user.passwordHash)) {
    return { ok: false, statusCode: 401, body: { ok: false, error: "Invalid username or password." } };
  }

  return { ok: true, user };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, passwordHash) {
  const [algorithm, salt, expectedHash] = String(passwordHash || "").split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHash) {
    return false;
  }

  const actualHash = crypto.scryptSync(String(password), salt, 64);
  const expectedBuffer = Buffer.from(expectedHash, "hex");
  return (
    actualHash.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualHash, expectedBuffer)
  );
}

function createSession(user, config) {
  const sessions = readSessions(config);
  const now = Date.now();
  const session = {
    id: crypto.randomBytes(32).toString("hex"),
    userId: user.id,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + config.sessionTtlSeconds * 1000).toISOString(),
  };

  sessions.sessions = sessions.sessions.filter(
    (candidate) => new Date(candidate.expiresAt).getTime() > now,
  );
  sessions.sessions.push(session);
  writeSessions(sessions, config);
  return session;
}

function getCurrentUser(req, config) {
  const sessionId = parseCookies(req.headers.cookie || "")[config.sessionCookieName];
  if (!sessionId) {
    return null;
  }

  const sessions = readSessions(config);
  const session = sessions.sessions.find((candidate) => candidate.id === sessionId);
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
    return null;
  }

  return readUsers(config).users.find((user) => user.id === session.userId) || null;
}

function clearCurrentSession(req, config) {
  const sessionId = parseCookies(req.headers.cookie || "")[config.sessionCookieName];
  if (!sessionId) {
    return;
  }

  const sessions = readSessions(config);
  sessions.sessions = sessions.sessions.filter((candidate) => candidate.id !== sessionId);
  writeSessions(sessions, config);
}

function setSessionCookie(res, sessionId, config) {
  res.setHeader(
    "Set-Cookie",
    `${config.sessionCookieName}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.sessionTtlSeconds}`,
  );
}

function clearSessionCookie(res, config) {
  res.setHeader(
    "Set-Cookie",
    `${config.sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  );
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of String(cookieHeader || "").split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) {
      continue;
    }
    cookies[rawName] = decodeURIComponent(rawValue.join("=") || "");
  }
  return cookies;
}

function requireUser(user, res) {
  if (user) {
    return true;
  }
  sendJson(res, 401, { ok: false, error: "Login is required." });
  return false;
}

function requireAdmin(user, res, redirectToLogin = false) {
  if (user && user.role === "admin") {
    return true;
  }

  if (redirectToLogin && !user) {
    redirect(res, "/login");
    return false;
  }

  if (redirectToLogin) {
    redirect(res, "/queue");
    return false;
  }

  sendJson(res, user ? 403 : 401, {
    ok: false,
    error: user ? "Admin permission is required." : "Login is required.",
  });
  return false;
}

function getRuntimeConfig(config) {
  const settings = readSettings(config);
  const githubMode = settings.githubMode || config.githubMode;
  const githubApiBaseUrl =
    githubMode === "direct"
      ? "https://api.github.com"
      : trimTrailingSlash(settings.githubApiBaseUrl || config.githubApiBaseUrl);

  return {
    ...config,
    githubMode,
    githubApiBaseUrl,
    githubToken: settings.githubToken || config.githubToken,
    ghProxyToken: settings.ghProxyToken ?? config.ghProxyToken,
    githubOwner: settings.githubOwner || config.githubOwner,
    githubRepo: settings.githubRepo || config.githubRepo,
  };
}

function getPublicGitHubSettings(config) {
  return {
    githubMode: config.githubMode,
    githubApiBaseUrl: config.githubApiBaseUrl,
    githubOwner: config.githubOwner,
    githubRepo: config.githubRepo,
    githubTokenConfigured: Boolean(config.githubToken),
    ghProxyTokenConfigured: Boolean(config.ghProxyToken),
  };
}

function updateGitHubSettings(body, config) {
  const current = readSettings(config);
  const next = {
    ...current,
    githubMode:
      String(body.githubMode || "").toLowerCase() === "direct" ? "direct" : "proxy",
    githubOwner: String(body.githubOwner || "").trim() || config.githubOwner,
    githubRepo: String(body.githubRepo || "").trim() || config.githubRepo,
  };

  if (next.githubMode === "proxy") {
    next.githubApiBaseUrl =
      trimTrailingSlash(String(body.githubApiBaseUrl || "").trim()) ||
      "https://github-proxy.example.com/api/v3";
  } else {
    next.githubApiBaseUrl = "";
  }

  if (typeof body.githubToken === "string" && body.githubToken.trim()) {
    next.githubToken = body.githubToken.trim();
  }

  if (body.clearGithubToken === true) {
    next.githubToken = "";
  }

  if (typeof body.ghProxyToken === "string" && body.ghProxyToken.trim()) {
    next.ghProxyToken = body.ghProxyToken.trim();
  }

  if (body.clearGhProxyToken === true) {
    next.ghProxyToken = "";
  }

  writeSettings(next, config);
  return {
    statusCode: 200,
    body: {
      ok: true,
      settings: getPublicGitHubSettings(getRuntimeConfig(config)),
    },
  };
}

function verifyApprovalRequest(req, requestUrl, res, config) {
  if (!config.approvalToken) {
    return true;
  }

  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : "";
  const providedToken =
    String(req.headers["x-approval-token"] || "") ||
    requestUrl.searchParams.get("token") ||
    bearer;

  if (providedToken === config.approvalToken) {
    return true;
  }

  sendJson(res, 401, {
    ok: false,
    error: "Approval token is required.",
  });
  return false;
}

function getMattermostRequestLog(payload) {
  const text = String(payload.text || "");
  return {
    postId: payload.post_id || "",
    channelId: payload.channel_id || "",
    channelName: payload.channel_name || "",
    teamDomain: payload.team_domain || "",
    userName: payload.user_name || "",
    triggerWord: payload.trigger_word || "",
    textPreview: text.replace(/\s+/g, " ").slice(0, 240),
    fileIdCount: extractPayloadFileIds(payload).length,
  };
}

function writeAuditLog(config, event) {
  const logPath = config.auditLogPath || path.join(PROJECT_ROOT, "logs", "audit.log");
  const safeEvent = {
    timestamp: new Date().toISOString(),
    ...event,
  };

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(safeEvent)}\n`, "utf8");
  } catch (error) {
    console.error("Failed to write audit log", error);
  }
}

async function collectAttachmentSection(payload, config) {
  if (config.attachmentStorage === "off") {
    return "";
  }

  const fileInfos = await getMattermostAttachmentInfos(payload, config);
  if (fileInfos.length === 0) {
    return "";
  }

  const attachments = [];
  const notes = [];
  const limitedFileInfos = fileInfos.slice(0, config.attachmentMaxCount);

  if (fileInfos.length > limitedFileInfos.length) {
    notes.push(`Only the first ${config.attachmentMaxCount} attachments were processed.`);
  }

  if (!config.mattermostAccessToken) {
    notes.push("MATTERMOST_ACCESS_TOKEN is not configured, so attachments could not be downloaded.");
    for (const fileInfo of limitedFileInfos) {
      attachments.push({
        name: getMattermostFileName(fileInfo),
        size: fileInfo.size,
        mimeType: fileInfo.mime_type,
        sourceUrl: getMattermostFileSourceUrl(fileInfo.id, config),
      });
    }
    return buildAttachmentSection(attachments, notes);
  }

  if (config.attachmentStorage !== "github") {
    notes.push(`Unsupported ATTACHMENT_STORAGE value: ${config.attachmentStorage}`);
    return buildAttachmentSection([], notes);
  }

  const branch = await resolveGitHubAttachmentBranch(config);
  const usedNames = new Set();

  for (const [index, fileInfo] of limitedFileInfos.entries()) {
    const name = getMattermostFileName(fileInfo);
    const size = Number(fileInfo.size || 0);

    if (size > config.attachmentMaxBytes) {
      notes.push(
        `${name} was skipped because it is ${formatBytes(size)}, over the ${formatBytes(config.attachmentMaxBytes)} limit.`,
      );
      continue;
    }

    try {
      const fileBuffer = await downloadMattermostFile(fileInfo.id, config);
      const uniqueName = makeUniqueFileName(sanitizeAttachmentFileName(name), usedNames);
      const repoPath = buildAttachmentRepoPath(payload, uniqueName, index, config);
      const uploaded = await uploadGitHubContent(repoPath, fileBuffer, {
        branch,
        config,
        message: `Add Mattermost attachment ${uniqueName}`,
      });

      attachments.push({
        name: uniqueName,
        size: fileBuffer.length,
        mimeType: fileInfo.mime_type,
        htmlUrl: uploaded.htmlUrl,
        rawUrl: uploaded.rawUrl,
      });
    } catch (error) {
      notes.push(`${name} could not be attached: ${toShortErrorMessage(error)}`);
    }
  }

  return buildAttachmentSection(attachments, notes);
}

async function getMattermostAttachmentInfos(payload, config) {
  const payloadFileIds = extractPayloadFileIds(payload);

  if (config.mattermostAccessToken && payload.post_id) {
    try {
      const postFiles = await mattermostFetchJson(
        `/api/v4/posts/${encodeURIComponent(payload.post_id)}/files/info`,
        config,
      );

      if (Array.isArray(postFiles) && postFiles.length > 0) {
        return postFiles;
      }
    } catch (error) {
      if (payloadFileIds.length === 0) {
        return [];
      }
    }
  }

  if (payloadFileIds.length === 0) {
    return [];
  }

  if (!config.mattermostAccessToken) {
    return payloadFileIds.map((id) => ({ id, name: id }));
  }

  const fileInfos = [];
  for (const fileId of payloadFileIds) {
    try {
      fileInfos.push(
        await mattermostFetchJson(`/api/v4/files/${encodeURIComponent(fileId)}/info`, config),
      );
    } catch {
      fileInfos.push({ id: fileId, name: fileId });
    }
  }
  return fileInfos;
}

function extractPayloadFileIds(payload) {
  const candidates = [
    payload.file_ids,
    payload.file_id,
    payload.files,
    payload["file_ids[]"],
  ];
  const ids = [];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (Array.isArray(candidate)) {
      ids.push(...candidate);
      continue;
    }

    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          ids.push(...parsed);
          continue;
        }
      } catch {
        // Fall through to comma-separated parsing.
      }

      ids.push(...trimmed.split(","));
    }
  }

  return [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
}

async function mattermostFetchJson(apiPath, config) {
  const response = await mattermostFetch(apiPath, config);
  return response.json();
}

async function downloadMattermostFile(fileId, config) {
  const response = await mattermostFetch(`/api/v4/files/${encodeURIComponent(fileId)}`, config);
  return Buffer.from(await response.arrayBuffer());
}

async function mattermostFetch(apiPath, config) {
  if (!config.mattermostBaseUrl) {
    throw new Error("MATTERMOST_BASE_URL is not configured.");
  }

  if (!config.mattermostAccessToken) {
    throw new Error("MATTERMOST_ACCESS_TOKEN is not configured.");
  }

  const response = await fetch(`${trimTrailingSlash(config.mattermostBaseUrl)}${apiPath}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.mattermostAccessToken}`,
      "User-Agent": "mattermost-github-issue-callback",
    },
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`Mattermost API error ${response.status}: ${responseText}`);
  }

  return response;
}

async function resolveGitHubAttachmentBranch(config) {
  if (config.githubAttachmentBranch) {
    return config.githubAttachmentBranch;
  }

  const repo = await githubFetchJson(
    "GET",
    `/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}`,
    null,
    config,
  );
  return repo.default_branch || "main";
}

async function uploadGitHubContent(repoPath, contentBuffer, { branch, config, message }) {
  const existing = await getGitHubContent(repoPath, branch, config);
  if (existing) {
    return formatGitHubContentResult(existing, repoPath, branch, config);
  }

  const response = await githubFetchJson(
    "PUT",
    `/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents/${encodeGitHubPath(repoPath)}`,
    {
      message,
      content: contentBuffer.toString("base64"),
      branch,
    },
    config,
  );

  return formatGitHubContentResult(response.content || {}, repoPath, branch, config);
}

async function getGitHubContent(repoPath, branch, config) {
  try {
    return await githubFetchJson(
      "GET",
      `/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents/${encodeGitHubPath(repoPath)}?ref=${encodeURIComponent(branch)}`,
      null,
      config,
    );
  } catch (error) {
    if (error.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

async function githubFetchJson(method, apiPath, body, config) {
  const response = await githubFetch(method, apiPath, body, config);
  return response.json();
}

async function githubFetch(method, apiPath, body, config) {
  const url = `${trimTrailingSlash(config.githubApiBaseUrl || "https://api.github.com")}${apiPath}`;
  const response = await fetch(url, {
    method,
    headers: getGitHubHeaders(config),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const responseText = await response.text();
    const error = new Error(`GitHub API error ${response.status}: ${responseText}`);
    error.statusCode = response.status;
    throw error;
  }

  return response;
}

function getGitHubHeaders(config) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${config.githubToken}`,
    "Content-Type": "application/json",
    "User-Agent": "mattermost-github-issue-callback",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (config.githubMode === "proxy" && config.ghProxyToken) {
    headers["X-Proxy-Token"] = config.ghProxyToken;
    headers["Proxy-Authorization"] = `Bearer ${config.ghProxyToken}`;
  }

  return headers;
}

function formatGitHubContentResult(content, repoPath, branch, config) {
  const encodedPath = encodeGitHubPath(repoPath);
  return {
    htmlUrl:
      content.html_url ||
      `https://github.com/${config.githubOwner}/${config.githubRepo}/blob/${encodeURIComponent(branch)}/${encodedPath}`,
    rawUrl:
      content.download_url ||
      `https://github.com/${config.githubOwner}/${config.githubRepo}/raw/${encodeURIComponent(branch)}/${encodedPath}`,
  };
}

function encodeGitHubPath(repoPath) {
  return repoPath.split("/").map(encodeURIComponent).join("/");
}

function getMattermostFileName(fileInfo) {
  const extension = fileInfo.extension ? `.${String(fileInfo.extension).replace(/^\./, "")}` : "";
  return fileInfo.name || `${fileInfo.id || "mattermost-file"}${extension}`;
}

function getMattermostFileSourceUrl(fileId, config) {
  if (!fileId || !config.mattermostBaseUrl) {
    return "";
  }
  return `${trimTrailingSlash(config.mattermostBaseUrl)}/api/v4/files/${encodeURIComponent(fileId)}`;
}

function sanitizeAttachmentFileName(name) {
  const sanitized = String(name || "mattermost-file")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[._ -]+/, "")
    .slice(0, 160);

  return sanitized || "mattermost-file";
}

function makeUniqueFileName(fileName, usedNames) {
  if (!usedNames.has(fileName)) {
    usedNames.add(fileName);
    return fileName;
  }

  const extensionIndex = fileName.lastIndexOf(".");
  const base = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : "";
  let counter = 2;

  while (usedNames.has(`${base}-${counter}${extension}`)) {
    counter += 1;
  }

  const uniqueName = `${base}-${counter}${extension}`;
  usedNames.add(uniqueName);
  return uniqueName;
}

function buildAttachmentRepoPath(payload, fileName, index, config) {
  const postPart = sanitizePathSegment(payload.post_id || new Date().toISOString());
  const prefix = String(index + 1).padStart(2, "0");
  return `${config.attachmentRepoPath}/${postPart}/${prefix}-${fileName}`;
}

function sanitizePathSegment(value) {
  return String(value || "unknown")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

function buildAttachmentSection(attachments, notes = []) {
  if (attachments.length === 0 && notes.length === 0) {
    return "";
  }

  const lines = ["Mattermost attachments:"];
  for (const attachment of attachments) {
    const sizeText = attachment.size ? ` (${formatBytes(attachment.size)})` : "";
    const url = attachment.htmlUrl || attachment.sourceUrl || "";
    if (url) {
      lines.push(`- [${escapeMarkdownText(attachment.name)}](${url})${sizeText}`);
    } else {
      lines.push(`- ${escapeMarkdownText(attachment.name)}${sizeText}`);
    }
  }

  const imagePreviews = attachments.filter(
    (attachment) => attachment.rawUrl && isImageMimeType(attachment.mimeType),
  );

  if (imagePreviews.length > 0) {
    lines.push("");
    lines.push("Preview:");
    lines.push("");
    for (const attachment of imagePreviews) {
      lines.push(`![${escapeMarkdownAltText(attachment.name)}](${attachment.rawUrl})`);
      lines.push("");
    }
  }

  if (notes.length > 0) {
    lines.push("");
    lines.push("Attachment notes:");
    for (const note of notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n").trim();
}

function isImageMimeType(mimeType) {
  return String(mimeType || "").toLowerCase().startsWith("image/");
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  for (const unit of units) {
    if (size < 1024 || unit === "GB") {
      return `${size.toFixed(size >= 10 ? 0 : 1)} ${unit}`;
    }
    size /= 1024;
  }

  return `${bytes} B`;
}

function escapeMarkdownText(value) {
  return String(value || "").replace(/([\\[\]])/g, "\\$1");
}

function escapeMarkdownAltText(value) {
  return String(value || "").replace(/[\[\]\n\r]/g, " ");
}

function toShortErrorMessage(error) {
  const message = error && error.message ? error.message : String(error);
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

async function createGitHubIssue(issue, config) {
  const url = `${trimTrailingSlash(config.githubApiBaseUrl || "https://api.github.com")}/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/issues`;
  const response = await fetch(url, {
    method: "POST",
    headers: getGitHubHeaders(config),
    body: JSON.stringify(removeEmptyArrays(issue)),
  });

  if (!response.ok) {
    const responseText = await response.text();
    const error = new Error(`GitHub API error ${response.status}: ${responseText}`);
    error.statusCode = response.status;
    throw error;
  }

  return response.json();
}

function removeEmptyArrays(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => !Array.isArray(item) || item.length > 0),
  );
}

function renderQueuePage(config, currentUser) {
  const isAdmin = currentUser && currentUser.role === "admin";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mattermost Issue Queue</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #1d2430;
      --muted: #637083;
      --line: #d9dee7;
      --primary: #1463ff;
      --primary-dark: #0e4fc9;
      --danger: #b42318;
      --danger-bg: #fff1f0;
      --ok: #067647;
      --ok-bg: #ecfdf3;
      --warn: #b54708;
      --warn-bg: #fffaeb;
      --shadow: 0 12px 28px rgba(20, 28, 45, 0.08);
      font-family: Arial, Helvetica, sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    header { background: var(--panel); border-bottom: 1px solid var(--line); }
    .wrap { width: min(1120px, calc(100vw - 32px)); margin: 0 auto; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 72px; }
    h1 { margin: 0; font-size: 22px; line-height: 1.2; letter-spacing: 0; }
    .sub { color: var(--muted); font-size: 13px; margin-top: 4px; }
    .nav { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 13px; }
    main { padding: 22px 0 40px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .tabs { display: inline-flex; gap: 4px; padding: 4px; background: #e9edf4; border-radius: 8px; }
    button, input { font: inherit; }
    button { border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 8px; min-height: 36px; padding: 0 12px; cursor: pointer; }
    button:hover { border-color: #aab4c3; }
    button:disabled { opacity: .55; cursor: wait; }
    .tab { border: 0; background: transparent; color: var(--muted); }
    .tab.active { background: var(--panel); color: var(--text); box-shadow: 0 1px 2px rgba(20, 28, 45, .08); }
    .primary { background: var(--primary); color: #fff; border-color: var(--primary); }
    .primary:hover { background: var(--primary-dark); border-color: var(--primary-dark); }
    .danger { background: var(--danger-bg); color: var(--danger); border-color: #fecdca; }
    .auth { display: flex; align-items: center; gap: 8px; }
    .auth.hidden { display: none; }
    input { height: 36px; border: 1px solid var(--line); border-radius: 8px; padding: 0 10px; min-width: 260px; }
    .status { min-height: 22px; color: var(--muted); font-size: 13px; }
    .list { display: grid; gap: 12px; }
    .item { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); padding: 16px; }
    .item-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .title { font-size: 16px; line-height: 1.35; font-weight: 700; overflow-wrap: anywhere; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; color: var(--muted); font-size: 12px; margin-top: 8px; }
    .badge { display: inline-flex; align-items: center; border-radius: 8px; padding: 3px 8px; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .pending { background: var(--warn-bg); color: var(--warn); }
    .processing { background: #eff4ff; color: #175cd3; }
    .approved { background: var(--ok-bg); color: var(--ok); }
    .denied, .failed { background: var(--danger-bg); color: var(--danger); }
    .body { margin: 14px 0 0; white-space: pre-wrap; color: #344054; background: #f8fafc; border: 1px solid #e4e7ec; border-radius: 8px; padding: 12px; font-size: 13px; line-height: 1.5; max-height: 260px; overflow: auto; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 14px; }
    .empty { border: 1px dashed var(--line); border-radius: 8px; background: var(--panel); color: var(--muted); padding: 28px; text-align: center; }
    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
    @media (max-width: 720px) {
      .topbar, .toolbar, .item-head { align-items: stretch; flex-direction: column; }
      .auth { width: 100%; }
      input { min-width: 0; width: 100%; }
      .tabs { width: 100%; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap topbar">
      <div>
        <h1>Mattermost Issue Queue</h1>
        <div class="sub">${escapeHtml(config.githubOwner)}/${escapeHtml(config.githubRepo)} via ${escapeHtml(config.githubMode)}</div>
      </div>
      <div class="nav">
        <span>${escapeHtml(currentUser.username)} (${escapeHtml(currentUser.role)})</span>
        ${isAdmin ? '<a href="/admin">Admin</a>' : ""}
        <a href="/health" target="_blank" rel="noreferrer">Health</a>
        <button id="logout">Logout</button>
      </div>
    </div>
  </header>
  <main class="wrap">
    <div class="toolbar">
      <div class="tabs" role="tablist" aria-label="Queue status">
        <button class="tab active" data-status="pending">Pending</button>
        <button class="tab" data-status="failed">Failed</button>
        <button class="tab" data-status="approved">Approved</button>
        <button class="tab" data-status="denied">Denied</button>
        <button class="tab" data-status="all">All</button>
      </div>
      <button id="refresh">Refresh</button>
    </div>
    <div id="status" class="status"></div>
    <div id="list" class="list"></div>
  </main>
  <script>
    let currentStatus = 'pending';
    const list = document.getElementById('list');
    const statusEl = document.getElementById('status');

    document.querySelectorAll('.tab').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
        button.classList.add('active');
        currentStatus = button.dataset.status;
        loadQueue();
      });
    });

    document.getElementById('refresh').addEventListener('click', loadQueue);
    document.getElementById('logout').addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST' });
      window.location.href = '/login';
    });

    async function api(path, options = {}) {
      const headers = { Accept: 'application/json', ...(options.headers || {}) };
      if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      const response = await fetch(path, { ...options, headers });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || data.text || response.statusText || 'Request failed');
      }
      return data;
    }

    async function loadQueue() {
      statusEl.textContent = 'Loading...';
      list.innerHTML = '';
      try {
        const data = await api('/api/queue?status=' + encodeURIComponent(currentStatus));
        renderItems(data.items || []);
        statusEl.textContent = (data.items || []).length + ' item(s)';
      } catch (error) {
        statusEl.textContent = error.message;
        list.innerHTML = '<div class="empty">' + escapeHtml(error.message) + '</div>';
      }
    }

    function renderItems(items) {
      if (!items.length) {
        list.innerHTML = '<div class="empty">No queue items</div>';
        return;
      }

      list.innerHTML = items.map(renderItem).join('');
      list.querySelectorAll('[data-action="approve"]').forEach((button) => {
        button.addEventListener('click', () => approveItem(button.dataset.id, button));
      });
      list.querySelectorAll('[data-action="deny"]').forEach((button) => {
        button.addEventListener('click', () => denyItem(button.dataset.id, button));
      });
    }

    function renderItem(item) {
      const issue = item.issue || {};
      const requestLog = item.requestLog || {};
      const githubLink = item.githubIssue && item.githubIssue.htmlUrl
        ? '<a href="' + escapeAttribute(item.githubIssue.htmlUrl) + '" target="_blank" rel="noreferrer">#' + escapeHtml(item.githubIssue.number) + '</a>'
        : '';
      const canReview = item.status === 'pending' || item.status === 'failed';
      const error = item.error ? '<div class="body">' + escapeHtml(item.error) + '</div>' : '';
      return '<article class="item">' +
        '<div class="item-head">' +
          '<div>' +
            '<div class="title">' + escapeHtml(issue.title || '(untitled)') + '</div>' +
            '<div class="meta">' +
              '<span class="badge ' + escapeAttribute(item.status) + '">' + escapeHtml(item.status) + '</span>' +
              '<span>' + escapeHtml(formatDate(item.createdAt)) + '</span>' +
              '<span>' + escapeHtml(requestLog.userName || 'unknown user') + '</span>' +
              '<span>' + escapeHtml(requestLog.channelName || requestLog.channelId || 'unknown channel') + '</span>' +
              (githubLink ? '<span>' + githubLink + '</span>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="body">' + escapeHtml(issue.body || requestLog.textPreview || '') + '</div>' +
        error +
        '<div class="actions">' +
          '<button class="primary" data-action="approve" data-id="' + escapeAttribute(item.id) + '"' + (canReview ? '' : ' disabled') + '>Approve</button>' +
          '<button class="danger" data-action="deny" data-id="' + escapeAttribute(item.id) + '"' + (canReview ? '' : ' disabled') + '>Deny</button>' +
        '</div>' +
      '</article>';
    }

    async function approveItem(id, button) {
      button.disabled = true;
      try {
        await api('/api/queue/' + encodeURIComponent(id) + '/approve', {
          method: 'POST',
          body: JSON.stringify({ reviewer: 'queue-ui' }),
        });
        await loadQueue();
      } catch (error) {
        statusEl.textContent = error.message;
        button.disabled = false;
      }
    }

    async function denyItem(id, button) {
      const reason = prompt('Deny reason') || '';
      button.disabled = true;
      try {
        await api('/api/queue/' + encodeURIComponent(id) + '/deny', {
          method: 'POST',
          body: JSON.stringify({ reviewer: 'queue-ui', reason }),
        });
        await loadQueue();
      } catch (error) {
        statusEl.textContent = error.message;
        button.disabled = false;
      }
    }

    function formatDate(value) {
      if (!value) return '';
      return new Date(value).toLocaleString();
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[char]);
    }

    function escapeAttribute(value) {
      return escapeHtml(value);
    }

    loadQueue();
  </script>
</body>
</html>`;
}

function renderLoginPage() {
  return renderAuthPage({
    title: "Login",
    heading: "Mattermost Issue Queue",
    subtitle: "Sign in to review queued GitHub issues.",
    endpoint: "/api/login",
    buttonText: "Login",
    footer: '<a href="/setup">Initial setup</a>',
    includeRole: false,
  });
}

function renderSetupPage() {
  return renderAuthPage({
    title: "Initial Admin Setup",
    heading: "Create Admin Account",
    subtitle: "Create the first admin account for this queue.",
    endpoint: "/api/setup",
    buttonText: "Create admin",
    footer: '<a href="/login">Login</a>',
    includeRole: false,
  });
}

function renderAuthPage({ title, heading, subtitle, endpoint, buttonText, footer }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { font-family: Arial, Helvetica, sans-serif; color: #1d2430; background: #f6f7f9; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .panel { width: min(420px, 100%); background: #fff; border: 1px solid #d9dee7; border-radius: 8px; padding: 24px; box-shadow: 0 12px 28px rgba(20, 28, 45, .08); }
    h1 { margin: 0; font-size: 24px; }
    p { color: #637083; margin: 8px 0 22px; }
    label { display: block; font-weight: 700; font-size: 13px; margin: 14px 0 6px; }
    input { width: 100%; height: 40px; border: 1px solid #d9dee7; border-radius: 8px; padding: 0 10px; font: inherit; }
    button { width: 100%; height: 40px; margin-top: 18px; border: 0; border-radius: 8px; background: #1463ff; color: #fff; font: inherit; cursor: pointer; }
    .status { min-height: 20px; margin-top: 12px; color: #b42318; font-size: 13px; }
    .footer { margin-top: 16px; font-size: 13px; text-align: center; }
    a { color: #1463ff; text-decoration: none; }
  </style>
</head>
<body>
  <section class="panel">
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(subtitle)}</p>
    <form id="auth-form">
      <label for="username">Username</label>
      <input id="username" name="username" autocomplete="username" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">${escapeHtml(buttonText)}</button>
      <div id="status" class="status"></div>
    </form>
    <div class="footer">${footer}</div>
  </section>
  <script>
    const form = document.getElementById('auth-form');
    const statusEl = document.getElementById('status');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      statusEl.textContent = '';
      const body = {
        username: document.getElementById('username').value,
        password: document.getElementById('password').value
      };
      const response = await fetch('${endpoint}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        statusEl.textContent = data.error || data.text || 'Login failed';
        return;
      }
      window.location.href = '/queue';
    });
  </script>
</body>
</html>`;
}

function renderAdminPage(config, currentUser) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Admin Settings</title>
  <style>
    :root { font-family: Arial, Helvetica, sans-serif; color: #1d2430; background: #f6f7f9; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header { background: #fff; border-bottom: 1px solid #d9dee7; }
    .wrap { width: min(1080px, calc(100vw - 32px)); margin: 0 auto; }
    .topbar { min-height: 72px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    h1 { margin: 0; font-size: 22px; }
    main { padding: 22px 0 40px; display: grid; gap: 16px; }
    section { background: #fff; border: 1px solid #d9dee7; border-radius: 8px; padding: 18px; box-shadow: 0 12px 28px rgba(20, 28, 45, .08); }
    h2 { margin: 0 0 14px; font-size: 18px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    label { display: block; font-weight: 700; font-size: 13px; margin-bottom: 6px; }
    input, select { width: 100%; height: 38px; border: 1px solid #d9dee7; border-radius: 8px; padding: 0 10px; font: inherit; }
    button { min-height: 38px; border: 1px solid #1463ff; background: #1463ff; color: #fff; border-radius: 8px; padding: 0 12px; font: inherit; cursor: pointer; }
    button.secondary { background: #fff; color: #1463ff; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 14px; }
    .status { min-height: 20px; color: #637083; font-size: 13px; }
    .users { display: grid; gap: 8px; margin-top: 12px; }
    .user { display: flex; justify-content: space-between; border: 1px solid #e4e7ec; border-radius: 8px; padding: 10px; font-size: 14px; }
    a { color: #1463ff; text-decoration: none; }
    @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } .topbar { flex-direction: column; align-items: stretch; padding: 16px 0; } }
  </style>
</head>
<body>
  <header>
    <div class="wrap topbar">
      <div>
        <h1>Admin Settings</h1>
        <div>${escapeHtml(currentUser.username)} (${escapeHtml(currentUser.role)})</div>
      </div>
      <div class="row">
        <a href="/queue">Queue</a>
        <button id="logout" class="secondary">Logout</button>
      </div>
    </div>
  </header>
  <main class="wrap">
    <section>
      <h2>GitHub Settings</h2>
      <form id="github-form">
        <div class="grid">
          <div>
            <label for="githubMode">GitHub mode</label>
            <select id="githubMode">
              <option value="proxy">Proxy</option>
              <option value="direct">Direct</option>
            </select>
          </div>
          <div>
            <label for="githubApiBaseUrl">Proxy API base URL</label>
            <input id="githubApiBaseUrl" placeholder="https://github-proxy.example.com/api/v3">
          </div>
          <div>
            <label for="githubOwner">GitHub owner</label>
            <input id="githubOwner">
          </div>
          <div>
            <label for="githubRepo">GitHub repo</label>
            <input id="githubRepo">
          </div>
          <div>
            <label for="githubToken">New GitHub token</label>
            <input id="githubToken" type="password" placeholder="Leave blank to keep current token">
          </div>
          <div>
            <label for="ghProxyToken">New proxy token</label>
            <input id="ghProxyToken" type="password" placeholder="Leave blank to keep current proxy token">
          </div>
        </div>
        <div class="row">
          <button type="submit">Save GitHub settings</button>
          <span id="github-status" class="status"></span>
        </div>
      </form>
    </section>
    <section>
      <h2>Users</h2>
      <form id="user-form">
        <div class="grid">
          <div>
            <label for="newUsername">Username</label>
            <input id="newUsername" autocomplete="off">
          </div>
          <div>
            <label for="newPassword">Password</label>
            <input id="newPassword" type="password" autocomplete="new-password">
          </div>
          <div>
            <label for="newRole">Role</label>
            <select id="newRole">
              <option value="reviewer">Reviewer</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        </div>
        <div class="row">
          <button type="submit">Add user</button>
          <span id="user-status" class="status"></span>
        </div>
      </form>
      <div id="users" class="users"></div>
    </section>
  </main>
  <script>
    const githubStatus = document.getElementById('github-status');
    const userStatus = document.getElementById('user-status');

    document.getElementById('logout').addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST' });
      window.location.href = '/login';
    });

    async function api(path, options = {}) {
      const headers = { Accept: 'application/json', ...(options.headers || {}) };
      if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      const response = await fetch(path, { ...options, headers });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || data.text || response.statusText);
      return data;
    }

    async function loadGitHubSettings() {
      const data = await api('/api/admin/github-settings');
      const settings = data.settings || {};
      document.getElementById('githubMode').value = settings.githubMode || 'proxy';
      document.getElementById('githubApiBaseUrl').value = settings.githubApiBaseUrl || '';
      document.getElementById('githubOwner').value = settings.githubOwner || '';
      document.getElementById('githubRepo').value = settings.githubRepo || '';
      githubStatus.textContent = 'GitHub token: ' + (settings.githubTokenConfigured ? 'configured' : 'missing') + ', proxy token: ' + (settings.ghProxyTokenConfigured ? 'configured' : 'missing');
    }

    async function loadUsers() {
      const data = await api('/api/admin/users');
      document.getElementById('users').innerHTML = (data.users || []).map((user) =>
        '<div class="user"><span>' + escapeHtml(user.username) + '</span><strong>' + escapeHtml(user.role) + '</strong></div>'
      ).join('');
    }

    document.getElementById('github-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      githubStatus.textContent = 'Saving...';
      try {
        await api('/api/admin/github-settings', {
          method: 'POST',
          body: JSON.stringify({
            githubMode: document.getElementById('githubMode').value,
            githubApiBaseUrl: document.getElementById('githubApiBaseUrl').value,
            githubOwner: document.getElementById('githubOwner').value,
            githubRepo: document.getElementById('githubRepo').value,
            githubToken: document.getElementById('githubToken').value,
            ghProxyToken: document.getElementById('ghProxyToken').value
          })
        });
        document.getElementById('githubToken').value = '';
        document.getElementById('ghProxyToken').value = '';
        await loadGitHubSettings();
      } catch (error) {
        githubStatus.textContent = error.message;
      }
    });

    document.getElementById('user-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      userStatus.textContent = 'Adding...';
      try {
        await api('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify({
            username: document.getElementById('newUsername').value,
            password: document.getElementById('newPassword').value,
            role: document.getElementById('newRole').value
          })
        });
        document.getElementById('newUsername').value = '';
        document.getElementById('newPassword').value = '';
        userStatus.textContent = 'Added';
        await loadUsers();
      } catch (error) {
        userStatus.textContent = error.message;
      }
    });

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[char]);
    }

    loadGitHubSettings().catch((error) => githubStatus.textContent = error.message);
    loadUsers().catch((error) => userStatus.textContent = error.message);
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
  });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
  });
  res.end();
}

if (require.main === module) {
  const server = createServer();
  server.listen(CONFIG.port, "0.0.0.0", () => {
    console.log(`Mattermost GitHub issue callback listening on port ${CONFIG.port}`);
  });
}

module.exports = {
  approveQueueItem,
  buildAttachmentRepoPath,
  buildAttachmentSection,
  buildIssueInput,
  createQueueItem,
  createServer,
  denyQueueItem,
  extractPayloadFileIds,
  formatTitle,
  getGitHubApiBaseUrl,
  getGitHubMode,
  listQueueItems,
  readQueue,
  sanitizeAttachmentFileName,
  sanitizePayloadForQueue,
  stripLeadingTriggerWord,
  verifyMattermostPayload,
};
