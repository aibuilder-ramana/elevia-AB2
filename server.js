const http = require("node:http");

const PORT = Number(process.env.PORT || 3000);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || "aibuilder-ramana";
const GITHUB_REPO = process.env.GITHUB_REPO || "elevia-AB2";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const FEEDBACK_FILE = process.env.FEEDBACK_FILE || "feedback.txt";
const INTAKE_PROGRESS_FILE = process.env.INTAKE_PROGRESS_FILE || "intake-progress.json";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_NOTE_CHARS = 2000;
const DEFAULT_ORIGINS = [
  "https://aibuilder-ramana.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(","))
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

const json = (res, status, body, origin) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(origin)
  });
  res.end(JSON.stringify(body));
};

const corsHeaders = origin => {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
};

const clean = value => String(value || "")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  .trim();

const readBody = req => new Promise((resolve, reject) => {
  let body = "";
  let size = 0;
  req.setEncoding("utf8");
  req.on("data", chunk => {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY_BYTES) {
      reject(Object.assign(new Error("Request body too large"), { status: 413 }));
      req.destroy();
      return;
    }
    body += chunk;
  });
  req.on("end", () => resolve(body));
  req.on("error", reject);
});

const parseFeedback = raw => {
  let data;
  try {
    data = JSON.parse(raw || "{}");
  } catch (e) {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }

  const sentiment = clean(data.sentiment).toLowerCase();
  const allowedSentiments = new Set(["up", "down", "note"]);
  const note = clean(data.note).slice(0, MAX_NOTE_CHARS);
  const screenId = clean(data.screenId).slice(0, 120);
  const screenLabel = clean(data.screenLabel).slice(0, 160);

  if (!screenId || !screenLabel) {
    throw Object.assign(new Error("screenId and screenLabel are required"), { status: 400 });
  }
  if (!allowedSentiments.has(sentiment)) {
    throw Object.assign(new Error("sentiment must be up, down, or note"), { status: 400 });
  }
  if (sentiment === "note" && !note) {
    throw Object.assign(new Error("note feedback requires text"), { status: 400 });
  }

  return {
    project: clean(data.project).slice(0, 80) || "elevia-AB2",
    screenId,
    screenLabel,
    sentiment,
    note,
    url: clean(data.url).slice(0, 500),
    clientId: clean(data.clientId).slice(0, 120),
    viewport: clean(data.viewport).slice(0, 40),
    userAgent: clean(data.userAgent || "").slice(0, 240),
    createdAt: clean(data.createdAt).slice(0, 80) || new Date().toISOString()
  };
};

const formatEntry = feedback => {
  const receivedAt = new Date().toISOString();
  const rating = {
    up: "Thumbs up",
    down: "Thumbs down",
    note: "Text feedback"
  }[feedback.sentiment];
  const note = feedback.note
    ? feedback.note.split("\n").map(line => `> ${line}`).join("\n")
    : "> No written note.";

  return [
    `## ${receivedAt}`,
    `Project: ${feedback.project}`,
    `Screen: ${feedback.screenLabel}`,
    `Screen ID: ${feedback.screenId}`,
    `Rating: ${rating}`,
    `Client ID: ${feedback.clientId || "anonymous"}`,
    `Client timestamp: ${feedback.createdAt}`,
    `URL: ${feedback.url || "not provided"}`,
    `Viewport: ${feedback.viewport || "not provided"}`,
    "",
    "Feedback:",
    note,
    "",
    "---",
    ""
  ].join("\n");
};

const githubPath = path => path.split("/").map(encodeURIComponent).join("/");

const githubFetch = async (path, options = {}) => {
  if (!GITHUB_TOKEN) {
    throw Object.assign(new Error("GITHUB_TOKEN is not configured"), { status: 500 });
  }
  return fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/${path}`, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "User-Agent": "elevia-feedback-service",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    }
  });
};

const loadRepoFile = async filePath => {
  const res = await githubFetch(`contents/${githubPath(filePath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
  if (res.status === 404) return { content: "", sha: undefined };
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error(`GitHub read failed: ${res.status} ${body}`), { status: 502 });
  }
  const file = await res.json();
  const content = Buffer.from((file.content || "").replace(/\n/g, ""), "base64").toString("utf8");
  return { content, sha: file.sha };
};

const saveRepoFile = async (filePath, content, sha, message) => {
  const body = {
    message,
    branch: GITHUB_BRANCH,
    content: Buffer.from(content, "utf8").toString("base64")
  };
  if (sha) body.sha = sha;

  return githubFetch(`contents/${githubPath(filePath)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
};

const loadFeedbackFile = () => loadRepoFile(FEEDBACK_FILE);

const saveFeedbackFile = (content, sha, message) => saveRepoFile(FEEDBACK_FILE, content, sha, message);

const appendFeedback = async feedback => {
  const entry = formatEntry(feedback);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await loadFeedbackFile();
    const spacer = current.content && !current.content.endsWith("\n") ? "\n" : "";
    const nextContent = `${current.content}${spacer}${entry}`;
    const res = await saveFeedbackFile(
      nextContent,
      current.sha,
      `Add feedback for ${feedback.screenLabel}`
    );

    if (res.ok) {
      const saved = await res.json();
      return saved.commit?.sha || null;
    }
    if (res.status === 409 && attempt < 2) continue;

    const body = await res.text();
    throw Object.assign(new Error(`GitHub write failed: ${res.status} ${body}`), { status: 502 });
  }
};

const handleFeedback = async (req, res, origin) => {
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    json(res, 403, { ok: false, error: "Origin is not allowed" }, origin);
    return;
  }
  const raw = await readBody(req);
  const feedback = parseFeedback(raw);
  if (!feedback.userAgent) feedback.userAgent = clean(req.headers["user-agent"]).slice(0, 240);
  const commit = await appendFeedback(feedback);
  json(res, 201, { ok: true, commit }, origin);
};

const parseIntakeProgress = raw => {
  let data;
  try {
    data = JSON.parse(raw || "{}");
  } catch (e) {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }

  const enquiryId = clean(data.enquiryId).toUpperCase();
  const status = clean(data.status).toLowerCase() || "started";
  const allowedStatuses = new Set(["started", "completed"]);
  const percent = Math.round(Number(data.percent) || 0);

  if (!/^E-\d+$/.test(enquiryId)) {
    throw Object.assign(new Error("enquiryId is required"), { status: 400 });
  }
  if (!allowedStatuses.has(status)) {
    throw Object.assign(new Error("status must be started or completed"), { status: 400 });
  }

  return {
    project: clean(data.project).slice(0, 80) || "elevia-AB2",
    enquiryId,
    status,
    percent: status === "completed" ? 100 : Math.max(1, Math.min(99, percent)),
    startedAt: clean(data.startedAt).slice(0, 80),
    completedAt: clean(data.completedAt).slice(0, 80),
    updatedAt: clean(data.updatedAt).slice(0, 80) || new Date().toISOString(),
    sections: Array.isArray(data.sections) ? data.sections.map(item => clean(item).slice(0, 40)).filter(Boolean) : [],
    doctor: clean(data.doctor).slice(0, 120),
    slot: clean(data.slot).slice(0, 120),
    sourceUrl: clean(data.sourceUrl).slice(0, 500),
    clientId: clean(data.clientId).slice(0, 120)
  };
};

const readIntakeProgressStore = async () => {
  const file = await loadRepoFile(INTAKE_PROGRESS_FILE);
  if (!file.content.trim()) {
    return {
      sha: file.sha,
      store: {
        project: "elevia-AB2",
        updatedAt: null,
        patients: {}
      }
    };
  }
  try {
    const parsed = JSON.parse(file.content);
    return {
      sha: file.sha,
      store: {
        project: parsed.project || "elevia-AB2",
        updatedAt: parsed.updatedAt || null,
        patients: parsed.patients && typeof parsed.patients === "object" ? parsed.patients : {}
      }
    };
  } catch (e) {
    throw Object.assign(new Error("Intake progress file contains invalid JSON"), { status: 502 });
  }
};

const saveIntakeProgress = async progress => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readIntakeProgressStore();
    const previous = current.store.patients[progress.enquiryId] || {};
    const alreadyCompleted = previous.status === "completed" || Number(previous.percent) >= 100;
    const completed = alreadyCompleted || progress.status === "completed";
    const previousPercent = Number(previous.percent) || 0;
    const nextPercent = completed ? 100 : Math.max(previousPercent, progress.percent);

    current.store.project = progress.project;
    current.store.updatedAt = progress.updatedAt;
    current.store.patients[progress.enquiryId] = {
      ...previous,
      project: progress.project,
      enquiryId: progress.enquiryId,
      status: completed ? "completed" : "started",
      percent: nextPercent,
      startedAt: previous.startedAt || progress.startedAt || progress.updatedAt,
      updatedAt: progress.updatedAt,
      completedAt: completed ? previous.completedAt || progress.completedAt || progress.updatedAt : previous.completedAt || null,
      sections: progress.sections.length ? progress.sections : previous.sections || [],
      doctor: progress.doctor || previous.doctor || "",
      slot: progress.slot || previous.slot || "",
      sourceUrl: progress.sourceUrl || previous.sourceUrl || "",
      clientId: progress.clientId || previous.clientId || ""
    };

    const res = await saveRepoFile(
      INTAKE_PROGRESS_FILE,
      `${JSON.stringify(current.store, null, 2)}\n`,
      current.sha,
      `Update intake progress for ${progress.enquiryId}`
    );

    if (res.ok) {
      const saved = await res.json();
      return {
        commit: saved.commit?.sha || null,
        progress: current.store.patients[progress.enquiryId]
      };
    }
    if (res.status === 409 && attempt < 2) continue;

    const body = await res.text();
    throw Object.assign(new Error(`GitHub write failed: ${res.status} ${body}`), { status: 502 });
  }
};

const handleIntakeProgressRead = async (req, res, origin) => {
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    json(res, 403, { ok: false, error: "Origin is not allowed" }, origin);
    return;
  }
  const current = await readIntakeProgressStore();
  json(res, 200, {
    ok: true,
    file: INTAKE_PROGRESS_FILE,
    updatedAt: current.store.updatedAt,
    patients: current.store.patients
  }, origin);
};

const handleIntakeProgressWrite = async (req, res, origin) => {
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    json(res, 403, { ok: false, error: "Origin is not allowed" }, origin);
    return;
  }
  const raw = await readBody(req);
  const progress = parseIntakeProgress(raw);
  const saved = await saveIntakeProgress(progress);
  json(res, 201, { ok: true, ...saved }, origin);
};

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, {
        ok: true,
        repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
        file: FEEDBACK_FILE,
        intakeFile: INTAKE_PROGRESS_FILE,
        branch: GITHUB_BRANCH
      }, origin);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/feedback") {
      await handleFeedback(req, res, origin);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/intake-progress") {
      await handleIntakeProgressRead(req, res, origin);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/intake-progress") {
      await handleIntakeProgressWrite(req, res, origin);
      return;
    }

    json(res, 404, { ok: false, error: "Not found" }, origin);
  } catch (error) {
    const status = error.status || 500;
    console.error(error);
    json(res, status, { ok: false, error: status >= 500 ? "Feedback service failed" : error.message }, origin);
  }
});

server.listen(PORT, () => {
  console.log(`Elevia feedback service listening on ${PORT}`);
});
