'use strict';
// 用量与预算（借鉴 Paperclip 的 budgets）：每次调用记下 token 和花费，按自然月汇总；
// 智能体可以设「本月预算」（美元）或「本月 token 上限」，用到 80% 时提醒一次，用完就自动跳过它。
// 记录在 data/usage.json（只有数字和名字，不含聊天内容和 Key）
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'usage.json');
const KEEP_MONTHS = 13; // 只留最近 13 个月的明细
const WARN_AT = 0.8;

let records = null;
let timer = null;
function load() {
  if (records) return records;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    records = Array.isArray(j.records) ? j.records.filter((r) => r && typeof r.ts === 'number') : [];
  } catch { records = []; }
  return records;
}
function flush() {
  clearTimeout(timer); timer = null;
  if (!records) return;
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - KEEP_MONTHS);
  records = records.filter((r) => r.ts >= cutoff.getTime());
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ records }));
  fs.renameSync(tmp, FILE);
}
const save = () => { if (!timer) timer = setTimeout(flush, 1000); };

const monthOf = (ts = Date.now()) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const dayOf = (ts = Date.now()) => { const d = new Date(ts); return `${monthOf(ts)}-${String(d.getDate()).padStart(2, '0')}`; };
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

// 花费：接口自己报了就用它的（Claude Code 会报，按 API 价格折算）；没报但填了单价就估算；都没有就是 null（未知）
function priceOf(agent, u) {
  if (typeof u.cost === 'number' && u.cost >= 0) return { cost: u.cost, est: false };
  const pin = num(agent.priceIn), pout = num(agent.priceOut);
  if (!pin && !pout) return { cost: null, est: false };
  return { cost: ((u.in + u.cache) * pin + u.out * pout) / 1e6, est: true }; // 缓存的输入按原价算，实际可能更便宜
}

// u = { in: 没命中缓存的输入, cache: 命中缓存的输入, out: 输出, cost?: 美元 }
function record(agent, u, { roomId = null, model = '' } = {}) {
  const r = { in: Math.round(num(u.in)), cache: Math.round(num(u.cache)), out: Math.round(num(u.out)) };
  if (!r.in && !r.out && !r.cache && typeof u.cost !== 'number') return null;
  const { cost, est } = priceOf(agent, { ...r, cost: u.cost });
  const rec = { ts: Date.now(), agentId: agent.id, name: agent.name, provider: agent.provider, model: model || agent.model || '', roomId, ...r, cost, est };
  load().push(rec); save();
  return rec;
}

const blank = () => ({ calls: 0, in: 0, cache: 0, out: 0, cost: 0, costCalls: 0 });
function add(t, r) { t.calls++; t.in += r.in; t.cache += r.cache; t.out += r.out; if (typeof r.cost === 'number') { t.cost += r.cost; t.costCalls++; } }

// 某个智能体本月用了多少
function spent(agentId, month = monthOf()) {
  const t = blank();
  for (const r of load()) if (r.agentId === agentId && monthOf(r.ts) === month) add(t, r);
  return t;
}
// token 上限算「没命中缓存的输入 + 输出」：缓存读取很便宜，Claude Code 每次都有上万
const tokensOf = (t) => t.in + t.out;

// 预算状况：over = 已经用完；ratio = 用了几成（两种上限取较高的）
function budget(agent) {
  const t = spent(agent.id);
  const lim = { usd: num(agent.budgetUsd), tokens: num(agent.budgetTokens) };
  const ratios = [];
  if (lim.usd) ratios.push(t.cost / lim.usd);
  if (lim.tokens) ratios.push(tokensOf(t) / lim.tokens);
  const ratio = ratios.length ? Math.max(...ratios) : 0;
  return { spent: t, limit: lim, ratio, over: ratios.length > 0 && ratio >= 1, limited: ratios.length > 0 };
}
const fmtUsd = (n) => '$' + (n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toFixed(4));
const fmtTok = (n) => (n >= 10000 ? (n / 10000).toFixed(n >= 1e6 ? 0 : 1) + ' 万' : String(n));
function budgetText(agent, b = budget(agent)) {
  const parts = [];
  if (b.limit.usd) parts.push(`${fmtUsd(b.spent.cost)} / ${fmtUsd(b.limit.usd)}`);
  if (b.limit.tokens) parts.push(`${fmtTok(tokensOf(b.spent))} / ${fmtTok(b.limit.tokens)} token`);
  return parts.join('，');
}

// 每个智能体每个月只提醒一次「快用完了」
const warned = new Set();
function shouldWarn(agent) {
  const b = budget(agent);
  if (!b.limited || b.over || b.ratio < WARN_AT) return null;
  const k = agent.id + '|' + monthOf();
  if (warned.has(k)) return null;
  warned.add(k);
  return b;
}

// 用量页：本月、今天按智能体汇总，以及最近 6 个月的总数
function report(agents) {
  const month = monthOf(), today = dayOf();
  const byAgent = new Map(), todayBy = new Map(), months = new Map();
  for (const r of load()) {
    const m = monthOf(r.ts);
    if (!months.has(m)) months.set(m, blank());
    add(months.get(m), r);
    if (m !== month) continue;
    if (!byAgent.has(r.agentId)) byAgent.set(r.agentId, { ...blank(), name: r.name });
    add(byAgent.get(r.agentId), r);
    if (dayOf(r.ts) === today) {
      if (!todayBy.has(r.agentId)) todayBy.set(r.agentId, blank());
      add(todayBy.get(r.agentId), r);
    }
  }
  const ids = [...new Set([...agents.map((a) => a.id), ...byAgent.keys()])];
  const rows = ids.map((id) => {
    const a = agents.find((x) => x.id === id);
    const t = byAgent.get(id) || { ...blank(), name: a ? a.name : '' };
    return {
      id, name: a ? a.name : t.name + '（已删除）', avatar: a && a.avatar, color: a && a.color, provider: a ? a.provider : '', exists: !!a,
      month: t, today: todayBy.get(id) || blank(),
      budgetUsd: a ? num(a.budgetUsd) : 0, budgetTokens: a ? num(a.budgetTokens) : 0,
      priced: a ? !!(num(a.priceIn) || num(a.priceOut)) : false,
    };
  }).filter((r) => r.exists || r.month.calls);
  const history = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6).map(([m, t]) => ({ month: m, ...t }));
  return { month, today, rows, history };
}

module.exports = { record, spent, budget, budgetText, shouldWarn, report, flush, tokensOf, fmtUsd, fmtTok, monthOf };
