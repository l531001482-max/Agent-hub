'use strict';
// 请求模板：把 {{变量}} 填进 JSON 模板（「自定义 JSON 接口」的请求体、请求头和 OpenAI 兼容接口的额外参数都用它）。
// 先把模板解析成 JSON 再替换，所以聊天内容里的引号、换行不会把 JSON 弄坏。
// 整个字符串只有一个 {{变量}} 时保留原来的类型（数组、数字），值为空时整个字段省略；嵌在文字里时按文字替换。
// 没加引号的 {{messages}} 也接受，会自动补上引号。

const ONE = /^\{\{\s*(\w+)\s*\}\}$/;
const ANY = /\{\{\s*(\w+)\s*\}\}/g;
const OMIT = Symbol('omit');

// 模板文本 → JSON（没填时返回 null）
function parseTemplate(text, what = '模板') {
  const src = String(text || '').trim();
  if (!src) return null;
  try { return JSON.parse(src); }
  catch (e) {
    // 没加引号的 {{变量}}（比如 "messages": {{messages}}）补上引号再试
    const quoted = src.replace(/([:[,]\s*)\{\{\s*(\w+)\s*\}\}(?=\s*[,}\]])/g, '$1"{{$2}}"');
    try { return JSON.parse(quoted); } catch {}
    throw new Error(`${what}不是合法的 JSON：${e.message}`);
  }
}

function lookup(vars, name) {
  if (!(name in vars)) throw new Error(`模板里的 {{${name}}} 不是可用的变量（可用：${Object.keys(vars).join('、')}）`);
  return vars[name];
}
function fillValue(v, vars) {
  if (typeof v === 'string') {
    const one = v.match(ONE);
    if (one) { const x = lookup(vars, one[1]); return x === undefined || x === null || x === '' ? OMIT : x; }
    return v.replace(ANY, (_, k) => { const x = lookup(vars, k); return x === undefined || x === null ? '' : typeof x === 'string' ? x : JSON.stringify(x); });
  }
  if (Array.isArray(v)) return v.map((x) => fillValue(x, vars)).filter((x) => x !== OMIT);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) { const y = fillValue(x, vars); if (y !== OMIT) o[k] = y; }
    return o;
  }
  return v;
}
const fill = (tpl, vars) => { const v = fillValue(tpl, vars); return v === OMIT ? null : v; };

// 请求头模板 → { 名字: 文字 }
function fillHeaders(text, vars) {
  const tpl = parseTemplate(text, '请求头');
  if (!tpl) return {};
  if (typeof tpl !== 'object' || Array.isArray(tpl)) throw new Error('请求头要写成 JSON 对象，比如 {"X-API-Key": "{{key}}"}');
  const out = {};
  for (const [k, v] of Object.entries(fill(tpl, vars) || {})) out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  return out;
}
// 自己在请求头里写了 Authorization 或用到了 Key，就不再自动加 Bearer
const usesKey = (headers, key) => Object.entries(headers).some(([k, v]) => /^authorization$/i.test(k) || (key && String(v).includes(key)));

module.exports = { parseTemplate, fill, fillHeaders, usesKey };
