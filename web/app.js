// 牛马工厂本地 Web 协作驾驶舱
// 纯原生 JS；数学公式由同源内置 KaTeX 渲染。
// ---------------------------------------------------------------------------

(() => {
  "use strict";

  // ---- 配置 ----
  const REFRESH_DEBOUNCE_MS = 200;
  const DRAWER_OPEN_CLASS = "drawer--open";
  const LANG_STORAGE_KEY = "oxFactoryLang";
  const NOTIFICATION_LAST_SEEN_KEY = "oxFactoryNotificationsLastSeen";
  const NOTIFICATION_SPOKEN_IDS_KEY = "oxFactoryNotificationsSpokenIds";
  const TALK_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
  const TALK_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
  const TALK_IMAGE_MAX_COUNT = 6;
  const I18N = {
    zh: {
      "app.title": "牛马工厂 · 驾驶舱",
      "brand.title": "牛马工厂",
      "brand.subtitle": "本地协作驾驶舱",
      "health.loading": "加载中…",
      "metrics.workers": "员工",
      "metrics.jobs": "Jobs",
      "metrics.stale": "Stale",
      "metrics.tokensToday": "今日 Token",
      "actions.refresh": "刷新",
      "actions.refreshTitle": "刷新（手动）",
      "actions.switchLanguage": "切换语言",
      "nav.aria": "主导航",
      "nav.overview": "概览",
      "nav.projects": "项目",
      "nav.workers": "员工",
      "nav.jobs": "任务",
      "nav.tasks": "任务看板",
      "nav.schedules": "定时任务",
      "nav.tokens": "Token",
      "nav.compactions": "压缩",
      "nav.messages": "消息",
      "nav.report": "日报",
      "nav.permissions": "权限",
      "nav.outsource": "外包",
      "nav.notifications": "提醒",
      "topbar.updatedAt": "更新于",
      "toast.refreshed": "已刷新",
    },
    en: {
      "app.title": "Ox Factory · Dashboard",
      "brand.title": "Ox Factory",
      "brand.subtitle": "Local Collaboration Dashboard",
      "health.loading": "Loading…",
      "metrics.workers": "Workers",
      "metrics.jobs": "Jobs",
      "metrics.stale": "Stale",
      "metrics.tokensToday": "Tokens Today",
      "actions.refresh": "Refresh",
      "actions.refreshTitle": "Refresh manually",
      "actions.switchLanguage": "Switch language",
      "nav.aria": "Primary navigation",
      "nav.overview": "Overview",
      "nav.projects": "Projects",
      "nav.workers": "Workers",
      "nav.jobs": "Jobs",
      "nav.tasks": "Task Board",
      "nav.schedules": "Schedules",
      "nav.tokens": "Tokens",
      "nav.compactions": "Compactions",
      "nav.messages": "Messages",
      "nav.report": "Report",
      "nav.permissions": "Permissions",
      "nav.outsource": "Outsource",
      "nav.notifications": "Alerts",
      "topbar.updatedAt": "Updated",
      "toast.refreshed": "Refreshed",
    },
  };
  const STATE = {
    lastOverview: null,
    workers: [],
    jobs: [],
    taskRequests: [],
    factoryTasks: [],
    factoryTaskFacets: {},
    factoryTaskFilters: {
      query: "",
      project: "",
      status: "",
      assignee: "",
      priority: "",
      executionState: "",
      includeArchived: false,
    },
    factoryTaskDragId: null,
    notificationSettings: null,
    notificationPollTimer: null,
    notificationPollInFlight: false,
    currentPage: "overview",
    drawerJob: null,
    tokensDate: null,
    tokensTrendDays: null,
    qualityDateMode: "all",
    qualityDate: null,
    lang: readInitialLang(),
  };

  // ---- 工具 ----
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function readInitialLang() {
    try {
      const saved = localStorage.getItem(LANG_STORAGE_KEY);
      if (saved === "zh" || saved === "en") return saved;
    } catch {}
    return "zh";
  }

  function t(key) {
    return I18N[STATE.lang]?.[key] || I18N.zh[key] || key;
  }

  function updateLangSwitchUI() {
    const btn = $("#langSwitch");
    const text = $("#langSwitchText");
    if (!btn || !text) return;
    const label = t("actions.switchLanguage");
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-pressed", STATE.lang === "en" ? "true" : "false");
    text.textContent = STATE.lang === "zh" ? "中 / EN" : "ZH / EN";
  }

  function applyStaticI18n() {
    document.documentElement.lang = STATE.lang === "en" ? "en" : "zh-CN";
    document.title = t("app.title");
    $$("[data-i18n]").forEach((node) => {
      node.textContent = t(node.dataset.i18n);
    });
    $$("[data-i18n-title]").forEach((node) => {
      node.title = t(node.dataset.i18nTitle);
    });
    $$("[data-i18n-aria-label]").forEach((node) => {
      node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
    });
    updateLangSwitchUI();
  }

  function setLanguage(lang) {
    STATE.lang = lang === "en" ? "en" : "zh";
    try { localStorage.setItem(LANG_STORAGE_KEY, STATE.lang); } catch {}
    applyStaticI18n();
    if (STATE.lastOverview) setTopbar(STATE.lastOverview);
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === "data" && typeof v === "object") {
        for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
      } else {
        node.setAttribute(k, v);
      }
    }
    // 递归展平：children 可以是 Node / string / 数组 / 嵌套数组 / null
    // 防御：避免 [].concat() 不能展平嵌套数组导致的 appendChild(array) 报错
    const flat = (arr) => {
      const out = [];
      for (const item of arr) {
        if (item == null || item === false) continue;
        if (Array.isArray(item)) out.push(...flat(item));
        else out.push(item);
      }
      return out;
    };
    for (const c of flat([].concat(children))) {
      if (typeof c === "string" || typeof c === "number") node.appendChild(document.createTextNode(String(c)));
      else if (c instanceof Node) node.appendChild(c);
      else if (c && typeof c === "object" && c.nodeType) node.appendChild(c);
      // 静默跳过其他类型，避免 appendChild 报错
    }
    return node;
  }

  function loadingText(label, tag = "p") {
    const node = el(tag, { class: "muted", text: label });
    window.FactorySkin?.decorateLoading(node);
    return node;
  }

  function todayLocal() {
    // 本地时区 YYYY-MM-DD（避免后端 localDateString 依赖）
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  // ---- 轻量级 markdown 渲染器（零依赖）
  // 支持：标题 / 列表 / 任务列表 / 引用 / 代码块 / 行内代码 / 粗体 / 斜体 / 链接 / 分隔线 / 表格
  // 安全：先转义 HTML，再做受控替换；不允许原始 HTML。
  // options.compact = true 时不渲染多行结构，适合预览场景（Overview 消息预览用）。
  function md(text, options = {}) {
    if (text == null) return "";
    const compact = Boolean(options.compact);
    const source = String(text).replace(/\r\n?/g, "\n");
    const math = !compact && typeof globalThis.OxMath?.prepare === "function"
      ? globalThis.OxMath.prepare(source, globalThis.katex)
      : { text: source, restore: (html) => html };
    const lines = math.text.split("\n");
    const out = [];
    let i = 0;

    // 占位符系统避免 inline 规则互相冲突
    const stash = [];
    const stashIt = (s) => {
      stash.push(s);
      return `\u0001${stash.length - 1}\u0001`;
    };

    const inline = (raw) => {
      // 白名单：<br> / <br/> / <br /> 是安全的内联换行（用于表格 cell 等多行展示）
      // 先 stash 再 esc，避免 <script> 等危险标签进入最终 HTML
      let s = String(raw).replace(/<br\s*\/?>/gi, () => stashIt("<br>"));
      s = esc(s);
      // 代码块 `code`
      s = s.replace(/`([^`\n]+)`/g, (_, c) => stashIt(`<code>${c}</code>`));
      // 图片先于链接处理，避免 ![alt](url) 被当成普通链接。
      s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
        const label = alt || "图片";
        if (compact) return stashIt(`[图片：${label}]`);
        const safe = /^https?:\/\//i.test(url) || /^\/api\/talk-attachments\/[^/]+\/content$/.test(url);
        if (!safe) return stashIt(`[图片无法预览：${label}]`);
        return stashIt(`<a class="md__image-link" href="${url}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"><img class="md__image" src="${url}" alt="${label}" loading="lazy" decoding="async" referrerpolicy="no-referrer"><span class="md__image-caption">${label} · 查看原图</span></a>`);
      });
      // 粗体 **text** / __text__
      s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, c) => stashIt(`<strong>${c}</strong>`));
      s = s.replace(/__([^_\n]+)__/g, (_, c) => stashIt(`<strong>${c}</strong>`));
      // 斜体 *text* / _text_（避免吃掉 **）
      s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, p, c) => `${p}${stashIt(`<em>${c}</em>`)}`);
      s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, (_, p, c) => `${p}${stashIt(`<em>${c}</em>`)}`);
      // 链接 [text](url)
      s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
        const safeUrl = /^(https?:|mailto:|#|\/)/.test(u) ? u : "#";
        return stashIt(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${t}</a>`);
      });
      // 还原占位符
      s = s.replace(/\u0001(\d+)\u0001/g, (_, idx) => stash[Number(idx)]);
      return s;
    };

    const flushList = (buf) => {
      if (!buf.length) return;
      const isOrdered = /^\s*\d+\.\s/.test(buf[0]);
      const tag = isOrdered ? "ol" : "ul";
      out.push(`<${tag} class="md__list">`);
      for (const item of buf) {
        const text = item.replace(/^\s*([-*]|\d+\.)\s+/, "");
        // 任务列表 - [ ] / - [x]
        const taskMatch = text.match(/^\[( |x|X)\]\s+(.*)$/);
        if (taskMatch) {
          const checked = taskMatch[1].toLowerCase() === "x" ? "checked" : "";
          out.push(`<li class="md__task"><input type="checkbox" disabled ${checked}> ${inline(taskMatch[2])}</li>`);
        } else {
          out.push(`<li>${inline(text)}</li>`);
        }
      }
      out.push(`</${tag}>`);
    };

    while (i < lines.length) {
      const line = lines[i];

      // 代码块 ```
      if (/^```/.test(line)) {
        const lang = line.replace(/^```\s*/, "").trim();
        const codeLines = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // 跳过结束 ```
        const langAttr = lang ? ` data-lang="${esc(lang)}"` : "";
        out.push(`<pre class="md__pre"${langAttr}><code>${esc(codeLines.join("\n"))}</code></pre>`);
        continue;
      }

      // 标题 # / ## / ### / ####
      const hMatch = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
      if (hMatch) {
        const level = hMatch[1].length;
        out.push(`<h${level} class="md__h md__h--${level}">${inline(hMatch[2])}</h${level}>`);
        i++;
        continue;
      }

      // 水平线 ---
      if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line)) {
        out.push(`<hr class="md__hr">`);
        i++;
        continue;
      }

      // 引用 >
      if (/^\s*>\s?/.test(line)) {
        const quoteLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        out.push(`<blockquote class="md__quote">${inline(quoteLines.join(" "))}</blockquote>`);
        continue;
      }

      // 表格 | col | col |
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
        // 表格 cell 拆列时需要保留 \| 转义后的 |
        const splitRow = (row) => row
          // 先 stash 真实 |（吃掉转义用的反斜杠）
          .replace(/\\\|/g, () => stashIt("|"))
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim().replace(/\u0001(\d+)\u0001/g, (_, idx) => stash[Number(idx)]));
        const headerCells = splitRow(line);
        i += 2; // 跳过分隔行
        const bodyRows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          bodyRows.push(splitRow(lines[i]));
          i++;
        }
        out.push(`<table class="md__table"><thead><tr>${headerCells.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${bodyRows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        continue;
      }

      // 列表（无序 / 有序）
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        flushList(buf);
        continue;
      }

      // 空行
      if (/^\s*$/.test(line)) {
        i++;
        continue;
      }

      // 普通段落
      const para = [line];
      i++;
      while (i < lines.length && lines[i] && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s|>\s|\s*\|.*\|\s*$|\s*---+\s*$)/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      out.push(`<p class="md__p">${inline(para.join(" "))}</p>`);
    }

    const html = math.restore(out.join("\n"));
    if (compact) {
      // 预览模式：去掉块级标签，保留 inline；超过 3 段用省略号
      const flat = html
        .replace(/<\/?(h\d|ul|ol|li|blockquote|pre|hr|table|thead|tbody|tr|th|td|p)[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const max = options.max || 220;
      if (flat.length <= max) return flat;
      return esc(flat.slice(0, max)) + "…";
    }
    return html;
  }

  function mdNode(text, options = {}) {
    const wrap = el("div", { class: "md" });
    wrap.innerHTML = md(text, options);
    wrap.querySelectorAll("img.md__image").forEach((img) => {
      img.addEventListener("error", () => {
        img.hidden = true;
        const caption = img.parentElement?.querySelector(".md__image-caption");
        if (caption) caption.textContent = `${img.alt || "图片"} · 加载失败，点击查看原图`;
      }, { once: true });
    });
    return wrap;
  }

  function apiCostText(cost) {
    if (cost?.usd != null) return `≈ $${cost.usd.toFixed(4)}${cost.provisional ? "（累计估算）" : ""}`;
    return ({price_missing:"价格未配置", usage_unknown:"用量口径未确认", usage_incomplete:"用量不完整"})[cost?.status] || "暂无费用数据";
  }

  async function pollDrawerCost(id, target) {
    while (target.isConnected && STATE.drawerJob === id) {
      await sleep(3000);
      if (!target.isConnected || STATE.drawerJob !== id) return;
      const response = await api(`/api/jobs/${encodeURIComponent(id)}?markRead=0`);
      if (!target.isConnected || STATE.drawerJob !== id) return;
      if (response.ok) {
        target.textContent = apiCostText(response.data.apiCost);
        target.title = response.data.apiCost?.note || "";
        if (["done", "failed", "aborted", "stale"].includes(response.data.status)) return;
      }
    }
  }

  function fmtTime(iso, opts = {}) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const pad = (n) => String(n).padStart(2, "0");
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (opts.dateOnly) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (sameDay) return time;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
  }

  function fmtRelative(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (Number.isNaN(diff)) return "—";
    if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s 前`;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m 前`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h 前`;
    return `${Math.round(diff / 86_400_000)}d 前`;
  }

  function fmtNumber(n) {
    const v = Number(n || 0);
    if (!Number.isFinite(v)) return "0";
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 1 : 2)}K`;
    return String(Math.round(v));
  }

  function fmtDurationMs(ms) {
    const v = Number(ms || 0);
    if (!Number.isFinite(v) || v <= 0) return "—";
    if (v < 1000) return `${Math.round(v)}ms`;
    if (v < 10_000) return `${(v / 1000).toFixed(1)}s`;
    return `${Math.round(v / 1000)}s`;
  }

  function fmtTaskLength(value) {
    const v = Number(value || 0);
    if (!Number.isFinite(v) || v <= 0) return "—";
    return `${fmtNumber(v)} 字`;
  }

  function sortableNumericTh(label) {
    return el("th", {
      class: "table__sort-th",
      data: { sortType: "number" },
      title: "点击按数值排序",
    }, [
      el("button", {
        class: "table__sort-btn",
        type: "button",
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          sortTableByHeader(e.currentTarget.closest("th"));
        },
      }, [
        el("span", { text: label }),
        el("span", { class: "table__sort-indicator", text: "↕" }),
      ]),
    ]);
  }

  function sortableValue(value) {
    if (value == null || value === "") return "";
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : "";
  }

  function numericTd(value, text, className = "td--mono") {
    return el("td", {
      class: className,
      data: { sortValue: sortableValue(value) },
      text,
    });
  }

  function sortTableByHeader(th) {
    const table = th?.closest?.("table");
    const tbody = table?.tBodies?.[0];
    const headRow = th?.parentElement;
    if (!table || !tbody || !headRow) return;
    const headers = Array.from(headRow.children);
    const columnIndex = headers.indexOf(th);
    if (columnIndex < 0) return;
    const nextDir = th.dataset.sortDir === "desc" ? "asc" : "desc";
    for (const header of headers) {
      delete header.dataset.sortDir;
      header.removeAttribute("aria-sort");
      header.querySelector(".table__sort-indicator")?.replaceChildren(document.createTextNode("↕"));
    }
    th.dataset.sortDir = nextDir;
    th.setAttribute("aria-sort", nextDir === "asc" ? "ascending" : "descending");
    th.querySelector(".table__sort-indicator")?.replaceChildren(document.createTextNode(nextDir === "asc" ? "↑" : "↓"));
    const rows = Array.from(tbody.rows);
    rows.sort((a, b) => {
      const ar = a.cells[columnIndex]?.dataset.sortValue;
      const br = b.cells[columnIndex]?.dataset.sortValue;
      const av = ar === "" || ar == null ? Number.NEGATIVE_INFINITY : Number(ar);
      const bv = br === "" || br == null ? Number.NEGATIVE_INFINITY : Number(br);
      const an = Number.isFinite(av) ? av : Number.NEGATIVE_INFINITY;
      const bn = Number.isFinite(bv) ? bv : Number.NEGATIVE_INFINITY;
      if (an !== bn) return nextDir === "asc" ? an - bn : bn - an;
      return String(a.textContent || "").localeCompare(String(b.textContent || ""), "zh-Hans-CN");
    });
    for (const row of rows) tbody.appendChild(row);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function toast(msg, kind = "info") {
    const t = $("#toast");
    t.textContent = msg;
    t.dataset.kind = kind;
    t.hidden = false;
    t.classList.add("toast--show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      t.classList.remove("toast--show");
      setTimeout(() => (t.hidden = true), 250);
    }, 2400);
  }

  // ---- API ----
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function api(path, opts = {}) {
    const url = path.startsWith("http") ? path : path;
    try {
      const res = await fetch(url, { cache: "no-store", ...opts });
      const ct = res.headers.get("content-type") || "";
      if (!res.ok) {
        let detail;
        try {
          detail = ct.includes("json") ? (await res.json()) : await res.text();
        } catch {
          detail = null;
        }
        return { ok: false, status: res.status, detail };
      }
      if (ct.includes("json")) return { ok: true, data: await res.json() };
      return { ok: true, data: await res.text() };
    } catch (err) {
      return { ok: false, status: 0, detail: String(err?.message || err) };
    }
  }

  function isRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }

  function recordList(value) {
    return Array.isArray(value) ? value.filter(isRecord) : [];
  }

  // ---- 声音提醒（第一版：浏览器 Web Speech API + 轮询 /api/notifications） ----
  function nowIso() {
    return new Date().toISOString();
  }

  function getNotificationLastSeen() {
    try {
      const saved = localStorage.getItem(NOTIFICATION_LAST_SEEN_KEY);
      if (saved && !Number.isNaN(new Date(saved).getTime())) return saved;
      const initial = nowIso();
      localStorage.setItem(NOTIFICATION_LAST_SEEN_KEY, initial);
      return initial;
    } catch {
      return nowIso();
    }
  }

  function setNotificationLastSeen(value = nowIso()) {
    try { localStorage.setItem(NOTIFICATION_LAST_SEEN_KEY, value); } catch {}
  }

  function readSpokenNotificationIds() {
    try {
      const parsed = JSON.parse(localStorage.getItem(NOTIFICATION_SPOKEN_IDS_KEY) || "[]");
      return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      return new Set();
    }
  }

  function selectNotificationVoice() {
    if (!("speechSynthesis" in window) || typeof window.speechSynthesis.getVoices !== "function") return null;
    const voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) return null;
    const femaleHints = /(female|woman|girl|xiaoxiao|xiaoyi|xiaobei|xiaoni|xiaozhen|tingting|mei[- ]?jia|sin[- ]?ji|yuna|hanhan|huihui|yaoyao|晓晓|晓伊|婷婷|美佳|女声)/i;
    const zhVoices = voices.filter((voice) =>
      /^zh\b/i.test(voice.lang || "") || /chinese|mandarin|cantonese|中文|普通话|粤语/i.test(voice.name || ""),
    );
    return zhVoices.find((voice) => femaleHints.test(`${voice.name} ${voice.lang}`))
      || voices.find((voice) => femaleHints.test(`${voice.name} ${voice.lang}`))
      || zhVoices[0]
      || voices[0]
      || null;
  }

  function rememberSpokenNotificationId(id) {
    if (!id) return;
    const ids = readSpokenNotificationIds();
    ids.add(String(id));
    const list = [...ids].slice(-500);
    try { localStorage.setItem(NOTIFICATION_SPOKEN_IDS_KEY, JSON.stringify(list)); } catch {}
  }

  function speakNotification(text) {
    const message = String(text || "").trim();
    if (!message) return false;
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      toast("当前浏览器不支持语音提醒", "error");
      return false;
    }
    try {
      const utterance = new SpeechSynthesisUtterance(message);
      utterance.lang = "zh-CN";
      utterance.rate = 1;
      utterance.pitch = 1.08;
      const voice = selectNotificationVoice();
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang || utterance.lang;
      }
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
      return true;
    } catch (err) {
      toast(`播放提醒失败：${String(err?.message || err)}`, "error");
      return false;
    }
  }

  function notificationPollIntervalMs(settings = STATE.notificationSettings) {
    const ms = Number(settings?.pollIntervalMs || 5000);
    if (!Number.isFinite(ms)) return 5000;
    return Math.min(60000, Math.max(1000, Math.round(ms)));
  }

  function scheduleNotificationPolling() {
    if (STATE.notificationPollTimer) {
      clearInterval(STATE.notificationPollTimer);
      STATE.notificationPollTimer = null;
    }
    if (!STATE.notificationSettings?.enabled) return;
    const interval = notificationPollIntervalMs();
    STATE.notificationPollTimer = setInterval(() => {
      void pollNotifications();
    }, interval);
  }

  async function loadNotificationSettings() {
    const res = await api("/api/notification-settings");
    if (!res.ok) return res;
    STATE.notificationSettings = res.data?.settings || null;
    scheduleNotificationPolling();
    return res;
  }

  async function saveNotificationSettings(settings, opts = {}) {
    const wasEnabled = Boolean(STATE.notificationSettings?.enabled);
    const res = await api("/api/notification-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    if (!res.ok) return res;
    STATE.notificationSettings = res.data?.settings || null;
    if (!wasEnabled && STATE.notificationSettings?.enabled) {
      // 开启时从“现在”开始提醒，避免把历史完成任务一口气读出来。
      setNotificationLastSeen(nowIso());
    }
    if (opts.resetLastSeen) setNotificationLastSeen(nowIso());
    scheduleNotificationPolling();
    return res;
  }

  async function pollNotifications() {
    const settings = STATE.notificationSettings;
    if (!settings?.enabled || STATE.notificationPollInFlight) return;
    STATE.notificationPollInFlight = true;
    try {
      const since = getNotificationLastSeen();
      const res = await api(`/api/notifications?since=${encodeURIComponent(since)}&limit=50`);
      if (!res.ok) return;
      if (res.data?.settings) STATE.notificationSettings = res.data.settings;
      const notifications = recordList(res.data?.notifications);
      const spoken = readSpokenNotificationIds();
      let latestAt = since;
      for (const item of notifications) {
        if (item.at && String(item.at).localeCompare(String(latestAt)) > 0) latestAt = item.at;
        if (!item.id || spoken.has(String(item.id))) continue;
        if (speakNotification(item.message || `${item.worker || "员工"} 任务完成`)) {
          rememberSpokenNotificationId(item.id);
          spoken.add(String(item.id));
        }
      }
      if (latestAt !== since) setNotificationLastSeen(latestAt);
    } finally {
      STATE.notificationPollInFlight = false;
    }
  }

  // ---- 渲染状态徽章 ----
  const STATUS_KEYS = ["queued", "running", "orphan-running", "done", "stale", "failed", "aborted"];
  const STATUS_LABELS = {
    queued: "排队",
    running: "运行中",
    "orphan-running": "孤儿",
    done: "完成",
    stale: "Stale",
    failed: "失败",
    aborted: "中止",
    vacation: "休假",
    pending: "待接管",
    processing: "接管中",
    accepted: "已接管",
    reported: "已回传",
    cancelled: "已取消",
  };
  const JOB_TERMINAL_STATUSES = new Set(["done", "failed", "aborted", "stale", "cancelled"]);

  function statusPill(status) {
    const s = String(status || "idle");
    return el("span", { class: `pill pill--${s}`, text: STATUS_LABELS[s] || s });
  }

  function isCancellableJob(job) {
    return Boolean(job?.id) && !JOB_TERMINAL_STATUSES.has(String(job.status || ""));
  }

  function workerStatusDot(status) {
    return el("span", { class: `dot dot--${w.activeJobs > 0 ? "busy" : status || "idle"}`, title: status || "idle" });
  }

  function normalizedAvatarStatus(status) {
    const value = String(status || "idle");
    return value === "working" ? "busy" : value;
  }

  function workerAvatarNode(worker, opts = {}) {
    const name = typeof worker === "string" ? worker : (worker?.name || "");
    const avatar = typeof worker === "object" ? String(worker?.avatar || "").trim() : "";
    const status = normalizedAvatarStatus(typeof worker === "object" ? worker?.status : opts.status);
    const className = `avatar${opts.large ? " avatar--lg" : ""} avatar--${status}`;
    if (/^(https?:\/\/|data:image\/|\/api\/avatars\/)/i.test(avatar)) {
      return el("div", { class: className }, [
        el("img", { class: "avatar__img", src: avatar, alt: "" }),
      ]);
    }
    return el("div", { class: className }, [
      el("span", { class: "avatar__char", text: avatar || (name || "?").slice(0, 1) }),
    ]);
  }

  // ---- Topbar ----
  function setTopbar(overview) {
    const totals = overview?.totals || {};
    $("#metricWorkers").textContent = totals.workers ?? "—";
    $("#metricJobs").textContent = totals.jobsAll ?? "—";
    $("#metricStale").textContent = (totals.stale || 0) + (totals["orphan-running"] || 0);
    $("#metricTokens").textContent = fmtNumber(totals.tokens?.totalWithCached || 0);
    const h = overview?.health || { level: "healthy", label: "—" };
    const health = $("#topbarHealth");
    health.querySelector(".health__dot").dataset.level = h.level;
    health.querySelector(".health__label").textContent = h.label + (h.signals?.length ? ` · ${h.signals[0]}` : "");
    $("#lastUpdated").textContent = `${t("topbar.updatedAt")} ${fmtTime(overview?.generatedAt)}`;
  }

  // ---- Overview 页面 ----
  function renderOverview(overview, outsourceBundle) {
    const main = $("#main");
    main.innerHTML = "";
    const t = overview.totals || {};
    const wrap = el("div", { class: "page page--overview" });

    // ① 健康摘要
    const health = overview.health || {};
    const hero = el("section", { class: "hero" }, [
      el("div", { class: "hero__left" }, [
        el("div", { class: "hero__eyebrow", text: "工厂健康" }),
        el("h1", { class: `hero__title hero__title--${health.level || "healthy"}`, text: health.label || "—" }),
        el("div", { class: "hero__signals" },
          (health.signals && health.signals.length
            ? health.signals.map((s) => el("span", { class: "tag tag--soft", text: s }))
            : [el("span", { class: "tag tag--soft", text: "所有指标正常" })])),
        el("div", { class: "hero__date", text: `${overview.date || "—"} · 数据来源: jobs / sessions / queue / compactions` }),
      ]),
      el("div", { class: "hero__right" }, [
        kpiCard("员工", `${t.activeWorkers || 0}/${t.workers || 0}`, "活跃 / 总数"),
        kpiCard("Jobs", String(t.jobsAll ?? 0), `今日 ${t.jobsToday ?? 0}`),
        kpiCard("Stale", String((t.stale || 0) + (t["orphan-running"] || 0)), "需关注"),
        kpiCard("Tokens", fmtNumber(t.tokens?.totalWithCached || 0), `in ${fmtNumber(t.tokens?.inputTokens || 0)} · out ${fmtNumber(t.tokens?.outputTokens || 0)}`),
      ]),
    ]);
    wrap.appendChild(hero);

    // ①-b Subagent / 外包 KPI
    if (outsourceBundle) {
      wrap.appendChild(renderOverviewSubagentSection(outsourceBundle));
    }

    // ② 项目态势：优先展示 Project Entity，派生 job.project 只作辅助
    const catalog = overview.projectCatalog || [];
    const strips = overview.projects || [];
    // 过滤掉 talk 这种对话模式的派生 strips
    const activityStrips = strips.filter((p) => p.name && p.name.toLowerCase() !== "talk");
    const talkStrips = strips.filter((p) => p.name && p.name.toLowerCase() === "talk");

    let projectSection;
    if (catalog.length > 0) {
      projectSection = el("section", { class: "section" }, [
        sectionHead("项目态势", `Project Entity 一等展示（${catalog.length} 个） · 数据来源: projects.jsonl`),
        el("div", { class: "project-catalog" },
          catalog.map((p) => projectCatalogCard(p))),
      ]);
    } else {
      projectSection = el("section", { class: "section" }, [
        sectionHead("项目态势", "暂无 Project Entity；可以让主 agent 用 factory_project_upsert 创建项目。"),
        emptyState("暂无项目", "可以让主 agent 用 factory_project_upsert 创建 Project Entity。"),
      ]);
    }
    wrap.appendChild(projectSection);

    // ②-b 活动归档（从 job.project 派生，辅助区）
    if (activityStrips.length > 0 || talkStrips.length > 0) {
      const activitySection = el("section", { class: "section" }, [
        sectionHead("活动归档", "从 job.project 派生的历史活动条；talk 归入对话/临时咨询"),
        activityStrips.length > 0
          ? el("div", { class: "project-strips" },
              activityStrips.slice(0, 6).map((p) => projectStrip(p)))
          : null,
        talkStrips.length > 0
          ? el("div", { class: "project-strips project-strips--talk" },
              talkStrips.map((p) => projectStrip(p, { talk: true })))
          : null,
      ]);
      wrap.appendChild(activitySection);
    }

    // ③ Job 状态分布 + 风险  (两列)
    const split = el("section", { class: "section section--grid" }, [
      el("div", { class: "card" }, [
        cardHead("Job 状态分布", "点击数字跳 Jobs 页预过滤"),
        el("div", { class: "jobstats" },
          STATUS_KEYS.map((s) => {
            const count = t[s] || 0;
            return el("button", {
              class: "jobstat",
              type: "button",
              onclick: () => location.hash = `#/jobs?status=${encodeURIComponent(s)}`,
            }, [
              el("span", { class: `jobstat__num jobstat__num--${s}`, text: String(count) }),
              el("span", { class: "jobstat__label", text: STATUS_LABELS[s] || s }),
            ]);
          }),
        ),
      ]),
      el("div", { class: "card" }, [
        cardHead("最近风险", "Stale / Orphan / Failed / 压缩失败"),
        (overview.risks && overview.risks.length
          ? el("ul", { class: "risks" }, overview.risks.map((r) => riskItem(r)))
          : emptyState("无风险信号", "工厂运行平稳。")),
      ]),
    ]);
    wrap.appendChild(split);

    // ④ Token Top 5
    const tokens = overview.tokens || {};
    const top = tokens.top || [];
    const maxT = Math.max(1, ...top.map((t) => t.reported?.totalWithCachedTokens || 0));
    const tokenSection = el("section", { class: "section" }, [
      cardHead("今日 Token Top 5", `合计 ${fmtNumber(tokens.totals?.totalWithCached || 0)}（含缓存） · 数据来源: ${(top[0]?.source) || "—"}`),
      top.length === 0
        ? emptyState("今日暂无 token 记录")
        : el("div", { class: "bar-list" },
            top.map((row) => barRow(row, maxT))),
      el("div", { class: "card__foot" }, [
        el("a", { class: "link link--more", href: "#/tokens", text: "查看完整 Token 报告 →" }),
      ]),
    ]);
    wrap.appendChild(tokenSection);

    // ⑤ 员工预览 + 消息预览 + 压缩预览 (三列紧凑)
    const trio = el("section", { class: "section section--trio" }, [
      el("div", { class: "card" }, [
        cardHead("员工状态", "前 8 位"),
        workerPreview(overview.workers || []),
        el("div", { class: "card__foot" }, [
          el("a", { class: "link link--more", href: "#/workers", text: "全部员工 →" }),
        ]),
      ]),
      el("div", { class: "card" }, [
        cardHead("最近消息", "主 agent 收件箱"),
        messagePreview(overview.messages?.recent || []),
        el("div", { class: "card__foot" }, [
          el("a", { class: "link link--more", href: "#/messages", text: "全部消息 →" }),
        ]),
      ]),
      el("div", { class: "card" }, [
        cardHead("压缩评估 (Codex shadow)", "只评估，不替换 Pi 真实压缩"),
        compactionPreview(overview.compactions?.recent || []),
        el("div", { class: "card__foot" }, [
          el("a", { class: "link link--more", href: "#/compactions", text: "完整对比 →" }),
        ]),
      ]),
    ]);
    wrap.appendChild(trio);

    main.appendChild(wrap);
  }

  function renderOverviewSubagentSection(bundle) {
    const counts = computeOutsourceCounts(bundle.runs || []);
    const profileCount = (bundle.profiles || []).length;
    const section = el("section", { class: "section" }, [
      cardHead("Subagent / 外包", `${profileCount} profiles · ${counts.total} runs · 数据: outsource-runs.jsonl`),
      el("div", { class: "kpi-row" }, [
        kpiCard("可用 Profiles", String(profileCount), "外包团队配置数"),
        kpiCard("正在运行", String(counts.running + counts.queued), `运行 ${counts.running} · 排队 ${counts.queued}`),
        kpiCard("今日完成", String(counts.doneToday), `本地时区 ${todayLocal()}`),
        kpiCard("需关注", String(counts.needsAttention), "异常终态 + error"),
      ]),
      el("div", { class: "card__foot" }, [
        el("a", { class: "link link--more", href: "#/outsource", text: "进入外包页面 →" }),
      ]),
    ]);
    if (bundle.runsError) {
      section.appendChild(errorBox("拉 runs 失败", bundle.runsError));
    }
    if (bundle.profilesError) {
      section.appendChild(errorBox("拉 profiles 失败", bundle.profilesError));
    }
    return section;
  }

  function kpiCard(label, value, sub) {
    return el("div", { class: "kpi" }, [
      el("div", { class: "kpi__label", text: label }),
      el("div", { class: "kpi__value", text: value }),
      el("div", { class: "kpi__sub", text: sub }),
    ]);
  }

  function kvRow(label, value) {
    return el("div", { class: "kv__row" }, [
      el("span", { class: "kv__label", text: label }),
      el("span", { class: "kv__value", text: value == null ? "—" : String(value) }),
    ]);
  }

  function cardHead(title, sub) {
    const h = el("div", { class: "card__head" });
    h.appendChild(el("h3", { class: "card__title", text: title }));
    if (sub) h.appendChild(el("p", { class: "card__sub", text: sub }));
    return h;
  }

  // 可折叠卡片（默认折叠；点击 header 展开/收起）
  // 避免一打开页面就看到一大坨长内容（消息、项目、风险等）
  async function markMessageReadFromUi(message, root, worker) {
    if (!message?.id || !worker) return;
    root.dataset.readPending = "1";
    const res = await api(`/api/messages/${encodeURIComponent(message.id)}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worker, from: "web" }),
    });
    delete root.dataset.readPending;
    if (!res.ok) {
      root.dataset.readFailed = "1";
      return;
    }
    message.read = true;
    root.classList.remove("msg-list__item--unread");
    root.querySelector(".msg-preview__unread")?.remove();
    void refreshWorkerUnreadBadges();
  }

  async function markWorkerReadFromUi(worker) {
    if (!worker) return { ok: false, count: 0 };
    const res = await api(`/api/workers/${encodeURIComponent(worker)}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "web" }),
    });
    return {
      ok: res.ok,
      count: Number(res.data?.count || 0),
      messages: Number(res.data?.messages?.count || 0),
      jobs: Number(res.data?.jobs?.count || 0),
      jobEvents: Number(res.data?.jobs?.unreadEvents || 0),
    };
  }

  function clearWorkerCardUnreadLocally(worker) {
    const card = $$(".worker-card").find((item) => item.dataset.name === worker);
    if (!card) return;
    card.dataset.unread = "0";
    card.classList.remove("worker-card--unread");
    card.querySelector(".worker-card__badge--unread")?.remove();
  }

  function decrementWorkerCardUnreadLocally(worker, amount = 1) {
    const card = $$(".worker-card").find((item) => item.dataset.name === worker);
    if (!card) return;
    const nextUnread = Math.max(0, Number(card.dataset.unread || 0) - Math.max(1, Number(amount) || 1));
    card.dataset.unread = String(nextUnread);
    const badge = card.querySelector(".worker-card__badge--unread");
    if (nextUnread > 0) {
      card.classList.add("worker-card--unread");
      if (badge) badge.textContent = nextUnread > 99 ? "99+" : String(nextUnread);
    } else {
      card.classList.remove("worker-card--unread");
      badge?.remove();
    }
  }

  function unreadBadgeTitle(worker) {
    return `${worker.finishedUnreadJobs || 0} 个已结束任务未读（每个任务计 1）`;
  }

  function workerCardTalkPreviewText(worker) {
    if (worker.activeJobs > 0) return "正在输入…";
    if (worker.queuedJobs > 0) return "等待执行…";
    if (worker.status === "vacation") return "休假中";
    const status = worker.lastJob?.status;
    if (status === "failed" || status === "stale") return "任务失败 · " + (worker.lastTalkReply?.contentPreview || "请查看任务详情");
    if (status === "aborted") return "已停止 · " + (worker.lastTalkReply?.contentPreview || "请查看任务详情");
    if (worker.finishedUnreadJobs > 0) return "已结束 · " + (worker.lastTalkReply?.contentPreview || "有任务结果待查看");
    return "空闲";
  }

  function workerCardTalkPreviewNode(worker) {
    const text = workerCardTalkPreviewText(worker);
    if (!text) return null;
    return el("div", {
      class: "worker-card__talk-preview",
      text,
      title: text,
    });
  }

  function syncWorkerCardTalkPreview(card, worker) {
    const body = card?.querySelector(".worker-card__body");
    if (!body) return;
    const text = workerCardTalkPreviewText(worker);
    const existing = card.querySelector(".worker-card__talk-preview");
    if (!text) {
      existing?.remove();
      return;
    }
    if (existing) {
      existing.textContent = text;
      existing.title = text;
      return;
    }
    body.appendChild(workerCardTalkPreviewNode(worker));
  }

  function messageItem(m, opts = {}) {
    // m: { from, to, direction, createdAt, content, read }
    // opts: { defaultOpen, showDirection, showRead }
    const showDirection = opts.showDirection !== false;
    const showRead = opts.showRead !== false;
    const defaultOpen = Boolean(opts.defaultOpen);
    const direction = m.direction || (m.to === (opts.worker || "") ? "in" : "out");
    const worker = opts.worker || "";
    const unreadBeforeOpen = Boolean(m.unreadBeforeOpen);
    const unreadIncoming = showRead && (m.read === false || unreadBeforeOpen) && worker && m.from !== worker && (m.to === worker || m.to === "*");

    // 预览（第一行 plain text，折叠时可见）
    const preview = String(m.content || "").replace(/\s+/g, " ").trim().slice(0, 120);

    const headChildren = [];
    if (showDirection) {
      headChildren.push(el("span", { class: `tag tag--${direction === "in" ? "main" : "soft"}`, text: direction === "in" ? "IN" : "OUT" }));
    }
    headChildren.push(el("span", { class: "msg-list__peer", text: `${m.from} → ${m.to}` }));
    headChildren.push(el("span", { class: "msg-list__time", text: fmtRelative(m.createdAt) }));
    if (unreadIncoming) {
      headChildren.push(el("span", {
        class: "msg-preview__unread",
        text: unreadBeforeOpen && m.read !== false ? "打开前未读" : "未读",
        title: "本次打开员工详情前尚未读过",
      }));
    }

    // 详情项（原生 <details>，可折叠）
    const details = el("details", {
      class: `msg-list__item msg-list__item--${direction}${unreadIncoming ? " msg-list__item--unread" : ""}${unreadBeforeOpen ? " msg-list__item--unread-before-open" : ""} ${defaultOpen ? "msg-list__item--open" : ""}`,
    });
    if (unreadIncoming && m.read === false) {
      details.addEventListener("toggle", () => {
        if (!details.open || m.read || details.dataset.readPending === "1") return;
        void markMessageReadFromUi(m, details, worker);
      });
    }
    if (defaultOpen) details.open = true;
    const summary = el("summary", { class: "msg-list__head" });
    const left = el("div", { class: "msg-list__head-left" }, headChildren);
    summary.appendChild(left);
    summary.appendChild(el("span", { class: "msg-list__preview", text: preview || "（空内容）" }));
    summary.appendChild(el("span", { class: "msg-list__chevron", text: "▾" }));
    details.appendChild(summary);
    const body = el("div", { class: "msg-list__body" });
    if (m.content) body.appendChild(mdNode(m.content));
    else body.appendChild(el("span", { class: "muted", text: "（空内容）" }));
    details.appendChild(body);
    return details;
  }

  function collapsibleCard({ title, sub, count, defaultOpen = false, empty = null, body = null }) {
    const details = el("details", { class: "card card--collapsible" });
    if (defaultOpen) details.open = true;
    const summary = el("summary", { class: "card__summary" });
    const left = el("div", { class: "card__summary-left" });
    left.appendChild(el("h3", { class: "card__title", text: title }));
    if (sub) left.appendChild(el("p", { class: "card__sub", text: sub }));
    summary.appendChild(left);
    if (count != null) {
      summary.appendChild(el("span", { class: "card__count", text: String(count) }));
    }
    summary.appendChild(el("span", { class: "card__chevron", text: "▾" }));
    details.appendChild(summary);
    const bodyWrap = el("div", { class: "card__body" });
    if (empty) {
      bodyWrap.appendChild(empty);
    } else if (body) {
      bodyWrap.appendChild(body);
    }
    details.appendChild(bodyWrap);
    return details;
  }

  function sectionHead(title, sub) {
    const h = el("div", { class: "section__head" });
    h.appendChild(el("h2", { class: "section__title", text: title }));
    if (sub) h.appendChild(el("p", { class: "section__sub", text: sub }));
    return h;
  }

  function emptyState(title, hint) {
    return el("div", { class: "empty" }, [
      el("div", { class: "empty__icon", text: "✷" }),
      el("div", { class: "empty__title", text: title }),
      hint ? el("div", { class: "empty__hint", text: hint }) : null,
    ]);
  }

  function projectStrip(p, opts = {}) {
    const counts = p.byStatus || {};
    const segs = STATUS_KEYS.filter((k) => counts[k]);
    const isTalk = opts.talk;
    return el("a", {
      class: `project-strip${isTalk ? " project-strip--talk" : ""}`,
      href: `#/jobs?project=${encodeURIComponent(p.name)}`,
    }, [
      el("div", { class: "project-strip__head" }, [
        el("div", { class: "project-strip__name" }, [
          isTalk ? el("span", { class: "tag tag--soft", text: "对话" }) : null,
          el("span", { text: p.name }),
        ]),
        el("div", { class: "project-strip__total", text: `${p.total} jobs` }),
      ]),
      el("div", { class: "project-strip__bar" },
        segs.map((k) => el("span", {
          class: `project-strip__seg project-strip__seg--${k}`,
          style: `flex: ${counts[k] || 0};`,
          title: `${STATUS_LABELS[k] || k}: ${counts[k]}`,
        }))),
      el("div", { class: "project-strip__meta" }, [
        el("span", { text: `参与: ${(p.participants || []).join(" · ") || "—"}` }),
        el("span", { text: `最近: ${fmtRelative(p.lastActivity)}` }),
      ]),
      p.lastSummary ? el("div", { class: "project-strip__summary", text: p.lastSummary }) : null,
    ]);
  }

  // ---- Project Entity catalog card ----
  function projectCatalogCard(p) {
    const todoCounts = (p.todos || []).reduce((acc, t) => {
      acc[t.status] = (acc[t.status] || 0) + 1;
      return acc;
    }, {});
    const members = p.members || [];
    const owner = members.find((m) => m.relation === "owner");
    const lead = members.find((m) => m.relation === "lead");
    const latestProgress = (p.progress || [])[0];
    const truth = p.truth;
    const statusClass = p.status === "active" ? "done" : p.status === "paused" ? "stale" : "soft";

    return el("a", {
      class: "proj-card",
      href: `#/projects/${encodeURIComponent(p.id)}`,
    }, [
      el("div", { class: "proj-card__head" }, [
        el("div", { class: "proj-card__title" }, [
          el("span", { class: `pill pill--${statusClass}`, text: p.status }),
          el("span", { class: "tag tag--soft", text: p.priority || "P1" }),
          el("strong", { text: p.name }),
        ]),
        p.relatedJobCount != null && p.relatedJobCount > 0
          ? el("span", { class: "proj-card__jobcount", text: `${p.relatedJobCount} jobs` })
          : null,
      ]),
      p.summary ? el("div", { class: "proj-card__summary", text: p.summary }) : null,
      el("div", { class: "proj-card__meta" }, [
        owner ? el("span", { text: `👤 ${owner.worker}` }) : null,
        lead ? el("span", { text: `⚡ ${lead.worker}` }) : null,
        members.length > 2 ? el("span", { class: "muted", text: `+${members.length - 2} 人` }) : null,
      ]),
      (p.todos && p.todos.length > 0) ? el("div", { class: "proj-card__todos" },
        ["todo", "doing", "done", "blocked"].filter((k) => todoCounts[k]).map((k) =>
          el("span", { class: `proj-card__todo proj-card__todo--${k}`, text: `${todoCounts[k]} ${k}` })
        )
      ) : null,
      latestProgress ? el("div", { class: "proj-card__progress" }, [
        el("span", { class: "muted", text: fmtRelative(latestProgress.updatedAt) }),
        el("span", { text: compactForCard(latestProgress.text, 80) }),
      ]) : null,
      truth ? el("div", { class: "proj-card__truth" }, [
        el("span", { class: "tag tag--soft", text: `📎 ${truth.type}` }),
        el("span", { class: "proj-card__truthref", text: compactForCard(truth.ref, 50) }),
      ]) : null,
    ]);
  }

  function compactForCard(s, max) {
    const text = String(s || "").replace(/\s+/g, " ").trim();
    if (text.length <= max) return text;
    return text.slice(0, max) + "…";
  }

  function riskItem(r) {
    const ref = r.ref && r.source === "job" ? `#/jobs/${encodeURIComponent(r.ref)}` : null;
    return el("li", { class: `risk risk--${r.level || "medium"}` }, [
      el("span", { class: "risk__level", text: r.level === "high" ? "HIGH" : r.level === "medium" ? "MED" : "LOW" }),
      el("span", { class: "risk__source", text: r.source || "—" }),
      ref
        ? el("a", { class: "risk__msg", href: ref, text: r.message })
        : el("span", { class: "risk__msg", text: r.message }),
      el("span", { class: "risk__time", text: fmtRelative(r.at) }),
    ]);
  }

  function barRow(row, max) {
    const r = row.reported || {};
    const input = r.inputTokens || 0;
    const cache = r.cachedInputTokens || 0;
    const output = r.outputTokens || 0;
    const reasoning = r.reasoningOutputTokens || 0;
    const total = r.totalWithCachedTokens || 0;

    // 同一根条子里多段堆叠：cache / input / output / reasoning
    const segs = [
      { key: "cache",     label: "缓存",  val: cache },
      { key: "input",     label: "输入",  val: input },
      { key: "output",    label: "输出",  val: output },
      { key: "reasoning", label: "推理",  val: reasoning },
    ].filter((s) => s.val > 0);
    const totalSegSum = segs.reduce((a, b) => a + b.val, 0) || 1;
    const fillPct = total > 0 ? Math.max(2, Math.min(100, (total / max) * 100)) : 0;
    const segWidths = segs.map((s) => Math.max(0.5, (s.val / totalSegSum) * 100));

    // 气泡内容：每行色块 + 标签 + 数值
    const tooltipRows = segs.map((s) => el("div", { class: "bar-row__tip-row" }, [
      el("span", { class: `bar-row__tip-dot bar-row__tip-dot--${s.key}` }),
      el("span", { class: "bar-row__tip-label", text: s.label }),
      el("span", { class: "bar-row__tip-value", text: fmtNumber(s.val) }),
    ]));
    const tooltip = el("div", { class: "bar-row__tip" }, [
      el("div", { class: "bar-row__tip-title", text: `${row.worker} · 合计 ${fmtNumber(total)}` }),
      ...tooltipRows,
    ]);

    return el("div", { class: "bar-row" }, [
      el("div", { class: "bar-row__name", text: row.worker }),
      el("div", { class: "bar-row__track" }, [
        el("div", {
          class: "bar-row__fill",
          style: `width: ${fillPct}%;`,
          "data-pct": String(Math.round(fillPct)),
        }, segs.map((s, i) => el("div", {
          class: `bar-row__seg bar-row__seg--${s.key}`,
          style: `width: ${segWidths[i]}%;`,
        }))),
        tooltip,
      ]),
      // 右边：只放一个 total 数字，右对齐
      el("div", { class: "bar-row__sub", text: fmtNumber(total) }),
    ]);
  }

  function workerPreview(workers) {
    if (!workers.length) return emptyState("暂无员工", "可以让主 agent 招聘，或等待员工上线。");
    return el("ul", { class: "worker-preview" },
      workers.slice(0, 8).map((w) => el("li", { class: "worker-preview__item" }, [
        el("a", { class: "worker-preview__link", href: `#/workers/${encodeURIComponent(w.name)}` }, [
          workerAvatarNode(w),
          el("div", { class: "worker-preview__body" }, [
            el("div", { class: "worker-preview__name" }, [
              workerStatusDot(w.status),
              el("span", { text: w.name }),
              w.status === "vacation" ? el("span", { class: "worker-card__vacation-badge", text: "🏖 休假" }) : null,
            ]),
            el("div", { class: "worker-preview__meta" }, [
              el("span", { text: STATUS_LABELS[w.status] || w.status || "idle" }),
              el("span", { text: `· tok ${fmtNumber(w.tokenToday?.totalWithCached || 0)}` }),
            ]),
            w.responsibility ? el("div", { class: "worker-preview__meta", text: w.responsibility.split("\n")[0] }) : null,
          ]),
        ]),
      ])));
  }

  function messagePreview(messages) {
    if (!messages.length) return emptyState("暂无消息");
    return el("ul", { class: "msg-preview" },
      messages.map((m) => el("li", { class: "msg-preview__item" }, [
        el("div", { class: "msg-preview__head" }, [
          el("span", { class: "msg-preview__from", text: m.from }),
          el("span", { class: "msg-preview__arrow", text: "→" }),
          el("span", { class: "msg-preview__to", text: m.to }),
          el("span", { class: "msg-preview__time", text: fmtRelative(m.createdAt) }),
          m.read ? null : el("span", { class: "msg-preview__unread", text: "未读" }),
        ]),
        // compact: true → 平铺 inline，截断到 ~180 字符，避免在 Overview 拥挤
        el("div", { class: "msg-preview__body", html: md(m.preview || "", { compact: true, max: 200 }) }),
      ])));
  }

  function compactionPreview(records) {
    if (!records.length) return emptyState("暂无压缩记录", "Codex shadow 评估未启动，或主 agent 还没触发压缩。");
    return el("ul", { class: "cmp-preview" },
      records.map((r) => el("li", { class: "cmp-preview__item" }, [
        el("div", { class: "cmp-preview__head" }, [
          el("span", { class: `tag tag--${r.targetType === "main" ? "main" : "soft"}`, text: r.targetType === "main" ? "主 agent" : r.worker || "员工" }),
          el("span", { class: "cmp-preview__time", text: fmtRelative(r.createdAt) }),
        ]),
        el("div", { class: "cmp-preview__sizes" }, [
          el("span", { class: "cmp-preview__pi", text: `Pi: ${r.pi?.summaryChars || 0}字` }),
          el("span", { class: "cmp-preview__vs", text: "vs" }),
          el("span", { class: "cmp-preview__codex", text: `Codex: ${r.codex?.summaryChars || 0}字${r.codex?.error ? " (失败)" : ""}` }),
        ]),
      ])));
  }

  // ---- Workers 页面 ----
  // 纯前端过滤：输入 → name.toLowerCase().includes(query) → 隐藏/显示卡片
  let workerSearchDebounceTimer = null;

  function scheduleWorkerCardsFilter(query) {
    if (workerSearchDebounceTimer) clearTimeout(workerSearchDebounceTimer);
    workerSearchDebounceTimer = setTimeout(() => {
      workerSearchDebounceTimer = null;
      filterWorkerCards(query);
    }, 140);
  }

  function filterWorkerCards(query) {
    const list = $(".workers__list");
    if (!list) return;
    const q = String(query || "").trim().toLowerCase();
    const cards = $$(".worker-card", list);
    let visible = 0;
    for (const card of cards) {
      const name = String(card.dataset.name || "").toLowerCase();
      const match = !q || name.includes(q);
      card.hidden = !match;
      if (match) visible += 1;
    }
    const counter = $("#workerSearchCount");
    const total = cards.length;
    if (counter) {
      counter.textContent = q ? `${visible} / ${total} 匹配` : `${total} 员工`;
    }
  }

  // ---- 外包团队页面 ----
  // 信息架构：标题「外包团队」；区块「外包团队配置」(Profiles) + 「运行与消息」(Runs)
  async function renderOutsource() {
    const main = $("#main");
    main.innerHTML = "";
    const wrap = el("div", { class: "page page--outsource" });

    // 顶部标题
    wrap.appendChild(sectionHead("外包团队", "外包 profile 配置 + 运行历史与消息流 · 只读展示"));

    // 并行拉取 profiles + runs，各自独立容错
    const [profileRes, runsRes] = await Promise.all([
      api("/api/outsource/profiles"),
      api("/api/outsource/runs?limit=50"),
    ]);

    const profiles = profileRes.ok ? (profileRes.data?.profiles || []) : [];
    const runs = runsRes.ok ? (runsRes.data?.runs || []) : [];
    const counts = computeOutsourceCounts(runs);

    // KPI 区（始终展示，基于已有数据）
    wrap.appendChild(renderOutsourceKpis(profiles, counts));

    // 外包团队配置区块
    const profileSection = el("section", { class: "section", id: "outsource-profiles-section" });
    profileSection.appendChild(cardHead("外包团队配置", `${profiles.length} 个可用 profile${profileRes.ok ? "" : " (加载失败)"}`));
    if (!profileRes.ok) {
      profileSection.appendChild(errorBox("加载 profiles 失败", profileRes.detail));
    } else if (!profiles.length) {
      profileSection.appendChild(emptyState("暂无外包 profile", "用 factory_outsource_profiles 创建外包团队配置。"));
    } else {
      const grid = el("div", { class: "profile-grid" });
      for (const p of profiles) {
        grid.appendChild(renderOutsourceProfileCard(p));
      }
      profileSection.appendChild(grid);
    }
    wrap.appendChild(profileSection);

    // 运行与消息区块
    const runsSection = el("section", { class: "section", id: "outsource-runs-section" });
    runsSection.appendChild(cardHead("运行与消息", `${runs.length} 条执行记录${runsRes.ok ? "" : " (加载失败)"}`));
    if (!runsRes.ok) {
      runsSection.appendChild(errorBox("加载 runs 失败", runsRes.detail));
    } else {
      const tableEl = renderOutsourceRunsTable(runs, profiles);
      runsSection.appendChild(tableEl);
    }
    wrap.appendChild(runsSection);

    return wrap;
  }

  // 异常终态：failed / cancelled / stale / aborted + 有 error 的
  const OUTSOURCE_NEEDS_ATTENTION_STATUSES = new Set(["failed", "cancelled", "stale", "aborted"]);

  function isLocalToday(iso) {
    if (!iso) return false;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return false;
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` === todayLocal();
  }

  function computeOutsourceCounts(runs) {
    const activeGroupIds = new Set();
    let needsAttention = 0;
    let running = 0;
    let doneToday = 0;
    let done = 0;
    let queued = 0;
    let failed = 0;

    for (const r of runs) {
      const status = r.status || "";
      // 活跃 group：至少有一个 queued/running 的 run
      if (r.groupId && (status === "queued" || status === "running")) {
        activeGroupIds.add(r.groupId);
      }
      if (status === "queued") queued++;
      else if (status === "running") running++;
      else if (status === "done") {
        done++;
        // 今日完成：finishedAt 或 updatedAt 在今天
        const ref = r.finishedAt || r.updatedAt || r.createdAt;
        if (isLocalToday(ref)) doneToday++;
      }
      if (OUTSOURCE_NEEDS_ATTENTION_STATUSES.has(status) || r.error) {
        needsAttention++;
      }
      if (status === "failed") failed++;
    }
    return {
      activeGroups: activeGroupIds.size,
      needsAttention,
      running,
      queued,
      done,
      doneToday,
      failed,
      total: runs.length,
    };
  }

  function renderOutsourceKpis(profiles, counts) {
    const section = el("section", { class: "section kpi-row kpi-row--outsource" });
    // 可用 Profiles
    section.appendChild(kpiCard("可用 Profiles", String(profiles.length), "外包团队配置数"));
    // 正在运行（queued + running）
    section.appendChild(kpiCard("正在运行", String(counts.running + counts.queued), `运行 ${counts.running} · 排队 ${counts.queued}`));
    // 今日完成
    section.appendChild(kpiCard("今日完成", String(counts.doneToday), `本地时区 ${todayLocal()}`));
    // 需关注（failed/cancelled/stale/aborted/error）
    section.appendChild(kpiCard("需关注", String(counts.needsAttention), "异常终态 + error"));
    return section;
  }

  function renderOutsourceProfileCard(p) {
    const tools = Array.isArray(p.tools) && p.tools.length ? p.tools.join(", ") : "-";
    const skillsList = Array.isArray(p.skills) && p.skills.length ? p.skills.join(", ") : (p.skills ? "yes" : "no");
    const card = el("article", {
      class: "profile-card profile-card--clickable",
      tabindex: "0",
      "data-profile-name": p.name || "",
      role: "button",
      "aria-label": `查看外包 profile ${p.name}`,
    }, [
      el("header", { class: "profile-card__head" }, [
        el("span", { class: "profile-card__name" }, p.name || "?"),
        el("span", { class: "profile-card__backend" }, p.backend || "?"),
      ]),
      el("div", { class: "profile-card__meta" }, [
        el("div", { class: "profile-card__meta-row" }, [
          el("span", { class: "profile-card__meta-key" }, "model"),
          el("span", { class: "profile-card__meta-val mono" }, p.model || "-"),
        ]),
        el("div", { class: "profile-card__meta-row" }, [
          el("span", { class: "profile-card__meta-key" }, "thinking"),
          el("span", { class: "profile-card__meta-val mono" }, p.thinking || "-"),
        ]),
        el("div", { class: "profile-card__meta-row" }, [
          el("span", { class: "profile-card__meta-key" }, "tools"),
          el("span", { class: "profile-card__meta-val" }, tools),
        ]),
        el("div", { class: "profile-card__meta-row" }, [
          el("span", { class: "profile-card__meta-key" }, "skills"),
          el("span", { class: "profile-card__meta-val" }, skillsList),
        ]),
        el("div", { class: "profile-card__meta-row" }, [
          el("span", { class: "profile-card__meta-key" }, "defaultWait"),
          el("span", { class: "profile-card__meta-val mono" }, p.defaultWait ? "yes" : "no"),
        ]),
        el("div", { class: "profile-card__meta-row" }, [
          el("span", { class: "profile-card__meta-key" }, "timeout"),
          el("span", { class: "profile-card__meta-val mono" }, Number(p.timeoutMs) > 0 ? fmtDurationMs(p.timeoutMs) : "不超时"),
        ]),
      ]),
      p.description ? el("p", { class: "profile-card__desc" }, p.description) : null,
      el("div", { class: "profile-card__hint muted" }, "点击查看详情 →"),
    ]);
    card.addEventListener("click", () => openOutsourceProfileDrawer(p.name));
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openOutsourceProfileDrawer(p.name); } });
    return card;
  }

  async function openOutsourceProfileDrawer(name) {
    const [profRes, runsRes] = await Promise.all([
      api(`/api/outsource/profiles/${encodeURIComponent(name)}`),
      api(`/api/outsource/runs?profile=${encodeURIComponent(name)}&limit=10`),
    ]);
    if (!profRes.ok) { toast("加载 profile 失败: " + (profRes.detail || ""), "error"); return; }
    const p = profRes.data || {};
    const recentRuns = runsRes.ok ? (runsRes.data?.runs || []) : [];
    const tools = Array.isArray(p.tools) && p.tools.length ? p.tools.join(", ") : "-";
    const skillsList = Array.isArray(p.skills) && p.skills.length ? p.skills.join(", ") : (p.skills ? "yes" : "no");

    // 优先清晰展示的字段：name / backend / model / thinking / tools / skills / defaultWait / timeout / maxTurns / description
    const body = el("div", { class: "outsource-run outsource-run--profile" }, [
      el("header", { class: "outsource-run__head" }, [
        el("div", { class: "outsource-run__head-main" }, [
          el("h2", { class: "outsource-run__title" }, p.name || name),
          el("span", { class: "profile-card__backend" }, p.backend || "?"),
        ]),
      ]),
      el("dl", { class: "outsource-run__meta outsource-run__meta--profile" }, [
        el("dt", {}, "model"),        el("dd", { class: "mono" }, p.model || "-"),
        el("dt", {}, "thinking"),     el("dd", { class: "mono" }, p.thinking || "-"),
        el("dt", {}, "tools"),        el("dd", {}, tools),
        el("dt", {}, "skills"),       el("dd", {}, skillsList),
        el("dt", {}, "defaultWait"),  el("dd", { class: "mono" }, p.defaultWait ? "yes" : "no"),
        el("dt", {}, "timeout"),      el("dd", { class: "mono" }, Number(p.timeoutMs) > 0 ? fmtDurationMs(p.timeoutMs) : "不超时"),
        el("dt", {}, "maxTurns"),     el("dd", { class: "mono" }, p.maxTurns != null ? String(p.maxTurns) : "-"),
        p.createdAt ? el("dt", {}, "createdAt") : null,
        p.createdAt ? el("dd", { class: "mono" }, p.createdAt) : null,
        p.updatedAt ? el("dt", {}, "updatedAt") : null,
        p.updatedAt ? el("dd", { class: "mono" }, p.updatedAt) : null,
      ].filter(Boolean)),
      p.description ? el("section", { class: "outsource-run__desc-section" }, [
        cardHead("描述", null),
        el("p", { class: "outsource-run__desc" }, p.description),
      ]) : null,
      el("section", { class: "outsource-run__recent" }, [
        cardHead(`最近 ${recentRuns.length} 条 Run`, "点击查看 run 详情与消息流"),
        recentRuns.length === 0
          ? emptyState("该 profile 暂无 run")
          : el("table", { class: "runs-table runs-table--mini" }, [
              el("thead", {}, [el("tr", {}, [
                el("th", {}, "runId"), el("th", {}, "status"), el("th", {}, "耗时"), el("th", {}, "task"),
              ])]),
              el("tbody", {}, recentRuns.map((r) => el("tr", {
                class: "runs-row", "data-run-id": r.runId, tabindex: "0",
              }, [
                el("td", { class: "mono" }, r.runId || "-"),
                el("td", {}, statusPill(r.status)),
                el("td", { class: "mono" }, r.elapsedMs != null ? fmtDurationMs(r.elapsedMs) : "-"),
                el("td", { class: "runs-row__task" }, (r.taskPreview || r.summary || "-").slice(0, 80)),
              ]))),
            ]),
      ]),
    ].filter(Boolean));
    // 给 mini 表里的行绑事件
    body.querySelectorAll(".runs-row[data-run-id]").forEach((row) => {
      row.addEventListener("click", () => openOutsourceRunDrawer(row.dataset.runId));
      row.addEventListener("keydown", (e) => { if (e.key === "Enter") openOutsourceRunDrawer(row.dataset.runId); });
    });
    openDrawer(body, { eyebrow: "PROFILE", title: p.name || name });
  }

  function renderOutsourceRunsTable(runs, profiles) {
    const wrap = el("div", { class: "runs-section" });
    if (!runs.length) {
      wrap.appendChild(emptyState("暂无 run", "使用 factory_outsource_run 或 POST /api/outsource/runs 派活。"));
      return wrap;
    }
    const profileOptions = (profiles || []).map((p) => p.name).filter(Boolean);
    const filterBar = el("div", { class: "runs-filter" }, [
      el("input", {
        type: "search",
        id: "outsourceRunSearch",
        class: "input runs-filter__search",
        placeholder: "搜索 runId / requestedBy / task…",
      }),
      el("select", {
        id: "outsourceRunStatus",
        class: "input runs-filter__status",
      }, [
        el("option", { value: "" }, "全部状态"),
        ...["queued", "running", "done", "failed", "cancelled", "stale", "aborted"].map((s) =>
          el("option", { value: s }, STATUS_LABELS[s] || s)
        ),
      ]),
      el("select", {
        id: "outsourceRunProfile",
        class: "input runs-filter__profile",
      }, [
        el("option", { value: "" }, "全部 profile"),
        ...profileOptions.map((name) => el("option", { value: name }, name)),
      ]),
      el("span", { id: "outsourceRunCount", class: "runs-filter__count muted" }, `显示 ${runs.length} / ${runs.length} 条`),
    ]);
    filterBar.addEventListener("input", filterOutsourceRuns);
    filterBar.addEventListener("change", filterOutsourceRuns);
    wrap.appendChild(filterBar);

    // 空状态提示（过滤后 0 条时显示）
    const emptyHint = el("div", { class: "runs-empty", hidden: true }, [
      emptyState("无匹配的执行记录", "试试调整搜索词或筛选条件。"),
    ]);
    wrap.appendChild(emptyHint);

    const tbl = el("table", { class: "runs-table", id: "outsource__table" });
    tbl.appendChild(el("thead", {}, [
      el("tr", {}, [
        el("th", {}, "状态"),
        el("th", {}, "Profile"),
        el("th", {}, "派活方"),
        el("th", {}, "耗时"),
        el("th", {}, "任务长度"),
        el("th", {}, "任务 / 摘要"),
        el("th", {}, "更新"),
      ]),
    ]));
    const tbody = el("tbody");
    for (const r of runs) {
      const tr = el("tr", {
        class: "runs-row",
        "data-run-id": r.runId || "",
        "data-profile": r.profile || "",
        "data-status": r.status || "",
        "data-search-blob": [r.runId, r.groupId, r.requestedBy, r.taskPreview, r.summary, r.project, r.profile].filter(Boolean).join(" ").toLowerCase(),
        tabindex: "0",
        title: `runId: ${r.runId || "-"}${r.groupId ? " · group: " + r.groupId : ""}${r.project ? " · project: " + r.project : ""}`,
      });
      tr.appendChild(el("td", { class: "runs-row__status" }, statusPill(r.status)));
      tr.appendChild(el("td", { class: "runs-row__profile" }, r.profile || "-"));
      tr.appendChild(el("td", { class: "runs-row__requester" }, r.requestedBy || "-"));
      tr.appendChild(el("td", { class: "mono runs-row__elapsed" }, r.elapsedMs != null ? fmtDurationMs(r.elapsedMs) : "-"));
      tr.appendChild(el("td", { class: "mono outsource-run__task-length", title: "原始任务字符数" }, fmtTaskLength(r.taskLength)));
      const taskText = (r.taskPreview || r.summary || r.error || "(无任务描述)").slice(0, 140);
      tr.appendChild(el("td", { class: "runs-row__task" }, taskText));
      tr.appendChild(el("td", { class: "runs-row__time muted mono" }, fmtRelative(r.updatedAt || r.finishedAt || r.startedAt || r.createdAt)));
      tr.addEventListener("click", () => openOutsourceRunDrawer(r.runId));
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") openOutsourceRunDrawer(r.runId); });
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    return wrap;
  }

  function filterOutsourceRuns() {
    const q = String($("#outsourceRunSearch")?.value || "").trim().toLowerCase();
    const status = String($("#outsourceRunStatus")?.value || "");
    const profile = String($("#outsourceRunProfile")?.value || "");
    const rows = $$("#outsource__table .runs-row");
    let visible = 0;
    for (const row of rows) {
      const blob = row.dataset.searchBlob || "";
      const matchQ = !q || blob.includes(q);
      const matchStatus = !status || row.dataset.status === status;
      const matchProfile = !profile || row.dataset.profile === profile;
      const show = matchQ && matchStatus && matchProfile;
      row.hidden = !show;
      if (show) visible++;
    }
    const count = $("#outsourceRunCount");
    if (count) count.textContent = `显示 ${visible} / ${rows.length} 条`;
    // 过滤后 0 条时显示空状态提示，隐藏表格
    const table = $("#outsource__table");
    const emptyHint = $(".runs-empty");
    if (table) table.style.display = visible === 0 ? "none" : "";
    if (emptyHint) emptyHint.hidden = visible !== 0;
  }

  // ---- 外包 Run 抽屉：消息流阅读体验 ----
  async function openOutsourceRunDrawer(runId) {
    const res = await api(`/api/outsource/runs/${encodeURIComponent(runId)}`);
    if (!res.ok) { toast("加载 run 失败: " + (res.detail || ""), "error"); return; }
    const run = res.data || {};
    const events = Array.isArray(run.events) ? run.events : [];

    // 元信息区
    const metaRows = [];
    if (run.profile) metaRows.push(["profile", el("span", { class: "mono" }, run.profile)]);
    if (run.groupId) metaRows.push(["groupId", el("span", { class: "mono" }, run.groupId)]);
    if (run.requestedBy) metaRows.push(["requestedBy", el("span", {}, run.requestedBy)]);
    if (run.project) metaRows.push(["project", el("span", {}, run.project)]);
    if (run.model) metaRows.push(["model", el("span", { class: "mono" }, run.model)]);
    if (run.createdAt) metaRows.push(["createdAt", el("span", { class: "mono" }, run.createdAt)]);
    if (run.startedAt) metaRows.push(["startedAt", el("span", { class: "mono" }, run.startedAt)]);
    if (run.finishedAt) metaRows.push(["finishedAt", el("span", { class: "mono" }, run.finishedAt)]);
    if (run.elapsedMs != null) metaRows.push(["elapsed", el("span", { class: "mono" }, fmtDurationMs(run.elapsedMs))]);
    if (run.taskLength != null) metaRows.push(["任务长度", el("span", { class: "mono outsource-run__task-length" }, fmtTaskLength(run.taskLength))]);
    if (run.jobId) metaRows.push(["jobId", el("span", { class: "mono" }, run.jobId)]);

    const metaDl = el("dl", { class: "outsource-run__meta" });
    for (const [dt, dd] of metaRows) {
      metaDl.appendChild(el("dt", {}, dt));
      metaDl.appendChild(el("dd", {}, dd));
    }

    // 构建消息流
    const messageFlow = buildOutsourceMessageFlow(run, events);

    // 技术事件折叠区（thinking + 原始 events）
    const techSection = buildOutsourceTechSection(run, events);

    // Error 区
    let errorSection = null;
    if (run.error) {
      errorSection = el("section", { class: "outsource-run__error-section" }, [
        cardHead("错误", null),
        el("pre", { class: "outsource-run__error" }, run.error),
      ]);
    }

    // Usage 折叠
    let usageSection = null;
    if (run.usage) {
      usageSection = el("details", { class: "outsource-run__usage" }, [
        el("summary", { class: "outsource-run__usage-summary" }, "Token 使用情况"),
        el("pre", { class: "outsource-run__usage-body mono" }, JSON.stringify(run.usage, null, 2)),
      ]);
    }

    const body = el("div", { class: "outsource-run outsource-run--detail" }, [
      el("header", { class: "outsource-run__head" }, [
        el("div", { class: "outsource-run__head-main" }, [
          el("h2", { class: "outsource-run__title" }, run.runId || "-"),
          statusPill(run.status),
        ]),
      ]),
      metaDl,
      messageFlow,
      errorSection,
      techSection,
      usageSection,
    ].filter(Boolean));

    openDrawer(body, { eyebrow: "RUN", title: run.runId || runId });
  }

  // 构建消息流：task 作为派活方消息，连续 text chunk 聚合成外包回复，tool 调用独立卡片
  function buildOutsourceMessageFlow(run, events) {
    const container = el("div", { class: "outsource-msgflow" });

    // 1) 派活方消息（task）
    if (run.task) {
      const taskCard = el("div", { class: "outsource-msg outsource-msg--task" }, [
        el("div", { class: "outsource-msg__head" }, [
          el("span", { class: "outsource-msg__role" }, run.requestedBy || "派活方"),
          el("span", { class: "outsource-msg__tag" }, "任务"),
          run.createdAt ? el("span", { class: "outsource-msg__time muted mono" }, fmtTime(run.createdAt)) : null,
        ]),
        el("div", { class: "outsource-msg__body" }, [mdNode(run.task)]),
      ]);
      container.appendChild(taskCard);
    }

    // 2) 完成时优先展示 fullOutput，否则 summary/result fallback
    const finalOutput = run.fullOutput || run.summary || (run.result && typeof run.result === "string" ? run.result : null);
    const hasFinalOutput = finalOutput && String(finalOutput).trim().length > 0;

    // 3) 从 events 中提取外包回复（聚合连续 text）和工具调用
    const { replyBlocks, toolCalls } = parseOutsourceEvents(events);

    // 如果有 finalOutput，用它作为最终回复（不重复展示 events 里的 text 碎片）
    if (hasFinalOutput) {
      const replyCard = el("div", { class: "outsource-msg outsource-msg--reply" }, [
        el("div", { class: "outsource-msg__head" }, [
          el("span", { class: "outsource-msg__role" }, run.profile || "外包"),
          el("span", { class: "outsource-msg__tag outsource-msg__tag--done" }, "完成"),
          run.finishedAt ? el("span", { class: "outsource-msg__time muted mono" }, fmtTime(run.finishedAt)) : null,
        ]),
        el("div", { class: "outsource-msg__body" }, [mdNode(finalOutput)]),
      ]);
      container.appendChild(replyCard);
    } else if (replyBlocks.length > 0) {
      for (const block of replyBlocks) {
        const replyCard = el("div", { class: "outsource-msg outsource-msg--reply" }, [
          el("div", { class: "outsource-msg__head" }, [
            el("span", { class: "outsource-msg__role" }, run.profile || "外包"),
            el("span", { class: "outsource-msg__tag" }, "回复"),
            block.time ? el("span", { class: "outsource-msg__time muted mono" }, fmtTime(block.time)) : null,
          ]),
          el("div", { class: "outsource-msg__body" }, [mdNode(block.text)]),
        ]);
        container.appendChild(replyCard);
      }
    } else if (run.status === "running" || run.status === "queued") {
      // 运行中但还没有 text 输出
      const pendingCard = el("div", { class: "outsource-msg outsource-msg--pending" }, [
        el("div", { class: "outsource-msg__body" }, [
          el("span", { class: "outsource-msg__pending-dot" }, "●"),
          el("span", { class: "muted" }, run.status === "queued" ? "等待执行…" : "执行中，等待输出…"),
        ]),
      ]);
      container.appendChild(pendingCard);
    }

    // 4) 工具调用卡片（如果有 finalOutput 且工具调用在 events 里，仍展示工具调用但放进技术区折叠）
    if (toolCalls.length > 0 && !hasFinalOutput) {
      for (const tc of toolCalls) {
        container.appendChild(buildToolCallCard(tc));
      }
    }

    // 如果容器为空（没有 task 也没有 events），给一个提示
    if (!container.children.length) {
      container.appendChild(el("div", { class: "muted" }, "暂无消息内容。"));
    }

    return el("section", { class: "outsource-run__messages" }, [
      cardHead("任务消息", "像消息流一样阅读派活与外包回复"),
      container,
    ]);
  }

  // 解析 events：聚合连续 text chunk，提取工具调用
  function parseOutsourceEvents(events) {
    const replyBlocks = [];
    const toolCalls = [];
    let currentText = null;
    let currentTool = null;

    const flushText = () => {
      if (currentText && currentText.text.trim()) {
        replyBlocks.push(currentText);
      }
      currentText = null;
    };
    const flushTool = () => {
      if (currentTool && (currentTool.input || currentTool.output || currentTool.name)) {
        toolCalls.push(currentTool);
      }
      currentTool = null;
    };

    for (const ev of events || []) {
      const streamType = ev.streamType || ev.type || "";
      const time = ev.createdAt || ev.time || ev.timestamp;

      if (streamType === "text" || (streamType === "" && ev.text && !ev.toolName)) {
        // 连续 text 聚合
        const chunk = ev.text || ev.content || ev.message || "";
        if (!chunk) continue;
        if (currentText) {
          currentText.text += chunk;
          currentText.time = time || currentText.time;
        } else {
          currentText = { text: chunk, time };
        }
      } else if (streamType === "tool_start" || streamType === "tool_call" || ev.type === "tool_start") {
        flushText();
        if (currentTool) flushTool();
        currentTool = {
          name: ev.toolName || ev.name || ev.tool || "?",
          input: ev.input || ev.args || ev.text || "",
          output: "",
          status: "running",
          time,
        };
      } else if (streamType === "tool_output" || ev.type === "tool_output") {
        if (currentTool) {
          currentTool.output += (ev.output || ev.text || ev.content || "");
          currentTool.time = time || currentTool.time;
        }
      } else if (streamType === "tool_end" || ev.type === "tool_end") {
        if (currentTool) {
          currentTool.status = (ev.error || ev.isError) ? "error" : "done";
          if (ev.output && !currentTool.output) currentTool.output = ev.output;
          currentTool.time = time || currentTool.time;
          flushTool();
        }
      } else if (streamType === "thinking" || ev.type === "thinking") {
        // thinking 不放进消息流，放进技术事件区
        flushText();
      }
      // 其他事件类型忽略（done / error / started 等状态事件）
    }
    flushText();
    if (currentTool) flushTool();

    return { replyBlocks, toolCalls };
  }

  // 工具调用卡片
  function buildToolCallCard(tc) {
    const statusClass = tc.status === "error" ? "tool-call--error" : tc.status === "running" ? "tool-call--running" : "";
    const card = el("div", { class: `tool-call ${statusClass}` }, [
      el("div", { class: "tool-call__head" }, [
        el("span", { class: "tool-call__icon" }, tc.status === "error" ? "⚠" : "⚙"),
        el("span", { class: "tool-call__name mono" }, tc.name),
        el("span", { class: `tool-call__status pill pill--${tc.status === "error" ? "failed" : tc.status === "running" ? "running" : "done"}` },
          tc.status === "error" ? "失败" : tc.status === "running" ? "执行中" : "完成"
        ),
      ]),
    ]);
    if (tc.input) {
      const inputDetails = el("details", { class: "tool-call__input" }, [
        el("summary", {}, "输入"),
        el("pre", { class: "tool-call__pre" }, typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input, null, 2)),
      ]);
      card.appendChild(inputDetails);
    }
    if (tc.output) {
      const outputDetails = el("details", { class: "tool-call__output" }, [
        el("summary", {}, "输出"),
        el("pre", { class: "tool-call__pre" }, typeof tc.output === "string" ? tc.output : JSON.stringify(tc.output, null, 2)),
      ]);
      card.appendChild(outputDetails);
    }
    return card;
  }

  // 构建技术事件折叠区（thinking + 原始 events 列表 + 工具调用详情）
  function buildOutsourceTechSection(run, events) {
    const thinkingEvents = (events || []).filter((e) =>
      (e.streamType === "thinking" || e.type === "thinking") && (e.text || e.content || e.message)
    );
    const { toolCalls } = parseOutsourceEvents(events);
    const hasFinalOutput = run.fullOutput || run.summary;

    // 如果有 finalOutput，工具调用放这里；否则放消息流里
    const showToolsHere = hasFinalOutput && toolCalls.length > 0;
    const showThinking = thinkingEvents.length > 0;
    const showRawEvents = (events || []).length > 0 && (showThinking || toolCalls.length > 0);

    if (!showThinking && !showToolsHere && !showRawEvents) return null;

    const details = el("details", { class: "outsource-tech" });
    const summary = el("summary", { class: "outsource-tech__summary" }, [
      el("span", { class: "outsource-tech__icon" }, "⚙"),
      el("span", {}, "推理过程 / 技术事件"),
      el("span", { class: "outsource-tech__count muted" }, `(${(events || []).length} 条事件)`),
    ]);
    details.appendChild(summary);

    const body = el("div", { class: "outsource-tech__body" });

    // Thinking 聚合
    if (showThinking) {
      let thinkingText = "";
      for (const t of thinkingEvents) {
        thinkingText += (t.text || t.content || t.message || "") + "\n";
      }
      const thinkingLimit = 50_000;
      const thinkingTruncated = thinkingText.length > thinkingLimit;
      if (thinkingTruncated) thinkingText = thinkingText.slice(-thinkingLimit);
      body.appendChild(el("div", { class: "outsource-tech__block" }, [
        el("div", { class: "outsource-tech__label" }, "推理过程 (thinking)"),
        thinkingTruncated
          ? el("p", { class: "outsource-tech__notice" }, `内容较长，仅展示最后 ${thinkingLimit.toLocaleString()} 个字符。`)
          : null,
        el("pre", { class: "outsource-tech__pre" }, thinkingText.trim() || "(空)"),
      ]));
    }

    // 工具调用（当有 finalOutput 时放这里）
    if (showToolsHere) {
      const toolsWrap = el("div", { class: "outsource-tech__block" }, [
        el("div", { class: "outsource-tech__label" }, `工具调用 (${toolCalls.length})`),
      ]);
      for (const tc of toolCalls) {
        toolsWrap.appendChild(buildToolCallCard(tc));
      }
      body.appendChild(toolsWrap);
    }

    // 原始事件时间线（紧凑）
    if (showRawEvents) {
      const timelineWrap = el("div", { class: "outsource-tech__block" }, [
        el("div", { class: "outsource-tech__label" }, "原始事件流"),
      ]);
      const list = el("ol", { class: "outsource-tech__timeline" });
      const eventLimit = 200;
      const visibleEvents = (events || []).slice(-eventLimit);
      if ((events || []).length > eventLimit) {
        timelineWrap.appendChild(el("p", { class: "outsource-tech__notice" }, `事件较多，仅展示最后 ${eventLimit} 条。`));
      }
      for (const ev of visibleEvents) {
        const evType = ev.streamType || ev.type || "event";
        const evText = ev.text || ev.message || ev.summary || ev.error || (ev.toolName ? ev.toolName : "") || "";
        const evTime = ev.createdAt || ev.time || ev.timestamp || "";
        list.appendChild(el("li", { class: `outsource-tech__event outsource-tech__event--${evType}` }, [
          el("span", { class: "outsource-tech__event-type mono" }, evType),
          evTime ? el("span", { class: "outsource-tech__event-time muted mono" }, fmtTime(evTime)) : null,
          el("span", { class: "outsource-tech__event-text" }, String(evText).slice(0, 200)),
        ]));
      }
      timelineWrap.appendChild(list);
      body.appendChild(timelineWrap);
    }

    // result JSON（如果有且不是字符串）
    if (run.result && typeof run.result === "object") {
      body.appendChild(el("div", { class: "outsource-tech__block" }, [
        el("div", { class: "outsource-tech__label" }, "Result (JSON)"),
        el("pre", { class: "outsource-tech__pre" }, JSON.stringify(run.result, null, 2)),
      ]));
    }

    details.appendChild(body);
    return el("section", { class: "outsource-run__tech" }, [details]);
  }

  // ---- 通用抽屉打开函数 ----
  function openDrawer(contentNode, opts = {}) {
    const drawer = $("#drawer");
    if (!drawer) return;
    const eyebrow = opts.eyebrow || "DETAIL";
    const title = opts.title || "详情";
    $("#drawerEyebrow").textContent = eyebrow;
    $("#drawerTitle").textContent = title;
    const bodyEl = $("#drawerBody");
    bodyEl.innerHTML = "";
    bodyEl.appendChild(contentNode);
    drawer.classList.add(DRAWER_OPEN_CLASS);
    drawer.setAttribute("aria-hidden", "false");
  }

  function renderWorkers(workers) {
    const main = $("#main");
    main.innerHTML = "";
    const wrap = el("div", { class: "page page--workers" });

    if (!workers.length) {
      wrap.appendChild(el("section", { class: "section" }, [
        sectionHead("员工看板", "谁在干活、token、最近活动"),
        emptyState("暂无员工", "可以让主 agent 招聘，或等待员工上线。"),
      ]));
      main.appendChild(wrap);
      return;
    }

    // 初次渲染时，根据当前 URL 选中的 worker 高亮 active card
    const initialWorker = decodeURIComponent((location.hash.split("?")[0].split("/")[2] || ""));

    // 已结束未读优先，其次执行中，再按最近交互排序。
    const sortedWorkers = [...workers].sort((a, b) => {
      const rank = (w) => w.finishedUnreadJobs > 0 ? 2 : w.activeJobs > 0 ? 1 : 0;
      if (rank(a) !== rank(b)) return rank(b) - rank(a);
      const la = a.lastInteractionAt ? new Date(a.lastInteractionAt).getTime() : 0;
      const lb = b.lastInteractionAt ? new Date(b.lastInteractionAt).getTime() : 0;
      if (lb !== la) return lb - la;
      return (a.name || "").localeCompare(b.name || "", "zh-Hans-CN");
    });

    const split = el("section", { class: "workers" }, [
      el("aside", { class: "workers__list" }, [
        el("div", { class: "workers__search" }, [
          el("input", {
            class: "input workers__search-input",
            type: "search",
            id: "workerSearch",
            placeholder: "搜索员工名（中文/英文）…",
            oninput: (e) => scheduleWorkerCardsFilter(e.target.value),
            onkeydown: (e) => {
              if (e.key === "Escape") {
                e.target.value = "";
                if (workerSearchDebounceTimer) clearTimeout(workerSearchDebounceTimer);
                workerSearchDebounceTimer = null;
                filterWorkerCards("");
              }
            },
          }),
          el("span", { class: "muted workers__search-count", id: "workerSearchCount" }),
        ]),
        ...sortedWorkers.map((w) => {
          const unread = Number(w.finishedUnreadJobs || 0);
          const hasUnread = unread > 0;
          const status = w.status || "idle";
          return el("a", {
            class: `worker-card${status === "vacation" ? " worker-card--vacation" : ""}${w.name === initialWorker ? " worker-card--active" : ""}${hasUnread ? " worker-card--unread" : ""}`,
            href: `#/workers/${encodeURIComponent(w.name)}`,
            data: { name: w.name, role: w.role || "", model: w.model || "", unread, activeJobs: w.activeJobs || 0, lastInteractionAt: w.lastInteractionAt || "" },
            onclick: (e) => {
              e.preventDefault();
              navigateToWorker(w.name);
            },
          }, [
            workerAvatarNode(w),
            el("div", { class: "worker-card__body" }, [
              el("div", { class: "worker-card__headline" }, [
                el("span", { class: "worker-card__name", text: w.name }),
                el("span", { class: `worker-card__status-dot dot dot--${w.activeJobs > 0 ? "busy" : status || "idle"}`, title: status || "idle" }),
                status === "vacation" ? el("span", { class: "worker-card__vacation-badge", text: "休假" }) : null,
              ]),
              workerCardTalkPreviewNode(w),
            ]),
            el("div", { class: "worker-card__aside" }, [
              hasUnread ? el("span", {
                class: "worker-card__badge worker-card__badge--unread",
                text: unread > 99 ? "99+" : String(unread),
                title: unreadBadgeTitle(w),
              }) : null,
            ]),
          ]);
        }),
      ]),
      el("div", { class: "workers__detail", id: "workerDetail" }, [
        emptyState("选择左侧员工查看详情"),
      ]),
    ]);
    wrap.appendChild(split);
    main.appendChild(wrap);
    // 初始化搜索计数
    queueMicrotask(() => filterWorkerCards(""));
  }

  function talkAttachmentUrl(attachment) {
    if (attachment?.contentUrl) return attachment.contentUrl;
    if (!attachment?.id) return "";
    return `/api/talk-attachments/${encodeURIComponent(attachment.id)}/content`;
  }

  function formatTalkAttachmentSize(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }

  function escapeTalkMentionRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function talkMessageHasMention(message, token) {
    return new RegExp(`${escapeTalkMentionRegex(token)}(?!\\d)`, "u").test(String(message || ""));
  }

  function findTalkImageMentionTrigger(value, cursor) {
    const text = String(value || "");
    const end = Math.max(0, Math.min(Number(cursor) || 0, text.length));
    const before = text.slice(0, end);
    const match = /(^|[\s([{（])@([^\s@]*)$/u.exec(before);
    if (!match) return null;
    return {
      start: before.length - match[0].length + match[1].length,
      end,
      query: match[2] || "",
    };
  }

  function talkMessageNode(message, attachmentMentions = [], attachments = [], { compact = true } = {}) {
    const wrap = el("div", { class: compact ? "talk-list__task talk-message" : "prose talk-message" });
    const text = String(message || "");
    const attachmentById = new Map((attachments || []).map((attachment) => [attachment.id, attachment]));
    const mentionByToken = new Map((attachmentMentions || []).map((mention) => [mention.token, mention]));
    const tokens = [...mentionByToken.keys()].sort((a, b) => b.length - a.length);
    if (!tokens.length) {
      wrap.textContent = text;
      return wrap;
    }
    const matcher = new RegExp(`(${tokens.map(escapeTalkMentionRegex).join("|")})(?!\\d)`, "gu");
    let cursor = 0;
    for (const match of text.matchAll(matcher)) {
      if (match.index > cursor) wrap.appendChild(document.createTextNode(text.slice(cursor, match.index)));
      const mention = mentionByToken.get(match[0]);
      const attachment = attachmentById.get(mention?.attachmentId);
      if (attachment) {
        wrap.appendChild(el("a", {
          class: "talk-inline-mention",
          href: talkAttachmentUrl(attachment),
          target: "_blank",
          rel: "noreferrer",
          text: match[0],
          title: `${match[0]} · ${attachment.name || "图片"}`,
        }));
      } else {
        wrap.appendChild(document.createTextNode(match[0]));
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) wrap.appendChild(document.createTextNode(text.slice(cursor)));
    return wrap;
  }

  function talkAttachmentNodes(attachments = [], { preview = false, onRemove, onMention } = {}) {
    if (!Array.isArray(attachments) || attachments.length === 0) return null;
    return el("div", {
      class: `talk-attachments${preview ? " talk-panel__attachment-preview" : ""}`,
    }, attachments.map((attachment, index) => {
      const src = preview ? attachment.previewUrl : talkAttachmentUrl(attachment);
      return el("figure", { class: "talk-attachment" }, [
        src ? el("a", {
          class: "talk-attachment__link",
          href: src,
          target: "_blank",
          rel: "noreferrer",
          title: attachment.name || "查看图片",
        }, [
          el("img", {
            class: "talk-attachment__image",
            src,
            alt: attachment.name || "对话图片",
            loading: preview ? "eager" : "lazy",
          }),
        ]) : null,
        el("figcaption", { class: "talk-attachment__caption" }, [
          preview && attachment.mentionToken && onMention ? el("button", {
            class: "talk-attachment__mention",
            type: "button",
            text: attachment.mentionToken,
            title: `在光标处引用 ${attachment.name || "图片"}`,
            onclick: () => onMention(index),
          }) : null,
          el("span", { class: "talk-attachment__name", text: attachment.name || `图片 ${index + 1}` }),
          attachment.size != null ? el("span", { class: "talk-attachment__size", text: formatTalkAttachmentSize(attachment.size) }) : null,
        ]),
        preview && onRemove ? el("button", {
          class: "talk-attachment__remove",
          type: "button",
          text: "×",
          title: "移除图片",
          "aria-label": `移除 ${attachment.name || `图片 ${index + 1}`}`,
          onclick: () => onRemove(index),
        }) : null,
      ]);
    }));
  }

// 和 TA 对话 · Web 版 /talk 员工名
  // 后端走 web-talk 流程：POST /api/talk → createWebTalkRequest (pending)，
  // Pi 主进程接管后转为 accepted (创建 talk job)、done / failed / cancelled。
  // 前端轮询 /api/talk-requests/:id 看状态；点开抽屉默认会调 /api/jobs/:id (后端会标已读)。
  function buildTalkPanel(worker, d, initialJobs = []) {
    STATE.talkMode = STATE.talkMode || "auto";
    const card = el("div", { class: "card talk-panel" });
    const head = el("div", { class: "card__head" });
    head.appendChild(el("h3", { class: "card__title", text: `和 ${worker} 对话` }));
    head.appendChild(el("p", { class: "card__sub", text: "Web 版 /talk · 提交 web-talk 请求，Pi 主进程接管后走正常 talk 调度。", }));
    card.appendChild(head);

    // 状态条：员工元信息 + 未读气泡
    const status = d.status || "idle";
    const metaChildren = [
      el("span", { class: `tag tag--${status === "busy" ? "main" : "soft"}`, text: `状态：${status}` }),
      d.backend ? el("span", { class: "tag tag--soft", text: `backend: ${d.backend}` }) : null,
      d.model ? el("span", { class: "tag tag--soft", text: `model: ${d.model}` }) : null,
      d.thinking ? el("span", { class: "tag tag--soft", text: `thinking: ${d.thinking}` }) : null,
    ];
    if (d.unreadCount && d.unreadCount > 0) {
      metaChildren.push(el("span", { class: "talk-panel__badge", text: `${d.unreadCount} 条未读` }));
    }
    const unreadSnapshot = d.unreadBeforeOpen || {};
    const unreadSnapshotTotal = Number(unreadSnapshot.total || 0);
    if (unreadSnapshotTotal > 0) {
      metaChildren.push(el("span", {
        class: "talk-panel__badge talk-panel__badge--snapshot",
        text: `本次打开前 ${unreadSnapshotTotal} 项未读`,
        title: `消息 ${Number(unreadSnapshot.messages || 0)} · job ${Number(unreadSnapshot.jobUpdates || 0)} · event ${Number(unreadSnapshot.jobEvents || 0)}`,
      }));
    }
    card.appendChild(el("div", { class: "talk-panel__meta" }, metaChildren));

    // 输入区
    const pendingImages = [];
    let nextImageMentionNumber = 1;
    let mentionMenuActiveIndex = 0;
    let mentionMenuOptions = [];
    const backend = String(d.backend || "pi").toLowerCase();
    const supportsImages = backend === "pi" || backend === "codex";
    const textarea = el("textarea", {
      class: "input talk-panel__input",
      id: `talkInput-${worker}`,
      placeholder: `输入要发送给 ${worker} 的消息…（Ctrl+Enter 发送）`,
      rows: 4,
    });
    const imageInput = el("input", {
      class: "talk-panel__file-input",
      type: "file",
      accept: "image/png,image/jpeg,image/webp,image/gif",
      multiple: "multiple",
      tabindex: "-1",
      "aria-hidden": "true",
    });
    const mentionMenu = el("div", {
      class: "talk-panel__mention-menu",
      role: "listbox",
      hidden: "hidden",
    });
    const attachBtn = el("button", {
      class: "btn btn--ghost talk-panel__attach",
      type: "button",
      text: "＋ 图片",
      disabled: !supportsImages,
      title: supportsImages ? "选择图片，也可以直接粘贴到输入框" : `${backend} 后端暂不支持图片输入`,
      onclick: () => imageInput.click(),
    });
    const attachmentPreview = el("div", {
      class: "talk-panel__attachment-preview-wrap",
      hidden: "hidden",
    });
    const sendBtn = el("button", {
      class: "btn btn--primary",
      id: `talkSendBtn-${worker}`,
      type: "button",
      text: "发送",
      disabled: false,
    });
    const modeSel = el("select", {
      class: "input talk-panel__mode",
      id: `talkMode-${worker}`,
      onchange: (e) => { STATE.talkMode = e.target.value; },
    }, [
      el("option", { value: "auto",  text: "自动 (auto)",  ...(STATE.talkMode === "auto"  ? { selected: "selected" } : {}) }),
      el("option", { value: "queue", text: "排队 (queue)", ...(STATE.talkMode === "queue" ? { selected: "selected" } : {}) }),
      el("option", { value: "steer", text: "插队 (steer)", ...(STATE.talkMode === "steer" ? { selected: "selected" } : {}) }),
    ]);
    const hintText = supportsImages
      ? "**图片** 支持选择或粘贴；输入 **@** 可引用已上传图片的位置（最多 6 张、每张 10 MiB） · **auto** 空闲马上起、忙碌排队 · **queue** 强制排队 · **steer** 优先插入 Codex active turn。"
      : `当前 **${backend}** 后端暂不支持图片 · **auto** 空闲马上起、忙碌排队 · **queue** 强制排队。`;
    const hint = el("p", { class: "muted talk-panel__hint", html: md(hintText, { compact: true, max: 320 }) });

    // 提示：API 调用状态
    const feedback = el("div", { class: "talk-panel__feedback", id: `talkFeedback-${worker}` });
    const sendRow = el("div", { class: "talk-panel__row" }, [
      el("div", { class: "talk-panel__compose" }, [textarea, imageInput, mentionMenu, attachmentPreview]),
      el("div", { class: "talk-panel__actions" }, [modeSel, attachBtn, sendBtn, feedback]),
    ]);
    card.appendChild(sendRow);
    card.appendChild(hint);

    // 历史 talk jobs（最近 20 条）
    const historyBox = el("div", { class: "talk-panel__history", id: `talkHistory-${worker}` }, [loadingText("加载中…")]);
    card.appendChild(historyBox);

    const showFeedbackError = (message) => {
      feedback.textContent = `❌ ${message}`;
      feedback.className = "talk-panel__feedback talk-panel__feedback--error";
    };

    const apiDetailMessage = (detail, fallback) => {
      if (typeof detail === "string") return detail;
      return detail?.error?.message || detail?.detail || fallback;
    };

    const hideMentionMenu = () => {
      mentionMenu.hidden = true;
      mentionMenu.innerHTML = "";
      mentionMenuOptions = [];
      mentionMenuActiveIndex = 0;
    };

    const insertImageMention = (item, trigger = findTalkImageMentionTrigger(textarea.value, textarea.selectionStart)) => {
      const start = trigger?.start ?? textarea.selectionStart ?? textarea.value.length;
      const end = trigger?.end ?? textarea.selectionEnd ?? start;
      const before = textarea.value.slice(0, start);
      const after = textarea.value.slice(end);
      const trailingSpace = after.startsWith(" ") ? "" : " ";
      textarea.value = `${before}${item.mentionToken}${trailingSpace}${after}`;
      const nextCursor = before.length + item.mentionToken.length + trailingSpace.length;
      textarea.setSelectionRange(nextCursor, nextCursor);
      textarea.focus();
      hideMentionMenu();
      feedback.textContent = `已引用 ${item.mentionToken} · ${item.name}`;
      feedback.className = "talk-panel__feedback";
    };

    const renderMentionMenu = () => {
      const trigger = findTalkImageMentionTrigger(textarea.value, textarea.selectionStart);
      if (!trigger) {
        hideMentionMenu();
        return;
      }
      const query = trigger.query.toLowerCase();
      mentionMenuOptions = pendingImages.filter((item) =>
        `${item.mentionToken} ${item.name}`.toLowerCase().includes(query),
      );
      mentionMenu.innerHTML = "";
      mentionMenu.hidden = false;
      if (!pendingImages.length) {
        mentionMenu.appendChild(el("div", { class: "talk-panel__mention-empty", text: "请先上传或粘贴图片" }));
        return;
      }
      if (!mentionMenuOptions.length) {
        mentionMenu.appendChild(el("div", { class: "talk-panel__mention-empty", text: "没有匹配的已上传图片" }));
        return;
      }
      mentionMenuActiveIndex = Math.min(mentionMenuActiveIndex, mentionMenuOptions.length - 1);
      mentionMenu.appendChild(el("div", {}, mentionMenuOptions.map((item, index) => el("button", {
        class: `talk-panel__mention-option${index === mentionMenuActiveIndex ? " is-active" : ""}`,
        type: "button",
        role: "option",
        "aria-selected": index === mentionMenuActiveIndex ? "true" : "false",
        onmousedown: (event) => {
          event.preventDefault();
          insertImageMention(item, trigger);
        },
      }, [
        el("img", { class: "talk-panel__mention-thumb", src: item.previewUrl, alt: "" }),
        el("span", { class: "talk-panel__mention-copy" }, [
          el("strong", { text: item.mentionToken }),
          el("span", { text: item.name }),
        ]),
      ]))));
    };

    const renderPendingImages = () => {
      attachmentPreview.innerHTML = "";
      attachmentPreview.hidden = pendingImages.length === 0;
      if (!pendingImages.length) return;
      attachmentPreview.appendChild(talkAttachmentNodes(pendingImages, {
        preview: true,
        onMention: (index) => insertImageMention(pendingImages[index], null),
        onRemove: (index) => {
          const [removed] = pendingImages.splice(index, 1);
          if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
          if (removed?.mentionToken) {
            textarea.value = textarea.value
              .replace(new RegExp(`${escapeTalkMentionRegex(removed.mentionToken)}(?!\\d)\\s?`, "gu"), "");
          }
          if (!pendingImages.length) nextImageMentionNumber = 1;
          renderPendingImages();
          renderMentionMenu();
        },
      }));
    };

    const addImageFiles = (files) => {
      if (!supportsImages) {
        showFeedbackError(`${backend} 后端暂不支持图片输入，请改用 Pi 或 Codex 员工`);
        return;
      }
      let error = "";
      for (const file of Array.from(files || [])) {
        if (!TALK_IMAGE_TYPES.has(file.type)) {
          error = "仅支持 PNG、JPEG、WebP、GIF 图片";
          continue;
        }
        if (file.size > TALK_IMAGE_MAX_BYTES) {
          error = `${file.name || "图片"} 超过 10 MiB`;
          continue;
        }
        if (pendingImages.length >= TALK_IMAGE_MAX_COUNT) {
          error = `每条消息最多 ${TALK_IMAGE_MAX_COUNT} 张图片`;
          break;
        }
        pendingImages.push({
          file,
          name: file.name || `粘贴图片-${pendingImages.length + 1}.png`,
          size: file.size,
          mimeType: file.type,
          mentionToken: `@图片${nextImageMentionNumber++}`,
          previewUrl: URL.createObjectURL(file),
          remote: null,
        });
      }
      renderPendingImages();
      if (error) showFeedbackError(error);
      else if (pendingImages.length) {
        feedback.textContent = `已添加 ${pendingImages.length} 张图片`;
        feedback.className = "talk-panel__feedback";
      }
      imageInput.value = "";
      renderMentionMenu();
    };

    imageInput.addEventListener("change", () => addImageFiles(imageInput.files));
    textarea.addEventListener("input", renderMentionMenu);
    textarea.addEventListener("click", renderMentionMenu);
    textarea.addEventListener("paste", (event) => {
      const files = Array.from(event.clipboardData?.items || [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (!files.length) return;
      if (!supportsImages) {
        addImageFiles(files);
        return;
      }
      event.preventDefault();
      addImageFiles(files);
    });

    const uploadPendingImages = async () => {
      for (let index = 0; index < pendingImages.length; index++) {
        const item = pendingImages[index];
        if (item.remote?.id) continue;
        feedback.textContent = `上传图片 ${index + 1}/${pendingImages.length}…`;
        const upload = await api(`/api/talk-attachments?name=${encodeURIComponent(item.name)}`, {
          method: "POST",
          headers: { "Content-Type": item.mimeType },
          body: item.file,
        });
        if (!upload.ok || !upload.data?.attachment?.id) {
          throw new Error(apiDetailMessage(upload.detail, `${item.name} 上传失败`));
        }
        item.remote = upload.data.attachment;
      }
      return pendingImages.map((item) => item.remote.id);
    };

    // 点击发送
    const send = async () => {
      const msg = (textarea.value || "").trim();
      if (!msg && pendingImages.length === 0) {
        showFeedbackError("消息或图片至少需要一个");
        return;
      }
      sendBtn.disabled = true;
      attachBtn.disabled = true;
      sendBtn.textContent = "发送中…";
      feedback.textContent = "";
      feedback.className = "talk-panel__feedback";
      const mode = document.getElementById(`talkMode-${worker}`)?.value || "auto";
      let attachmentIds;
      try {
        attachmentIds = await uploadPendingImages();
      } catch (error) {
        sendBtn.disabled = false;
        attachBtn.disabled = !supportsImages;
        sendBtn.textContent = "发送";
        showFeedbackError(error?.message || "图片上传失败");
        return;
      }
      const res = await api(`/api/talk/${encodeURIComponent(worker)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg,
          mode,
          attachmentIds,
          attachmentMentions: pendingImages
            .filter((item) => talkMessageHasMention(msg, item.mentionToken))
            .map((item) => ({ attachmentId: item.remote.id, token: item.mentionToken })),
        }),
      });
      sendBtn.disabled = false;
      attachBtn.disabled = !supportsImages;
      sendBtn.textContent = "发送";
      if (!res.ok) {
        showFeedbackError(apiDetailMessage(res.detail, "发送失败"));
        return;
      }
      const requestId = res.data?.request?.id;
      const deliveryMode = res.data?.request?.mode;
      feedback.textContent = requestId
        ? `✓ 已提交 · request ${requestId.slice(-6)} · mode=${deliveryMode}，等待 Pi 主进程接管…`
        : "✓ 已提交，等待 Pi 主进程接管…";
      feedback.className = "talk-panel__feedback talk-panel__feedback--ok";
      textarea.value = "";
      for (const item of pendingImages) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      pendingImages.length = 0;
      nextImageMentionNumber = 1;
      hideMentionMenu();
      renderPendingImages();
      void refreshWorkerUnreadBadges();
      if (requestId) await waitTalkRequest(worker, requestId, feedback);
      await reloadTalkHistory(worker);
    };
    sendBtn.addEventListener("click", send);
    textarea.addEventListener("keydown", (e) => {
      if (!mentionMenu.hidden && mentionMenuOptions.length && !e.ctrlKey && !e.metaKey) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const delta = e.key === "ArrowDown" ? 1 : -1;
          mentionMenuActiveIndex = (mentionMenuActiveIndex + delta + mentionMenuOptions.length) % mentionMenuOptions.length;
          renderMentionMenu();
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          insertImageMention(mentionMenuOptions[mentionMenuActiveIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          hideMentionMenu();
          return;
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send(); }
    });

    // 首次加载历史：复用 /api/workers/:name 已带回的 jobs / pending requests，避免点击员工后重复读。
    queueMicrotask(() => renderTalkHistory(worker, initialJobs, d.talkRequests || []));
    return card;
  }

  async function waitTalkRequest(worker, requestId, feedback) {
    for (let i = 0; i < 20; i++) {
      await sleep(i === 0 ? 500 : 1500);
      const res = await api(`/api/talk-requests/${encodeURIComponent(requestId)}`);
      if (!res.ok) continue;
      const request = res.data?.request || {};
      if (request.status === "accepted") {
        feedback.textContent = `✓ 已接入 talk · job ${request.jobId || "—"}${request.deliveryMode ? ` · ${request.deliveryMode}` : ""}`;
        feedback.className = "talk-panel__feedback talk-panel__feedback--ok";
        void refreshWorkerUnreadBadges();
        await reloadTalkHistory(worker);
        return;
      }
      if (request.status === "failed") {
        feedback.textContent = `❌ ${request.error || "Pi 主进程接管失败"}`;
        feedback.className = "talk-panel__feedback talk-panel__feedback--error";
        return;
      }
    }
    feedback.textContent = `⌛ 已提交但仍未被 Pi 主进程接管；如果刚更新代码，请 reload Pi 后再看。`;
    feedback.className = "talk-panel__feedback";
  }

  function talkRequestSortTime(request) {
    return request?.updatedAt || request?.editedAt || request?.acceptedAt || request?.cancelledAt || request?.failedAt || request?.claimedAt || request?.createdAt || "";
  }

  function talkJobSortTime(job) {
    return job?.createdAt || job?.updatedAt || "";
  }

  function shouldShowTalkRequest(request, jobsById) {
    const status = String(request?.status || "");
    if (!request?.id) return false;
    if (status === "accepted" && request.jobId && jobsById.has(request.jobId)) return false;
    return ["pending", "processing", "accepted", "failed", "cancelled"].includes(status);
  }

  function isEditableQueuedJob(job) {
    return Boolean(job?.id) && String(job.status || "") === "queued";
  }

  function markTalkJobReadLocally(jobId) {
    const id = String(jobId || "").trim();
    if (!id) return 0;
    let cleared = 0;
    for (const item of $$(".talk-list__item[data-job-id]")) {
      if (item.dataset.jobId !== id) continue;
      if (item.classList.contains("talk-list__item--unread-before-open")) cleared += 1;
      item.classList.remove("talk-list__item--unread-before-open");
      item.dataset.unreadBeforeOpen = "0";
      item.querySelector(".talk-list__unread-badge")?.remove();
    }
    return cleared;
  }

  function talkUnreadBadge(count, title = "本次打开员工详情前尚未看过的更新") {
    const n = Number(count || 0);
    return el("span", {
      class: "talk-list__unread-badge",
      text: n > 1 ? `未读×${n}` : "未读",
      title,
    });
  }

  function renderTalkJobItem(worker, j) {
    const queued = isEditableQueuedJob(j);
    const unreadBeforeOpen = Boolean(j.unreadBeforeOpen);
    const unreadEventsBeforeOpen = Number(j.unreadEventsBeforeOpen || 0);
    return el("li", {
      class: `talk-list__item talk-list__item--job${unreadBeforeOpen ? " talk-list__item--unread-before-open" : ""}`,
      data: { jobId: j.id || "", unreadBeforeOpen: unreadBeforeOpen ? "1" : "0" },
    }, [
      el("div", { class: "talk-list__head" }, [
        statusPill(j.status),
        el("span", { class: "talk-list__id", text: (j.id || "").slice(-6) }),
        el("span", { class: "talk-list__time", text: fmtRelative(talkJobSortTime(j)) }),
        unreadBeforeOpen ? talkUnreadBadge(unreadEventsBeforeOpen) : null,
        el("div", { class: "talk-list__actions" }, [
          el("button", { class: "btn btn--ghost talk-list__btn", type: "button", text: "查看", onclick: () => openJobDrawer(j.id) }),
          queued ? el("button", {
            class: "btn btn--ghost talk-list__btn",
            type: "button",
            text: "编辑",
            onclick: () => editQueuedTalkJobFromList(worker, j),
          }) : null,
          isCancellableJob(j) ? el("button", {
            class: "btn btn--danger talk-list__btn",
            type: "button",
            text: queued ? "取消" : "停止",
            onclick: (e) => stopTalkJobFromList(worker, j.id, e.currentTarget, { queued }),
          }) : null,
        ]),
      ]),
      (j.assignedBy || j.source) ? el("div", { class: "talk-list__meta", text: [j.assignedBy ? `指派: ${j.assignedBy}` : "", j.source ? `来源: ${j.source}` : ""].filter(Boolean).join(" · ") }) : null,
      j.task ? talkMessageNode(j.task, j.attachmentMentions, j.attachments) : null,
      talkAttachmentNodes(j.attachments || []),
    ]);
  }

  function renderTalkRequestItem(worker, request) {
    const mode = request.deliveryMode || request.mode || "auto";
    const status = String(request.status || "pending");
    const pending = status === "pending";
    const actions = [];
    if (pending) {
      actions.push(el("button", {
        class: "btn btn--ghost talk-list__btn",
        type: "button",
        text: "编辑",
        onclick: () => editTalkRequestFromList(worker, request),
      }));
      actions.push(el("button", {
        class: "btn btn--danger talk-list__btn",
        type: "button",
        text: "取消",
        onclick: (e) => cancelTalkRequestFromList(worker, request, e.currentTarget),
      }));
    } else if (request.jobId) {
      actions.push(el("button", {
        class: "btn btn--ghost talk-list__btn",
        type: "button",
        text: "查看",
        onclick: () => openJobDrawer(request.jobId),
      }));
    }
    return el("li", { class: "talk-list__item talk-list__item--request" }, [
      el("div", { class: "talk-list__head" }, [
        statusPill(status),
        el("span", { class: "talk-list__id", text: (request.id || "").slice(-6) }),
        el("span", { class: "talk-list__time", text: fmtRelative(talkRequestSortTime(request)) }),
        actions.length ? el("div", { class: "talk-list__actions" }, actions) : null,
      ]),
      el("div", {
        class: "talk-list__meta",
        text: [
          `请求: ${mode}`,
          request.jobId ? `job: ${String(request.jobId).slice(-6)}` : "",
          pending ? "未接管前可编辑/取消" : "",
          status === "accepted" ? "已生效后只跟随 job 控制" : "",
          request.error ? `错误: ${request.error}` : "",
        ].filter(Boolean).join(" · "),
      }),
      request.message ? talkMessageNode(request.message, request.attachmentMentions, request.attachments) : null,
      talkAttachmentNodes(request.attachments || []),
    ]);
  }

  function renderTalkHistory(worker, jobs = [], requests = []) {
    const box = document.getElementById(`talkHistory-${worker}`);
    if (!box) return;
    const talkJobs = (jobs || []).filter((j) => j.project === "talk" || j.kind === "talk" || j.displayChannel === "talk");
    const jobsById = new Map(talkJobs.filter((j) => j.id).map((j) => [j.id, j]));
    const talkRequests = (requests || []).filter((request) => shouldShowTalkRequest(request, jobsById));
    const items = [
      ...talkJobs.map((job) => ({ type: "job", at: talkJobSortTime(job), job })),
      ...talkRequests.map((request) => ({ type: "request", at: talkRequestSortTime(request), request })),
    ].sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 40);
    box.innerHTML = "";
    if (!items.length) { box.appendChild(el("p", { class: "muted", text: "暂无对话记录。发第一条消息试试。", })); return; }
    // 最新在上面
    const list = el("ul", { class: "talk-list" }, items.map((item) =>
      item.type === "job" ? renderTalkJobItem(worker, item.job) : renderTalkRequestItem(worker, item.request),
    ));
    box.appendChild(list);
  }

  async function reloadTalkHistory(worker) {
    const box = document.getElementById(`talkHistory-${worker}`);
    if (!box) return;
    box.innerHTML = "";
    box.appendChild(loadingText("加载中…"));
    const [jobsRes, requestsRes] = await Promise.all([
      api(`/api/jobs?worker=${encodeURIComponent(worker)}&limit=20`),
      api(`/api/talk-requests?worker=${encodeURIComponent(worker)}&limit=20`),
    ]);
    if (!jobsRes.ok) { box.innerHTML = ""; box.appendChild(errorBox("加载对话历史失败", jobsRes.detail)); return; }
    if (!requestsRes.ok) toast("加载 talk 请求状态失败，仅展示 job", "error");
    renderTalkHistory(worker, jobsRes.data.jobs || [], requestsRes.ok ? (requestsRes.data.requests || []) : []);
  }

  async function stopTalkJobFromList(worker, jobId, button, options = {}) {
    if (!jobId) return;
    const queued = Boolean(options.queued);
    if (!window.confirm(`确定要${queued ? "取消排队中的" : "停止"} job ${jobId} 吗？`)) return;
    if (button) button.disabled = true;
    const res = await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "web", reason: queued ? "用户通过 Web talk 列表取消排队 job" : "用户通过 Web talk 列表停止 job" }),
    });
    if (!res.ok) {
      if (button) button.disabled = false;
      toast("停止 job 失败", "error");
      return;
    }
    toast("停止请求已提交", "success");
    await reloadTalkHistory(worker);
    if (STATE.currentPage === "jobs") await loadJobs();
  }

  async function editQueuedTalkJobFromList(worker, job) {
    if (!isEditableQueuedJob(job)) {
      toast("只有排队中的 job 可编辑", "error");
      return;
    }
    const message = window.prompt("编辑排队中的任务内容", job.task || "");
    if (message == null) return;
    const nextMessage = String(message || "").trim();
    if (!nextMessage) {
      toast("任务不能为空", "error");
      return;
    }
    const res = await api(`/api/jobs/${encodeURIComponent(job.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "web", message: nextMessage }),
    });
    if (!res.ok) {
      toast("编辑排队 job 失败", "error");
      return;
    }
    toast("编辑请求已提交", "success");
    await reloadTalkHistory(worker);
    if (STATE.currentPage === "jobs") await loadJobs();
  }

  async function editTalkRequestFromList(worker, request) {
    if (!request?.id || request.status !== "pending") {
      toast("只有待接管请求可编辑", "error");
      return;
    }
    const message = window.prompt("编辑待发送给员工的消息", request.message || "");
    if (message == null) return;
    const nextMessage = String(message || "").trim();
    if (!nextMessage) {
      toast("消息不能为空", "error");
      return;
    }
    const res = await api(`/api/talk-requests/${encodeURIComponent(request.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "web", message: nextMessage, mode: request.mode || request.deliveryMode || "auto" }),
    });
    if (!res.ok) {
      toast("编辑请求失败", "error");
      return;
    }
    toast("请求已更新", "success");
    await reloadTalkHistory(worker);
  }

  async function cancelTalkRequestFromList(worker, request, button) {
    if (!request?.id || request.status !== "pending") {
      toast("只有待接管请求可取消", "error");
      return;
    }
    if (!window.confirm(`确定取消这条 ${request.mode || "talk"} 请求吗？`)) return;
    if (button) button.disabled = true;
    const res = await api(`/api/talk-requests/${encodeURIComponent(request.id)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "web", reason: "用户通过 Web talk 列表取消待接管请求" }),
    });
    if (!res.ok) {
      if (button) button.disabled = false;
      toast("取消请求失败", "error");
      return;
    }
    toast("请求已取消", "success");
    await reloadTalkHistory(worker);
  }

  async function renderWorkerDetail(name) {
    const myId = ++currentDetailId;
    const target = $("#workerDetail");
    if (!target) return;
    target.innerHTML = "";
    target.appendChild(loadingText("加载中…"));
    const res = await api(`/api/workers/${encodeURIComponent(name)}`);
    if (myId !== currentDetailId) return;
    if (!res.ok) {
      target.innerHTML = "";
      target.appendChild(errorBox("加载员工详情失败", res.detail));
      return;
    }
    const d = res.data;
    const previousUnreadMessages = Number(d.unreadMessages || 0);
    const previousUnreadJobUpdates = Number(d.unreadJobUpdates || 0);
    const previousUnreadJobEvents = Number(d.unreadJobEvents || 0);
    d.unreadBeforeOpen = {
      messages: previousUnreadMessages,
      jobUpdates: previousUnreadJobUpdates,
      jobEvents: previousUnreadJobEvents,
      total: previousUnreadMessages + previousUnreadJobUpdates,
    };
    const hasUnreadForWorker = d.finishedUnreadJobs > 0 || previousUnreadMessages > 0 || previousUnreadJobUpdates > 0 || previousUnreadJobEvents > 0;
    if (hasUnreadForWorker) {
      const marked = await markWorkerReadFromUi(name);
      if (myId !== currentDetailId) return;
      if (marked.ok) {
        for (const message of d.inbox || []) {
          if (message.from !== name && (message.to === name || message.to === "*")) message.read = true;
        }
        d.unreadMessages = 0;
        d.unreadJobUpdates = 0;
        d.unreadJobEvents = 0;
        d.unreadCount = 0;
        d.lastUnreadAt = null;
        clearWorkerCardUnreadLocally(name);
        void refreshWorkerUnreadBadges();
      }
    }
    target.innerHTML = "";
    const head = el("header", { class: "worker-detail__head" }, [
      workerAvatarNode(d, { large: true }),
      el("div", { class: "worker-detail__title" }, [
        el("h2", {}, [
          d.status === "vacation" ? el("span", { class: "worker-card__vacation-badge", text: "🏖 休假" }) : null,
          el("span", { text: ` ${d.name}` }),
          d.unreadCount > 0 ? el("span", { class: "worker-detail__unread-badge", text: `${d.unreadCount} 条未读` }) : null,
        ]),
        el("div", { class: "worker-detail__sub" }, [
          statusPill(d.status),
          el("span", { class: "tag tag--soft", text: `Backend: ${d.backend || "—"}` }),
          el("span", { class: "tag tag--soft", text: `Model: ${d.model || "—"}` }),
          el("span", { class: "tag tag--soft", text: `Thinking: ${d.thinking || "—"}` }),
          el("span", { class: "tag tag--soft", text: `Role: ${d.role || "—"}` }),
        ]),
      ]),
    ]);
    target.appendChild(head);

    // 和 TA 对话 · Web 版 /talk 员工名
    target.appendChild(buildTalkPanel(name, d, d.jobs || []));

    // 职责
    const responsibilities = d.responsibilities || [];
    target.appendChild(el("div", { class: "card" }, [
      cardHead("职责", "来自 factory_responsibility_set / responsibilities.jsonl"),
      responsibilities.length
        ? el("ul", { class: "kv-list" }, responsibilities.map((r) => el("li", {}, [
            el("strong", { text: `${r.project} · ${r.relation}` }),
            el("span", { class: `tag tag--${r.status === "active" ? "done" : "soft"}`, text: r.status }),
            el("p", { text: r.scope }),
          ])))
        : emptyState("暂未提供", "可以让主 agent 用 factory_responsibility_set 给员工设定负责项目/职责。"),
    ]));

    // 最近 jobs
    const recentJobs = (d.jobs || []).slice(0, 8);
    target.appendChild(el("div", { class: "card" }, [
      cardHead(`最近 Jobs (${d.jobCount})`, "按更新时间倒序"),
      recentJobs.length === 0
        ? emptyState("暂无 job 记录")
        : el("table", { class: "table" }, [
            el("thead", {}, [el("tr", {}, [
              el("th", { text: "状态" }),
              el("th", { text: "项目" }),
              el("th", { text: "任务" }),
              el("th", { text: "更新" }),
            ])]),
            el("tbody", {}, recentJobs.map((j) => el("tr", {
              onclick: () => openJobDrawer(j.id),
            }, [
              el("td", {}, [statusPill(j.status)]),
              el("td", { class: "td--proj", text: j.project || "—" }),
              el("td", { class: "td--task", text: j.task }),
              el("td", { class: "td--time", text: fmtRelative(j.updatedAt) }),
            ]))),
          ]),
    ]));

    // 收件箱 / 发件（默认折叠；长内容不直接展开；支持 markdown）
    const inbox = d.inbox || [];
    const inboxBody = inbox.length === 0
      ? emptyState("暂无消息")
      : el("ul", { class: "msg-list" }, inbox.map((m) => messageItem(m, { defaultOpen: false, showDirection: true, showRead: true, worker: name })));
    target.appendChild(collapsibleCard({
      title: `收件箱 / 发件 (${inbox.length})`,
      sub: "授权式通信记录 · Markdown 渲染",
      count: inbox.length,
      defaultOpen: false,
      empty: inbox.length === 0 ? inboxBody : null,
      body: inbox.length > 0 ? inboxBody : null,
    }));
  }
  // ---- Jobs 页面 ----
  function renderJobsPage() {
    const main = $("#main");
    main.innerHTML = "";
    const wrap = el("div", { class: "page page--jobs" });

    const filterBar = el("section", { class: "filters" }, [
      el("div", { class: "filters__group" }, [
        el("label", { class: "filters__label", text: "状态" }),
        el("div", { class: "chips", id: "filterStatus" },
          [{ k: null, l: "全部" }, ...STATUS_KEYS.map((k) => ({ k, l: STATUS_LABELS[k] || k }))].map((opt) =>
            el("button", {
              class: "chip",
              type: "button",
              data: { value: opt.k || "" },
              text: opt.l,
              onclick: (e) => onChipClick(e, "status"),
            }))),
      ]),
      el("div", { class: "filters__group" }, [
        el("label", { class: "filters__label", text: "员工" }),
        el("select", { class: "input", id: "filterWorker", onchange: loadJobs }),
      ]),
      el("div", { class: "filters__group" }, [
        el("label", { class: "filters__label", text: "项目" }),
        el("select", { class: "input", id: "filterProject", onchange: loadJobs }),
      ]),
      el("div", { class: "filters__group filters__group--grow" }, [
        el("label", { class: "filters__label", text: "搜索" }),
        el("input", { class: "input", type: "search", id: "filterSearch", placeholder: "任务 / 摘要 / ID / 员工", oninput: debounce(loadJobs, 250) }),
      ]),
      el("div", { class: "filters__group" }, [
        el("label", { class: "filters__label", text: "时间" }),
        el("select", { class: "input", id: "filterDate", onchange: loadJobs }, [
          el("option", { value: "today", text: "今日" }),
          el("option", { value: "", text: "全部" }),
        ]),
      ]),
    ]);
    wrap.appendChild(filterBar);

    wrap.appendChild(el("section", { class: "section" }, [
      el("div", { class: "card card--flush" }, [
        el("div", { class: "jobs-summary", id: "jobsSummary" }, [loadingText("加载中…", "span")]),
        el("div", { class: "table-wrap" }, [
          el("table", { class: "table table--jobs" }, [
            el("thead", {}, [el("tr", {}, [
              el("th", { text: "状态" }),
              el("th", { text: "ID" }),
              el("th", { text: "员工" }),
              el("th", { text: "项目" }),
              el("th", { text: "任务" }),
              el("th", { text: "耗时" }),
              el("th", { text: "更新" }),
            ])]),
            el("tbody", { id: "jobsBody" }),
          ]),
        ]),
      ]),
    ]));

    main.appendChild(wrap);
    populateWorkerOptions().then(populateProjectOptions).then(loadJobs);
  }

  function onChipClick(e, key) {
    const group = e.currentTarget.parentElement;
    for (const c of group.querySelectorAll(".chip")) c.classList.remove("chip--active");
    e.currentTarget.classList.add("chip--active");
    loadJobs();
  }

  function getFilterStatus() {
    const el = $(".chip.chip--active", $("#filterStatus"));
    return el ? el.dataset.value || null : null;
  }

  async function populateWorkerOptions() {
    const sel = $("#filterWorker");
    if (!sel) return;
    const res = await api("/api/workers");
    if (res.ok) {
      STATE.workers = res.data.workers || [];
      sel.innerHTML = `<option value="">全部 (${STATE.workers.length})</option>` +
        STATE.workers.map((w) => `<option value="${esc(w.name)}">${esc(w.name)}</option>`).join("");
    }
  }

  async function populateProjectOptions() {
    const sel = $("#filterProject");
    if (!sel) return;
    const res = await api("/api/projects");
    if (res.ok) {
      const projects = res.data.projects || [];
      sel.innerHTML = `<option value="">全部 (${projects.length})</option>` +
        projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} (${p.total})</option>`).join("");
    }
  }

  async function loadJobs() {
    const myId = ++currentJobsId;
    const params = new URLSearchParams();
    const status = getFilterStatus();
    if (status) params.set("status", status);
    const worker = $("#filterWorker")?.value;
    if (worker) params.set("worker", worker);
    const project = $("#filterProject")?.value;
    if (project) params.set("project", project);
    const search = $("#filterSearch")?.value;
    if (search) params.set("search", search);
    const date = $("#filterDate")?.value;
    if (date) params.set("date", date);
    const res = await api(`/api/jobs?${params}`);
    if (myId !== currentJobsId) return;
    const tbody = $("#jobsBody");
    const summary = $("#jobsSummary");
    if (!res.ok) {
      tbody.innerHTML = "";
      summary.innerHTML = "";
      summary.appendChild(errorBox("加载 Jobs 失败", res.detail));
      return;
    }
    STATE.jobs = res.data.jobs || [];
    const total = res.data.total || STATE.jobs.length;
    summary.innerHTML = "";
    summary.appendChild(el("span", { class: "muted", text: `共 ${total} 条 · 显示前 200` }));
    tbody.innerHTML = "";
    if (STATE.jobs.length === 0) {
      tbody.appendChild(el("tr", {}, [el("td", { colspan: 7, class: "td--empty" }, [emptyState("暂无 job", "可以调整筛选条件，或等待员工产生任务。")])]));
      return;
    }
    for (const job of STATE.jobs) {
      const tr = el("tr", { onclick: () => openJobDrawer(job.id) }, [
        el("td", {}, [statusPill(job.status)]),
        el("td", { class: "td--mono", text: (job.id || "").slice(-6) }),
        el("td", { text: job.worker || "—" }),
        el("td", { class: "td--proj", text: job.project || "—" }),
        el("td", { class: "td--task", title: job.task, text: job.task || "—" }),
        el("td", { class: "td--mono", text: job.elapsedSeconds != null ? `${job.elapsedSeconds}s` : "—" }),
        el("td", { class: "td--time", text: fmtRelative(job.updatedAt) }),
      ]);
      tbody.appendChild(tr);
    }
  }

  // ---- Drawer (Job 详情) ----
  async function openJobDrawer(id) {
    STATE.drawerJob = id;
    const drawer = $("#drawer");
    drawer.classList.add(DRAWER_OPEN_CLASS);
    drawer.setAttribute("aria-hidden", "false");
    $("#drawerEyebrow").textContent = "JOB";
    $("#drawerTitle").textContent = id;
    $("#drawerBody").innerHTML = "";
    $("#drawerBody").appendChild(loadingText("加载中…"));
    const res = await api(`/api/jobs/${encodeURIComponent(id)}`);
    const body = $("#drawerBody");
    if (!res.ok) {
      body.innerHTML = "";
      body.appendChild(errorBox("加载 Job 详情失败", res.detail));
      return;
    }
    const d = res.data;
    if (d.read?.marked) {
      markTalkJobReadLocally(d.id || id);
      void refreshWorkerUnreadBadges();
    }
    body.innerHTML = "";
    body.appendChild(el("div", { class: "drawer__meta" }, [
	      el("div", {}, [el("span", { class: "muted", text: "状态" }), statusPill(d.status)]),
	      el("div", {}, [el("span", { class: "muted", text: "员工" }), el("strong", { text: d.worker || "—" })]),
	      el("div", {}, [el("span", { class: "muted", text: "项目" }), el("strong", { text: d.project || "—" })]),
	      (d.assignedBy || d.source) ? el("div", {}, [el("span", { class: "muted", text: "来源" }), el("span", { text: [d.assignedBy ? `指派: ${d.assignedBy}` : "", d.source ? `source: ${d.source}` : ""].filter(Boolean).join(" · ") })]) : null,
	      el("div", {}, [el("span", { class: "muted", text: "创建" }), el("span", { text: fmtTime(d.createdAt, { dateOnly: false }) })]),
      el("div", {}, [el("span", { class: "muted", text: "更新" }), el("span", { text: fmtTime(d.updatedAt) })]),
      d.elapsedSeconds != null ? el("div", {}, [el("span", { class: "muted", text: "耗时" }), el("span", { text: `${d.elapsedSeconds}s` })]) : null,
    ]));
    if (isCancellableJob(d)) {
      body.appendChild(el("div", { class: "drawer__actions" }, [
        el("button", {
          class: "btn btn--danger",
          type: "button",
          onclick: (e) => cancelJobFromDrawer(d.id || id, e.currentTarget),
        }, [
          el("span", { class: "btn__icon", text: "⏹" }),
          "停止 job",
        ]),
        el("span", { class: "muted", text: "会提交取消请求；运行中任务由 Pi 主进程尝试中止，排队任务会移出队列。" }),
      ]));
    }
    body.appendChild(el("div", { class: "drawer__section" }, [
      el("h4", { text: "任务" }),
      d.task
        ? (d.attachmentMentions?.length ? talkMessageNode(d.task, d.attachmentMentions, d.attachments, { compact: false }) : mdNode(d.task))
        : el("p", { class: "prose", text: "—" }),
      talkAttachmentNodes(d.attachments || []),
    ]));
    const costValue = el("strong", {text: apiCostText(d.apiCost), title:d.apiCost?.note || ""});
    body.appendChild(el("div", {class:"drawer__section"}, [
      el("h4", {text:"API 参考费用（非实际扣费）"}), costValue,
      el("p", {class:"muted", text:d.apiCost?.note || "等待可识别的模型价格与用量；历史数据不会按零费用处理。"}),
    ]));
    if (!["done", "failed", "aborted", "stale"].includes(d.status)) void pollDrawerCost(d.id || id, costValue);
    const replyText = d.fullReply || d.latestReply || d.summary || "";
    if (replyText) {
      body.appendChild(el("div", { class: "drawer__section" }, [
        el("h4", { text: "AI 响应" }),
        d.fullReplyTruncated
          ? el("p", {
              class: "muted",
              text: `响应过长，已展示前 ${fmtNumber(d.fullReplyLimit || 0)} 字符 / 共 ${fmtNumber(d.fullReplyChars || 0)} 字符。`,
            })
          : null,
        mdNode(replyText),
      ]));
    }
    if (d.error) {
      body.appendChild(el("div", { class: "drawer__section drawer__section--error" }, [
        el("h4", { text: "Error" }),
        el("pre", { text: d.error }),
      ]));
    }
    if (d.events && d.events.length) {
      body.appendChild(el("div", { class: "drawer__section" }, [
        el("h4", { text: `执行过程 (${d.events.length})` }),
        el("ul", { class: "timeline" }, d.events.map(renderJobEventItem)),
      ]));
    }
  }

  async function cancelJobFromDrawer(jobId, button) {
    if (!jobId) return;
    if (!window.confirm(`确定要停止 job ${jobId} 吗？`)) return;
    if (button) button.disabled = true;
    const res = await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "web", reason: "用户通过 Web 停止 job" }),
    });
    if (!res.ok) {
      if (button) button.disabled = false;
      toast("停止 job 失败", "error");
      return;
    }
    toast("停止请求已提交", "success");
    await openJobDrawer(jobId);
    if (STATE.currentPage === "jobs") await loadJobs();
  }

  function jobEventLabel(ev) {
    if (ev.isError || ev.type === "error") return "错误";
    if (ev.type === "text") return "回答";
    if (ev.type === "tool") return "工具";
    if (ev.type === "thinking") return "思考";
    if (ev.type === "done") return "完成";
    if (ev.type === "queued") return "入队";
    if (ev.type === "started") return "开始";
    if (ev.type === "codex_thread") return "线程";
    if (ev.type === "claude_session") return "会话";
    if (ev.type === "kimi_session") return "会话";
    return ev.type || "事件";
  }

  function renderJobEventItem(ev) {
    const itemClass = ev.type === "text"
      ? "timeline__item--assistant"
      : `timeline__item--${ev.isError ? "error" : ev.type || "event"}`;
    const text = ev.text || ev.message || "";
    const contentChildren = [
      el("div", { class: "timeline__meta" }, [
        el("span", { class: "timeline__type", text: jobEventLabel(ev) }),
        ev.name ? el("span", { class: "timeline__name", text: ev.name }) : null,
      ]),
    ];

    if (ev.type === "text") {
      contentChildren.push(el("div", { class: "timeline__text timeline__text--assistant" }, [mdNode(text, { compact: true, max: 8000 })]));
    } else if (ev.type === "tool") {
      contentChildren.push(el("div", { class: "timeline__tool-card" }, [
        el("div", { class: "timeline__tool-head" }, [
          el("span", { class: "timeline__tool-dot", text: ev.isError ? "!" : "›" }),
          el("span", { class: "timeline__tool-name", text: ev.name || "tool" }),
        ]),
        text ? el("pre", { class: "timeline__tool-body", text }) : null,
      ]));
    } else {
      contentChildren.push(el("div", {
        class: `timeline__text${ev.isError ? " timeline__text--error" : ""}`,
        text: text || "—",
      }));
    }

    return el("li", { class: `timeline__item ${itemClass}` }, [
      el("span", { class: "timeline__time", text: fmtTime(ev.time) }),
      el("div", { class: "timeline__content" }, contentChildren),
    ]);
  }

  function closeDrawer() {
    const drawer = $("#drawer");
    drawer.classList.remove(DRAWER_OPEN_CLASS);
    drawer.setAttribute("aria-hidden", "true");
    STATE.drawerJob = null;
    // 关闭抽屉后异步静默刷新侧边气泡（GET /api/jobs/:id 打开时已自动 markRead）
    void refreshWorkerUnreadBadges();
  }

  // ---- P1 页面 (Tokens / Compactions / Messages / Report / Permissions) ----
  function renderComingSoon(title, sub, badge) {
    const main = $("#main");
    main.innerHTML = "";
    const wrap = el("div", { class: "page page--coming" });
    wrap.appendChild(el("section", { class: "section" }, [
      sectionHead(title, sub),
      el("div", { class: "card" }, [
        el("div", { class: "coming" }, [
          el("div", { class: "coming__badge", text: badge || "P1" }),
          el("div", { class: "coming__title", text: "Coming soon" }),
          el("div", { class: "coming__hint", text: "Phase 1 优先 Overview / Workers / Jobs。完整页将在 P1 实现。" }),
        ]),
      ]),
    ]));
    main.appendChild(wrap);
  }

  async function renderTokens() {
    const wrap = el("div", { class: "page page--tokens" });

    // 从 URL hash 读出当前 date / days。route()/refreshCurrent() 都会重新进入
    // renderTokens，所以这里要始终尊重 hash，而不是只在 STATE 为空时读取。
    const hash = location.hash || "#/tokens";
    const query = new URLSearchParams(hash.split("?")[1] || "");
    const hashTrendDays = Number(query.get("trend"));
    STATE.tokensDate = query.get("date") || STATE.tokensDate || todayLocal();
    STATE.tokensTrendDays = Number.isFinite(hashTrendDays) && hashTrendDays > 0
      ? hashTrendDays
      : (STATE.tokensTrendDays || 7);

    function applyTokenFilters(patch = {}) {
      const nextDate = patch.date || STATE.tokensDate || todayLocal();
      const nextTrendDays = Number(patch.trend || STATE.tokensTrendDays || 7);
      const safeTrendDays = Number.isFinite(nextTrendDays) && nextTrendDays > 0 ? nextTrendDays : 7;
      const newHash = `#/tokens?date=${encodeURIComponent(nextDate)}&trend=${safeTrendDays}`;
      const unchanged = STATE.tokensDate === nextDate
        && STATE.tokensTrendDays === safeTrendDays
        && location.hash === newHash;
      if (unchanged) return;

      STATE.tokensDate = nextDate;
      STATE.tokensTrendDays = safeTrendDays;
      if (location.hash !== newHash) history.replaceState(null, "", newHash);
      // 直接调用 renderTokens() 只会返回新 DOM 节点，不会挂载到 #main。
      // 走 route() 才能触发 loading、竞态保护和主区域替换。
      void route();
    }

    // 顶部 filter
    const filterBar = el("section", { class: "filters" }, [
      el("div", { class: "filters__group" }, [
        el("label", { class: "filters__label", text: "日期" }),
        el("input", {
          class: "input",
          type: "date",
          id: "filterTokenDate",
          value: STATE.tokensDate,
          max: todayLocal(),
          oninput: (e) => applyTokenFilters({ date: e.target.value }),
          onchange: (e) => applyTokenFilters({ date: e.target.value }),
        }),
      ]),
      el("div", { class: "filters__group" }, [
        el("label", { class: "filters__label", text: "趋势区间" }),
        el("select", {
          class: "input",
          id: "filterTokenTrend",
          onchange: (e) => applyTokenFilters({ trend: Number(e.target.value) }),
        }, [3, 7, 14, 30].map((d) => el("option", { value: String(d), text: `近 ${d} 天`, ...(d === STATE.tokensTrendDays ? { selected: "selected" } : {}) }))),
      ]),
      el("div", { class: "filters__group filters__group--grow" }, [
        el("span", { class: "filters__hint", text: `选择日期查看当日明细；趋势看每日总量` }),
      ]),
    ]);
    wrap.appendChild(filterBar);
    wrap.appendChild(el("section", { class: "section" }, [
      sectionHead(`Token 报告 · ${STATE.tokensDate}`, "按日聚合；session 优先，job 兜底；K/M 紧凑显示"),
    ]));

    // 并发拉明细 + 趋势
    const [resDetail, resTrend] = await Promise.all([
      api(`/api/tokens?date=${encodeURIComponent(STATE.tokensDate)}`),
      api(`/api/tokens/trend?days=${STATE.tokensTrendDays}`),
    ]);

    if (!resDetail.ok) {
      wrap.appendChild(errorBox("加载 Token 报告失败", resDetail.detail));
    } else {
      const d = resDetail.data;
      const totals = d.totals || {};
      const kpi = el("section", { class: "kpi-row" }, [
        kpiCard("输入", fmtNumber(totals.inputTokens), ""),
        kpiCard("缓存输入", fmtNumber(totals.cachedInputTokens), ""),
        kpiCard("输出", fmtNumber(totals.outputTokens), ""),
        kpiCard("推理输出", fmtNumber(totals.reasoningOutputTokens), ""),
        kpiCard("总 Token", fmtNumber(totals.totalTokens), "input + output"),
        kpiCard("含缓存合计", fmtNumber(totals.totalWithCachedTokens), "input + cache + output"),
        kpiCard("参考费用", apiCostText(d.apiCost), `${d.apiCost?.pricedJobs || 0} 项可估 · ${d.apiCost?.unpricedJobs || 0} 项未知`),
      ]);
      wrap.appendChild(kpi);
      const max = Math.max(1, ...(d.workers || []).map((w) => w.reported?.totalWithCachedTokens || 0));
      wrap.appendChild(el("section", { class: "section" }, [
        el("div", { class: "card" }, [
          cardHead(`员工 Token 明细 (${d.workers?.length || 0})`, `按 totalWithCachedTokens 降序 · 生成于 ${fmtTime(d.generatedAt)}`),
          (d.workers && d.workers.length)
            ? el("div", { class: "bar-list" }, d.workers.map((row) => barRow(row, max)))
            : emptyState(`${STATE.tokensDate} 暂无 token 记录`),
        ]),
      ]));
      wrap.appendChild(el("section", { class: "section" }, [
        el("div", { class: "card" }, [
          cardHead("API 参考费用", `按 ${STATE.tokensDate} 的 job usage 估算；非实际账单`),
          el("p", { text: `${apiCostText(d.apiCost)} · 已估算 ${d.apiCost?.pricedJobs || 0} 项 · 未能估算 ${d.apiCost?.unpricedJobs || 0} 项` }),
          el("p", { class: "muted", text: "仅对有可确认 token 口径和价格表的 job 计价；运行中 job 会按已收到用量累计估算。" }),
          (d.costByWorker || []).length
            ? el("div", { class: "table-wrap" }, [el("table", { class: "table quality-table" }, [
              el("thead", {}, [el("tr", {}, [
                el("th", { text: "员工" }),
                sortableNumericTh("参考费用 $"),
                sortableNumericTh("计价样本"),
                sortableNumericTh("未计价"),
                sortableNumericTh("平均每计价任务 $"),
              ])]),
              el("tbody", {}, d.costByWorker.map((row) => el("tr", {}, [
                el("td", { text: row.worker || "—" }),
                numericTd(row.usd ?? -1, apiCostText(row)),
                numericTd(row.pricedJobs || 0, String(row.pricedJobs || 0)),
                numericTd(row.unpricedJobs || 0, String(row.unpricedJobs || 0)),
                numericTd(row.avgUsd ?? -1, row.avgUsd == null ? "—" : `≈ $${row.avgUsd.toFixed(4)}`),
              ]))),
            ])])
            : emptyState("当前日期暂无可估算费用", "等待新的 Codex inclusive usage 或补充模型价格表"),
        ]),
      ]));
      if (d.warnings && d.warnings.length) {
        wrap.appendChild(el("section", { class: "section" }, [
          el("div", { class: "card card--warn" }, [
            cardHead("数据警告", "源数据中可能存在缺失/重复"),
            el("ul", { class: "warn-list" }, d.warnings.map((w) => el("li", { text: w }))),
          ]),
        ]));
      }
    }

    // 趋势 bar chart
    wrap.appendChild(el("section", { class: "section" }, [
      el("div", { class: "card" }, [
        cardHead(`近 ${STATE.tokensTrendDays} 天趋势`, "每日总 Token 总量与含缓存合计"),
        resTrend.ok ? renderTrendChart(resTrend.data) : errorBox("加载趋势失败", resTrend.detail),
      ]),
    ]));

    // 同步 filter 到 hash
    const newHash = `#/tokens?date=${encodeURIComponent(STATE.tokensDate)}&trend=${STATE.tokensTrendDays}`;
    if (location.hash !== newHash) history.replaceState(null, "", newHash);

    return wrap;
  }

  function renderTrendChart(trend) {
    const days = trend.days || [];
    if (!days.length) return emptyState("近 N 天暂无 token 数据", "可以等待明天或调大 trend 区间");
    const max = Math.max(1, ...days.map((d) => d.totalWithCachedTokens || 0));
    const total = days.reduce((a, b) => a + (b.totalWithCachedTokens || 0), 0);
    const avg = Math.round(total / days.length);
    const peakDay = days.find((d) => d.totalWithCachedTokens === max);
    return el("div", { class: "trend-chart" }, [
      // 顶部汇总
      el("div", { class: "trend-chart__summary" }, [
        trendKpi("合计", fmtNumber(total), `${days.length} 天总消耗`),
        trendKpi("日均", fmtNumber(avg), "含缓存平均"),
        trendKpi("峰值", fmtNumber(max), peakDay && peakDay.date ? String(peakDay.date) : "—"),
      ]),
      // bar chart
      el("div", { class: "trend-chart__bars" },
        days.map((d) => {
          const pct = Math.max(2, Math.round(((d.totalWithCachedTokens || 0) / max) * 100));
          const isCurrent = d.date === STATE.tokensDate;
          return el("div", { class: `trend-chart__col${isCurrent ? " trend-chart__col--current" : ""}` }, [
            el("div", { class: "trend-chart__bar-wrap" },
              el("div", {
                class: "trend-chart__bar",
                style: `height: ${pct}%;`,
                title: `${d.date}\n总 ${fmtNumber(d.totalTokens)}\n含缓存 ${fmtNumber(d.totalWithCachedTokens)}`,
              })),
            el("div", { class: "trend-chart__date", text: (d.date || "").slice(5) }),
            el("div", { class: "trend-chart__val", text: fmtNumber(d.totalWithCachedTokens) }),
          ]);
        })),
    ]);
  }

  function trendKpi(label, value, sub, note) {
    const labelChildren = [el("span", { class: "trend-kpi__label-text", text: label })];
    if (note) labelChildren.push(noteTag(note));
    return el("div", { class: "trend-kpi" }, [
      el("div", { class: "trend-kpi__label" }, labelChildren),
      el("div", { class: "trend-kpi__value", text: value }),
      el("div", { class: "trend-kpi__sub", text: sub }),
    ]);
  }

  // 指标值 / 标签旁加一个问号 tooltip，用于说明“包含 subagent/外包相关工具调用”
  const SUBAGENT_TOOL_NOTE = "包含 subagent/外包相关工具调用：factory_task_assign / factory_outsource_run / factory_outsource_wait / factory_outsource_result / factory_outsource_status";
  function noteTag(text) {
    return el("span", { class: "metric__note", title: text }, "ⓘ");
  }
  function labelWithNote(label, noteText) {
    return el("span", { class: "metric-with-note" }, [label, noteTag(noteText)]);
  }
  function valueWithNote(valueNode, noteText) {
    return el("span", { class: "metric-with-note" }, [valueNode, noteTag(noteText)]);
  }

  // ---- Projects 页面 ----
  async function renderProjects() {
    const wrap = el("div", { class: "page page--projects" });
    wrap.appendChild(el("section", { class: "section" }, [
      sectionHead("项目目录", "Project Entity 一等实体，来自 projects.jsonl"),
    ]));

    const res = await api("/api/projects");
    if (!res.ok) {
      wrap.appendChild(errorBox("加载项目失败", res.detail));
      return wrap;
    }

    const d = res.data;
    const catalog = d.catalog || [];

    // 统计概览
    const activeCount = catalog.filter((p) => p.status === "active").length;
    const pausedCount = catalog.filter((p) => p.status === "paused").length;
    const doneCount = catalog.filter((p) => p.status === "done").length;
    const totalJobs = catalog.reduce((sum, p) => sum + (p.relatedJobCount || 0), 0);

    wrap.appendChild(el("section", { class: "section" }, [
      el("div", { class: "kpi-row" }, [
        trendKpi("项目总数", String(catalog.length), `active ${activeCount} · paused ${pausedCount} · done ${doneCount}`),
        trendKpi("关联 Jobs", String(totalJobs), "从 job.project 反向匹配"),
        trendKpi("派生活动条", String((d.projects || []).length), "job.project 去重后的活跃项目"),
      ]),
    ]));

    // 项目卡片网格
    if (catalog.length === 0) {
      wrap.appendChild(el("section", { class: "section" }, [
        emptyState("暂无 Project Entity", "使用 factory_project_upsert 创建项目后会出现在这里。"),
      ]));
    } else {
      wrap.appendChild(el("section", { class: "section" }, [
        el("div", { class: "proj-grid" }, catalog.map((p) => projectCatalogCard(p))),
      ]));
    }

    // 派生活动条（辅助参考）
    const strips = (d.projects || []).filter((p) => p.name && p.name !== "talk");
    if (strips.length > 0) {
      wrap.appendChild(el("section", { class: "section" }, [
        sectionHead("活动归档", "从 job.project 派生的活跃项目（含对话模式）"),
        el("div", { class: "strips" }, strips.map((p) => projectStrip(p))),
      ]));
    }

    return wrap;
  }

  // ---- Project 详情页 ----
  async function renderProjectDetail(projectId) {
    const wrap = el("div", { class: "page page--project-detail" });

    // 面包屑
    wrap.appendChild(el("div", { class: "breadcrumb" }, [
      el("a", { href: "#/projects", text: "← Projects" }),
    ]));

    const makeFallbackDetail = async (reason) => {
      const fallback = await api("/api/projects");
      if (!fallback.ok || !isRecord(fallback.data)) return null;
      const catalog = recordList(fallback.data.catalog);
      const wanted = String(projectId || "").toLowerCase();
      const project = catalog.find((item) => {
        const keys = [item.id, item.name, ...((Array.isArray(item.aliases) && item.aliases) || [])]
          .filter(Boolean)
          .map((v) => String(v).toLowerCase());
        return keys.includes(wanted);
      });
      if (!project) return null;
      return {
        generatedAt: fallback.data.generatedAt,
        project,
        relatedJobs: { total: project.relatedJobCount || 0, byStatus: {}, recent: [] },
        progress: recordList(project.progress),
        relatedResponsibilities: [],
        fallbackReason: reason,
      };
    };

    const res = await api(`/api/projects/${encodeURIComponent(projectId)}`);
    let d = null;
    if (res.ok && isRecord(res.data) && isRecord(res.data.project)) {
      d = res.data;
    } else {
      // 兼容旧 web-server 进程：静态 app.js 已更新，但后端还没重启时，
      // /api/projects/:id 可能被 SPA fallback 成 index.html（text/html）。
      d = await makeFallbackDetail(res.ok ? "详情接口返回了非 JSON 数据，已使用项目目录快照兜底。" : "详情接口不可用，已使用项目目录快照兜底。");
    }

    if (!d || !isRecord(d.project)) {
      wrap.appendChild(errorBox("加载项目详情失败", res.ok ? "项目详情接口不可用，且无法从 /api/projects 目录兜底。" : res.detail));
      return wrap;
    }

    const p = d.project;
    const jobs = isRecord(d.relatedJobs) ? d.relatedJobs : { total: 0, byStatus: {}, recent: [] };
    const progress = recordList(d.progress || p.progress);
    const resps = recordList(d.relatedResponsibilities);

    if (d.fallbackReason) {
      wrap.appendChild(el("div", { class: "warn-banner" }, [
        el("strong", { text: "项目详情使用兼容兜底：" }),
        el("span", { text: d.fallbackReason }),
      ]));
    }

    const projectStatus = p.status || "active";
    const statusClass = projectStatus === "active" ? "done" : projectStatus === "paused" ? "stale" : "soft";
    const members = recordList(p.members);
    const owner = members.find((m) => m.relation === "owner");
    const lead = members.find((m) => m.relation === "lead");
    const devs = members.filter((m) => m.relation === "developer");
    const todos = recordList(p.todos);
    const todoByStatus = todos.reduce((acc, t) => {
      const status = t.status || "todo";
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    const worktrees = recordList(p.worktrees);
    const links = recordList(p.links);
    const truth = isRecord(p.truth) ? p.truth : null;
    const recentJobs = recordList(jobs.recent);

    // Hero 区
    wrap.appendChild(el("section", { class: "section" }, [
      el("div", { class: "proj-hero" }, [
        el("div", { class: "proj-hero__title" }, [
          el("h1", { text: p.name }),
          el("div", { class: "proj-hero__tags" }, [
            el("span", { class: `pill pill--${statusClass}`, text: projectStatus }),
            el("span", { class: "tag tag--soft", text: p.priority || "P1" }),
            p.id ? el("span", { class: "tag tag--mono", text: p.id }) : null,
          ].filter(Boolean)),
        ]),
        p.summary ? el("p", { class: "proj-hero__summary", text: p.summary }) : null,
        el("div", { class: "proj-hero__meta" }, [
          owner ? el("span", { text: `👤 Owner: ${owner.worker}` }) : null,
          lead ? el("span", { text: `⚡ Lead: ${lead.worker}` }) : null,
          devs.length ? el("span", { text: `🔧 ${devs.length} dev${devs.length > 1 ? "s" : ""}` }) : null,
          p.createdAt ? el("span", { class: "muted", text: `创建: ${fmtTime(p.createdAt, { dateOnly: true })}` }) : null,
          p.updatedAt ? el("span", { class: "muted", text: `更新: ${fmtRelative(p.updatedAt)}` }) : null,
        ].filter(Boolean)),
      ]),
    ]));

    // KPI 行
    wrap.appendChild(el("section", { class: "section" }, [
      el("div", { class: "kpi-row" }, [
        trendKpi("关联 Jobs", String(jobs.total || 0), Object.entries(jobs.byStatus || {})
          .map(([k, v]) => `${STATUS_LABELS[k] || k} ${v}`).join(" · ") || "暂无"),
        trendKpi("待办", String(todos.length),
          ["todo", "doing", "done", "blocked"].filter((k) => todoByStatus[k])
            .map((k) => `${k} ${todoByStatus[k]}`).join(" · ") || "暂无"),
        trendKpi("团队成员", String(members.length),
          members.slice(0, 4).map((m) => `${m.worker}(${m.relation})`).join(" · ") || "暂无"),
        trendKpi("Worktrees", String(worktrees.length), worktrees.length ? "见下方" : "未配置"),
      ]),
    ]));

    // Truth & Links
    if (truth || links.length > 0) {
      wrap.appendChild(el("section", { class: "section" }, [
        sectionHead("文档与链接", "Single Source of Truth 和相关资源"),
        el("div", { class: "proj-links" }, [
          truth ? el("a", {
            class: "proj-link proj-link--truth",
            href: truth.ref && (truth.ref.startsWith("http") ? truth.ref : null),
            target: "_blank",
          }, [
            el("span", { class: "proj-link__icon", text: "📎" }),
            el("div", {}, [
              el("div", { class: "proj-link__label", text: `Truth · ${truth.type || "markdown"}` }),
              el("div", { class: "proj-link__ref", text: truth.ref }),
            ]),
          ]) : null,
          ...links.map((l) => el("a", {
            class: "proj-link",
            href: l.ref && (l.ref.startsWith("http") ? l.ref : null),
            target: "_blank",
          }, [
            el("span", { class: "proj-link__icon", text: l.type === "feishu" ? "📄" : l.type === "repo" ? "📦" : l.type === "dashboard" ? "📊" : "🔗" }),
            el("div", {}, [
              el("div", { class: "proj-link__label", text: l.label || l.type || "链接" }),
              el("div", { class: "proj-link__ref", text: l.ref }),
            ]),
          ])),
        ].filter(Boolean)),
      ]));
    }

    // 团队成员详情
    if (members.length > 0) {
      wrap.appendChild(el("section", { class: "section" }, [
        sectionHead("团队", "项目成员与职责"),
        el("div", { class: "card" }, [
          el("table", { class: "tbl" }, [
            el("thead", {}, [el("tr", {}, [
              el("th", { text: "员工" }),
              el("th", { text: "角色" }),
              el("th", { text: "状态" }),
              el("th", { text: "备注" }),
            ])]),
            el("tbody", {}, members.map((m) => el("tr", {}, [
              el("td", {}, [el("a", { href: `#/workers/${encodeURIComponent(m.worker)}`, text: m.worker })]),
              el("td", {}, [el("span", { class: `tag tag--${m.relation === "owner" ? "main" : m.relation === "lead" ? "done" : "soft"}`, text: m.relation })]),
              el("td", {}, [el("span", { class: `pill pill--${m.status === "active" ? "done" : "soft"}`, text: m.status || "active" })]),
              el("td", { class: "muted", text: m.note || "—" }),
            ]))),
          ]),
        ]),
      ]));
    }

    // 职责分配
    if (resps.length > 0) {
      wrap.appendChild(el("section", { class: "section" }, [
        sectionHead("职责分配", "从 responsibilities.jsonl 匹配"),
        el("div", { class: "card" }, [
          el("table", { class: "tbl" }, [
            el("thead", {}, [el("tr", {}, [
              el("th", { text: "员工" }),
              el("th", { text: "关系" }),
              el("th", { text: "职责范围" }),
              el("th", { text: "状态" }),
            ])]),
            el("tbody", {}, resps.map((r) => el("tr", {}, [
              el("td", {}, [el("a", { href: `#/workers/${encodeURIComponent(r.worker)}`, text: r.worker })]),
              el("td", {}, [el("span", { class: "tag tag--soft", text: r.relation || "contributor" })]),
              el("td", { text: r.scope || "—" }),
              el("td", {}, [el("span", { class: `pill pill--${r.status === "active" ? "done" : "soft"}`, text: r.status || "active" })]),
            ]))),
          ]),
        ]),
      ]));
    }

    // Todo 列表
    if (todos.length > 0) {
      wrap.appendChild(el("section", { class: "section" }, [
        sectionHead("待办事项", `${todos.length} 条`),
        el("div", { class: "card" }, [
          el("table", { class: "tbl" }, [
            el("thead", {}, [el("tr", {}, [
              el("th", { text: "状态" }),
              el("th", { text: "标题" }),
              el("th", { text: "负责人" }),
              el("th", { text: "备注" }),
              el("th", { text: "更新" }),
            ])]),
            el("tbody", {}, todos.map((t) => el("tr", {}, [
              el("td", {}, [el("span", { class: `pill pill--${t.status === "done" ? "done" : t.status === "doing" ? "running" : t.status === "blocked" ? "failed" : "soft"}`, text: t.status || "todo" })]),
              el("td", { text: t.title || t.id || "未命名 Todo" }),
              el("td", {}, t.owner ? [el("a", { href: `#/workers/${encodeURIComponent(t.owner)}`, text: t.owner })] : [el("span", { class: "muted", text: "—" })]),
              el("td", { class: "muted", text: t.note || "—" }),
              el("td", { class: "td--time", text: fmtRelative(t.updatedAt) }),
            ]))),
          ]),
        ]),
      ]));
    }

    // 最近进展
    if (progress.length > 0) {
      wrap.appendChild(el("section", { class: "section" }, [
        sectionHead("进展流水", `最近 ${progress.length} 条`),
        el("div", { class: "card" }, [
          el("div", { class: "proj-progress" }, progress.slice(0, 20).map((pr) => el("div", { class: "proj-progress__item" }, [
            el("div", { class: "proj-progress__head" }, [
              el("span", { class: `proj-progress__status proj-progress__status--${pr.status || "note"}`, text: pr.status || "note" }),
              el("span", { class: "muted", text: fmtRelative(pr.updatedAt) }),
              pr.owner ? el("a", { class: "proj-progress__owner", href: `#/workers/${encodeURIComponent(pr.owner)}`, text: pr.owner }) : null,
            ].filter(Boolean)),
            el("div", { class: "proj-progress__text", text: pr.text || pr.summary || "—" }),
            pr.evidence ? el("div", { class: "proj-progress__evidence muted", text: `📎 ${pr.evidence}` }) : null,
          ]))),
        ]),
      ]));
    }

    // Worktrees
    if (worktrees.length > 0) {
      wrap.appendChild(el("section", { class: "section" }, [
        sectionHead("Worktrees", "Git worktree 分配"),
        el("div", { class: "card" }, [
          el("table", { class: "tbl" }, [
            el("thead", {}, [el("tr", {}, [
              el("th", { text: "路径" }),
              el("th", { text: "分支" }),
              el("th", { text: "负责人" }),
              el("th", { text: "状态" }),
            ])]),
            el("tbody", {}, worktrees.map((w) => el("tr", {}, [
              el("td", { class: "td--mono", text: w.path || "—" }),
              el("td", { class: "td--mono", text: w.branch || "—" }),
              el("td", {}, w.worker ? [el("a", { href: `#/workers/${encodeURIComponent(w.worker)}`, text: w.worker })] : [el("span", { class: "muted", text: "—" })]),
              el("td", {}, [el("span", { class: `pill pill--${w.status === "active" ? "done" : w.status === "merged" ? "soft" : "stale"}`, text: w.status || "active" })]),
            ]))),
          ]),
        ]),
      ]));
    }

    // 最近 Jobs
    if (recentJobs.length > 0) {
      wrap.appendChild(el("section", { class: "section" }, [
        sectionHead("最近 Jobs", `最近 20 条（共 ${jobs.total}）`),
        el("div", { class: "card" }, [
          el("table", { class: "tbl" }, [
            el("thead", {}, [el("tr", {}, [
              el("th", { text: "状态" }),
              el("th", { text: "ID" }),
              el("th", { text: "员工" }),
              el("th", { text: "任务" }),
              el("th", { text: "耗时" }),
              el("th", { text: "更新" }),
            ])]),
            el("tbody", {}, recentJobs.map((j) => el("tr", { onclick: () => { if (j.id) location.hash = `#/jobs/${j.id}`; } }, [
              el("td", {}, [statusPill(j.status)]),
              el("td", { class: "td--mono", text: (j.id || "").slice(-6) }),
              el("td", {}, j.worker ? [el("a", { href: `#/workers/${encodeURIComponent(j.worker)}`, text: j.worker })] : [el("span", { text: "—" })]),
              el("td", { class: "td--task", title: j.task, text: j.task || "—" }),
              el("td", { class: "td--mono", text: j.elapsedSeconds != null ? `${j.elapsedSeconds}s` : "—" }),
              el("td", { class: "td--time", text: fmtRelative(j.updatedAt) }),
            ]))),
          ]),
        ]),
      ]));
    }

    // Aliases
    if (p.aliases && p.aliases.length > 0) {
      wrap.appendChild(el("section", { class: "section" }, [
        el("div", { class: "muted", text: `别名: ${p.aliases.join(" · ")}` }),
      ]));
    }

    return wrap;
  }

  // ---- Schedules 页面 ----
  async function renderSchedules() {
    const wrap = el("div", { class: "page page--schedules" });
    wrap.appendChild(el("div", { class: "warn-banner" }, [
      el("strong", { text: "⏱ 定时任务视图展示 queue.jsonl 中的 runner/cron/factory_queue 条目，不含 project-recorded 履历标记。" }),
    ]));
    wrap.appendChild(el("section", { class: "section" }, [
      sectionHead("调度概览", "定时 / 循环 / 一次性队列任务"),
    ]));

    const res = await api("/api/schedules?limit=200");
    if (!res.ok) {
      wrap.appendChild(errorBox("加载调度失败", res.detail));
      return wrap;
    }

    const d = res.data;
    const counts = d.counts || {};

    // KPI 行
    wrap.appendChild(el("section", { class: "section" }, [
      el("div", { class: "kpi-row" }, [
        trendKpi("总条目", String(d.total || 0), `展示 ${d.shown || 0}`),
        trendKpi("循环任务", String(d.repeatCount || 0), "有 repeat 字段"),
        trendKpi("Running", String(counts.running || 0), "执行中"),
        trendKpi("Done", String(counts.done || 0), "已完成"),
        trendKpi("Stale", String(counts.stale || 0), "需关注"),
        counts.failed ? trendKpi("Failed", String(counts.failed), "失败") : null,
      ].filter(Boolean)),
    ]));

    // 状态分布条
    const statusKeys = ["running", "done", "stale", "failed", "queued", "orphan-running", "aborted"];
    const totalExec = statusKeys.reduce((s, k) => s + (counts[k] || 0), 0) || 1;
    wrap.appendChild(el("section", { class: "section" }, [
      el("div", { class: "card" }, [
        cardHead("状态分布", "按执行状态聚合"),
        el("div", { class: "sched-bar" },
          statusKeys.filter((k) => counts[k]).map((k) => el("span", {
            class: `sched-bar__seg sched-bar__seg--${k}`,
            style: `flex: ${counts[k]};`,
            title: `${STATUS_LABELS[k] || k}: ${counts[k]} (${Math.round(counts[k] / totalExec * 100)}%)`,
          }))
        ),
        el("div", { class: "sched-legend" },
          statusKeys.filter((k) => counts[k]).map((k) => el("span", { class: "sched-legend__item" }, [
            el("span", { class: `sched-legend__dot sched-legend__dot--${k}` }),
            el("span", { text: `${STATUS_LABELS[k] || k}: ${counts[k]}` }),
          ]))
        ),
      ]),
    ]));

    // 循环任务高亮
    const repeatEntries = (d.entries || []).filter((e) => e.repeat != null);
    if (repeatEntries.length > 0) {
      wrap.appendChild(el("section", { class: "section" }, [
        sectionHead("循环任务", "有 repeat 间隔的定时任务"),
        el("div", { class: "card" }, [
          el("table", { class: "tbl sched-tbl" }, [
            el("thead", {}, [el("tr", {}, [
              el("th", { text: "状态" }),
              el("th", { text: "员工" }),
              el("th", { text: "项目" }),
              el("th", { text: "任务" }),
              el("th", { text: "间隔" }),
              el("th", { text: "最近执行" }),
            ])]),
            el("tbody", {}, repeatEntries.slice(0, 20).map((e) => el("tr", {}, [
              el("td", {}, [statusPill(e.status)]),
              el("td", { text: e.worker || "—" }),
              el("td", { class: "td--proj", text: e.project || "—" }),
              el("td", { class: "td--task", title: e.taskFull || e.task, text: e.task || "—" }),
              el("td", { class: "td--mono", text: e.repeat != null ? `${e.repeat}min` : "—" }),
              el("td", { class: "td--time", text: fmtRelative(e.time) }),
            ]))),
          ]),
        ]),
      ]));
    }

    // 全量条目表格
    const entries = d.entries || [];
    wrap.appendChild(el("section", { class: "section" }, [
      sectionHead("全部条目", `最近 ${entries.length} 条（按时间倒序）`),
      el("div", { class: "card" }, [
        el("table", { class: "tbl sched-tbl" }, [
          el("thead", {}, [el("tr", {}, [
            el("th", { text: "状态" }),
            el("th", { text: "员工" }),
            el("th", { text: "项目" }),
            el("th", { text: "任务" }),
            el("th", { text: "耗时" }),
            el("th", { text: "时间" }),
          ])]),
          el("tbody", {}, entries.length === 0
            ? [el("tr", {}, [el("td", { colspan: 6, class: "td--empty" }, [emptyState("暂无调度条目", "使用 factory_queue 添加定时任务后会出现在这里。")])])]
            : entries.map((e) => el("tr", { onclick: () => { if (e.id) location.hash = `#/jobs`; } }, [
              el("td", {}, [statusPill(e.status)]),
              el("td", { text: e.worker || "—" }),
              el("td", { class: "td--proj", text: e.project || "—" }),
              el("td", { class: "td--task", title: e.taskFull || e.task, text: e.task || "—" }),
              el("td", { class: "td--mono", text: e.elapsed != null ? `${e.elapsed}s` : e.repeat != null ? `${e.repeat}min↻` : "—" }),
              el("td", { class: "td--time", text: fmtRelative(e.time) }),
            ]))
          ),
        ]),
      ]),
    ]));

    return wrap;
  }

  async function renderCompactions() {
    const wrap = el("div", { class: "page page--compactions" });
    wrap.appendChild(el("div", { class: "warn-banner" }, [
      el("strong", { text: "⚠ Codex shadow 压缩只用于评估，不会替换 Pi 真实压缩结果。" }),
    ]));
    const qualityHost = el("div", { id: "qualityMetricsHost" }, [
      el("section", { class: "section section--quality" }, [
        sectionHead("上下文 / 回复质量观测", "正在异步加载；压缩对比记录会先展示，避免整页被历史回溯阻塞。"),
        el("div", { class: "card" }, [el("p", { class: "muted", text: "加载质量观测中…" })]),
      ]),
    ]);
    wrap.appendChild(qualityHost);
    window.FactorySkin?.decorateLoading(qualityHost.querySelector(".card"));
    queueMicrotask(async () => {
      try {
        const node = await renderQualityMetrics();
        if (!document.contains(qualityHost)) return;
        qualityHost.innerHTML = "";
        qualityHost.appendChild(node);
      } catch (error) {
        if (!document.contains(qualityHost)) return;
        qualityHost.innerHTML = "";
        qualityHost.appendChild(errorBox("加载质量观测失败", String(error?.message || error)));
      }
    });
    wrap.appendChild(el("section", { class: "section" }, [
      sectionHead("压缩对比记录", "主 agent / 员工 · Pi (真实) vs Codex (shadow，仅评估)"),
    ]));
    const res = await api("/api/compactions?target=all&limit=50");
    if (!res.ok) {
      wrap.appendChild(errorBox("加载压缩记录失败", res.detail));
    } else {
      const d = res.data;
      wrap.appendChild(el("section", { class: "section" }, [
        el("div", { class: "card" }, [
          cardHead(`记录 (${d.total})`, "side-by-side 摘要对比"),
          d.records && d.records.length
            ? el("div", { class: "cmp-list" }, d.records.map((r) => el("div", { class: "cmp-card" }, [
                el("div", { class: "cmp-card__head" }, [
                  el("span", { class: `tag tag--${r.targetType === "main" ? "main" : "soft"}`, text: r.targetType === "main" ? "主 agent" : r.worker || "员工" }),
                  el("span", { class: "muted", text: fmtTime(r.createdAt) }),
                ]),
                el("div", { class: "cmp-card__grid" }, [
                  el("div", { class: "cmp-card__col cmp-card__col--pi" }, [
                    el("div", { class: "cmp-card__label", text: `Pi · ${r.pi?.summaryChars || 0}字 · ~${r.pi?.estimatedTokens || 0} tok` }),
                    el("pre", { class: "cmp-card__body", text: r.pi?.summary || "(空)" }),
                  ]),
                  el("div", { class: "cmp-card__col cmp-card__col--codex" }, [
                    el("div", { class: "cmp-card__label", text: `Codex · ${r.codex?.summaryChars || 0}字 · ~${r.codex?.estimatedTokens || 0} tok${r.codex?.error ? " · 失败" : ""}` }),
                    el("pre", { class: "cmp-card__body", text: r.codex?.summary || r.codex?.error || "(空)" }),
                  ]),
                ]),
              ])))
            : emptyState("暂无压缩记录"),
        ]),
      ]));
    }
    return wrap;
  }

  async function renderQualityMetrics() {
    const hash = location.hash || "#/compactions";
    const query = new URLSearchParams(hash.split("?")[1] || "");
    STATE.qualityDateMode = query.get("qdate") === "day" ? "day" : "all";
    STATE.qualityDate = query.get("date") || STATE.qualityDate || todayLocal();
    const selectedDate = STATE.qualityDateMode === "all" ? "all" : STATE.qualityDate;
    const displayDate = selectedDate === "all" ? "全部历史" : selectedDate;

    function applyQualityFilters(patch = {}) {
      const nextMode = patch.mode || STATE.qualityDateMode || "all";
      const nextDate = patch.date || STATE.qualityDate || todayLocal();
      STATE.qualityDateMode = nextMode === "day" ? "day" : "all";
      STATE.qualityDate = nextDate;
      const newHash = STATE.qualityDateMode === "all"
        ? "#/compactions?qdate=all"
        : `#/compactions?qdate=day&date=${encodeURIComponent(STATE.qualityDate)}`;
      if (location.hash !== newHash) history.replaceState(null, "", newHash);
      void route();
    }

    const section = el("section", { class: "section section--quality" }, [
      sectionHead("上下文 / 回复质量观测", "回溯 jobs/events/session：当前上下文估算、历史文件体量、压缩次数、输入/输出长度、耗时、工具调用、情绪评分"),
    ]);
    section.appendChild(el("div", { class: "filters quality-filters" }, [
      el("div", { class: "filters__group" }, [
        el("label", { class: "filters__label", text: "范围" }),
        el("select", {
          class: "input",
          id: "qualityDateMode",
          onchange: (e) => applyQualityFilters({ mode: e.target.value }),
        }, [
          el("option", { value: "all", text: "全部历史", ...(STATE.qualityDateMode === "all" ? { selected: "selected" } : {}) }),
          el("option", { value: "day", text: "指定日期", ...(STATE.qualityDateMode === "day" ? { selected: "selected" } : {}) }),
        ]),
      ]),
      el("div", { class: "filters__group" }, [
        el("label", { class: "filters__label", text: "日期" }),
        el("input", {
          class: "input",
          type: "date",
          id: "qualityDate",
          value: STATE.qualityDate,
          max: todayLocal(),
          disabled: STATE.qualityDateMode === "all" ? "disabled" : null,
          oninput: (e) => applyQualityFilters({ mode: "day", date: e.target.value }),
          onchange: (e) => applyQualityFilters({ mode: "day", date: e.target.value }),
        }),
      ]),
      el("div", { class: "filters__group filters__group--grow" }, [
        el("span", { class: "filters__hint", text: "全部历史会回溯可用 jobs/events/session；明显坏数据会丢弃，不补情绪分。" }),
      ]),
    ]));

    const limitParam = selectedDate === "all" ? "all" : "120";
    const res = await api(`/api/quality-metrics?date=${encodeURIComponent(selectedDate)}&limit=${encodeURIComponent(limitParam)}`);
    if (!res.ok) {
      section.appendChild(errorBox("加载质量观测失败", res.detail));
      return section;
    }
    const d = res.data || {};
    const totals = d.totals || {};
    const config = d.config || {};
    const workers = d.workers || [];
    const turns = d.turns || [];
    const dates = d.dates || [];
    const history = d.history || {};
    section.appendChild(el("div", { class: "quality-panel" }, [
      el("div", { class: "kpi-row" }, [
        trendKpi("样本 Turn", String(totals.turns || 0), displayDate),
        trendKpi("压缩次数", String(totals.compactions || 0), "所有员工 session"),
        trendKpi("平均耗时", fmtDurationMs(totals.avgResponseMs), "job elapsed"),
        trendKpi("工具调用", String(totals.toolCalls || 0), "tool_start events", SUBAGENT_TOOL_NOTE),
        trendKpi("已评分", String(totals.scoredTurns || 0), config.enabled ? "情绪旁路已开启" : "情绪旁路关闭"),
        trendKpi("丢弃", String(history.droppedJobs || 0), Object.entries(history.dropReasons || {}).map(([k, v]) => `${k}:${v}`).join(" · ") || "无明显坏数据"),
      ]),
      el("div", {class:"card"}, [
        cardHead("API 参考费用", "按本页日期与样本范围折算；含运行中及失败任务已记录的消耗，非账单。"),
        el("p", {text: `${apiCostText(d.apiCost)} · 已估算 ${d.apiCost?.pricedJobs || 0} 项 · 未能估算 ${d.apiCost?.unpricedJobs || 0} 项`}),
        el("p", {class:"muted",text:"默认 Standard 短上下文参考价；不含缓存写入、图片生成、搜索等额外费用，不自动识别 Fast / 长上下文 / 区域加价。"}),
        el("div", {class:"table-wrap"}, [el("table", {class:"table quality-table"}, [
          el("thead", {}, [el("tr", {}, [el("th", {text:"员工"}), sortableNumericTh("参考费用 $"), sortableNumericTh("计价样本"), sortableNumericTh("未计价")])]),
          el("tbody", {}, (d.costByWorker || []).map(row=>el("tr", {}, [
            el("td", {text:row.worker}), numericTd(row.usd ?? -1, apiCostText(row)),
            numericTd(row.pricedJobs, String(row.pricedJobs)), numericTd(row.unpricedJobs, String(row.unpricedJobs)),
          ]))),
        ])]),
      ]),
      dates.length > 1 ? el("div", { class: "card" }, [
        cardHead(`历史分布 (${dates.length} 天)`, "按天回溯可用 turn；点击日期切换到当天"),
        el("div", { class: "quality-date-strip" }, dates.map((day) => el("button", {
          class: "quality-date-strip__item",
          onclick: () => applyQualityFilters({ mode: "day", date: day.date }),
          title: `${day.date}\nturn ${day.turns}\n员工 ${day.workers}\n平均耗时 ${fmtDurationMs(day.avgResponseMs)}`,
        }, [
          el("span", { class: "quality-date-strip__date", text: day.date.slice(5) }),
          el("span", { class: "quality-date-strip__bar", style: `height:${Math.max(8, Math.min(80, day.turns * 8))}px` }),
          el("span", { class: "quality-date-strip__val", text: String(day.turns) }),
        ]))),
      ]) : null,
      el("div", { class: "card" }, [
        cardHead("模型执行对比", "按本页日期和样本范围聚合；仅完成任务，排除 steer。耗时 = finishedAt − startedAt，不含排队，包含工具执行与等待；缺失值不算作 0。"),
        el("p", { class: "muted", text: "Token 各列按实际有记录的样本独立求均值（悬停查看样本数）。费用列包含运行中/失败任务的已记录消耗，均价分母为计价样本；任务难度不同，不代表模型能力排名。" }),
        (d.models || []).length ? el("div", { class: "table-wrap" }, [
          el("table", { class: "table quality-table" }, [
            el("thead", {}, [el("tr", {}, [
              el("th", { text: "模型" }),
              ...["完成数", "耗时样本", "缺失耗时", "排除 steer", "平均耗时", "耗时中位数", "平均输入 Token", "平均输出 Token", "平均缓存 Token", "平均含缓存总 Token", "参考费用 $", "平均每计价任务 $", "计价样本", "未计价"].map(label => sortableNumericTh(label)),
            ])]),
            el("tbody", {}, d.models.map(row => el("tr", {}, [
              el("td", { class: "td--mono", text: row.model }),
              numericTd(row.completed, String(row.completed)),
              numericTd(row.durationSamples, String(row.durationSamples)),
              numericTd(row.missingDuration, String(row.missingDuration)),
              numericTd(row.excludedSteer, String(row.excludedSteer)),
              numericTd(row.avgDurationMs ?? -1, row.avgDurationMs == null ? "—" : fmtDurationMs(row.avgDurationMs)),
              numericTd(row.medianDurationMs ?? -1, row.medianDurationMs == null ? "—" : fmtDurationMs(row.medianDurationMs)),
              ...["inputTokens", "outputTokens", "cachedInputTokens", "totalWithCachedTokens"].map(field => {
                const metric = row.tokens[field];
                const cell = numericTd(metric.average ?? -1, metric.average == null ? "—" : fmtNumber(metric.average));
                cell.title = `有效样本 ${metric.samples} · 缺失 ${metric.missing}`;
                return cell;
              }),
              numericTd(row.apiCost?.usd ?? -1, apiCostText(row.apiCost)),
              numericTd(row.apiCost?.avgUsd ?? -1, row.apiCost?.avgUsd == null ? "—" : `≈ $${row.apiCost.avgUsd.toFixed(4)}`),
              numericTd(row.apiCost?.pricedJobs || 0, String(row.apiCost?.pricedJobs || 0)),
              numericTd(row.apiCost?.unpricedJobs || 0, String(row.apiCost?.unpricedJobs || 0)),
            ]))),
          ]),
        ]) : emptyState("当前范围暂无模型统计"),
      ]),
      el("div", { class: "card" }, [
        cardHead(`员工质量指标 (${workers.length})`, `评分: ${config.enabled ? "开启" : "关闭"} · ${config.provider || "—"}/${config.model || "—"} · ${history.exactContextPerTurn ? "精确上下文" : "历史回放估算"} · usable ${history.usableJobs ?? totals.turns ?? 0}/${history.candidateJobs ?? "—"}`),
        workers.length
          ? el("div", { class: "table-wrap" }, [
              el("table", { class: "table quality-table" }, [
                el("thead", {}, [el("tr", {}, [
                  el("th", { text: "员工" }),
                  sortableNumericTh("会话轮次"),
                  sortableNumericTh("当前上下文"),
                  sortableNumericTh("历史文件"),
                  sortableNumericTh("压缩"),
                  sortableNumericTh("样本"),
                  sortableNumericTh("平均输入"),
                  sortableNumericTh("平均输出"),
                  sortableNumericTh("平均耗时"),
                  sortableNumericTh("工具"),
                  sortableNumericTh("情绪"),
                ])]),
                el("tbody", {}, workers.map((w) => el("tr", {}, [
                  el("td", { class: "td--mono", text: w.worker || "—" }),
                  numericTd(w.session?.userTurns || 0, String(w.session?.userTurns || 0)),
                  numericTd(w.session?.activeContextTokens ?? w.session?.estimatedContextTokens ?? 0, fmtNumber(w.session?.activeContextTokens ?? w.session?.estimatedContextTokens ?? 0)),
                  numericTd(w.session?.sessionFileTokens || 0, fmtNumber(w.session?.sessionFileTokens || 0)),
                  numericTd(w.session?.compactionCount || 0, String(w.session?.compactionCount || 0)),
                  numericTd(w.jobs?.count || 0, String(w.jobs?.count || 0)),
                  numericTd(w.jobs?.avgInputChars || 0, fmtNumber(w.jobs?.avgInputChars || 0)),
                  numericTd(w.jobs?.avgOutputChars || 0, fmtNumber(w.jobs?.avgOutputChars || 0)),
                  numericTd(w.jobs?.avgResponseMs || 0, fmtDurationMs(w.jobs?.avgResponseMs || 0)),
                  numericTd(w.jobs?.toolCalls || 0, String(w.jobs?.toolCalls || 0)),
                  numericTd(w.jobs?.avgEmotionScore ?? "", w.jobs?.avgEmotionScore == null ? "—" : String(w.jobs.avgEmotionScore)),
                ]))),
              ]),
            ])
          : emptyState("暂无质量指标样本", "产生员工 job 后会自动聚合。"),
      ]),
      el("div", { class: "card" }, [
        cardHead(`最近 Turn (${turns.length})`, "情绪分绑定当前用户输入；低分通常意味着用户对上一轮表现不满"),
        turns.length
          ? el("div", { class: "table-wrap" }, [
              el("table", { class: "table quality-turn-table" }, [
                el("thead", {}, [el("tr", {}, [
                  el("th", { text: "时间" }),
                  el("th", { text: "员工" }),
                  sortableNumericTh("输入"),
                  sortableNumericTh("输出"),
                  sortableNumericTh("耗时"),
                  sortableNumericTh("工具"),
                  sortableNumericTh("上下文"),
                  sortableNumericTh("压缩"),
                  sortableNumericTh("情绪"),
                  el("th", { text: "任务" }),
                ])]),
                el("tbody", {}, turns.slice(0, 30).map((turn) => el("tr", { onclick: () => { location.hash = `#/jobs/${encodeURIComponent(turn.jobId)}`; } }, [
                  el("td", { class: "td--time", text: fmtTime(turn.createdAt) }),
                  el("td", { class: "td--mono", text: turn.worker || "—" }),
                  numericTd(turn.inputChars || 0, fmtNumber(turn.inputChars)),
                  numericTd(turn.outputChars || 0, fmtNumber(turn.outputChars)),
                  numericTd(turn.responseMs || 0, fmtDurationMs(turn.responseMs)),
                  numericTd(turn.toolCalls || 0, String(turn.toolCalls || 0)),
                  numericTd(turn.sessionContextTokens || 0, fmtNumber(turn.sessionContextTokens || 0)),
                  numericTd(turn.sessionCompactions || 0, String(turn.sessionCompactions || 0)),
                  numericTd(turn.emotionScore ?? "", turn.emotionScore == null ? "—" : `${turn.emotionScore}${turn.emotionLabel ? ` · ${turn.emotionLabel}` : ""}`),
                  el("td", { class: "td--task", title: turn.taskPreview || "", text: turn.taskPreview || "—" }),
                ]))),
              ]),
            ])
          : emptyState(`${displayDate} 暂无可用 turn 样本`, "queued/running、坏时间、空输入/空输出等不一致数据会被丢弃。"),
      ]),
      // 趋势 / 散点图表：自变量 vs 因变量的关系胉示
      buildQualityCharts(turns, workers, totals),
    ]));
    return section;
  }

  // ------------------------------------------------------------------
  // QualityCharts · 单员工按轮次 / 输入 / 上下文看输出 / 工具调用 / 耗时 / 情绪
  // 自制 SVG，不引第三方库
  // ------------------------------------------------------------------
  function buildQualityCharts(turns, workers, totals) {
    STATE.qualityCharts = { turns, workers, totals };
    if (!STATE.qualityChartWorker || !(workers || []).find((w) => w.worker === STATE.qualityChartWorker)) {
      STATE.qualityChartWorker = "all";
    }
    const card = el("div", { class: "card quality-charts" });
    card.appendChild(cardHead("趋势图谱 · 单员工分析", "默认全部员工；选择员工后只看该员工。点散点可跳到 Job Drawer。"));
    const select = el("select", {
      class: "input",
      id: "qualityChartWorker",
      onchange: (e) => { STATE.qualityChartWorker = e.target.value; refreshQualityCharts(); ensureModelIndexAndRender(); },
    }, [
      el("option", { value: "all", text: `全部员工 (${turns.length})` }),
      ...workers.map((w) =>
        el("option", { value: w.worker, text: `${w.worker} (${w.jobs?.count || 0} jobs)`,
        ...(w.worker === STATE.qualityChartWorker ? { selected: "selected" } : {}) })),
    ]);
    card.appendChild(el("div", { class: "quality-charts__filter" }, [
      el("span", { class: "tag tag--soft", text: "员工" }),
      select,
      el("span", { class: "muted", id: "qualityChartSummary" }),
    ]));
    card.appendChild(el("div", { class: "charts-grid", id: "qualityChartsGrid" }));

    // 自定义散点图：任意选择 X / Y 字段的两两组合
    card.appendChild(buildCustomChart(turns));

    queueMicrotask(() => refreshQualityCharts());
    return card;
  }

  // 默认任两两
  const CUSTOM_FIELDS = [
    { key: "inputChars",          label: "输入字符",       fmt: fmtNumber },
    { key: "outputChars",         label: "输出字符",       fmt: fmtNumber },
    { key: "inputTokens",         label: "输入 token",     fmt: fmtNumber },
    { key: "outputTokens",        label: "输出 token",     fmt: fmtNumber },
    { key: "totalTokens",         label: "总 token",       fmt: fmtNumber },
    { key: "toolCalls",           label: "工具调用",       fmt: (n) => String(Math.round(n)) },
    { key: "responseMs",          label: "耗时 (ms)",      fmt: fmtNumber },
    { key: "elapsedMs",           label: "elapsedMs",      fmt: fmtNumber },
    { key: "sessionContextTokens",label: "当前上下文 token",fmt: fmtNumber },
    { key: "sessionUserTurns",    label: "会话轮次",       fmt: (n) => String(Math.round(n)) },
    { key: "sessionCompactions",  label: "压缩次数",       fmt: (n) => String(Math.round(n)) },
    { key: "turns",               label: "Turn 数",        fmt: (n) => String(Math.round(n)) },
    { key: "taskChars",           label: "任务字符数",     fmt: fmtNumber },
    { key: "summaryChars",        label: "摘要字符数",     fmt: fmtNumber },
    { key: "elapsedSeconds",      label: "耗时 (s)",       fmt: (n) => String(Math.round(n)) },
    { key: "cachedInputTokens",   label: "缓存 token",     fmt: fmtNumber },
    { key: "emotionScore",        label: "情绪分 (1-5)",   fmt: (n) => String(Math.round(n * 10) / 10) },
  ];

  function buildCustomChart(turns) {
    STATE.customChart = STATE.customChart || { xKey: "sessionContextTokens", yKey: "outputTokens" };
    STATE.customModel = STATE.customModel || "all";
    const card = el("div", { class: "card quality-custom" });
    card.appendChild(cardHead("自定义散点 · 任两两组合", "选择 X 轴与 Y 轴字段 + 员工筛选 + 模型筛选。点击点跳转到 Job Drawer。"));
    const selX = el("select", { class: "input", id: "customChartX", onchange: (e) => { STATE.customChart.xKey = e.target.value; renderCustomChart(); } },
      CUSTOM_FIELDS.map((f) => el("option", { value: f.key, text: f.label, ...(f.key === STATE.customChart.xKey ? { selected: "selected" } : {}) })));
    const selY = el("select", { class: "input", id: "customChartY", onchange: (e) => { STATE.customChart.yKey = e.target.value; renderCustomChart(); } },
      CUSTOM_FIELDS.map((f) => el("option", { value: f.key, text: f.label, ...(f.key === STATE.customChart.yKey ? { selected: "selected" } : {}) })));
    const selModel = el("select", { class: "input", id: "customChartModel", onchange: (e) => { STATE.customModel = e.target.value; renderCustomChart(); } });
    // 模型下拉选项优先从 quality turn 自带的 model 字段计算；/api/jobs 只做旧数据兜底。
    card.appendChild(el("div", { class: "quality-custom__filter" }, [
      el("span", { class: "tag tag--soft", text: "X 轴" }),
      selX,
      el("span", { class: "tag tag--soft", text: "Y 轴" }),
      selY,
      el("span", { class: "tag tag--soft", text: "按模型筛" }),
      selModel,
      el("span", { class: "muted", id: "customChartSummary" }),
    ]));
    card.appendChild(el("div", { class: "chart-card" }, [el("div", { class: "chart-card__body", id: "customChartBody" })]));
    queueMicrotask(() => ensureModelIndexAndRender());
    return card;
  }

  function modelForTurn(turn) {
    return String(turn?.model || STATE.modelByJobId?.get(turn?.jobId) || "").trim();
  }

  function rememberQualityTurnModels(turns) {
    STATE.modelByJobId = STATE.modelByJobId || new Map();
    for (const turn of turns || []) {
      const model = String(turn?.model || "").trim();
      if (turn?.jobId && model) STATE.modelByJobId.set(turn.jobId, model);
    }
  }

  function customChartScope() {
    let scope = STATE.qualityCharts?.turns || [];
    if (STATE.qualityChartWorker && STATE.qualityChartWorker !== "all") {
      scope = scope.filter((t) => t.worker === STATE.qualityChartWorker);
    }
    return scope;
  }

  // 确保 modelByJobId 索引加载，然后渲染
  async function ensureModelIndexAndRender() {
    rememberQualityTurnModels(STATE.qualityCharts?.turns || []);
    if (!STATE.modelIndexLoaded) {
      const r = await api("/api/jobs?limit=5000");
      if (r.ok) {
        for (const j of r.data.jobs || []) {
          if (j.id && j.model) STATE.modelByJobId.set(j.id, j.model);
        }
        STATE.modelIndexLoaded = true;
      }
    }
    // 填充 model 下拉
    const sel = document.getElementById("customChartModel");
    if (sel) {
      const turns = customChartScope();
      const modelSet = new Set();
      turns.forEach((t) => {
        const m = modelForTurn(t);
        if (m) modelSet.add(m);
      });
      const models = Array.from(modelSet).sort();
      sel.innerHTML = "";
      sel.appendChild(el("option", { value: "all", text: `全部 (${models.length})` }));
      for (const m of models) {
        const opt = el("option", { value: m, text: m, ...(m === STATE.customModel ? { selected: "selected" } : {}) });
        sel.appendChild(opt);
      }
      if (![...sel.options].some((o) => o.value === STATE.customModel)) {
        STATE.customModel = "all";
      }
    }
    renderCustomChart();
  }

  function renderCustomChart() {
    const body = document.getElementById("customChartBody");
    if (!body) return;
    body.innerHTML = "";
    const xKey = STATE.customChart.xKey;
    const yKey = STATE.customChart.yKey;
    if (!xKey || !yKey) {
      body.appendChild(emptyState("请选择 X 轴和 Y 轴"));
      return;
    }
    if (xKey === yKey) {
      body.appendChild(emptyState("X 与 Y 不能是同一字段"));
      return;
    }
    const xField = CUSTOM_FIELDS.find((f) => f.key === xKey);
    const yField = CUSTOM_FIELDS.find((f) => f.key === yKey);
    if (!xField || !yField) {
      body.appendChild(emptyState("字段不存在"));
      return;
    }
    rememberQualityTurnModels(STATE.qualityCharts?.turns || []);
    let scope = customChartScope();
    if (STATE.customModel && STATE.customModel !== "all") {
      scope = scope.filter((t) => modelForTurn(t) === STATE.customModel);
    }
    if (!scope.length) {
      body.appendChild(emptyState("无 turn 样本"));
      return;
    }
    // 使用与 chartScatter 同样的 SVG 但带自定义 fmt + 颜色
    const title = `${xField.label} → ${yField.label}`;
    const head = el("div", { class: "chart-card__head" }, [
      el("h4", { class: "chart-card__title", text: title }),
      el("span", { class: "chart-card__hint", text: `${scope.length} 点 · ${xField.label} · ${yField.label}${STATE.customModel && STATE.customModel !== "all" ? ` · 仅 ${STATE.customModel}` : ""}` }),
    ]);
    body.appendChild(head);
    const tip = el("div", { class: "chart-tip" });
    const svg = renderScatterSvg(scope, xKey, yKey, xField.label, yField.label, xField.fmt, yField.fmt);
    svg.querySelectorAll("circle").forEach((c, i) => {
      c.addEventListener("mouseenter", (e) => showChartTip(tip, scope[i], scope[i], e));
      c.addEventListener("mouseleave", () => tip.classList.remove("chart-tip--show"));
      c.addEventListener("click", () => { location.hash = `#/jobs/${encodeURIComponent(scope[i].jobId)}`; });
    });
    body.appendChild(svg);
    body.appendChild(tip);
    const sum = document.getElementById("customChartSummary");
    if (sum) {
      const xs = scope.map((d) => Number(d[xKey] || 0));
      const ys = scope.map((d) => Number(d[yKey] || 0));
      const avgX = xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
      const avgY = ys.length ? Math.round(ys.reduce((a, b) => a + b, 0) / ys.length) : 0;
      sum.textContent = `${scope.length} 点 · 均 ${xField.label} ${xField.fmt(avgX)} · 均 ${yField.label} ${yField.fmt(avgY)}`;
    }
  }

  function refreshQualityCharts() {
    const grid = document.getElementById("qualityChartsGrid");
    if (!grid) return;
    const data = STATE.qualityCharts;
    if (!data) return;
    let turns = data.turns || [];
    if (STATE.qualityChartWorker && STATE.qualityChartWorker !== "all") {
      turns = turns.filter((t) => t.worker === STATE.qualityChartWorker);
    }
    grid.innerHTML = "";
    if (!turns.length) {
      grid.appendChild(emptyState("该员工暂无 turn 样本"));
      const sum = document.getElementById("qualityChartSummary");
      if (sum) sum.textContent = "";
      return;
    }
    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const sum = document.getElementById("qualityChartSummary");
    if (sum) sum.textContent = `样本 ${turns.length} 个 turn · 员工: ${STATE.qualityChartWorker === "all" ? "全部" : STATE.qualityChartWorker}`;
    // KPI mini
    grid.appendChild(el("div", { class: "kpi-row quality-kpi-row" }, [
      trendKpi("样本 turn", String(turns.length), "本次过滤后"),
      trendKpi("输入字符(均)", fmtNumber(Math.round(avg(turns.map((t) => t.inputChars || 0)))), "inputChars"),
      trendKpi("输出字符(均)", fmtNumber(Math.round(avg(turns.map((t) => t.outputChars || 0)))), "outputChars"),
      trendKpi("耗时(均)", fmtDurationMs(Math.round(avg(turns.map((t) => t.responseMs || 0)))), "responseMs"),
      trendKpi("工具/turn", (avg(turns.map((t) => t.toolCalls || 0))).toFixed(1), "tool_start 计数", SUBAGENT_TOOL_NOTE),
    ]));
    // 6 charts · 输入、上下文、时间趋势、情绪
    grid.appendChild(chartScatter("输入字符 → 输出字符", turns, "inputChars", "outputChars", "输入字符", "输出字符"));
    grid.appendChild(chartScatter("工具调用 → 输出字符", turns, "toolCalls", "outputChars", "工具调用数", "输出字符", { titleNote: SUBAGENT_TOOL_NOTE }));
    grid.appendChild(chartScatter("输入 token → 输出 token", turns, "inputTokens", "outputTokens", "输入 token", "输出 token"));
    grid.appendChild(chartScatter("耗时 ms → 输出字符", turns, "responseMs", "outputChars", "耗时 (ms)", "输出字符"));
    grid.appendChild(chartScatter("当前上下文 → 输出 token", turns, "sessionContextTokens", "outputTokens", "sessionContextTokens", "输出 token"));
    grid.appendChild(chartScatter("会话轮次 → 输出字符", turns, "sessionUserTurns", "outputChars", "sessionUserTurns", "输出字符"));
    grid.appendChild(chartLine("时间序列：输入/输出 token", turns, "createdAt", [
      { key: "inputTokens", label: "输入", color: "var(--seg-input)" },
      { key: "outputTokens", label: "输出", color: "var(--seg-output)" },
    ]));
    grid.appendChild(chartLine("时间序列：工具调用 / 耗时", turns, "createdAt", [
      { key: "toolCalls", label: "工具调用", color: "var(--seg-cache)" },
      { key: "responseMs", label: "耗时(ms)", color: "var(--seg-reasoning)" },
    ], { titleNote: SUBAGENT_TOOL_NOTE }));
    const emotionTurns = turns.filter((t) => isValidEmotionScore(t.emotionScore));
    if (emotionTurns.length) {
      grid.appendChild(chartLine("情绪评分（情绪旁路开启时）", emotionTurns, "createdAt", [
        { key: "emotionScore", label: "情绪 1-5", color: "var(--accent)" },
      ]));
    }
  }

  // ------------------------------------------------------------------
  // SVG 图表 helpers · 零依赖
  // ------------------------------------------------------------------
  function svgEl(name, attrs = {}) {
    const n = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      n.setAttribute(k, String(v));
    }
    return n;
  }

  function renderScatterSvg(data, xKey, yKey, xLabel, yLabel, xFmt, yFmt) {
    const W = 520, H = 220, pad = { l: 56, r: 12, t: 12, b: 28 };
    const innerW = W - pad.l - pad.r, innerH = H - pad.t - pad.b;
    const svg = svgEl("svg", { class: "chart-svg", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${xLabel || xKey} → ${yLabel || yKey}` });
    // 软背景参考线
    for (let i = 0; i < 4; i++) {
      const y = pad.t + (innerH * i) / 4;
      svg.appendChild(svgEl("line", { x1: pad.l, y1: y, x2: W - pad.r, y2: y, stroke: "var(--grid-line)", "stroke-width": 1 }));
    }
    // 计算范围
    const xs = data.map((d) => Number(d[xKey] || 0));
    const ys = data.map((d) => Number(d[yKey] || 0));
    const xMin = Math.min(...xs), xMax = Math.max(...xs, xMin + 1);
    const yMin = Math.min(...ys), yMax = Math.max(...ys, yMin + 1);
    const fmtX = xFmt || ((n) => fmtNumber(Math.round(n)));
    const fmtY = yFmt || ((n) => fmtNumber(Math.round(n)));
    // y 轴标签
    const labelY = svgEl("text", { x: pad.l - 8, y: pad.t + innerH / 2, "text-anchor": "end", "font-size": 10, fill: "var(--text-muted)", "dominant-baseline": "middle" });
    labelY.textContent = yLabel || yKey;
    svg.appendChild(labelY);
    // x 轴标签
    const labelX = svgEl("text", { x: pad.l + innerW / 2, y: H - 6, "text-anchor": "middle", "font-size": 10, fill: "var(--text-muted)" });
    labelX.textContent = xLabel || xKey;
    svg.appendChild(labelX);
    // x 轴范围
    [xMin, xMax].forEach((val, i) => {
      const x = pad.l + (innerW * i);
      const t = svgEl("text", { x, y: pad.t + innerH + 14, "text-anchor": i === 0 ? "start" : "end", "font-size": 9, fill: "var(--text-muted)" });
      t.textContent = fmtX(val);
      svg.appendChild(t);
    });
    // y 轴范围
    [yMin, yMax].forEach((val, i) => {
      const y = pad.t + innerH - (innerH * i);
      const t = svgEl("text", { x: pad.l - 4, y, "text-anchor": "end", "font-size": 9, fill: "var(--text-muted)", "dominant-baseline": i === 0 ? "auto" : "hanging" });
      t.textContent = fmtY(val);
      svg.appendChild(t);
    });
    // 点
    data.forEach((d) => {
      const x = pad.l + ((Number(d[xKey] || 0) - xMin) / (xMax - xMin || 1)) * innerW;
      const y = pad.t + innerH - ((Number(d[yKey] || 0) - yMin) / (yMax - yMin || 1)) * innerH;
      if (Number.isNaN(x) || Number.isNaN(y)) return;
      const point = svgEl("circle", { cx: x, cy: y, r: 4, fill: "var(--accent)", "fill-opacity": 0.55, stroke: "var(--accent-strong)", "stroke-width": 1 });
      svg.appendChild(point);
    });
    return svg;
  }

  function chartScatter(title, data, xKey, yKey, xLabel, yLabel, opts = {}) {
    const titleChildren = [el("span", { class: "chart-card__title-text", text: title })];
    if (opts.titleNote) titleChildren.push(noteTag(opts.titleNote));
    const card = el("div", { class: "chart-card" }, [
      el("div", { class: "chart-card__head" }, [
        el("h4", { class: "chart-card__title" }, titleChildren),
        el("span", { class: "chart-card__hint", text: `${data.length} 点 · ${xLabel || xKey} · ${yLabel || yKey}` }),
      ]),
    ]);
    const W = 520, H = 220, pad = { l: 56, r: 12, t: 12, b: 28 };
    const innerW = W - pad.l - pad.r, innerH = H - pad.t - pad.b;
    const tip = el("div", { class: "chart-tip" });
    const svg = renderScatterSvg(data, xKey, yKey, xLabel, yLabel);
    svg.querySelectorAll("circle").forEach((c, i) => {
      c.addEventListener("mouseenter", (e) => showChartTip(tip, data[i], data[i], e));
      c.addEventListener("mouseleave", () => tip.classList.remove("chart-tip--show"));
      c.addEventListener("click", () => { location.hash = `#/jobs/${encodeURIComponent(data[i].jobId)}`; });
    });
    card.appendChild(svg);
    card.appendChild(tip);
    if (!data.length) card.appendChild(emptyState("该轴无数点"));
    return card;
  }

  function chartLine(title, data, xKey, series, opts = {}) {
    // series: [{key, label, color}]
    const titleChildren = [el("span", { class: "chart-card__title-text", text: title })];
    if (opts.titleNote) titleChildren.push(noteTag(opts.titleNote));
    const card = el("div", { class: "chart-card" }, [
      el("div", { class: "chart-card__head" }, [
        el("h4", { class: "chart-card__title" }, titleChildren),
        el("div", { class: "chart-card__legend" }, series.map((s) => el("span", { class: "chart-card__legend-item" }, [
          el("span", { class: "chart-card__swatch", style: `background:${s.color}` }),
          el("span", { text: s.label }),
        ]))),
      ]),
    ]);
    const W = 520, H = 220, pad = { l: 56, r: 12, t: 12, b: 28 };
    const innerW = W - pad.l - pad.r, innerH = H - pad.t - pad.b;
    const svg = svgEl("svg", { class: "chart-svg", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": title });
    for (let i = 0; i < 4; i++) {
      const y = pad.t + (innerH * i) / 4;
      svg.appendChild(svgEl("line", { x1: pad.l, y1: y, x2: W - pad.r, y2: y, stroke: "var(--grid-line)", "stroke-width": 1 }));
    }
    // 按 x 排序
    const sorted = [...data].sort((a, b) => new Date(a[xKey] || 0).getTime() - new Date(b[xKey] || 0).getTime());
    const tsArr = sorted.map((d) => new Date(d[xKey] || 0).getTime());
    const xMin = Math.min(...tsArr), xMax = Math.max(...tsArr, xMin + 1);
    const yMin = 0;
    let yMax = 1;
    series.forEach((s) => {
      sorted.forEach((d) => {
        const v = Number(d[s.key] || 0);
        if (v > yMax) yMax = v;
      });
    });
    yMax = Math.max(yMax, 1);
    // 轴
    const labelX = svgEl("text", { x: pad.l + innerW / 2, y: H - 6, "text-anchor": "middle", "font-size": 10, fill: "var(--text-muted)" });
    labelX.textContent = "时间";
    svg.appendChild(labelX);
    const fmtNum = (n) => fmtNumber(Math.round(n));
    [yMin, yMax].forEach((val, i) => {
      const y = pad.t + innerH - (innerH * i);
      const t = svgEl("text", { x: pad.l - 4, y, "text-anchor": "end", "font-size": 9, fill: "var(--text-muted)" });
      t.textContent = fmtNum(val);
      svg.appendChild(t);
    });
    // x 轴最小最大时间
    const fmtTs = (t) => {
      const d = new Date(t);
      const pad2 = (n) => String(n).padStart(2, "0");
      return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
    };
    [xMin, xMax].forEach((val, i) => {
      const x = pad.l + (innerW * i);
      const t = svgEl("text", { x, y: pad.t + innerH + 14, "text-anchor": i === 0 ? "start" : "end", "font-size": 9, fill: "var(--text-muted)" });
      t.textContent = fmtTs(val);
      svg.appendChild(t);
    });
    // 折线
    series.forEach((s) => {
      const seriesData = sorted.filter((d) => Number(d[s.key] || 0) > 0);
      const points = seriesData
        .map((d) => {
          const t = new Date(d[xKey] || 0).getTime();
          const x = pad.l + ((t - xMin) / (xMax - xMin || 1)) * innerW;
          const y = pad.t + innerH - ((Number(d[s.key] || 0) - yMin) / (yMax - yMin || 1)) * innerH;
          return `${x},${y}`;
        });
      if (points.length > 1) {
        const path = svgEl("polyline", { points: points.join(" "), fill: "none", stroke: s.color, "stroke-width": 1.6, "stroke-opacity": 0.85 });
        svg.appendChild(path);
      } else if (points.length === 1) {
        const [x, y] = points[0].split(",");
        svg.appendChild(svgEl("circle", { cx: x, cy: y, r: 4, fill: s.color }));
      }
      // 点
      seriesData.forEach((d) => {
        const t = new Date(d[xKey] || 0).getTime();
        const x = pad.l + ((t - xMin) / (xMax - xMin || 1)) * innerW;
        const y = pad.t + innerH - ((Number(d[s.key] || 0) - yMin) / (yMax - yMin || 1)) * innerH;
        if (Number.isNaN(x) || Number.isNaN(y)) return;
        const pt = svgEl("circle", { cx: x, cy: y, r: 3, fill: s.color, "fill-opacity": 0.9 });
        pt.addEventListener("click", () => { location.hash = `#/jobs/${encodeURIComponent(d.jobId)}`; });
        svg.appendChild(pt);
      });
    });
    card.appendChild(svg);
    return card;
  }

  function isValidEmotionScore(value) {
    const score = Number(value);
    return Number.isFinite(score) && score >= 1 && score <= 5;
  }

  function showChartTip(layer, d, fallback, e) {
    if (!layer) return;
    const lines = [
      `<strong>${esc(d.worker || "—")}</strong> · ${esc(fmtTime(d.createdAt))}`,
      `job <code>${esc((d.jobId || "").slice(-6))}</code>`,
      `输入 ${esc(fmtNumber(d.inputChars || 0))} / 输出 ${esc(fmtNumber(d.outputChars || 0))} 字符`,
      `耗时 ${esc(fmtDurationMs(d.responseMs || 0))} · 工具 ${esc(String(d.toolCalls || 0))}`,
      `当前上下文 ${esc(fmtNumber(d.sessionContextTokens || 0))} · 压缩 ${esc(String(d.sessionCompactions || 0))}`,
      d.emotionScore != null ? `情绪 ${esc(String(d.emotionScore))}${d.emotionLabel ? ` · ${esc(d.emotionLabel)}` : ""}` : "",
      `任务：${esc((d.taskPreview || "—").slice(0, 80))}`,
    ].filter(Boolean);
    layer.innerHTML = lines.join("<br>");
    layer.classList.add("chart-tip--show");
    const svgRect = layer.parentElement?.querySelector("svg")?.getBoundingClientRect?.();
    if (svgRect && e?.target) {
      const targetRect = e.target.getBoundingClientRect();
      layer.style.left = `${targetRect.left - svgRect.left + 8}px`;
      layer.style.top = `${targetRect.top - svgRect.top - 8}px`;
    }
  }

  function factoryTaskQueryString(filters = STATE.factoryTaskFilters) {
    const query = new URLSearchParams();
    for (const key of ["query", "project", "status", "assignee", "priority", "executionState"]) {
      if (filters[key]) query.set(key, filters[key]);
    }
    if (filters.includeArchived) query.set("includeArchived", "true");
    query.set("limit", "1000");
    return query.toString();
  }

  function factoryTaskStatusRank(status) {
    const normalized = String(status || "").trim().toLowerCase();
    const ranks = [
      [/^(todo|待办|待处理)$/i, 10],
      [/(设计|方案)/, 20],
      [/(进行中|开发中|处理中|doing|progress)/i, 30],
      [/(blocked|阻塞|等待)/i, 40],
      [/(review|验收|评审|测试)/i, 50],
      [/(done|完成|已完成)/i, 90],
    ];
    return ranks.find(([pattern]) => pattern.test(normalized))?.[1] ?? 60;
  }

  function factoryTaskExecutionLabel(state) {
    return ({
      idle: "未执行",
      scheduled: "待触发",
      dispatching: "派发中",
      queued: "已排队",
      running: "执行中",
      succeeded: "执行成功",
      failed: "执行失败",
      cancelled: "已取消",
    })[state] || state || "未执行";
  }

  function factoryTaskPriorityLabel(priority) {
    return ({ low: "低", normal: "普通", high: "高", urgent: "紧急" })[priority] || priority || "普通";
  }

  function factoryTaskPriorityRank(priority) {
    return ({ urgent: 0, high: 1, normal: 2, low: 3 })[priority] ?? 2;
  }

  function factoryTaskCard(task) {
    const executionState = task.execution?.state || "idle";
    return el("article", {
      class: `factory-task-card factory-task-card--${task.priority || "normal"}${task.archivedAt ? " factory-task-card--archived" : ""}`,
      tabindex: "0",
      role: "button",
      draggable: "true",
      data: { taskId: task.id },
      "aria-label": `${task.title}，状态 ${task.status}，负责人 ${task.assignee || "未指派"}`,
      onclick: () => openFactoryTaskDrawer(task.id),
      onkeydown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openFactoryTaskDrawer(task.id);
        }
      },
      ondragstart: (event) => {
        STATE.factoryTaskDragId = task.id;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
        event.currentTarget.classList.add("factory-task-card--dragging");
      },
      ondragend: (event) => {
        STATE.factoryTaskDragId = null;
        event.currentTarget.classList.remove("factory-task-card--dragging");
      },
    }, [
      el("div", { class: "factory-task-card__head" }, [
        el("span", { class: `factory-task-card__priority factory-task-card__priority--${task.priority || "normal"}`, text: factoryTaskPriorityLabel(task.priority) }),
        task.archivedAt ? el("span", { class: "factory-task-card__archived", text: "已归档" }) : null,
        el("span", { class: `factory-task-card__execution factory-task-card__execution--${executionState}`, text: factoryTaskExecutionLabel(executionState) }),
      ]),
      el("h3", { class: "factory-task-card__title", text: task.title }),
      task.description ? el("p", { class: "factory-task-card__description", text: task.description }) : null,
      el("div", { class: "factory-task-card__route" }, [
        task.project ? el("span", { class: "tag tag--soft", text: task.project }) : el("span", { class: "muted", text: "无项目" }),
        el("span", { class: "factory-task-card__assignee", text: task.assignee || "未指派" }),
      ]),
      task.labels?.length ? el("div", { class: "factory-task-card__labels" }, task.labels.slice(0, 4).map((label) => el("span", { class: "tag tag--soft", text: label }))) : null,
      el("div", { class: "factory-task-card__foot" }, [
        task.parentTaskId ? el("span", { text: "子任务" }) : el("span", { text: `#${String(task.id).slice(-6)}` }),
        task.triggerAt ? el("time", { datetime: task.triggerAt, text: `触发 ${fmtTime(task.triggerAt)}` }) : el("span", { text: `更新 ${fmtRelative(task.updatedAt)}` }),
      ]),
    ]);
  }

  async function moveFactoryTask(taskId, nextStatus) {
    const task = STATE.factoryTasks.find((item) => item.id === taskId);
    if (!task || !nextStatus || task.status === nextStatus) return;
    const card = document.querySelector(`.factory-task-card[data-task-id="${CSS.escape(taskId)}"]`);
    card?.classList.add("factory-task-card--saving");
    const res = await api(`/api/factory-tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: nextStatus, expectedRevision: task.revision, actor: "用户" }),
    });
    if (!res.ok) {
      toast(res.status === 409 ? "任务刚被其他人更新，已刷新看板" : "移动任务失败", "error");
    } else {
      toast(`已移动到「${nextStatus}」`, "success");
    }
    await refreshFactoryTaskBoard();
  }

  function factoryTaskColumn(status, tasks) {
    const orderedTasks = tasks.slice().sort((a, b) => {
      const priority = factoryTaskPriorityRank(a.priority) - factoryTaskPriorityRank(b.priority);
      if (priority) return priority;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
    return el("section", {
      class: "factory-board__column",
      data: { status },
      "aria-label": `${status}，${tasks.length} 个任务`,
      ondragover: (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        event.currentTarget.classList.add("factory-board__column--over");
      },
      ondragleave: (event) => event.currentTarget.classList.remove("factory-board__column--over"),
      ondrop: (event) => {
        event.preventDefault();
        event.currentTarget.classList.remove("factory-board__column--over");
        const taskId = event.dataTransfer.getData("text/plain") || STATE.factoryTaskDragId;
        if (taskId) void moveFactoryTask(taskId, status);
      },
    }, [
      el("header", { class: "factory-board__column-head" }, [
        el("div", { class: "factory-board__column-title" }, [
          el("span", { class: "factory-board__status-dot", "aria-hidden": "true" }),
          el("h2", { text: status }),
        ]),
        el("span", { class: "factory-board__count", text: String(tasks.length), title: `${tasks.length} 个任务` }),
      ]),
      el("div", { class: "factory-board__cards" }, orderedTasks.length
        ? orderedTasks.map(factoryTaskCard)
        : [el("div", { class: "factory-board__empty", text: "拖动任务到这里" })]),
    ]);
  }

  function factoryTaskFilterSelect(id, label, value, options, onchange) {
    return el("label", { class: "filters__group" }, [
      el("span", { class: "filters__label", text: label }),
      el("select", { class: "input", id, onchange }, [
        el("option", { value: "", text: "全部" }),
        ...options.map((option) => el("option", { value: option, text: option, selected: option === value })),
      ]),
    ]);
  }

  async function refreshFactoryTaskBoard() {
    const node = await renderFactoryTaskBoard();
    if (STATE.currentPage !== "tasks") return;
    const main = $("#main");
    main.innerHTML = "";
    main.appendChild(node);
  }

  function updateFactoryTaskFilter(key, value) {
    STATE.factoryTaskFilters[key] = value;
    void refreshFactoryTaskBoard();
  }

  async function renderFactoryTaskBoard() {
    const wrap = el("div", { class: "page page--factory-tasks" });
    const query = factoryTaskQueryString();
    const [res, workersRes] = await Promise.all([
      api(`/api/factory-tasks?${query}`),
      STATE.workers.length ? Promise.resolve({ ok: true, data: { workers: STATE.workers } }) : api("/api/workers"),
    ]);
    if (!res.ok) {
      wrap.appendChild(errorBox("加载任务看板失败", res.detail));
      return wrap;
    }
    if (workersRes.ok) STATE.workers = workersRes.data.workers || [];
    STATE.factoryTasks = res.data.tasks || [];
    STATE.factoryTaskFacets = res.data.facets || {};
    const filters = STATE.factoryTaskFilters;
    const tasks = STATE.factoryTasks;
    const statuses = [...(res.data.statuses || [])].sort((a, b) => factoryTaskStatusRank(a) - factoryTaskStatusRank(b));
    const running = tasks.filter((task) => ["dispatching", "queued", "running"].includes(task.execution?.state)).length;
    const scheduled = tasks.filter((task) => task.execution?.state === "scheduled").length;

    wrap.appendChild(el("section", { class: "factory-task-hero" }, [
      el("div", {}, [
        el("span", { class: "eyebrow", text: "FACTORY TASK BOARD" }),
        el("h1", { text: "全局任务看板" }),
        el("p", { text: "一套总账，项目只是筛选。状态由人和牛马按真实工作阶段共同维护。" }),
      ]),
      el("div", { class: "factory-task-hero__actions" }, [
        el("a", { class: "btn btn--ghost", href: "#/task-requests", text: "派活审计" }),
        el("button", { class: "btn btn--primary", type: "button", text: "新建任务", onclick: openNewFactoryTaskDrawer }),
      ]),
    ]));

    wrap.appendChild(el("section", { class: "factory-task-summary", "aria-label": "看板摘要" }, [
      el("div", {}, [el("strong", { text: String(tasks.length) }), el("span", { text: "当前任务" })]),
      el("div", {}, [el("strong", { text: String(statuses.length) }), el("span", { text: "实际状态" })]),
      el("div", {}, [el("strong", { text: String(running) }), el("span", { text: "执行中" })]),
      el("div", {}, [el("strong", { text: String(scheduled) }), el("span", { text: "待触发" })]),
    ]));

    wrap.appendChild(el("section", { class: "filters factory-task-filters", "aria-label": "任务筛选" }, [
      el("label", { class: "filters__group filters__group--grow" }, [
        el("span", { class: "filters__label", text: "搜索" }),
        el("input", {
          class: "input",
          id: "factoryTaskSearchFilter",
          type: "search",
          value: filters.query,
          placeholder: "标题、上下文、标签",
          oninput: debounce((event) => updateFactoryTaskFilter("query", event.target.value.trim()), 250),
        }),
      ]),
      factoryTaskFilterSelect("factoryTaskProjectFilter", "项目", filters.project, STATE.factoryTaskFacets.projects || [], (event) => updateFactoryTaskFilter("project", event.target.value)),
      factoryTaskFilterSelect("factoryTaskStatusFilter", "状态", filters.status, STATE.factoryTaskFacets.statuses || [], (event) => updateFactoryTaskFilter("status", event.target.value)),
      factoryTaskFilterSelect("factoryTaskAssigneeFilter", "负责人", filters.assignee, STATE.factoryTaskFacets.assignees || [], (event) => updateFactoryTaskFilter("assignee", event.target.value)),
      factoryTaskFilterSelect("factoryTaskPriorityFilter", "优先级", filters.priority, ["urgent", "high", "normal", "low"], (event) => updateFactoryTaskFilter("priority", event.target.value)),
      factoryTaskFilterSelect("factoryTaskExecutionFilter", "执行", filters.executionState, STATE.factoryTaskFacets.executionStates || [], (event) => updateFactoryTaskFilter("executionState", event.target.value)),
      el("label", { class: "factory-task-filter-check" }, [
        el("input", {
          id: "factoryTaskArchiveFilter",
          type: "checkbox",
          checked: filters.includeArchived,
          onchange: (event) => updateFactoryTaskFilter("includeArchived", event.target.checked),
        }),
        el("span", { text: "包含归档" }),
      ]),
    ]));

    if (!tasks.length) {
      wrap.appendChild(emptyState("暂无匹配任务", "新建第一条任务，或清除筛选条件。"));
      return wrap;
    }
    wrap.appendChild(el("div", { class: "factory-board", role: "region", "aria-label": "任务状态看板", tabindex: "0" },
      statuses.map((status) => factoryTaskColumn(status, tasks.filter((task) => task.status === status)))));
    return wrap;
  }

  function toDatetimeLocal(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }

  function factoryTaskForm(task = null) {
    const isNew = !task;
    const record = task || { priority: "normal", status: "TODO", mode: "auto", labels: [] };
    const assigneeSelect = el("select", { class: "input", name: "assignee" }, [
      el("option", { value: "", text: "未指派" }),
      ...STATE.workers.map((worker) => el("option", { value: worker.name, text: worker.name, selected: worker.name === record.assignee })),
    ]);
    const triggerInput = el("input", { class: "input", name: "triggerAt", type: "datetime-local", value: toDatetimeLocal(record.triggerAt) });
    const runAfterSaveInput = el("input", {
      name: "runNow",
      type: "checkbox",
      checked: isNew,
      disabled: !record.assignee || Boolean(record.triggerAt) || Boolean(record.archivedAt),
    });
    const syncRunAfterSave = () => {
      if (triggerInput.value) runAfterSaveInput.checked = false;
      runAfterSaveInput.disabled = !assigneeSelect.value || Boolean(triggerInput.value) || Boolean(record.archivedAt);
    };
    assigneeSelect.addEventListener("change", syncRunAfterSave);
    triggerInput.addEventListener("change", syncRunAfterSave);
    const form = el("form", { class: "factory-task-form", id: "factoryTaskForm" }, [
      el("label", { class: "factory-task-form__field factory-task-form__field--wide" }, [
        el("span", { text: "标题" }),
        el("input", { class: "input", name: "title", required: "true", maxlength: "240", value: record.title || "", placeholder: "要推进什么？" }),
      ]),
      el("label", { class: "factory-task-form__field factory-task-form__field--wide" }, [
        el("span", { text: "任务说明" }),
        el("textarea", { class: "input", name: "description", rows: "4", placeholder: "交付物、验收标准、边界", text: record.description || "" }),
      ]),
      el("label", { class: "factory-task-form__field factory-task-form__field--wide" }, [
        el("span", { text: "上下文" }),
        el("textarea", { class: "input", name: "context", rows: "5", placeholder: "背景、约束、决策和交接信息", text: record.context || "" }),
      ]),
      el("label", { class: "factory-task-form__field" }, [
        el("span", { text: "项目" }),
        el("input", { class: "input", name: "project", value: record.project || "", placeholder: "可为空" }),
      ]),
      el("label", { class: "factory-task-form__field" }, [
        el("span", { text: "状态（自由输入）" }),
        el("input", { class: "input", name: "status", list: "factoryTaskStatusOptions", required: "true", value: record.status || "TODO" }),
        el("datalist", { id: "factoryTaskStatusOptions" }, (STATE.factoryTaskFacets.statuses || []).map((status) => el("option", { value: status }))),
      ]),
      el("label", { class: "factory-task-form__field" }, [
        el("span", { text: "负责人" }),
        assigneeSelect,
      ]),
      el("label", { class: "factory-task-form__field" }, [
        el("span", { text: "优先级" }),
        el("select", { class: "input", name: "priority" }, ["low", "normal", "high", "urgent"].map((value) => el("option", { value, text: factoryTaskPriorityLabel(value), selected: value === record.priority }))),
      ]),
      el("label", { class: "factory-task-form__field factory-task-form__field--wide" }, [
        el("span", { text: "标签（逗号分隔）" }),
        el("input", { class: "input", name: "labels", value: (record.labels || []).join(", ") }),
      ]),
      el("label", { class: "factory-task-form__field" }, [
        el("span", { text: "触发时间" }),
        triggerInput,
      ]),
      el("label", { class: "factory-task-form__field" }, [
        el("span", { text: "执行方式" }),
        el("select", { class: "input", name: "mode" }, ["auto", "queue", "steer", "now"].map((value) => el("option", { value, text: value, selected: value === record.mode }))),
      ]),
      el("label", { class: "factory-task-filter-check factory-task-form__field--wide" }, [
        runAfterSaveInput,
        el("span", { text: isNew ? "指派后立即通知负责人并执行" : "保存后立即通知负责人并执行" }),
      ]),
      el("p", { class: "factory-task-form__hint factory-task-form__field--wide", text: "设置触发时间后改为到期执行；取消勾选可只登记负责人，不启动 Job。" }),
      el("div", { class: "factory-task-form__actions factory-task-form__field--wide" }, [
        el("button", { class: "btn btn--primary", type: "submit", text: isNew ? "创建任务" : "保存修改" }),
      ]),
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveFactoryTaskForm(form, task);
    });
    return form;
  }

  function factoryTaskFormPayload(form) {
    const data = new FormData(form);
    const triggerValue = String(data.get("triggerAt") || "").trim();
    return {
      title: String(data.get("title") || "").trim(),
      description: String(data.get("description") || "").trim(),
      context: String(data.get("context") || "").trim(),
      project: String(data.get("project") || "").trim(),
      status: String(data.get("status") || "TODO").trim(),
      assignee: String(data.get("assignee") || "").trim(),
      priority: String(data.get("priority") || "normal"),
      labels: String(data.get("labels") || "").split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      triggerAt: triggerValue ? new Date(triggerValue).toISOString() : "",
      mode: String(data.get("mode") || "auto"),
      runNow: data.get("runNow") === "on",
      actor: "用户",
    };
  }

  async function saveFactoryTaskForm(form, task = null) {
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = task ? "保存中…" : "创建中…";
    const payload = factoryTaskFormPayload(form);
    const runAfterSave = payload.runNow;
    if (task) {
      payload.expectedRevision = task.revision;
      delete payload.runNow;
    }
    const res = await api(task ? `/api/factory-tasks/${encodeURIComponent(task.id)}` : "/api/factory-tasks", {
      method: task ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      submit.disabled = false;
      submit.textContent = task ? "保存修改" : "创建任务";
      toast(res.status === 409 ? "任务已被其他人更新，请重新打开" : "保存任务失败", "error");
      if (res.status === 409 && task) void openFactoryTaskDrawer(task.id);
      return;
    }
    if (task && runAfterSave) {
      const updated = res.data.task;
      const runRes = await api(`/api/factory-tasks/${encodeURIComponent(updated.id)}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: "用户", mode: updated.mode, expectedRevision: updated.revision }),
      });
      if (!runRes.ok) {
        toast("任务已保存，但启动执行失败", "error");
        await refreshFactoryTaskBoard();
        void openFactoryTaskDrawer(updated.id);
        return;
      }
    }
    toast(runAfterSave ? "任务已保存并提交执行" : task ? "任务已更新" : "任务已创建", "success");
    closeDrawer();
    await refreshFactoryTaskBoard();
  }

  function openNewFactoryTaskDrawer() {
    openDrawer(factoryTaskForm(), { eyebrow: "NEW TASK", title: "新建任务" });
    requestAnimationFrame(() => document.querySelector('#factoryTaskForm input[name="title"]')?.focus());
  }

  async function splitFactoryTaskFromDrawer(task) {
    const title = String($("#factoryTaskSplitTitle")?.value || "").trim();
    if (!title) { toast("请先填写子任务标题", "error"); return; }
    const res = await api(`/api/factory-tasks/${encodeURIComponent(task.id)}/split`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "用户", expectedRevision: task.revision, children: [{ title, project: task.project, status: "TODO" }] }),
    });
    if (!res.ok) { toast(res.status === 409 ? "任务已更新，请重试" : "拆分失败", "error"); return; }
    toast("已创建子任务", "success");
    await refreshFactoryTaskBoard();
    void openFactoryTaskDrawer(task.id);
  }

  async function runFactoryTaskFromDrawer(task) {
    if (!task.assignee) { toast("请先设置负责人", "error"); return; }
    const res = await api(`/api/factory-tasks/${encodeURIComponent(task.id)}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "用户", expectedRevision: task.revision }),
    });
    if (!res.ok) { toast(res.status === 409 ? "任务已更新，请重试" : "请求执行失败", "error"); return; }
    toast("已提交执行请求", "success");
    await refreshFactoryTaskBoard();
    void openFactoryTaskDrawer(task.id);
  }

  async function archiveFactoryTaskFromDrawer(task) {
    const action = task.archivedAt ? "restore" : "archive";
    const res = await api(`/api/factory-tasks/${encodeURIComponent(task.id)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "用户", expectedRevision: task.revision }),
    });
    if (!res.ok) { toast(res.status === 409 ? "任务已更新，请重试" : "归档操作失败", "error"); return; }
    toast(action === "restore" ? "任务已恢复" : "任务已归档", "success");
    closeDrawer();
    await refreshFactoryTaskBoard();
  }

  async function cancelFactoryTaskExecutionFromDrawer(task) {
    const jobId = task.execution?.jobId;
    const requestId = task.execution?.taskRequestId;
    if (!jobId && !requestId) { toast("当前执行还没有可取消的 Job 或请求", "error"); return; }
    const path = jobId
      ? `/api/jobs/${encodeURIComponent(jobId)}/cancel`
      : `/api/task-requests/${encodeURIComponent(requestId)}/cancel`;
    const res = await api(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "用户", from: "用户", reason: "用户从任务看板停止执行" }),
    });
    if (!res.ok) { toast("停止执行失败", "error"); return; }
    toast("已提交停止执行请求", "success");
    await refreshFactoryTaskBoard();
    void openFactoryTaskDrawer(task.id);
  }

  function factoryTaskEventText(event) {
    if (event.type === "task:created") return event.task?.title || "已创建任务";
    if (event.patch?.status) return `状态 → ${event.patch.status}`;
    if (event.patch) {
      const fields = Object.keys(event.patch).filter((key) => key !== "updatedAt");
      if (fields.length) return `更新 ${fields.join("、")}`;
    }
    if (event.data?.childTaskIds?.length) return `拆分 ${event.data.childTaskIds.length} 个子任务`;
    if (event.data?.jobLinked) return "已关联员工 Job";
    if (event.execution?.resultSummary) return event.execution.resultSummary;
    if (event.execution?.error) return event.execution.error;
    if (event.execution?.state) return `执行状态 → ${factoryTaskExecutionLabel(event.execution.state)}`;
    return "—";
  }

  async function openFactoryTaskDrawer(id) {
    openDrawer(loadingText("加载中…"), { eyebrow: "TASK", title: "加载中…" });
    const res = await api(`/api/factory-tasks/${encodeURIComponent(id)}`);
    if (!res.ok) {
      openDrawer(errorBox("加载任务详情失败", res.detail), { eyebrow: "TASK", title: id });
      return;
    }
    const task = res.data.task;
    const content = el("div", { class: "factory-task-detail" }, [
      el("section", { class: "factory-task-detail__summary" }, [
        el("div", {}, [el("span", { class: "muted", text: "人类状态" }), el("strong", { text: task.status })]),
        el("div", {}, [el("span", { class: "muted", text: "执行状态" }), el("strong", { text: factoryTaskExecutionLabel(task.execution?.state) })]),
        el("div", {}, [el("span", { class: "muted", text: "Revision" }), el("strong", { text: String(task.revision) })]),
      ]),
      factoryTaskForm(task),
      el("section", { class: "factory-task-detail__actions" }, [
        el("button", { class: "btn", type: "button", text: "立即执行", disabled: !task.assignee || Boolean(task.archivedAt), onclick: () => runFactoryTaskFromDrawer(task) }),
        ["dispatching", "queued", "running"].includes(task.execution?.state) && (task.execution?.jobId || task.execution?.taskRequestId)
          ? el("button", { class: "btn btn--danger", type: "button", text: "停止执行", onclick: () => cancelFactoryTaskExecutionFromDrawer(task) })
          : null,
        el("button", { class: task.archivedAt ? "btn" : "btn btn--danger", type: "button", text: task.archivedAt ? "恢复任务" : "归档任务", onclick: () => archiveFactoryTaskFromDrawer(task) }),
        task.execution?.jobId ? el("button", { class: "btn btn--ghost", type: "button", text: `查看 Job ${String(task.execution.jobId).slice(-6)}`, onclick: () => openJobDrawer(task.execution.jobId) }) : null,
        task.execution?.taskRequestId ? el("a", { class: "btn btn--ghost", href: `#/task-requests/${encodeURIComponent(task.execution.taskRequestId)}`, text: "查看派活请求" }) : null,
      ]),
      el("section", { class: "factory-task-detail__evidence" }, [
        el("h4", { text: "执行证据" }),
        el("dl", { class: "factory-task-evidence" }, [
          el("dt", { text: "Execution Key" }), el("dd", { text: task.execution?.executionKey || "—" }),
          el("dt", { text: "Request" }), el("dd", { text: task.execution?.taskRequestId || "—" }),
          el("dt", { text: "Job" }), el("dd", { text: task.execution?.jobId || "—" }),
          el("dt", { text: "开始 / 结束" }), el("dd", { text: `${fmtTime(task.execution?.startedAt)} / ${fmtTime(task.execution?.finishedAt)}` }),
          el("dt", { text: "结果" }), el("dd", { text: task.execution?.resultSummary || task.execution?.error || "—" }),
        ]),
      ]),
      el("section", { class: "factory-task-detail__split" }, [
        el("h4", { text: "拆分子任务" }),
        el("div", { class: "factory-task-detail__split-row" }, [
          el("input", { class: "input", id: "factoryTaskSplitTitle", placeholder: "子任务标题" }),
          el("button", { class: "btn", type: "button", text: "添加子任务", onclick: () => splitFactoryTaskFromDrawer(task) }),
        ]),
        task.childTaskIds?.length ? el("div", { class: "factory-task-detail__children" }, task.childTaskIds.map((childId) => el("button", { class: "btn btn--ghost", type: "button", text: childId, onclick: () => openFactoryTaskDrawer(childId) }))) : el("p", { class: "muted", text: "暂无子任务" }),
      ]),
      el("section", { class: "factory-task-detail__timeline" }, [
        el("h4", { text: `事件时间线 (${task.events?.length || 0})` }),
        el("ul", { class: "timeline" }, (task.events || []).slice().reverse().map((event) => el("li", { class: `timeline__item timeline__item--${event.type}` }, [
          el("span", { class: "timeline__time", text: fmtTime(event.at) }),
          el("span", { class: "timeline__type", text: event.type }),
          el("span", { class: "timeline__name", text: event.actor || "—" }),
          el("span", { class: "timeline__text", text: factoryTaskEventText(event) }),
        ]))),
      ]),
    ]);
    openDrawer(content, { eyebrow: task.parentTaskId ? "SUBTASK" : "TASK", title: task.title });
  }

  function taskRequestEventText(ev) {
    if (!ev) return "—";
    const parts = [];
    if (ev.jobId) parts.push(`job ${String(ev.jobId).slice(-6)}`);
    if (ev.deliveryMode || ev.mode) parts.push(`mode ${ev.deliveryMode || ev.mode}`);
    if (ev.placement) parts.push(ev.placement);
    if (ev.error) parts.push(ev.error);
    if (ev.reason) parts.push(ev.reason);
    if (ev.summary) parts.push(String(ev.summary).slice(0, 160));
    if (ev.task && ev.type === "edited") parts.push(String(ev.task).slice(0, 160));
    return parts.join(" · ") || "—";
  }

  function taskRequestCard(request) {
    const id = request.id || "";
    const jobId = request.jobId || "";
    return el("article", {
      class: `task-request-card task-request-card--${request.status || "pending"}`,
      onclick: () => openTaskRequestDrawer(id),
    }, [
      el("div", { class: "task-request-card__top" }, [
        statusPill(request.status || "pending"),
        el("span", { class: "task-request-card__id", text: id ? id.slice(-8) : "—" }),
      ]),
      el("div", { class: "task-request-card__route" }, [
        el("strong", { text: request.from || "用户" }),
        el("span", { text: "→" }),
        el("strong", { text: request.to || "—" }),
      ]),
      el("div", { class: "task-request-card__meta" }, [
        el("span", { class: "tag tag--soft", text: request.project || "factory-task" }),
        el("span", { class: "tag tag--soft", text: `mode: ${request.deliveryMode || request.mode || "auto"}` }),
        jobId ? el("button", {
          class: "btn btn--ghost task-request-card__job",
          type: "button",
          text: `job ${jobId.slice(-6)}`,
          onclick: (event) => { event.stopPropagation(); openJobDrawer(jobId); },
        }) : null,
      ]),
      el("div", { class: "task-request-card__task", title: request.task || "", text: request.task || "—" }),
      request.resultSummary
        ? el("div", { class: "task-request-card__result", text: request.resultSummary })
        : null,
      el("div", { class: "task-request-card__foot" }, [
        el("span", { text: `创建 ${fmtRelative(request.createdAt)}` }),
        request.updatedAt || request.acceptedAt || request.reportedAt || request.failedAt || request.cancelledAt
          ? el("span", { text: `更新 ${fmtRelative(request.updatedAt || request.reportedAt || request.acceptedAt || request.failedAt || request.cancelledAt)}` })
          : null,
      ]),
    ]);
  }

  async function renderTaskRequests() {
    const wrap = el("div", { class: "page page--tasks" });
    wrap.appendChild(el("section", { class: "section" }, [
      sectionHead("员工派活", "授权动作 work:assign；页面创建请求后由 Pi 主进程接管，目标忙碌时按 mode 进入 queue/steer/now 语义。"),
    ]));

    const res = await api("/api/task-requests?limit=100");
    if (!res.ok) {
      wrap.appendChild(errorBox("加载派活请求失败", res.detail));
      return wrap;
    }

    const requests = res.data.requests || [];
    STATE.taskRequests = requests;
    const counts = requests.reduce((acc, request) => {
      const key = request.status || "pending";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    wrap.appendChild(el("div", { class: "kpi-row task-kpi-row" }, [
      kpiCard("总请求", String(res.data.total ?? requests.length), "最近 100 条"),
      kpiCard("待接管", String((counts.pending || 0) + (counts.processing || 0)), "pending + processing"),
      kpiCard("已接管", String(counts.accepted || 0), "已有 worker job"),
      kpiCard("已回传", String(counts.reported || 0), "已给来源回消息"),
    ]));

    wrap.appendChild(el("section", { class: "section" }, [
      el("div", { class: "task-toolbar" }, [
        el("span", { class: "muted", text: `共 ${requests.length} 条 · 新请求使用 POST /api/task-requests 或 comm-cli assign` }),
      ]),
      requests.length
        ? el("div", { class: "task-grid" }, requests.map(taskRequestCard))
        : emptyState("暂无派活请求", "员工可以用 comm-cli assign 或 factory_task_assign 工具创建授权派活请求。"),
    ]));
    return wrap;
  }

  async function openTaskRequestDrawer(id) {
    const drawer = $("#drawer");
    drawer.classList.add(DRAWER_OPEN_CLASS);
    drawer.setAttribute("aria-hidden", "false");
    $("#drawerEyebrow").textContent = "TASK";
    $("#drawerTitle").textContent = id;
    $("#drawerBody").innerHTML = "";
    $("#drawerBody").appendChild(el("div", { class: "skeleton skeleton--row" }));
    const res = await api(`/api/task-requests/${encodeURIComponent(id)}`);
    const body = $("#drawerBody");
    if (!res.ok) {
      body.innerHTML = "";
      body.appendChild(errorBox("加载派活详情失败", res.detail));
      return;
    }
    const request = res.data.request || {};
    body.innerHTML = "";
    body.appendChild(el("div", { class: "drawer__meta" }, [
      el("div", {}, [el("span", { class: "muted", text: "状态" }), statusPill(request.status || "pending")]),
      el("div", {}, [el("span", { class: "muted", text: "来源" }), el("strong", { text: request.from || "用户" })]),
      el("div", {}, [el("span", { class: "muted", text: "目标" }), el("strong", { text: request.to || "—" })]),
      el("div", {}, [el("span", { class: "muted", text: "项目" }), el("strong", { text: request.project || "factory-task" })]),
      el("div", {}, [el("span", { class: "muted", text: "模式" }), el("span", { text: request.deliveryMode || request.mode || "auto" })]),
      el("div", {}, [el("span", { class: "muted", text: "创建" }), el("span", { text: fmtTime(request.createdAt) })]),
      request.jobId ? el("div", {}, [
        el("span", { class: "muted", text: "Job" }),
        el("button", { class: "btn btn--ghost", type: "button", text: request.jobId, onclick: () => openJobDrawer(request.jobId) }),
      ]) : null,
      request.resultMessageId ? el("div", {}, [el("span", { class: "muted", text: "回执消息" }), el("span", { class: "td--mono", text: request.resultMessageId })]) : null,
    ]));
    body.appendChild(el("div", { class: "drawer__section" }, [
      el("h4", { text: "派活内容" }),
      request.task ? mdNode(request.task) : el("p", { class: "prose", text: "—" }),
    ]));
    if (request.resultSummary) {
      body.appendChild(el("div", { class: "drawer__section" }, [
        el("h4", { text: "回传摘要" }),
        mdNode(request.resultSummary),
      ]));
    }
    const events = request.events || [];
    if (events.length) {
      body.appendChild(el("div", { class: "drawer__section" }, [
        el("h4", { text: `事件流 (${events.length})` }),
        el("ul", { class: "timeline" }, events.map((ev) => el("li", { class: `timeline__item timeline__item--${ev.type}` }, [
          el("span", { class: "timeline__time", text: fmtTime(ev.createdAt || ev.claimedAt || ev.acceptedAt || ev.failedAt || ev.editedAt || ev.cancelledAt || ev.reportedAt) }),
          el("span", { class: "timeline__type", text: ev.type || "event" }),
          el("span", { class: "timeline__name", text: ev.from || ev.claimedBy || ev.to || "—" }),
          el("span", { class: "timeline__text", text: taskRequestEventText(ev) }),
        ]))),
      ]));
    }
  }

  function statusCheckbox(id, label, checked) {
    return el("label", { class: "notification-settings__check" }, [
      el("input", { id, type: "checkbox", checked: Boolean(checked) }),
      el("span", { text: label }),
    ]);
  }

  function notificationSettingsFromForm(form, current) {
    const statuses = [];
    if ($("#notificationStatusDone", form)?.checked) statuses.push("done");
    if ($("#notificationStatusFailed", form)?.checked) statuses.push("failed");
    const workers = String($("#notificationWorkers", form)?.value || "")
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      ...(current || {}),
      enabled: Boolean($("#notificationEnabled", form)?.checked),
      pollIntervalMs: Number($("#notificationPollInterval", form)?.value || 5000),
      jobTerminal: {
        ...(current?.jobTerminal || {}),
        enabled: true,
        statuses: statuses.length ? statuses : ["done"],
        workers,
        template: String($("#notificationTemplate", form)?.value || "{worker} 任务完成").trim() || "{worker} 任务完成",
        failureTemplate: String($("#notificationFailureTemplate", form)?.value || "{worker} 任务失败").trim() || "{worker} 任务失败",
      },
    };
  }

  async function renderNotificationsSettings() {
    const res = await loadNotificationSettings();
    const wrap = el("div", { class: "page page--notifications" });
    wrap.appendChild(el("section", { class: "section" }, [
      sectionHead("声音提醒", "浏览器本地 TTS；只对配置命中的非 steer job 终态进行提醒。"),
    ]));

    if (!res.ok) {
      wrap.appendChild(errorBox("加载提醒配置失败", res.detail));
      return wrap;
    }

    const settings = STATE.notificationSettings || res.data?.settings || {};
    const rule = settings.jobTerminal || {};
    const statuses = new Set(Array.isArray(rule.statuses) ? rule.statuses : []);
    const form = el("form", { class: "card notification-settings" }, [
      cardHead("任务完成提醒", "第一版使用 Web Speech API。浏览器可能要求先点击一次“测试播放/启用声音”。"),
      el("div", { class: "notification-settings__grid" }, [
        el("label", { class: "notification-settings__field notification-settings__field--switch" }, [
          el("span", { class: "notification-settings__label", text: "启用声音提醒" }),
          el("input", { id: "notificationEnabled", type: "checkbox", checked: Boolean(settings.enabled) }),
        ]),
        el("label", { class: "notification-settings__field" }, [
          el("span", { class: "notification-settings__label", text: "轮询间隔（毫秒）" }),
          el("input", {
            class: "input",
            id: "notificationPollInterval",
            type: "number",
            min: "1000",
            max: "60000",
            step: "500",
            value: String(settings.pollIntervalMs || 5000),
          }),
        ]),
        el("div", { class: "notification-settings__field" }, [
          el("span", { class: "notification-settings__label", text: "提醒状态" }),
          el("div", { class: "notification-settings__checks" }, [
            statusCheckbox("notificationStatusDone", "完成 done", statuses.has("done")),
            statusCheckbox("notificationStatusFailed", "失败 failed", statuses.has("failed")),
          ]),
        ]),
        el("label", { class: "notification-settings__field" }, [
          el("span", { class: "notification-settings__label", text: "员工白名单（空=全员，逗号分隔）" }),
          el("input", {
            class: "input",
            id: "notificationWorkers",
            type: "text",
            value: Array.isArray(rule.workers) ? rule.workers.join(", ") : "",
            placeholder: "派派, 阿哲",
          }),
        ]),
        el("label", { class: "notification-settings__field" }, [
          el("span", { class: "notification-settings__label", text: "完成文案模板" }),
          el("input", {
            class: "input",
            id: "notificationTemplate",
            type: "text",
            value: rule.template || "{worker} 任务完成",
          }),
        ]),
        el("label", { class: "notification-settings__field" }, [
          el("span", { class: "notification-settings__label", text: "失败文案模板" }),
          el("input", {
            class: "input",
            id: "notificationFailureTemplate",
            type: "text",
            value: rule.failureTemplate || "{worker} 任务失败",
          }),
        ]),
      ]),
      el("div", { class: "notification-settings__note muted" }, [
        "变量支持：{worker}、{project}、{status}、{statusText}、{kind}、{source}、{assignedBy}。默认排除 steer / compact / 情绪评分 / system。网页关闭时不会播放声音。",
      ]),
      el("div", { class: "notification-settings__actions" }, [
        el("button", { class: "btn", type: "submit", text: "保存配置" }),
        el("button", {
          class: "btn btn--ghost",
          type: "button",
          text: "测试播放",
          onclick: () => speakNotification("派派 任务完成"),
        }),
        el("button", {
          class: "btn btn--ghost",
          type: "button",
          text: "从现在开始提醒",
          onclick: () => {
            setNotificationLastSeen(nowIso());
            try { localStorage.setItem(NOTIFICATION_SPOKEN_IDS_KEY, "[]"); } catch {}
            toast("已重置提醒水位线", "success");
          },
        }),
      ]),
    ]);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const next = notificationSettingsFromForm(form, STATE.notificationSettings || settings);
      const saved = await saveNotificationSettings(next);
      if (!saved.ok) {
        toast("保存提醒配置失败", "error");
        return;
      }
      toast("提醒配置已保存", "success");
    });

    wrap.appendChild(el("section", { class: "section" }, [form]));
    wrap.appendChild(el("section", { class: "section" }, [
      el("div", { class: "card" }, [
        cardHead("当前状态", "配置保存在 workers/config/notifications.json，本地运行数据不进版本管理。"),
        el("div", { class: "kv" }, [
          kvRow("浏览器语音", ("speechSynthesis" in window) ? "可用" : "不可用"),
          kvRow("当前水位线", getNotificationLastSeen()),
          kvRow("轮询状态", settings.enabled ? `开启 · ${notificationPollIntervalMs(settings)}ms` : "关闭"),
        ]),
      ]),
    ]));
    return wrap;
  }

  async function renderMessages() {
    const wrap = el("div", { class: "page page--messages" });
    wrap.appendChild(el("section", { class: "section" }, [
      sectionHead("消息预览", "Overview 已展示主 agent 收件箱；按员工选择查看完整收件箱"),
    ]));
    const select = el("div", { class: "filters__group" }, [
      el("label", { class: "filters__label", text: "员工" }),
      el("select", { class: "input", id: "msgWorker", onchange: loadMessages }, [
        el("option", { value: "主agent", text: "主agent" }),
      ]),
    ]);
    wrap.appendChild(el("section", { class: "filters" }, [select]));
    wrap.appendChild(el("section", { class: "section" }, [
      el("div", { class: "card" }, [
        el("div", { id: "messagesBody" }, [loadingText("加载中…")]),
      ]),
    ]));
    main.appendChild(wrap);
    if (STATE.workers.length === 0) {
      const r = await api("/api/workers");
      if (r.ok) {
        STATE.workers = r.data.workers || [];
        const sel = $("#msgWorker");
        sel.innerHTML = STATE.workers.map((w) => `<option value="${esc(w.name)}">${esc(w.name)}</option>`).join("");
        sel.value = STATE.workers[0]?.name || "主agent";
      }
    } else {
      const sel = $("#msgWorker");
      sel.innerHTML = STATE.workers.map((w) => `<option value="${esc(w.name)}">${esc(w.name)}</option>`).join("");
      sel.value = STATE.workers[0]?.name || "主agent";
    }
    loadMessages();
    return wrap;
  }

  async function loadMessages() {
    const worker = $("#msgWorker")?.value;
    if (!worker) return;
    const res = await api(`/api/messages?worker=${encodeURIComponent(worker)}&unreadOnly=0`);
    const body = $("#messagesBody");
    if (!res.ok) {
      body.innerHTML = "";
      body.appendChild(errorBox("加载消息失败", res.detail));
      return;
    }
    const d = res.data;
    body.innerHTML = "";
    body.appendChild(el("div", { class: "muted", text: `共 ${d.total} 条 · 未读 ${d.unread}` }));
    if (!d.messages.length) {
      body.appendChild(emptyState("暂无消息"));
      return;
    }
    body.appendChild(el("ul", { class: "msg-list" }, d.messages.map((m) => messageItem(m, { defaultOpen: false, showDirection: false, showRead: true, worker }))));
  }

  async function renderReport() {
    const wrap = el("div", { class: "page page--report" });
    wrap.appendChild(el("section", { class: "section" }, [
      sectionHead("日报 / 产出", "复用 factory_report_context；Markdown 渲染（标题 / 列表 / 引用 / 表格）"),
    ]));
    const res = await api("/api/report-context?format=markdown");
    if (!res.ok) {
      wrap.appendChild(errorBox("加载 Report 失败", res.detail));
    } else {
      const node = mdNode(res.data || "");
      node.classList.add("md--report");
      wrap.appendChild(el("section", { class: "section" }, [
        el("div", { class: "card card--flush" }, [
          el("div", { class: "card__body--md" }, [node]),
        ]),
      ]));
    }
    return wrap;
  }

  async function renderPermissions() {
    const wrap = el("div", { class: "page page--permissions" });
    wrap.appendChild(el("section", { class: "section" }, [
      sectionHead("权限矩阵", "授权式通信；Phase 1 只读，不提供写操作入口"),
    ]));
    const res = await api("/api/permissions");
    if (!res.ok) {
      wrap.appendChild(errorBox("加载权限失败", res.detail));
    } else {
      const d = res.data;
      const grants = d.grants || [];
      wrap.appendChild(el("section", { class: "section" }, [
        el("div", { class: "card" }, [
          cardHead(`授权 (${grants.length})`, "subject · actions · targets · grantedBy · createdAt"),
          grants.length
            ? el("table", { class: "table" }, [
                el("thead", {}, [el("tr", {}, [
                  el("th", { text: "授权对象" }),
                  el("th", { text: "动作" }),
                  el("th", { text: "目标" }),
                  el("th", { text: "授权人" }),
                  el("th", { text: "备注" }),
                  el("th", { text: "时间" }),
                ])]),
                el("tbody", {}, grants.map((g) => el("tr", {}, [
                  el("td", { class: "td--mono", text: g.subject }),
                  el("td", { class: "td--actions" }, (g.actions || []).map((a) => el("span", { class: "tag tag--soft", text: a }))),
                  el("td", { class: "td--mono", text: (g.targets || []).join(", ") }),
                  el("td", { text: g.grantedBy || "—" }),
                  el("td", { class: "muted", text: g.note || "—" }),
                  el("td", { class: "td--time", text: fmtTime(g.createdAt) }),
                ]))),
              ])
            : emptyState("暂无授权"),
        ]),
      ]));
      if (d.events && d.events.length) {
        wrap.appendChild(el("section", { class: "section" }, [
          el("div", { class: "card" }, [
            cardHead("最近事件", "grant / revoke"),
            el("ul", { class: "msg-list" }, d.events.map((ev) => el("li", { class: "msg-list__item" }, [
              el("div", { class: "msg-list__head" }, [
                el("span", { class: `tag tag--${ev.type === "grant" ? "main" : "soft"}`, text: ev.type }),
                el("span", { class: "msg-list__peer", text: `${ev.subject} → ${(ev.targets || []).join(", ")}` }),
                el("span", { class: "msg-list__time", text: fmtTime(ev.createdAt || ev.revokedAt) }),
              ]),
              el("div", { class: "msg-list__body", text: `${(ev.actions || []).join(", ")} · ${ev.note || "—"}` }),
            ]))),
          ]),
        ]));
      }
    }
    return wrap;
  }

  // ---- 错误盒 ----
  function errorBox(title, detail) {
    return el("div", { class: "error-box" }, [
      el("div", { class: "error-box__title", text: title || "加载失败" }),
      el("div", { class: "error-box__detail", text: typeof detail === "string" ? detail : JSON.stringify(detail || {}) }),
    ]);
  }

  // ---- 路由 ----
  // 局部导航：切换 Workers 详情不重渲染整个 main。
  // 仅更新 URL hash（pushState 不触发 hashchange）、侧边 active class、detail 区域。
  // 浏览器后退/前进通过 popstate → route() 走全量重渲染。
  function navigateToWorker(name) {
    const newHash = `#/workers/${encodeURIComponent(name)}`;
    // pushState 避免触发 hashchange（hashchange 仍会触发 route()，会重渲染 main）
    history.pushState({ worker: name }, "", newHash);
    // 高亮侧边列表 active class
    for (const a of $$(".worker-card")) a.classList.toggle("worker-card--active", a.dataset.name === name);
    // 只重渲染 detail 区域
    renderWorkerDetail(name);
  }

  // 静默重新拉 /api/workers 刷新侧边列表的未读气泡。
  // 任何进入某个 worker detail / 打开 job drawer / 关闭 drawer 后都可能需要。
  // 独立于语音/系统通知开关；隐藏页面不轮询，不重建详情和输入框。
  setInterval(() => {
    if (!document.hidden) void refreshWorkerUnreadBadges();
  }, 5000);

  async function refreshWorkerUnreadBadges() {
    if (STATE.currentPage !== "workers" && STATE.currentPage !== "") return;
    if (STATE.unreadRefreshInFlight) return;
    STATE.unreadRefreshInFlight = true;
    const res = await api("/api/workers");
    STATE.unreadRefreshInFlight = false;
    if (!res.ok) return;
    const workers = res.data.workers || [];
    const map = new Map(workers.map((w) => [w.name, w]));
    // 更新每张 worker-card 的未读 badge + 排序
    const list = $(".workers__list");
    if (!list) return;
    const cards = $$(".worker-card", list);
    // 1. 更新每张卡片：badge / class / dataset
    for (const card of cards) {
      const name = card.dataset.name;
      const w = map.get(name);
      if (!w) continue;
      const unread = Number(w.finishedUnreadJobs || 0);
      card.dataset.unread = String(unread);
      card.dataset.activeJobs = String(w.activeJobs || 0);
      const dot = card.querySelector(".worker-card__status-dot");
      if (dot) {
        dot.className = `worker-card__status-dot dot dot--${w.activeJobs > 0 ? "busy" : w.status || "idle"}`;
        dot.title = workerCardTalkPreviewText(w);
      }
      card.dataset.lastInteractionAt = w.lastInteractionAt || "";
      card.classList.toggle("worker-card--unread", unread > 0);
          // 找现存的 badge，并同步最近 talk 返回摘要
          const existing = card.querySelector(".worker-card__badge--unread");
          syncWorkerCardTalkPreview(card, w);
          if (unread > 0) {
        const text = unread > 99 ? "99+" : String(unread);
        const title = unreadBadgeTitle(w);
        if (existing) {
          existing.textContent = text;
          existing.title = title;
        } else {
          const badge = el("span", {
            class: "worker-card__badge worker-card__badge--unread",
            text,
            title,
          });
          const aside = card.querySelector(".worker-card__aside");
          if (aside) aside.appendChild(badge);
        }
      } else if (existing) {
        existing.remove();
      }
    }
    // 2. 与初次渲染保持同一优先级，保留选中卡片。
    const ordered = cards.slice().sort((a, b) => {
      const rank = (card) => Number(card.dataset.unread) > 0 ? 2 : Number(card.dataset.activeJobs) > 0 ? 1 : 0;
      if (rank(a) !== rank(b)) return rank(b) - rank(a);
      const la = a.dataset.lastInteractionAt ? new Date(a.dataset.lastInteractionAt).getTime() : 0;
      const lb = b.dataset.lastInteractionAt ? new Date(b.dataset.lastInteractionAt).getTime() : 0;
      if (lb !== la) return lb - la;
      const an = a.dataset.name || "";
      const bn = b.dataset.name || "";
      return an.localeCompare(bn, "zh-Hans-CN");
    });
    for (const card of ordered) list.appendChild(card);
  }

  // 路由调用计数器：保证只有最后一次 route() 调用会渲染，避免竞态造成内容重复
let currentRouteId = 0;
  // 各子区域渲染计数器，防止并发请求导致旧数据覆盖新数据
let currentDetailId = 0;
let currentJobsId = 0;
let currentMsgId = 0;
let currentDrawerId = 0;

async function route() {
    const myRouteId = ++currentRouteId;
    const hash = location.hash || "#/overview";
    const [pathPart, queryPart] = hash.split("?");
    const path = pathPart.replace(/^#\/?/, "").split("/").filter(Boolean);
    const query = new URLSearchParams(queryPart || "");
    const main = $("#main");
    main.innerHTML = "";
    main.appendChild(el("div", { class: "page-loading", role: "status", "aria-label": "正在加载页面" }, [
      el("div", { class: "skeleton skeleton--title" }),
      el("div", { class: "skeleton skeleton--row" }),
      el("div", { class: "skeleton skeleton--row" }),
    ]));

    window.FactorySkin?.decorateLoading(main.querySelector(".page-loading"));

    // 高亮 nav
    for (const a of $$(".sidenav__list a")) a.classList.remove("sidenav__link--active");
    const route = path[0] || "overview";
    STATE.currentPage = route;
    const activeLink = $(`.sidenav__list a[data-route="${route}"]`);
    if (activeLink) activeLink.classList.add("sidenav__link--active");

    // 判断当前调用是否仍然是最新一次（await 期间用户可能切换页面）
    const isStale = () => myRouteId !== currentRouteId;

    try {
      if (route === "overview" || route === "") {
        const [res, osProfRes, osRunRes] = await Promise.all([
          api("/api/overview"),
          api("/api/outsource/profiles"),
          api("/api/outsource/runs?limit=200"),
        ]);
        if (isStale()) return;
        if (!res.ok) { renderErrorPage("加载 Overview 失败", res.detail); return; }
        STATE.lastOverview = res.data;
        setTopbar(res.data);
        const outsourceBundle = {
          profiles: osProfRes.ok ? (osProfRes.data?.profiles || []) : [],
          runs: osRunRes.ok ? (osRunRes.data?.runs || []) : [],
          profilesError: osProfRes.ok ? null : osProfRes.detail,
          runsError: osRunRes.ok ? null : osRunRes.detail,
        };
        renderOverview(res.data, outsourceBundle);
      } else if (route === "workers") {
        const res = await api("/api/workers");
        if (isStale()) return;
        if (!res.ok) { renderErrorPage("加载员工失败", res.detail); return; }
        renderWorkers(res.data.workers || []);
        if (path[1]) renderWorkerDetail(decodeURIComponent(path[1]));
        else if (query.get("select")) renderWorkerDetail(query.get("select"));
      } else if (route === "jobs") {
        renderJobsPage();
        const status = query.get("status");
        if (status) {
          const chip = $(`#filterStatus .chip[data-value="${CSS.escape(status)}"]`);
          if (chip) { for (const c of $$("#filterStatus .chip")) c.classList.remove("chip--active"); chip.classList.add("chip--active"); }
        }
        const project = query.get("project");
        if (project) {
          const sel = $("#filterProject");
          if (sel) sel.value = project;
        }
        const worker = query.get("worker");
        if (worker) {
          const sel = $("#filterWorker");
          if (sel) sel.value = worker;
        }
        if (status || project || worker) loadJobs();
        if (path[1]) openJobDrawer(path[1]);
      } else if (route === "tasks") {
        const node = await renderFactoryTaskBoard();
        if (isStale()) return;
        main.innerHTML = "";
        main.appendChild(node);
        if (path[1]) openFactoryTaskDrawer(decodeURIComponent(path[1]));
      } else if (route === "task-requests") {
        const node = await renderTaskRequests();
        if (isStale()) return;
        main.innerHTML = "";
        main.appendChild(node);
        if (path[1]) openTaskRequestDrawer(decodeURIComponent(path[1]));
      } else if (route === "projects") {
        if (path[1]) {
          const node = await renderProjectDetail(decodeURIComponent(path[1]));
          if (isStale()) return;
          main.innerHTML = "";
          main.appendChild(node);
        } else {
          const node = await renderProjects();
          if (isStale()) return;
          main.innerHTML = "";
          main.appendChild(node);
        }
      } else if (route === "schedules") {
        const node = await renderSchedules();
        if (isStale()) return;
        main.innerHTML = "";
        main.appendChild(node);
      } else if (route === "tokens") {
        const node = await renderTokens();
        if (isStale()) return;
        main.innerHTML = "";
        main.appendChild(node);
      } else if (route === "compactions") {
        const node = await renderCompactions();
        if (isStale()) return;
        main.innerHTML = "";
        main.appendChild(node);
      } else if (route === "messages") {
        const node = await renderMessages();
        if (isStale()) return;
        main.innerHTML = "";
        main.appendChild(node);
      } else if (route === "report") {
        const node = await renderReport();
        if (isStale()) return;
        main.innerHTML = "";
        main.appendChild(node);
      } else if (route === "permissions") {
        const node = await renderPermissions();
        if (isStale()) return;
        main.innerHTML = "";
        main.appendChild(node);
      } else if (route === "notifications") {
        const node = await renderNotificationsSettings();
        if (isStale()) return;
        main.innerHTML = "";
        main.appendChild(node);
      } else if (route === "outsource") {
        const node = await renderOutsource();
        if (isStale()) return;
        main.innerHTML = "";
        main.appendChild(node);
      } else {
        if (!isStale()) renderErrorPage(`未知路由: ${route}`, null);
      }
    } catch (err) {
      if (!isStale()) renderErrorPage("路由渲染失败", String(err?.message || err));
    }
  }

  function renderErrorPage(title, detail) {
    const main = $("#main");
    main.innerHTML = "";
    main.appendChild(el("div", { class: "page" }, [errorBox(title, detail)]));
  }

  // ---- 全局刷新：永远刷新当前页面主体 + topbar（保留 hash/query/filter） ----
  // 数据源是 request-time read（fetch 拿的是 files 快照），不依赖 SSE / WebSocket。
  // 手动刷新 / 整页刷新 / 路由切换都会重新拉取。
  async function refreshCurrent() {
    const hash = location.hash || "#/overview";
    const [pathPart, queryPart] = hash.split("?");
    const path = pathPart.replace(/^#\/?/, "").split("/").filter(Boolean);
    const query = new URLSearchParams(queryPart || "");
    const route = path[0] || "overview";

    // 1) 总是拉一次 overview，更新 topbar
    const [ov, osProfRes, osRunRes] = await Promise.all([
      api("/api/overview"),
      api("/api/outsource/profiles"),
      api("/api/outsource/runs?limit=200"),
    ]);
    if (ov.ok) { STATE.lastOverview = ov.data; setTopbar(ov.data); }
    const outsourceBundle = {
      profiles: osProfRes?.ok ? (osProfRes.data?.profiles || []) : [],
      runs: osRunRes?.ok ? (osRunRes.data?.runs || []) : [],
      profilesError: osProfRes?.ok ? null : osProfRes?.detail,
      runsError: osRunRes?.ok ? null : osRunRes?.detail,
    };

    // 2) 按当前路由刷新主体
    if (route === "overview" || route === "") {
      renderOverview(STATE.lastOverview, outsourceBundle);
    } else if (route === "workers") {
      const res = await api("/api/workers");
      if (res.ok) renderWorkers(res.data.workers || []);
      if (path[1]) renderWorkerDetail(decodeURIComponent(path[1]));
      else if (query.get("select")) renderWorkerDetail(query.get("select"));
    } else if (route === "jobs") {
      await loadJobs();
      if (path[1]) openJobDrawer(path[1]);
    } else if (route === "tasks") {
      const node = await renderFactoryTaskBoard();
      const m = $("#main"); m.innerHTML = ""; m.appendChild(node);
      if (path[1]) openFactoryTaskDrawer(decodeURIComponent(path[1]));
    } else if (route === "task-requests") {
      const node = await renderTaskRequests();
      const m = $("#main"); m.innerHTML = ""; m.appendChild(node);
      if (path[1]) openTaskRequestDrawer(decodeURIComponent(path[1]));
    } else if (route === "projects") {
      if (path[1]) {
        const node = await renderProjectDetail(decodeURIComponent(path[1]));
        const m = $("#main"); m.innerHTML = ""; m.appendChild(node);
      } else {
        const node = await renderProjects();
        const m = $("#main"); m.innerHTML = ""; m.appendChild(node);
      }
    } else if (route === "schedules") {
      const node = await renderSchedules();
      const m = $("#main"); m.innerHTML = ""; m.appendChild(node);
    } else if (route === "tokens") {
      const node = await renderTokens();
      const m = $("#main"); m.innerHTML = ""; m.appendChild(node);
    } else if (route === "compactions") {
      const node = await renderCompactions();
      const m = $("#main"); m.innerHTML = ""; m.appendChild(node);
    } else if (route === "messages") {
      await loadMessages();
    } else if (route === "report") {
      const node = await renderReport();
      const m = $("#main"); m.innerHTML = ""; m.appendChild(node);
    } else if (route === "permissions") {
      const node = await renderPermissions();
      const m = $("#main"); m.innerHTML = ""; m.appendChild(node);
    } else if (route === "notifications") {
      const node = await renderNotificationsSettings();
      const m = $("#main"); m.innerHTML = ""; m.appendChild(node);
    } else if (route === "outsource") {
      const node = await renderOutsource();
      const m = $("#main"); m.innerHTML = ""; m.appendChild(node);
    }

    toast(t("toast.refreshed"), "success");
  }

  // ---- 初始化 ----
  function bind() {
    $("#langSwitch")?.addEventListener("click", () => {
      setLanguage(STATE.lang === "zh" ? "en" : "zh");
      route();
    });
    $("#refreshBtn").addEventListener("click", () => refreshCurrent());
    $("#drawerClose").addEventListener("click", closeDrawer);
    $("#drawerBackdrop").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDrawer();
    });
    window.addEventListener("hashchange", route);
    // 后退 / 前进：重渲染整个 main（只特殊处理 workers 页内交互）
    window.addEventListener("popstate", route);
  }

  document.addEventListener("DOMContentLoaded", () => {
    bind();
    applyStaticI18n();
    void loadNotificationSettings();
    route();
  });
})();
