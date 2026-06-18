const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildAttachmentRepoPath,
  buildAttachmentSection,
  buildIssueInput,
  createQueueItem,
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
} = require("../src/server");

const baseConfig = {
  triggerWords: ["!issue", "#issue"],
  issueTitlePrefix: "",
  defaultLabels: ["mattermost", "bug"],
  defaultAssignees: [],
  mattermostBaseUrl: "http://10.1.19.93:8065",
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
  assert.match(result.issue.body, /http:\/\/10\.1\.19\.93:8065\/sw\/pl\/abc123/);
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
    getGitHubApiBaseUrl("proxy", { GH_PROXY_URL: "https://ucut.in/proxy/gh" }),
    "https://ucut.in/proxy/gh/api/v3",
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
