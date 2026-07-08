// 牛马工厂本地 Web 驾驶舱 · Phase 1 客户端
// 纯原生 JS，无依赖；不引第三方库。
// ---------------------------------------------------------------------------

(() => {
  "use strict";

  // ---- 配置 ----
  const REFRESH_DEBOUNCE_MS = 200;
  const DRAWER_OPEN_CLASS = "drawer--open";
  const LANG_STORAGE_KEY = "oxFactoryLang";
  const I18N = {
    zh: {
      "app.title": "牛马工厂 · 驾驶舱",
      "brand.title": "牛马工厂",
      "brand.subtitle": "本地驾驶舱 · Phase 1 · 只读",
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
      "nav.schedules": "定时任务",
      "nav.tokens": "Token",
      "nav.compactions": "压缩",
      "nav.messages": "消息",
      "nav.report": "日报",
      "nav.permissions": "权限",
      "nav.phase": "Phase 1 · read-first",
      "nav.readonly": "不写权限 / 不派活 / 不 apply 压缩",
      "topbar.updatedAt": "更新于",
      "toast.refreshed": "已刷新",
    },
    en: {
      "app.title": "Ox Factory · Dashboard",
      "brand.title": "Ox Factory",
      "brand.subtitle": "Local Dashboard · Phase 1 · Read-only",
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
      "nav.schedules": "Schedules",
      "nav.tokens": "Tokens",
      "nav.compactions": "Compactions",
      "nav.messages": "Messages",
      "nav.report": "Report",
      "nav.permissions": "Permissions",
      "nav.phase": "Phase 1 · read-first",
      "nav.readonly": "No writes / no dispatch / no compaction apply",
      "topbar.updatedAt": "Updated",
      "toast.refreshed": "Refreshed",
    },
  };
  const STATE = {
    lastOverview: null,
    workers: [],
    jobs: [],
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
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
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

    const html = out.join("\n");
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
    return wrap;
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
  };

  function statusPill(status) {
    const s = String(status || "idle");
    return el("span", { class: `pill pill--${s}`, text: STATUS_LABELS[s] || s });
  }

  function workerStatusDot(status) {
    return el("span", { class: `dot dot--${status || "idle"}`, title: status || "idle" });
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
  function renderOverview(overview) {
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

  function kpiCard(label, value, sub) {
    return el("div", { class: "kpi" }, [
      el("div", { class: "kpi__label", text: label }),
      el("div", { class: "kpi__value", text: value }),
      el("div", { class: "kpi__sub", text: sub }),
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
  function messageItem(m, opts = {}) {
    // m: { from, to, direction, createdAt, content, read }
    // opts: { defaultOpen, showDirection, showRead }
    const showDirection = opts.showDirection !== false;
    const showRead = opts.showRead !== false;
    const defaultOpen = Boolean(opts.defaultOpen);
    const direction = m.direction || (m.to === (opts.worker || "") ? "in" : "out");

    // 预览（第一行 plain text，折叠时可见）
    const preview = String(m.content || "").replace(/\s+/g, " ").trim().slice(0, 120);

    const headChildren = [];
    if (showDirection) {
      headChildren.push(el("span", { class: `tag tag--${direction === "in" ? "main" : "soft"}`, text: direction === "in" ? "IN" : "OUT" }));
    }
    headChildren.push(el("span", { class: "msg-list__peer", text: `${m.from} → ${m.to}` }));
    headChildren.push(el("span", { class: "msg-list__time", text: fmtRelative(m.createdAt) }));
    if (showRead && m.read === false) {
      headChildren.push(el("span", { class: "msg-preview__unread", text: "未读" }));
    }

    // 详情项（原生 <details>，可折叠）
    const details = el("details", {
      class: `msg-list__item msg-list__item--${direction} ${defaultOpen ? "msg-list__item--open" : ""}`,
    });
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
          el("div", { class: `avatar avatar--${w.status || "idle"}${w.status === "vacation" ? " avatar--vacation" : ""}` }, [el("span", { class: "avatar__char", text: (w.name || "?").slice(0, 1) })]),
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

    const split = el("section", { class: "workers" }, [
      el("aside", { class: "workers__list" },
        workers.map((w) => el("a", {
          class: `worker-card${w.status === "vacation" ? " worker-card--vacation" : ""}${w.name === initialWorker ? " worker-card--active" : ""}`,
          href: `#/workers/${encodeURIComponent(w.name)}`,
          data: { name: w.name },
          onclick: (e) => {
            // 拦截：只更新 detail + active class，不重渲染整个 main
            e.preventDefault();
            navigateToWorker(w.name);
          },
        }, [
          el("div", { class: `avatar avatar--${w.status || "idle"}${w.status === "vacation" ? " avatar--vacation" : ""}` }, [el("span", { class: "avatar__char", text: (w.name || "?").slice(0, 1) })]),
          el("div", { class: "worker-card__body" }, [
            el("div", { class: "worker-card__name" }, [
              workerStatusDot(w.status),
              el("span", { text: w.name }),
              w.status === "vacation" ? el("span", { class: "worker-card__vacation-badge", text: "🏖 休假" }) : null,
            ]),
            el("div", { class: "worker-card__meta" }, [
              el("span", { text: STATUS_LABELS[w.status] || w.status || "idle" }),
              w.role ? el("span", { text: `· ${w.role}` }) : null,
            ]),
            w.responsibility ? el("div", { class: "worker-card__meta", text: w.responsibility.split("\n")[0] }) : null,
            el("div", { class: "worker-card__stats" }, [
              el("span", { text: `Jobs ${w.jobCount}` }),
              el("span", { text: `Tok ${fmtNumber(w.tokenToday?.totalWithCached || 0)}` }),
              el("span", { text: `消息 ${w.unreadMessages || 0}` }),
            ]),
          ]),
        ]))),
      el("div", { class: "workers__detail", id: "workerDetail" }, [
        emptyState("选择左侧员工查看详情"),
      ]),
    ]);
    wrap.appendChild(split);
    main.appendChild(wrap);
  }

// 和 TA 对话 · Web 版 /talk 员工名
  // 限制：text 发送后，服务端调 jobs.mjs.createJob(kind:"talk") 创建 job。
  // Pi 主进程内 workerJobQueues 不会主动拾取 web 创建的 job 文件；
  // 依赖秘书/主 agent 读 messages.jsonl 后用 /talk 内核正式起活。
  // 这里只要 UI：输入 → 看已发 → 默认一次拉、看响应 → 「刷新」重拉
  function buildTalkPanel(worker, d) {
    const card = el("div", { class: "card talk-panel" });
    const head = el("div", { class: "card__head" });
    head.appendChild(el("h3", { class: "card__title", text: `和 ${worker} 对话` }));
    head.appendChild(el("p", { class: "card__sub", text: "Web 版 /talk · 提交到 Pi 主进程，由主进程走正常 talk 调度：空闲马上开始，忙碌自动排队。", }));
    card.appendChild(head);

    // 状态条：显示后台进程是否能拾起
    const status = d.status || "idle";
    card.appendChild(el("div", { class: "talk-panel__meta" }, [
      el("span", { class: `tag tag--${status === "busy" ? "main" : "soft"}`, text: `状态：${status}` }),
      d.backend ? el("span", { class: "tag tag--soft", text: `backend: ${d.backend}` }) : null,
      d.model ? el("span", { class: "tag tag--soft", text: `model: ${d.model}` }) : null,
      d.thinking ? el("span", { class: "tag tag--soft", text: `thinking: ${d.thinking}` }) : null,
    ]));

    // 输入区
    const textarea = el("textarea", {
      class: "input talk-panel__input",
      id: `talkInput-${worker}`,
      placeholder: `输入要发送给 ${worker} 的消息…（Ctrl+Enter 发送）`,
      rows: 4,
    });
    const sendBtn = el("button", {
      class: "btn btn--primary",
      id: `talkSendBtn-${worker}`,
      type: "button",
      text: "发送",
      disabled: false,
    });
    const hint = el("p", { class: "muted talk-panel__hint", html: md("发送后会生成 web-talk 请求；Pi 主进程接管后才会创建真实 talk job。若刚升级代码，请 reload Pi。", { compact: true, max: 200 }) });

    // 提示：API 调用状态
    const feedback = el("div", { class: "talk-panel__feedback", id: `talkFeedback-${worker}` });
    const sendRow = el("div", { class: "talk-panel__row" }, [textarea, el("div", { class: "talk-panel__actions" }, [sendBtn, feedback])]);
    card.appendChild(sendRow);
    card.appendChild(hint);

    // 历史 talk jobs（最近 20 条）
    const historyBox = el("div", { class: "talk-panel__history", id: `talkHistory-${worker}` }, [el("p", { class: "muted", text: "加载中…" })]);
    card.appendChild(historyBox);

    // 点击发送
    const send = async () => {
      const msg = (textarea.value || "").trim();
      if (!msg) { feedback.textContent = "消息不能为空"; feedback.className = "talk-panel__feedback talk-panel__feedback--error"; return; }
      sendBtn.disabled = true;
      sendBtn.textContent = "发送中…";
      feedback.textContent = "";
      feedback.className = "talk-panel__feedback";
      const res = await api(`/api/talk/${encodeURIComponent(worker)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      sendBtn.disabled = false;
      sendBtn.textContent = "发送";
      if (!res.ok) {
        feedback.textContent = `❌ ${(res.detail && (res.detail.error?.message || res.detail)) || "发送失败"}`;
        feedback.className = "talk-panel__feedback talk-panel__feedback--error";
        return;
      }
      const requestId = res.data?.request?.id;
      feedback.textContent = requestId
        ? `✓ 已提交 · request ${requestId.slice(-6)}，等待 Pi 主进程接管…`
        : "✓ 已提交，等待 Pi 主进程接管…";
      feedback.className = "talk-panel__feedback talk-panel__feedback--ok";
      textarea.value = "";
      if (requestId) await waitTalkRequest(worker, requestId, feedback);
      await reloadTalkHistory(worker);
    };
    sendBtn.addEventListener("click", send);
    textarea.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send(); }
    });

    // 首次加载历史
    queueMicrotask(() => reloadTalkHistory(worker));
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

  async function reloadTalkHistory(worker) {
    const box = document.getElementById(`talkHistory-${worker}`);
    if (!box) return;
    const res = await api(`/api/jobs?worker=${encodeURIComponent(worker)}&limit=20`);
    if (!res.ok) { box.innerHTML = ""; box.appendChild(errorBox("加载对话历史失败", res.detail)); return; }
    const jobs = (res.data.jobs || []).filter((j) => j.project === "talk");
    box.innerHTML = "";
    if (!jobs.length) { box.appendChild(el("p", { class: "muted", text: "暂无对话记录。发第一条消息试试。", })); return; }
    // 最新在上面
    const list = el("ul", { class: "talk-list" }, jobs.map((j) => {
      const li = el("li", { class: "talk-list__item" }, [
        el("div", { class: "talk-list__head" }, [
          statusPill(j.status),
          el("span", { class: "talk-list__id", text: (j.id || "").slice(-6) }),
          el("span", { class: "talk-list__time", text: fmtRelative(j.updatedAt || j.createdAt) }),
          el("button", { class: "btn btn--ghost talk-list__btn", type: "button", text: "查看", onclick: () => openJobDrawer(j.id) }),
        ]),
        el("div", { class: "talk-list__task", text: j.task || "" }),
      ]);
      return li;
    }));
    box.appendChild(list);
  }

  async function renderWorkerDetail(name) {
    const myId = ++currentDetailId;
    const target = $("#workerDetail");
    if (!target) return;
    target.innerHTML = "";
    target.appendChild(el("div", { class: "skeleton skeleton--row" }));
    const res = await api(`/api/workers/${encodeURIComponent(name)}`);
    if (myId !== currentDetailId) return;
    if (!res.ok) {
      target.innerHTML = "";
      target.appendChild(errorBox("加载员工详情失败", res.detail));
      return;
    }
    const d = res.data;
    target.innerHTML = "";
    const head = el("header", { class: "worker-detail__head" }, [
      el("div", { class: `avatar avatar--lg${d.status === "vacation" ? " avatar--vacation" : ""}` }, [el("span", { class: "avatar__char", text: (d.name || "?").slice(0, 1) })]),
      el("div", { class: "worker-detail__title" }, [
        el("h2", {}, [
          d.status === "vacation" ? el("span", { class: "worker-card__vacation-badge", text: "🏖 休假" }) : null,
          el("span", { text: ` ${d.name}` }),
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

        target.appendChild(head);

    // 和 TA 对话 · Web 版 /talk 员工名
    target.appendChild(buildTalkPanel(name, d));

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

    // 消息收件箱（每条消息默认折叠；点 header 展开看完整 markdown）
    const inbox = d.inbox || [];
    const inboxBody = inbox.length === 0
      ? emptyState("暂无消息")
      : el("ul", { class: "msg-list" }, inbox.map((m) => messageItem(m, { defaultOpen: false, showDirection: true, showRead: false })));
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
        el("div", { class: "jobs-summary", id: "jobsSummary" }, [el("span", { class: "muted", text: "加载中…" })]),
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
    $("#drawerBody").appendChild(el("div", { class: "skeleton skeleton--row" }));
    const res = await api(`/api/jobs/${encodeURIComponent(id)}`);
    const body = $("#drawerBody");
    if (!res.ok) {
      body.innerHTML = "";
      body.appendChild(errorBox("加载 Job 详情失败", res.detail));
      return;
    }
    const d = res.data;
    body.innerHTML = "";
    body.appendChild(el("div", { class: "drawer__meta" }, [
      el("div", {}, [el("span", { class: "muted", text: "状态" }), statusPill(d.status)]),
      el("div", {}, [el("span", { class: "muted", text: "员工" }), el("strong", { text: d.worker || "—" })]),
      el("div", {}, [el("span", { class: "muted", text: "项目" }), el("strong", { text: d.project || "—" })]),
      el("div", {}, [el("span", { class: "muted", text: "创建" }), el("span", { text: fmtTime(d.createdAt, { dateOnly: false }) })]),
      el("div", {}, [el("span", { class: "muted", text: "更新" }), el("span", { text: fmtTime(d.updatedAt) })]),
      d.elapsedSeconds != null ? el("div", {}, [el("span", { class: "muted", text: "耗时" }), el("span", { text: `${d.elapsedSeconds}s` })]) : null,
    ]));
    body.appendChild(el("div", { class: "drawer__section" }, [
      el("h4", { text: "任务" }),
      d.task ? mdNode(d.task) : el("p", { class: "prose", text: "—" }),
    ]));
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
        el("h4", { text: `事件流 (${d.events.length})` }),
        el("ul", { class: "timeline" }, d.events.map((ev) => el("li", { class: `timeline__item timeline__item--${ev.isError ? "error" : ev.type}` }, [
          el("span", { class: "timeline__time", text: fmtTime(ev.time) }),
          el("span", { class: "timeline__type", text: ev.type }),
          ev.name ? el("span", { class: "timeline__name", text: ev.name }) : null,
          ev.text || ev.message ? el("span", { class: "timeline__text", text: ev.text || ev.message }) : null,
        ]))),
      ]));
    }
  }

  function closeDrawer() {
    const drawer = $("#drawer");
    drawer.classList.remove(DRAWER_OPEN_CLASS);
    drawer.setAttribute("aria-hidden", "true");
    STATE.drawerJob = null;
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

  function trendKpi(label, value, sub) {
    return el("div", { class: "trend-kpi" }, [
      el("div", { class: "trend-kpi__label", text: label }),
      el("div", { class: "trend-kpi__value", text: value }),
      el("div", { class: "trend-kpi__sub", text: sub }),
    ]);
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
      sectionHead("上下文 / 回复质量观测", "回溯 jobs/events/session：会话轮次、上下文估算、压缩次数、输入/输出长度、耗时、工具调用、情绪评分"),
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
        trendKpi("工具调用", String(totals.toolCalls || 0), "tool_start events"),
        trendKpi("已评分", String(totals.scoredTurns || 0), config.enabled ? "情绪旁路已开启" : "情绪旁路关闭"),
        trendKpi("丢弃", String(history.droppedJobs || 0), Object.entries(history.dropReasons || {}).map(([k, v]) => `${k}:${v}`).join(" · ") || "无明显坏数据"),
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
        cardHead(`员工质量指标 (${workers.length})`, `评分: ${config.enabled ? "开启" : "关闭"} · ${config.provider || "—"}/${config.model || "—"} · ${history.exactContextPerTurn ? "精确上下文" : "历史回放估算"} · usable ${history.usableJobs ?? totals.turns ?? 0}/${history.candidateJobs ?? "—"}`),
        workers.length
          ? el("div", { class: "table-wrap" }, [
              el("table", { class: "table quality-table" }, [
                el("thead", {}, [el("tr", {}, [
                  el("th", { text: "员工" }),
                  el("th", { text: "会话轮次" }),
                  el("th", { text: "上下文估算" }),
                  el("th", { text: "压缩" }),
                  el("th", { text: "样本" }),
                  el("th", { text: "平均输入" }),
                  el("th", { text: "平均输出" }),
                  el("th", { text: "平均耗时" }),
                  el("th", { text: "工具" }),
                  el("th", { text: "情绪" }),
                ])]),
                el("tbody", {}, workers.map((w) => el("tr", {}, [
                  el("td", { class: "td--mono", text: w.worker || "—" }),
                  el("td", { class: "td--mono", text: String(w.session?.userTurns || 0) }),
                  el("td", { class: "td--mono", text: fmtNumber(w.session?.estimatedContextTokens || 0) }),
                  el("td", { class: "td--mono", text: String(w.session?.compactionCount || 0) }),
                  el("td", { class: "td--mono", text: String(w.jobs?.count || 0) }),
                  el("td", { class: "td--mono", text: fmtNumber(w.jobs?.avgInputChars || 0) }),
                  el("td", { class: "td--mono", text: fmtNumber(w.jobs?.avgOutputChars || 0) }),
                  el("td", { class: "td--mono", text: fmtDurationMs(w.jobs?.avgResponseMs || 0) }),
                  el("td", { class: "td--mono", text: String(w.jobs?.toolCalls || 0) }),
                  el("td", { class: "td--mono", text: w.jobs?.avgEmotionScore == null ? "—" : String(w.jobs.avgEmotionScore) }),
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
                  el("th", { text: "输入/输出" }),
                  el("th", { text: "耗时" }),
                  el("th", { text: "工具" }),
                  el("th", { text: "上下文/压缩" }),
                  el("th", { text: "情绪" }),
                  el("th", { text: "任务" }),
                ])]),
                el("tbody", {}, turns.slice(0, 30).map((turn) => el("tr", { onclick: () => { location.hash = `#/jobs/${encodeURIComponent(turn.jobId)}`; } }, [
                  el("td", { class: "td--time", text: fmtTime(turn.createdAt) }),
                  el("td", { class: "td--mono", text: turn.worker || "—" }),
                  el("td", { class: "td--mono", text: `${fmtNumber(turn.inputChars)} / ${fmtNumber(turn.outputChars)}` }),
                  el("td", { class: "td--mono", text: fmtDurationMs(turn.responseMs) }),
                  el("td", { class: "td--mono", text: String(turn.toolCalls || 0) }),
                  el("td", { class: "td--mono", text: `${fmtNumber(turn.sessionContextTokens || 0)} / ${turn.sessionCompactions || 0}` }),
                  el("td", { class: "td--mono", text: turn.emotionScore == null ? "—" : `${turn.emotionScore}${turn.emotionLabel ? ` · ${turn.emotionLabel}` : ""}` }),
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
    { key: "sessionContextTokens",label: "上下文估算 token",fmt: fmtNumber },
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
      trendKpi("工具/turn", (avg(turns.map((t) => t.toolCalls || 0))).toFixed(1), "tool_start 计数"),
    ]));
    // 6 charts · 输入、上下文、时间趋势、情绪
    grid.appendChild(chartScatter("输入字符 → 输出字符", turns, "inputChars", "outputChars", "输入字符", "输出字符"));
    grid.appendChild(chartScatter("工具调用 → 输出字符", turns, "toolCalls", "outputChars", "工具调用数", "输出字符"));
    grid.appendChild(chartScatter("输入 token → 输出 token", turns, "inputTokens", "outputTokens", "输入 token", "输出 token"));
    grid.appendChild(chartScatter("耗时 ms → 输出字符", turns, "responseMs", "outputChars", "耗时 (ms)", "输出字符"));
    grid.appendChild(chartScatter("上下文估算 → 输出 token", turns, "sessionContextTokens", "outputTokens", "sessionContextTokens", "输出 token"));
    grid.appendChild(chartScatter("会话轮次 → 输出字符", turns, "sessionUserTurns", "outputChars", "sessionUserTurns", "输出字符"));
    grid.appendChild(chartLine("时间序列：输入/输出 token", turns, "createdAt", [
      { key: "inputTokens", label: "输入", color: "var(--seg-input)" },
      { key: "outputTokens", label: "输出", color: "var(--seg-output)" },
    ]));
    grid.appendChild(chartLine("时间序列：工具调用 / 耗时", turns, "createdAt", [
      { key: "toolCalls", label: "工具调用", color: "var(--seg-cache)" },
      { key: "responseMs", label: "耗时(ms)", color: "var(--seg-reasoning)" },
    ]));
    if (turns.some((t) => t.emotionScore != null)) {
      grid.appendChild(chartLine("情绪评分（情绪旁路开启时）", turns, "createdAt", [
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

  function chartScatter(title, data, xKey, yKey, xLabel, yLabel) {
    const card = el("div", { class: "chart-card" }, [
      el("div", { class: "chart-card__head" }, [
        el("h4", { class: "chart-card__title", text: title }),
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

  function chartLine(title, data, xKey, series) {
    // series: [{key, label, color}]
    const card = el("div", { class: "chart-card" }, [
      el("div", { class: "chart-card__head" }, [
        el("h4", { class: "chart-card__title", text: title }),
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
      const points = sorted
        .filter((d) => Number(d[s.key] || 0) > 0 || s.key === "emotionScore")
        .map((d, i, arr) => {
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
      sorted.forEach((d) => {
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

  function showChartTip(layer, d, fallback, e) {
    if (!layer) return;
    const lines = [
      `<strong>${esc(d.worker || "—")}</strong> · ${esc(fmtTime(d.createdAt))}`,
      `job <code>${esc((d.jobId || "").slice(-6))}</code>`,
      `输入 ${esc(fmtNumber(d.inputChars || 0))} / 输出 ${esc(fmtNumber(d.outputChars || 0))} 字符`,
      `耗时 ${esc(fmtDurationMs(d.responseMs || 0))} · 工具 ${esc(String(d.toolCalls || 0))}`,
      `上下文 ${esc(fmtNumber(d.sessionContextTokens || 0))} · 压缩 ${esc(String(d.sessionCompactions || 0))}`,
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
        el("div", { id: "messagesBody" }, [el("p", { class: "muted", text: "加载中…" })]),
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
    main.appendChild(el("div", { class: "page-loading" }, [
      el("div", { class: "skeleton skeleton--title" }),
      el("div", { class: "skeleton skeleton--row" }),
      el("div", { class: "skeleton skeleton--row" }),
    ]));

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
        const res = await api("/api/overview");
        if (isStale()) return;
        if (!res.ok) { renderErrorPage("加载 Overview 失败", res.detail); return; }
        STATE.lastOverview = res.data;
        setTopbar(res.data);
        renderOverview(res.data);
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
    const ov = await api("/api/overview");
    if (ov.ok) { STATE.lastOverview = ov.data; setTopbar(ov.data); }

    // 2) 按当前路由刷新主体
    if (route === "overview" || route === "") {
      renderOverview(STATE.lastOverview);
    } else if (route === "workers") {
      const res = await api("/api/workers");
      if (res.ok) renderWorkers(res.data.workers || []);
      if (path[1]) renderWorkerDetail(decodeURIComponent(path[1]));
      else if (query.get("select")) renderWorkerDetail(query.get("select"));
    } else if (route === "jobs") {
      await loadJobs();
      if (path[1]) openJobDrawer(path[1]);
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
    route();
  });
})();
