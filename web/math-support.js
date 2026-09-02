// Local KaTeX bridge for the zero-build Ox Factory dashboard.
(function installOxMath(global) {
  "use strict";

  const BACKTICK = String.fromCharCode(96);
  const TOKEN_PREFIX = "\u0002OXMATH:";
  const TOKEN_SUFFIX = "\u0003";

  function identity(text) {
    return {
      text,
      restore(html) {
        return html;
      },
    };
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);
  }

  function isEscaped(text, index) {
    let slashes = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
    return slashes % 2 === 1;
  }

  function findClosing(text, start, close, allowNewline) {
    for (let i = start; i <= text.length - close.length; i++) {
      if (!allowNewline && text[i] === "\n") return -1;
      if (!text.startsWith(close, i) || isEscaped(text, i)) continue;
      if (close === "$" && (text[i - 1] === "$" || text[i + 1] === "$")) continue;
      return i;
    }
    return -1;
  }

  function lineEndAfter(text, start) {
    const newline = text.indexOf("\n", start);
    return newline === -1 ? text.length : newline + 1;
  }

  function fencedCodeEnd(text, start) {
    let cursor = lineEndAfter(text, start);
    while (cursor < text.length) {
      const end = lineEndAfter(text, cursor);
      const line = text.slice(cursor, end);
      if (line.startsWith(BACKTICK.repeat(3))) return end;
      cursor = end;
    }
    return text.length;
  }

  function inlineCodeEnd(text, start) {
    let tickCount = 1;
    while (text[start + tickCount] === BACKTICK) tickCount++;
    const delimiter = BACKTICK.repeat(tickCount);
    const end = text.indexOf(delimiter, start + tickCount);
    if (end === -1 || text.slice(start, end).includes("\n")) return start + tickCount;
    return end + tickCount;
  }

  function renderFormula(katexApi, tex, raw, displayMode) {
    try {
      const rendered = katexApi.renderToString(tex, {
        displayMode,
        throwOnError: false,
        strict: "warn",
        trust: false,
        output: "htmlAndMathml",
      });
      const mode = displayMode ? "display" : "inline";
      return '<span class="md__math md__math--' + mode + '">' + rendered + "</span>";
    } catch {
      return '<span class="md__math-error" title="公式渲染失败">' + escapeHtml(raw) + "</span>";
    }
  }

  function prepare(value, katexApi) {
    const source = String(value == null ? "" : value);
    if (!katexApi || typeof katexApi.renderToString !== "function") return identity(source);

    const replacements = [];
    let prepared = "";
    let i = 0;

    const stash = (raw, tex, displayMode) => {
      const token = TOKEN_PREFIX + replacements.length + TOKEN_SUFFIX;
      replacements.push(renderFormula(katexApi, tex.trim(), raw, displayMode));
      prepared += token;
    };

    while (i < source.length) {
      const atLineStart = i === 0 || source[i - 1] === "\n";

      if (atLineStart && source.startsWith(BACKTICK.repeat(3), i)) {
        const end = fencedCodeEnd(source, i);
        prepared += source.slice(i, end);
        i = end;
        continue;
      }

      if (source[i] === BACKTICK) {
        const end = inlineCodeEnd(source, i);
        prepared += source.slice(i, end);
        i = end;
        continue;
      }

      let open = "";
      let close = "";
      let displayMode = false;
      let allowNewline = false;

      if (source.startsWith("$$", i) && !isEscaped(source, i)) {
        open = "$$";
        close = "$$";
        displayMode = true;
        allowNewline = true;
      } else if (source.startsWith("\\[", i) && !isEscaped(source, i)) {
        open = "\\[";
        close = "\\]";
        displayMode = true;
        allowNewline = true;
      } else if (source.startsWith("\\(", i) && !isEscaped(source, i)) {
        open = "\\(";
        close = "\\)";
      } else if (source[i] === "$" && source[i + 1] !== "$" && !isEscaped(source, i)) {
        open = "$";
        close = "$";
      }

      if (!open) {
        prepared += source[i];
        i++;
        continue;
      }

      const contentStart = i + open.length;
      const closeAt = findClosing(source, contentStart, close, allowNewline);
      const tex = closeAt === -1 ? "" : source.slice(contentStart, closeAt);
      if (closeAt === -1 || !tex.trim()) {
        prepared += source[i];
        i++;
        continue;
      }

      const end = closeAt + close.length;
      stash(source.slice(i, end), tex, displayMode);
      i = end;
    }

    return {
      text: prepared,
      restore(html) {
        return String(html).replace(/\u0002OXMATH:(\d+)\u0003/g, (token, index) => replacements[Number(index)] || token);
      },
    };
  }

  global.OxMath = Object.freeze({ prepare });
})(globalThis);
