'use strict';
// 通用回复读取：对方返回 JSON、SSE（data: …）、NDJSON（一行一个 JSON，比如 Ollama 原生接口）还是纯文本都行，能边收边显示。
// 回复文字在哪个字段：先看指定的位置（比如 data.reply），没指定就按常见接口的写法依次找。
// 另外负责隐藏推理模型的 <think>思考过程</think>（hideThinking）。
const { readLines, short } = require('./util');

// 一次性返回的 JSON 里，回复文字常见的位置
const FULL_PATHS = ['choices.0.message.content', 'choices.0.text', 'message.content', 'response', 'reply', 'answer',
  'generated_text', '0.generated_text', 'results.0.text', 'output.text', 'output.choices.0.message.content', 'outputs.0.text',
  'candidates.0.content.parts.0.text', 'content.0.text', 'data.reply', 'data.answer', 'data.text', 'data.content', 'data.output',
  'result', 'output', 'text', 'content', 'completion'];
// 流式返回时，每一小段文字常见的位置
const DELTA_PATHS = ['choices.0.delta.content', 'choices.0.text', 'message.content', 'response', 'token.text', 'delta.text',
  'answer', 'candidates.0.content.parts.0.text', 'output.text', 'data.text', 'token', 'content', 'text', 'reply'];

const get = (obj, p) => String(p).split('.').filter(Boolean).reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
// 找回复文字：给了位置就只看那里，没给就依次试常见位置；找不到返回 undefined（空字符串也算找到了）
function find(obj, p, list) {
  if (p) { const v = get(obj, p); return typeof v === 'string' ? v : undefined; }
  if (typeof obj === 'string') return obj;
  for (const q of list) { const v = get(obj, q); if (typeof v === 'string') return v; }
  return undefined;
}
function errorOf(j) {
  if (!j || typeof j !== 'object') return '';
  if (j.event === 'error') return String(j.message || JSON.stringify(j)); // Dify
  const e = j.error;
  if (!e) return '';
  return typeof e === 'string' ? e : String(e.message || JSON.stringify(e));
}
function pickReply(j, p = '', list = FULL_PATHS, hint = '') {
  const t = find(j, p, list);
  if (t !== undefined) return t;
  const err = errorOf(j);
  if (err) throw new Error(err);
  throw new Error(`${p ? `回复里没有「${p}」这个字段` : '没认出回复文字在哪个字段'}${hint ? '，' + hint : ''}。收到的是：${short(JSON.stringify(j), 300)}`);
}

// 流里的每一段交给 add：有的接口每次给新增的一小段（增量），有的每次给到目前为止的全文（累计），第二段时判断是哪种
function collector(onDelta, cumulative) {
  let text = '', n = 0, cum = false;
  return {
    add(s) {
      if (typeof s !== 'string' || !s) return;
      n++;
      if (cumulative && n === 2 && text && s.length > text.length && s.startsWith(text)) cum = true;
      const d = cum && s.startsWith(text) ? s.slice(text.length) : s;
      if (d) { text += d; onDelta(d); }
    },
    get text() { return text; },
  };
}

async function readEvents(stream, kind, o) {
  const out = collector(o.onDelta, o.cumulative);
  let seen = 0, matched = 0, first = null;
  for await (const line of readLines(stream)) {
    let data = line;
    if (kind === 'sse') {
      if (!line.startsWith('data:')) continue; // event:、id:、注释行（: ping）都跳过
      data = line.slice(5).replace(/^ /, '');
      if (data.trim() === '[DONE]') break;
    }
    if (!data.trim()) continue;
    let j;
    try { j = JSON.parse(data); }
    catch { if (kind === 'sse') { matched++; out.add(data); } continue; } // SSE 里直接是文字
    const err = errorOf(j);
    if (err) throw new Error(err);
    if (o.onEvent) o.onEvent(j);
    if (j && j.token && j.token.special) continue; // TGI 的特殊符号（</s> 之类）
    seen++; if (!first) first = j;
    const t = find(j, o.path, o.delta);
    if (t !== undefined) { matched++; out.add(t); }
    if (kind === 'ndjson' && j && j.done === true) break; // Ollama 原生接口的最后一行
  }
  if (seen && !matched) {
    throw new Error(`收到了 ${seen} 段流式数据，但${o.path ? `里面没有「${o.path}」这个字段` : '没认出回复文字在哪个字段'}${o.hint ? '，' + o.hint : ''}。第一段是：${short(JSON.stringify(first), 300)}`);
  }
  return out.text;
}

async function readText(stream, onDelta) {
  const dec = new TextDecoder(); let text = '';
  for await (const chunk of stream) {
    const s = typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
    if (s) { text += s; onDelta(s); }
  }
  const s = dec.decode();
  if (s) { text += s; onDelta(s); }
  return text;
}
async function readAll(stream) {
  const dec = new TextDecoder(); let text = '';
  for await (const chunk of stream) text += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
  return text + dec.decode();
}

// 已经收完的一整段：先当 JSON，再当一行一个 JSON，都不是就当纯文本
function parseBuffered(raw, o) {
  const s = raw.trim();
  if (!s) return '';
  try { const j = JSON.parse(s); if (o.onEvent) o.onEvent(j); const t = pickReply(j, o.path, o.full, o.hint); o.onDelta(t); return t; }
  catch (e) { if (!(e instanceof SyntaxError)) throw e; }
  const lines = s.split(/\r?\n/).filter((l) => l.trim());
  let objs = null;
  try { objs = lines.map((l) => JSON.parse(l)); } catch {}
  if (objs) {
    const out = collector(o.onDelta, o.cumulative);
    for (const j of objs) {
      const err = errorOf(j);
      if (err) throw new Error(err);
      if (o.onEvent) o.onEvent(j);
      out.add(find(j, o.path, o.delta));
    }
    if (out.text) return out.text;
  }
  o.onDelta(raw);
  return raw;
}

// 没写内容类型（或写成 text/plain 之类）时，看开头几个字决定怎么读
async function sniff(stream, o) {
  const it = stream[Symbol.asyncIterator]();
  const dec = new TextDecoder(); const head = []; let peek = '';
  while (!peek.trim()) {
    const { value, done } = await it.next();
    if (done) break;
    head.push(value); peek += typeof value === 'string' ? value : dec.decode(value, { stream: true });
  }
  const rest = (async function* () { yield* head; for (;;) { const { value, done } = await it.next(); if (done) return; yield value; } })();
  const t = peek.trimStart();
  if (/^(data|event|id|retry):/.test(t)) return readEvents(rest, 'sse', o);
  if (t.startsWith('{') || t.startsWith('[')) return parseBuffered(await readAll(rest), o);
  return readText(rest, o.onDelta);
}

// 读取 fetch 的响应（也可以直接传一个可迭代的流，比如命令的标准输出）
async function readReply(res, { path = '', onDelta = () => {}, onEvent = null, full = FULL_PATHS, delta = DELTA_PATHS, cumulative = true, hint = '' } = {}) {
  const o = { path: String(path || '').trim(), onDelta, onEvent, full, delta, cumulative, hint };
  if (!res.body) return '';
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type.includes('event-stream')) return readEvents(res.body, 'sse', o);
  if (/ndjson|jsonl|json-seq|jsonlines/.test(type)) return readEvents(res.body, 'ndjson', o);
  if (type.includes('json')) return parseBuffered(await readAll(res.body), o);
  return sniff(res.body, o);
}

// 推理模型（Qwen3、DeepSeek-R1 蒸馏版等）会先输出 <think>思考过程</think> 再回答：思考过程不进群聊。
// 有的模型开头不写 <think>、直接从思考内容开始，到 </think> 才结束：碰到 </think> 时把前面已经显示的清掉。
function hideThinking(onDelta, onReset, onThink = () => {}) {
  const OPEN = '<think>', CLOSE = '</think>';
  let state = 'start', buf = '', text = '', closed = false, trim = true;
  const emit = (s) => {
    if (trim) { s = s.replace(/^\s+/, ''); if (!s) return; trim = false; }
    text += s; onDelta(s);
  };
  // 结尾可能是 </think> 的前半截，先留着
  const hold = (s) => { for (let k = Math.min(CLOSE.length - 1, s.length); k > 0; k--) if (CLOSE.startsWith(s.slice(-k))) return k; return 0; };
  function push(chunk) {
    buf += chunk;
    for (;;) {
      if (state === 'start') {
        const t = buf.replace(/^\s+/, '');
        if (!t) return;
        if (t.startsWith(OPEN)) { state = 'think'; buf = t.slice(OPEN.length); continue; }
        if (OPEN.startsWith(t)) return; // 可能是 <think> 的前半截，再等等
        state = 'answer'; buf = t; continue;
      }
      if (state === 'think') {
        const i = buf.indexOf(CLOSE);
        if (i < 0) { const keep = CLOSE.length - 1; if (buf.length > keep) { onThink(buf.slice(0, buf.length - keep)); buf = buf.slice(-keep); } return; }
        if (i) onThink(buf.slice(0, i));
        buf = buf.slice(i + CLOSE.length); state = 'answer'; closed = true; trim = true; continue;
      }
      if (!closed) {
        const i = buf.indexOf(CLOSE);
        if (i >= 0) { onThink(text + buf.slice(0, i)); text = ''; onReset(); buf = buf.slice(i + CLOSE.length); closed = true; trim = true; continue; }
        const k = hold(buf);
        emit(buf.slice(0, buf.length - k)); buf = buf.slice(buf.length - k);
        return;
      }
      emit(buf); buf = '';
      return;
    }
  }
  return {
    push,
    reset() { state = 'start'; buf = ''; text = ''; closed = false; trim = true; onReset(); },
    end() {
      if (state === 'think') { if (!text) emit('*（模型只输出了思考过程，没有给出回答）*'); }
      else if (buf) emit(buf);
      buf = '';
    },
    get text() { return text; },
  };
}

module.exports = { readReply, pickReply, hideThinking, FULL_PATHS, DELTA_PATHS };
