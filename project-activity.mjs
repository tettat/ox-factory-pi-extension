import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const DAY_MS = 86_400_000;

function clean(value) {
  return String(value ?? "").trim();
}

function dayKey(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function dateWindow(days = 371) {
  const count = Math.max(7, Math.min(371, Number(days) || 371));
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - (count - 1) * DAY_MS);
  const dates = [];
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += DAY_MS) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return { start: dates[0], end: dates.at(-1), dates };
}

function materializeCalendar(dates, counts) {
  return dates.map((date) => ({ date, count: Number(counts.get(date) || 0) }));
}

function addActivity(counts, contributors, at, actor, kind) {
  const date = dayKey(at);
  if (!date || !counts.has(date)) return;
  counts.set(date, counts.get(date) + 1);
  const name = clean(actor) || "未归属";
  const entry = contributors.get(name) || { name, total: 0, jobs: 0, progress: 0, todos: 0 };
  entry.total += 1;
  entry[kind] = (entry[kind] || 0) + 1;
  contributors.set(name, entry);
}

export function buildFactoryProjectActivity(project, jobs = [], { days = 371 } = {}) {
  const window = dateWindow(days);
  const counts = new Map(window.dates.map((date) => [date, 0]));
  const contributors = new Map();
  for (const job of jobs || []) addActivity(counts, contributors, job.updatedAt || job.createdAt, job.worker, "jobs");
  for (const item of project?.progress || []) addActivity(counts, contributors, item.updatedAt, item.owner, "progress");
  for (const item of project?.todos || []) addActivity(counts, contributors, item.updatedAt, item.owner, "todos");
  return {
    label: "本地工厂活动",
    description: "项目 Job 更新、进展记录和 Todo 更新各记 1 次；这是协作活跃度，不等同于代码提交。",
    start: window.start,
    end: window.end,
    days: materializeCalendar(window.dates, counts),
    total: [...counts.values()].reduce((sum, value) => sum + value, 0),
    contributors: [...contributors.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "zh-Hans-CN")),
  };
}

function isWebUrl(value) {
  return /^https?:\/\//i.test(clean(value));
}

function looksLikeGitRepo(path) {
  if (!path || !existsSync(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function git(cwd, args, options = {}) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: options.timeout || 5_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
  }).trim();
}

function tryGit(cwd, args, fallback = "") {
  try {
    return git(cwd, args);
  } catch {
    return fallback;
  }
}

function githubUrl(value) {
  const ref = clean(value);
  if (!ref) return null;
  const https = ref.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?(?:[/#].*)?$/i);
  if (https) return `https://github.com/${https[1]}/${https[2].replace(/\.git$/i, "")}`;
  const ssh = ref.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/#]+?)(?:\.git)?$/i);
  return ssh ? `https://github.com/${ssh[1]}/${ssh[2].replace(/\.git$/i, "")}` : null;
}

function configuredRepositories(project, baseDir) {
  const remoteUrls = [];
  const paths = [];
  for (const link of project?.links || []) {
    if (link?.type !== "repo") continue;
    const ref = clean(link.ref);
    const remote = githubUrl(ref);
    if (remote) remoteUrls.push(remote);
    else if (ref && !isWebUrl(ref)) paths.push(isAbsolute(ref) ? ref : resolve(baseDir, ref));
  }
  for (const worktree of project?.worktrees || []) {
    const ref = clean(worktree.path);
    if (ref) paths.push(isAbsolute(ref) ? ref : resolve(baseDir, ref));
  }
  return {
    paths: [...new Set(paths.filter(looksLikeGitRepo))],
    remoteUrls: [...new Set(remoteUrls)],
  };
}

function defaultRef(path) {
  const symbolic = tryGit(path, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (symbolic && tryGit(path, ["rev-parse", "--verify", symbolic])) return symbolic;
  for (const ref of ["origin/main", "origin/master", "main", "master", "HEAD"]) {
    if (tryGit(path, ["rev-parse", "--verify", ref])) return ref;
  }
  return "HEAD";
}

function repoSnapshot(path) {
  const root = tryGit(path, ["rev-parse", "--show-toplevel"]);
  if (!root) return null;
  const branch = tryGit(path, ["branch", "--show-current"], "(detached)");
  const remoteUrl = tryGit(path, ["remote", "get-url", "origin"]);
  const head = tryGit(path, ["rev-parse", "--short=10", "HEAD"]);
  const dirty = tryGit(path, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
  const upstream = tryGit(path, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const parts = tryGit(path, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]).split(/\s+/).map(Number);
    behind = Number(parts[0] || 0);
    ahead = Number(parts[1] || 0);
  }
  const last = tryGit(path, ["log", "-1", "--format=%H%x1f%aI%x1f%an%x1f%s"]).split("\x1f");
  return {
    path: root,
    branch,
    head,
    dirty,
    upstream: upstream || null,
    ahead,
    behind,
    remoteUrl: remoteUrl || null,
    githubUrl: githubUrl(remoteUrl),
    defaultRef: defaultRef(path),
    lastCommit: last[0] ? { hash: last[0], at: last[1] || null, author: last[2] || null, subject: last[3] || "" } : null,
  };
}

function parseGitLog(output, seen, counts, contributors, employeeNames) {
  for (const line of String(output || "").split("\n")) {
    if (!line) continue;
    const [hash, date, author, email] = line.split("\x1f");
    if (!hash || seen.has(hash) || !counts.has(date)) continue;
    seen.add(hash);
    counts.set(date, counts.get(date) + 1);
    const identity = `${clean(author) || "未知作者"} <${clean(email)}>`;
    const normalized = clean(author).normalize("NFKC").toLowerCase().replace(/\s+/g, "");
    const employee = employeeNames.get(normalized) || null;
    const entry = contributors.get(identity) || { name: clean(author) || "未知作者", email: clean(email), employee, total: 0 };
    entry.total += 1;
    contributors.set(identity, entry);
  }
}

function parseCommitRecords(records, seen, counts, contributors, employeeNames) {
  for (const record of records || []) {
    parseGitLog([record.hash, record.date, record.author, record.email].map(clean).join("\x1f"), seen, counts, contributors, employeeNames);
  }
}

function gitCalendar(repositories, window, mode, employeeNames, snapshotCommits = []) {
  const counts = new Map(window.dates.map((date) => [date, 0]));
  const contributors = new Map();
  const seen = new Set();
  for (const repo of repositories) {
    const refs = mode === "local" ? ["--branches"] : [repo.defaultRef || "HEAD"];
    const output = tryGit(repo.path, ["log", ...refs, `--since=${window.start}T00:00:00Z`, "--format=%H%x1f%as%x1f%an%x1f%ae"]);
    parseGitLog(output, seen, counts, contributors, employeeNames);
  }
  parseCommitRecords(snapshotCommits, seen, counts, contributors, employeeNames);
  return {
    start: window.start,
    end: window.end,
    days: materializeCalendar(window.dates, counts),
    total: seen.size,
    contributors: [...contributors.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
  };
}

function readSnapshot(snapshotPath, projectId) {
  if (!snapshotPath || !existsSync(snapshotPath)) return null;
  try {
    const data = JSON.parse(readFileSync(snapshotPath, "utf8"));
    const project = data?.projects?.[projectId];
    return project ? { generatedAt: data.generatedAt || null, ...project } : null;
  } catch {
    return null;
  }
}

export function buildProjectRepositoryActivity(project, { baseDir = process.cwd(), days = 371, workerNames = [], snapshotPath = null } = {}) {
  const configured = configuredRepositories(project, baseDir);
  const snapshot = readSnapshot(snapshotPath, project?.id);
  const liveRepositories = configured.paths.map(repoSnapshot).filter(Boolean);
  const repositories = liveRepositories.length ? liveRepositories : (snapshot?.repositories || []);
  const remoteUrls = [...new Set([...configured.remoteUrls, ...repositories.map((repo) => repo.githubUrl).filter(Boolean)])];
  const employeeNames = new Map();
  for (const name of workerNames) employeeNames.set(clean(name).normalize("NFKC").toLowerCase().replace(/\s+/g, ""), clean(name));
  for (const member of project?.members || []) employeeNames.set(clean(member.worker).normalize("NFKC").toLowerCase().replace(/\s+/g, ""), clean(member.worker));
  const window = dateWindow(days);
  return {
    available: repositories.length > 0,
    remoteUrls,
    repositories,
    localBranches: {
      label: "本地分支提交",
      description: "统计本机 refs/heads 下可达提交；包含尚未推送或尚未合并的本地分支。",
      ...gitCalendar(liveRepositories, window, "local", employeeNames, liveRepositories.length ? [] : snapshot?.localCommits),
    },
    mainline: {
      label: "主线提交",
      description: "统计本机已知的 origin 默认分支（否则 main/master/HEAD）。接近 GitHub 仓库主线提交口径，更新时间取决于最近一次 fetch。",
      ...gitCalendar(liveRepositories, window, "mainline", employeeNames, liveRepositories.length ? [] : snapshot?.mainlineCommits),
    },
    generatedAt: liveRepositories.length ? new Date().toISOString() : (snapshot?.generatedAt || new Date().toISOString()),
    source: liveRepositories.length ? "live-git" : snapshot ? "snapshot" : "none",
  };
}
