const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildAttachmentRepoPath,
  buildAttachmentSection,
  buildIssueInput,
  buildReviewNotification,
  createQueueItem,
  extractPayloadFileIds,
  formatTitle,
  getGitHubApiBaseUrl,
  getGitHubMode,
  listQueueItems,
  notifyMattermost,
  readQueue,
  sanitizeAttachmentFileName,
  sanitizePayloadForQueue,
  stripLeadingTriggerWord,
  toShortErrorMessage,
  verifyMattermostPayload,
} = require("../src/server");

const baseConfig = {
  triggerWords: ["!issue", "#issue"],
  issueTitlePrefix: "",
  defaultLabels: ["mattermost", "bug"],
  defaultAssignees: [],
  mattermostBaseUrl: "https://mattermost.example.com",
  mattermostToken: "secret",
  mattermostAllowedChannels: ["d612a0b7bc697dacc5aaef593d6d422e"],
};

test("stripLeadingTriggerWord removes configured trigger words", () => {
  assert.equal(stripLeadingTriggerWord("!issue Login fails", ["!issue"]), "Login fails");
  assert.equal(stripLeadingTriggerWord("#issue\nLogin fails", ["#issue"]), "Login fails");
});

test("buildIssueInput maps first line to title, rest to body, and default labels", () => {
  const result = buildIssueInput(
    {
      token: "secret",
      text: "!issue Login button returns 500\nSteps:\n1. Open login page",
      channel_id: "d612a0b7bc697dacc5aaef593d6d422e",
      user_name: "tester",
      team_domain: "sw",
      post_id: "abc123",
    },
    baseConfig,
  );

  assert.equal(result.ok, true);
  assert.equal(result.issue.title, "Login button returns 500");
  assert.match(result.issue.body, /Steps:/);
  assert.match(result.issue.body, /https:\/\/mattermost\.example\.com\/sw\/pl\/abc123/);
  assert.deepEqual(result.issue.labels, ["mattermost", "bug"]);
});

test("buildIssueInput returns usage message when no issue title exists", () => {
  const result = buildIssueInput({ text: "!issue" }, baseConfig);

  assert.equal(result.ok, false);
  assert.match(result.message, /Usage/);
});

test("verifyMattermostPayload validates token and channel", () => {
  assert.deepEqual(
    verifyMattermostPayload(
      {
        token: "secret",
        channel_id: "d612a0b7bc697dacc5aaef593d6d422e",
      },
      baseConfig,
    ),
    { ok: true },
  );

  assert.equal(
    verifyMattermostPayload(
      {
        token: "wrong",
        channel_id: "d612a0b7bc697dacc5aaef593d6d422e",
      },
      baseConfig,
    ).status,
    401,
  );

  assert.equal(
    verifyMattermostPayload(
      {
        token: "secret",
        channel_id: "another-channel",
      },
      baseConfig,
    ).status,
    403,
  );
});

test("formatTitle applies prefix and length limit", () => {
  const title = formatTitle("  Login    fails  ", "[MM] ");

  assert.equal(title, "[MM] Login fails");
  assert.ok(formatTitle("a".repeat(500), "").length <= 240);
});

test("extractPayloadFileIds accepts arrays, JSON arrays, and comma-separated values", () => {
  assert.deepEqual(extractPayloadFileIds({ file_ids: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(extractPayloadFileIds({ file_ids: '["a","b"]' }), ["a", "b"]);
  assert.deepEqual(extractPayloadFileIds({ file_ids: "a,b, c" }), ["a", "b", "c"]);
});

test("attachment helpers build safe names, paths, and markdown", () => {
  assert.equal(sanitizeAttachmentFileName('../bad:name?.png'), 'bad_name_.png');

  const repoPath = buildAttachmentRepoPath(
    { post_id: "abc/123" },
    "screenshot.png",
    0,
    { attachmentRepoPath: ".mattermost-issue-attachments" },
  );

  assert.equal(repoPath, ".mattermost-issue-attachments/abc-123/01-screenshot.png");

  const section = buildAttachmentSection([
    {
      name: "screenshot.png",
      size: 2048,
      mimeType: "image/png",
      htmlUrl: "https://github.com/org/repo/blob/main/file.png",
      rawUrl: "https://github.com/org/repo/raw/main/file.png",
    },
  ]);

  assert.match(section, /Mattermost attachments:/);
  assert.match(section, /\[screenshot\.png\]/);
  assert.match(section, /Preview:/);
  assert.match(section, /!\[screenshot\.png\]/);
});

test("github mode supports direct and proxy options", () => {
  assert.equal(getGitHubMode({ GITHUB_MODE: "direct", GITHUB_API_BASE_URL: "https://proxy" }), "direct");
  assert.equal(getGitHubMode({ GH_PROXY_TOKEN: "proxy-token" }), "proxy");
  assert.equal(getGitHubMode({}), "direct");

  assert.equal(
    getGitHubApiBaseUrl("direct", { GITHUB_API_BASE_URL: "https://proxy" }),
    "https://api.github.com",
  );
  assert.equal(
    getGitHubApiBaseUrl("proxy", { GH_PROXY_URL: "https://github-proxy.example.com" }),
    "https://github-proxy.example.com/api/v3",
  );
});

test("queue stores sanitized pending items", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mattermost-queue-"));
  const config = {
    ...baseConfig,
    queueFilePath: path.join(tempDir, "queue.json"),
  };

  const item = createQueueItem(
    {
      token: "secret",
      text: "!issue Queue title",
      channel_id: "channel",
      user_name: "tester",
    },
    {
      issue: {
        title: "Queue title",
        body: "Queue body",
        labels: ["mattermost", "bug"],
        assignees: [],
      },
    },
    {
      textPreview: "!issue Queue title",
      userName: "tester",
    },
    config,
  );

  assert.equal(item.status, "pending");
  assert.equal(readQueue(config).items.length, 1);
  assert.equal(readQueue(config).items[0].payload.token, undefined);
  assert.equal(listQueueItems("pending", config).length, 1);
  assert.equal(sanitizePayloadForQueue({ token: "secret", text: "hello" }).token, undefined);
});

test("toShortErrorMessage surfaces the underlying fetch cause code", () => {
  const error = new TypeError("fetch failed");
  error.cause = { code: "ENOTFOUND" };
  assert.equal(toShortErrorMessage(error), "fetch failed (ENOTFOUND)");

  // Does not duplicate detail that is already part of the message.
  const plain = new Error("GitHub API error 401: bad token");
  assert.equal(toShortErrorMessage(plain), "GitHub API error 401: bad token");
});

test("buildReviewNotification renders approve, deny, and fail messages with channel", () => {
  const base = {
    issue: { title: "case 37" },
    requestLog: { channelName: "front", userName: "seungui" },
  };

  const approved = buildReviewNotification(
    { ...base, githubIssue: { number: 12, htmlUrl: "https://github.com/o/r/issues/12" }, review: { reviewer: "zaeval" } },
    "approved",
  );
  assert.equal(approved.channel, "front");
  assert.match(approved.text, /이슈 등록 완료/);
  assert.match(approved.text, /https:\/\/github\.com\/o\/r\/issues\/12/);
  assert.match(approved.text, /@seungui/);

  const denied = buildReviewNotification(
    { ...base, review: { reviewer: "zaeval", reason: "중복 이슈" } },
    "denied",
  );
  assert.match(denied.text, /이슈 반려/);
  assert.match(denied.text, /중복 이슈/);

  const failed = buildReviewNotification(
    { ...base, error: "fetch failed (ENOTFOUND)", review: { reviewer: "zaeval" } },
    "failed",
  );
  assert.match(failed.text, /이슈 등록 실패/);
  assert.match(failed.text, /ENOTFOUND/);
});

test("notifyMattermost posts the expected body and never throws on failure", async () => {
  const originalFetch = global.fetch;
  try {
    // Captures the outgoing request.
    let captured = null;
    global.fetch = async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 200, text: async () => "" };
    };
    await notifyMattermost(
      { mattermostWebhookUrl: "http://hook.example/hooks/abc" },
      { text: "hello", channel: "front" },
    );
    assert.equal(captured.url, "http://hook.example/hooks/abc");
    const sent = JSON.parse(captured.options.body);
    assert.equal(sent.text, "hello");
    assert.equal(sent.channel, "front");

    // A rejecting fetch must be swallowed (no throw), so it can never flip an
    // approved item to failed.
    global.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await assert.doesNotReject(
      notifyMattermost(
        { mattermostWebhookUrl: "http://hook.example/hooks/abc", auditLogPath: path.join(os.tmpdir(), "notify-audit.log") },
        { text: "hello" },
      ),
    );

    // Disabled when no webhook URL is configured (no fetch attempted).
    let called = false;
    global.fetch = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => "" };
    };
    await notifyMattermost({ mattermostWebhookUrl: "" }, { text: "hello" });
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});
