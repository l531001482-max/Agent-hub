'use strict';
// 交接：减少 AI 之间传话的损耗。
// 1. 交接单：发言末尾附一段「【交接】」，写结论、依据和来源、假设、没把握的地方、给下一位的提醒
// 2. 思考过程：DeepSeek、Claude Code、Codex 等报回来的思考过程单独存（不进正文），截取一部分给后面的 AI
// 3. 资料和文件：查过的网页、搜过什么、写出了哪些文件，跟着发言传下去；只能聊天的 AI 读不了文件，直接附上文件内容
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NO_READ } = require('./providers/wide');
const { officeText, decodeText } = require('./providers/attachments');
const { DEFAULT_WORKDIR, expandHome, customApi } = require('./providers/claude-code');

const MARK = '【交接】';
const ASK = `\n\n最后另起一段，以「${MARK}」开头，用 3～5 行写给后面接手的成员：结论；依据和来源（查过的网址、读写过的文件路径）；做了哪些假设；哪里没把握；提醒下一位注意什么。交接要短，正文里写过的不用重复。`;
const THINK_KEEP = 20000; // 每条发言最多存多少字思考过程

// 太长时留开头和结尾（结论一般在后面）
function clipEnds(s, n) {
  s = String(s || '').trim();
  if (s.length <= n) return s;
  const head = Math.ceil(n * 0.6), tail = n - head;
  return `${s.slice(0, head)}\n……（中间省略 ${s.length - n} 字）……\n${s.slice(-tail)}`;
}

// 收集这次发言用了哪些资料、写了哪些文件（来自 Claude Code、Codex 报的工具调用）
function tracer() {
  const t = { urls: [], searches: [], read: [], wrote: [] };
  const add = (list, v) => { v = String(v || '').trim(); if (v && !list.includes(v) && list.length < 20) list.push(v); };
  const abs = (p, wd) => path.resolve(wd || DEFAULT_WORKDIR, expandHome(String(p)));
  return {
    on(ev) {
      const i = (ev && ev.input) || {};
      if (ev.tool === 'WebFetch') add(t.urls, i.url);
      else if (ev.tool === 'WebSearch') add(t.searches, i.query);
      else if (ev.tool === 'Read' && i.file_path) add(t.read, abs(i.file_path, ev.workdir));
      else if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(ev.tool)) {
        for (const p of ev.paths || [i.file_path || i.notebook_path]) if (p) add(t.wrote, abs(p, ev.workdir));
      }
    },
    get value() { return Object.values(t).some((l) => l.length) ? t : null; },
  };
}

// 能自己打开文件的成员（Claude Code、Codex 的非「只聊天」档）只给路径；其他的直接附上内容
const canReadFiles = (a) => ['claude-code', 'codex'].includes(a.provider) && a.toolMode && a.toolMode !== 'chat';
const blocked = (p) => NO_READ.some((b) => p === b || p.startsWith(b + path.sep));
function fileText(p, limit) {
  if (blocked(p)) return null; // Key、登录凭证这些一律不读
  let st; try { st = fs.statSync(p); } catch { return null; }
  if (!st.isFile() || st.size > 5 * 1024 * 1024) return null;
  const buf = fs.readFileSync(p), ext = path.extname(p).slice(1).toLowerCase();
  let text = null;
  if (['docx', 'pptx', 'xlsx'].includes(ext)) { try { text = officeText(buf, ext); } catch {} }
  else text = decodeText(buf);
  return text && text.trim() ? clipEnds(text, limit) : null;
}

// 跑在 Anthropic 官方 Claude 上的成员不给别人的思考过程：输入里带着其他模型的思考过程节选时，
// 可能被 Anthropic 的安全检查（reasoning_extraction）拦下，整个子任务失败。它们照样能看到正文、交接单、资料和文件
function onClaude(a) {
  if (a.provider === 'claude-code') return !customApi(a);
  if (a.provider !== 'anthropic') return false;
  try { return !a.baseUrl || /(^|\.)anthropic\.com$/i.test(new URL(a.baseUrl).hostname); } catch { return true; }
}

const home = os.homedir();
const tidy = (p) => p.replace(home, '~');

// 给某个成员看的一条发言：正文 +（同一轮、或它要等的子任务的）思考过程节选、资料、文件
// deps：它要等的子任务的消息 id，这些给得更多
function enrich(m, { runId, receiver, deps }) {
  if (m.role !== 'agent' || (!m.thinking && !m.trace)) return m;
  const dep = deps.has(m.id);
  if (!dep && m.runId !== runId) return m; // 更早的轮次只给正文和交接，省 token
  const parts = [m.content];
  if (m.thinking && !onClaude(receiver)) parts.push(`〔${m.name} 的思考过程节选〕\n${clipEnds(m.thinking, dep ? 3000 : 1200)}`);
  const t = m.trace;
  if (t) {
    if (t.urls.length) parts.push('〔查过的网页〕' + t.urls.join('、'));
    if (t.searches.length) parts.push('〔搜过〕' + t.searches.join('；'));
    if (t.wrote.length) {
      parts.push('〔写出的文件〕' + t.wrote.map(tidy).join('、'));
      if (!canReadFiles(receiver)) {
        let left = dep ? 16000 : 6000;
        for (const p of t.wrote) {
          if (left < 500) break;
          const text = fileText(p, Math.min(left, dep ? 8000 : 3000));
          if (!text) continue;
          parts.push(`〔文件 ${tidy(p)} 的内容〕\n${text}`);
          left -= text.length;
        }
      }
    }
  }
  return { ...m, content: parts.filter(Boolean).join('\n\n') };
}

module.exports = { MARK, ASK, THINK_KEEP, tracer, enrich, canReadFiles, clipEnds, onClaude };
