'use strict';
const { callOpenAI } = require('./openai');
const { callAnthropic } = require('./anthropic');
const { callHttp } = require('./http');
const { callRest } = require('./rest');
const { callCommand } = require('./command');
const { callMock } = require('./mock');
const { callClaudeCode } = require('./claude-code');
const { callCodex } = require('./codex');
const { callRelay } = require('./relay');
const { withServer } = require('./local-server');
const { hideThinking } = require('./reply');

const CALL_TIMEOUT_MS = Number(process.env.CALL_TIMEOUT_MS) || 600000;
const RELAY_TIMEOUT_MS = Number(process.env.RELAY_TIMEOUT_MS) || 3600000; // 手动转达要等人回复，默认 60 分钟
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS) || 3600000; // 能运行命令、改文件的 Claude Code / Codex 干的活长（装工具、处理视频），默认 60 分钟
const usesTools = (a) => ['claude-code', 'codex'].includes(a.provider) && !!a.toolMode && a.toolMode !== 'chat';
const timeoutOf = (a) => (a.provider === 'relay' ? RELAY_TIMEOUT_MS : usesTools(a) ? TOOL_TIMEOUT_MS : CALL_TIMEOUT_MS);
const THINKING = new Set(['openai', 'rest', 'command', 'http']); // 本机推理模型常输出 <think>…</think>，默认不进群聊
const SERVED = new Set(['openai', 'rest', 'http']); // 可以填「启动命令」：连不上时自动启动本机模型服务

// API Key 写成 "env:变量名" 时从环境变量（或 .env）读取
function resolveKey(agent) {
  const k = agent.apiKey || '';
  return k.startsWith('env:') ? process.env[k.slice(4)] || '' : k;
}
// 这些官方接口一定要 Key：没填就先跳过，不白白报一次 401（本机、局域网、自己部署的服务不一定要 Key，不管）
const KEY_HOSTS = /(^|\.)(deepseek\.com|x\.ai|googleapis\.com|openai\.com|anthropic\.com)$/i;
function missingKey(agent) {
  if (agent.provider === 'claude-code') return !!String(agent.baseUrl || '').trim() && !resolveKey(agent); // 接第三方接口时要 Key
  if (!['openai', 'anthropic'].includes(agent.provider) || resolveKey(agent)) return false;
  if (agent.provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) return false;
  const base = agent.baseUrl || (agent.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
  try { return KEY_HOSTS.test(new URL(base).hostname); } catch { return false; }
}

// 接口报回来的用量：{ in: 没命中缓存的输入 token, cache: 命中缓存的, out: 输出, cost?: 美元 }；记账出错不影响回复
const safeUsage = (fn) => (u) => { try { if (u) fn(u); } catch (e) { console.warn('记录用量失败', e.message); } };
// 统一入口：流式调用一个智能体，边生成边回调 onDelta，返回完整回复
async function callLLM(agent, system, prompt, { signal, onDelta = () => {}, onReset = () => {}, onUsage = () => {}, onThinking = () => {}, onTrace = () => {}, ...ctx } = {}) {
  const userSignal = signal || new AbortController().signal;
  const limit = timeoutOf(agent);
  const timeout = AbortSignal.timeout(limit);
  const thinkOut = safeUsage(onThinking);
  const think = THINKING.has(agent.provider) && agent.thinking !== 'keep' ? hideThinking(onDelta, onReset, thinkOut) : null;
  const opts = { signal: AbortSignal.any([userSignal, timeout]), onDelta: think ? think.push : onDelta, onReset: think ? think.reset : onReset, onUsage: safeUsage(onUsage),
    onThinking: thinkOut, onTrace: safeUsage(onTrace), apiKey: resolveKey(agent), limitMs: limit, ctx };
  const run = () => {
    switch (agent.provider) {
      case 'mock': return callMock(agent, system, prompt, opts);
      case 'http': return callHttp(agent, system, prompt, opts);
      case 'rest': return callRest(agent, system, prompt, opts);
      case 'command': return callCommand(agent, system, prompt, opts);
      case 'anthropic': return callAnthropic(agent, system, prompt, opts);
      case 'claude-code': return callClaudeCode(agent, system, prompt, opts);
      case 'codex': return callCodex(agent, system, prompt, opts);
      case 'relay': return callRelay(agent, system, prompt, opts);
      default: return callOpenAI(agent, system, prompt, opts);
    }
  };
  try {
    const text = SERVED.has(agent.provider) ? await withServer(agent, run, opts) : await run();
    if (!think) return text;
    think.end();
    return think.text;
  } catch (e) {
    if (!userSignal.aborted && timeout.aborted) throw new Error(`调用超时（超过 ${Math.round(limit / 60000)} 分钟没有完成）`);
    throw e;
  }
}

module.exports = { callLLM, missingKey, KEY_HOSTS, timeoutOf };
