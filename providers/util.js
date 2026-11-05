'use strict';
const short = (s, n = 30) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 按行读取流式响应（SSE）
async function* readLines(body) {
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { yield buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); }
  }
  if (buf) yield buf;
}

// 本机小模型最常见的错误是聊天记录超出了它的上下文长度，碰到时顺便说怎么调
const CONTEXT_ERROR = /context[ _-]?(length|size|window)|maximum context|n_ctx|prompt is too long|input is too long|too many tokens|exceeds? (the )?(available )?context|上下文/i;
async function httpError(res) {
  let t = ''; try { t = await res.text(); } catch {}
  let msg = `HTTP ${res.status}：${short(t, 400)}`;
  if (res.status !== 429 && CONTEXT_ERROR.test(t)) msg += '\n提示：多半是聊天记录超出了这个模型的上下文长度。编辑智能体 →「小模型 / 专精模型适配」→ 把「最多带多少字聊天记录」调小（比如 4000），或者把模型的上下文调大。';
  return new Error(msg);
}

// 发给模型的 messages：房间里已经按智能体的设置排好了（ctx.messages），测试连接等场合按 system + prompt 拼一个
const toMessages = (system, prompt, ctx = {}) => ctx.messages || [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
// 停止词：一行一个，可以写 \n 表示换行；没有时返回 null（模板里整个字段省略）
function stopList(text) {
  const list = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
  return list.length ? list : null;
}

// fetch 本身失败（连不上、DNS 失败等）时给出可读的提示
async function fetchOrExplain(url, init) {
  try { return await fetch(url, init); }
  catch (e) {
    if (init.signal && init.signal.aborted) throw e;
    throw new Error(`连不上 ${url}：${(e.cause && (e.cause.code || e.cause.message)) || e.message}`);
  }
}

module.exports = { short, sleep, readLines, httpError, fetchOrExplain, toMessages, stopList };
