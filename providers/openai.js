'use strict';
// OpenAI 兼容接口：DeepSeek、Grok、Gemini 等，以及本机的 Ollama、LM Studio、MLX、llama.cpp、vLLM 等
const { httpError, fetchOrExplain, toMessages, stopList } = require('./util');
const { parseTemplate, fillHeaders, usesKey } = require('./template');
const { readReply } = require('./reply');
const { withImagesOpenAI, NO_VISION } = require('./attachments');

const NO_VISION_MODELS = new Set(); // 试过、看不了图片的模型（接口地址 + 模型名）
function noVision(messages) {
  const i = messages.map((m) => m.role).lastIndexOf('user');
  if (i < 0) return messages;
  const out = messages.slice();
  out[i] = { ...out[i], content: out[i].content + '\n\n' + NO_VISION };
  return out;
}

const NO_USAGE = new Set(); // 不认 stream_options 的接口地址
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('aborted')); }, { once: true });
});

// 主模型繁忙（429 / 5xx）或已下线（404）时可以改用的备用模型
const FALLBACK_STATUS = new Set([404, 429, 500, 502, 503, 504]);

async function callOpenAI(agent, system, prompt, { signal, onDelta, onUsage = () => {}, onThinking = () => {}, apiKey, ctx = {} }) {
  const base = (agent.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  const fallbacks = String(agent.fallbackModels || '').split(/[,，、\s]+/).map((m) => m.trim()).filter((m) => m && m !== agent.model);
  const models = [agent.model || '', ...fallbacks];
  // 高级设置：额外参数（比如 top_p、repetition_penalty）、停止词、自定义请求头（本机或自己部署的服务常用）
  const extra = parseTemplate(agent.extraBody, '额外参数') || {};
  const stop = stopList(agent.stop);
  const headers = { 'content-type': 'application/json', ...fillHeaders(agent.headers, { key: apiKey || '', model: agent.model || '' }) };
  if (apiKey && !usesKey(headers, apiKey)) headers.authorization = 'Bearer ' + apiKey;
  let res, used;
  let official = false;
  try { official = /(^|\.)(deepseek\.com|x\.ai|googleapis\.com|openai\.com)$/i.test(new URL(base).hostname); } catch {}
  const request = async (messages) => {
    for (const [mi, model] of models.entries()) {
      // 模型名留空时不发 model：本机只跑一个模型的服务（llama.cpp、MLX 等）会用它默认的模型
      const body = { ...(model ? { model } : {}), stream: true, messages };
      if (typeof agent.temperature === 'number') body.temperature = agent.temperature;
      if (agent.maxTokens) body.max_tokens = Number(agent.maxTokens);
      if (stop) body.stop = stop;
      if (official && !NO_USAGE.has(base)) body.stream_options = { include_usage: true }; // 让官方接口在最后一段报用量
      Object.assign(body, extra);
      // 服务端临时繁忙（比如 Gemini 免费版常见的 503）或限流时，等几秒自动重试；有备用模型时少等一次，尽快换模型
      const tries = mi < models.length - 1 ? 2 : 3;
      for (let attempt = 1; ; attempt++) {
        res = await fetchOrExplain(base + '/chat/completions', { method: 'POST', signal, headers, body: JSON.stringify(body) });
        // 不认 stream_options 的接口：去掉它再发一次，并记住这个地址
        if (res.status === 400 && body.stream_options) {
          const t = await res.clone().text().catch(() => '');
          if (/stream_options|include_usage/i.test(t)) { NO_USAGE.add(base); delete body.stream_options; await res.text().catch(() => {}); attempt--; continue; }
        }
        if (res.ok || !RETRY_STATUS.has(res.status) || attempt >= tries) break;
        await res.text().catch(() => {});
        const after = Number(res.headers.get('retry-after'));
        await wait(after > 0 ? Math.min(after, 20) * 1000 : attempt * 3000, signal);
      }
      used = model;
      if (res.ok || mi === models.length - 1 || !FALLBACK_STATUS.has(res.status)) break;
      await res.text().catch(() => {}); // 换下一个备用模型
    }
  };
  // 有图片时先带图发；模型看不了图（接口报 400 / 415 / 422 等）就改成只发文字再试一次，并记住这个模型，下次直接只发文字
  const plain = toMessages(system, prompt, ctx);
  const visionKey = `${base}|${agent.model || ''}`;
  let images = ctx.images && ctx.images.length ? ctx.images : null;
  let blind = !!images && NO_VISION_MODELS.has(visionKey);
  if (images && !blind) {
    await request(withImagesOpenAI(plain, images));
    if (!res.ok && [400, 404, 413, 415, 422].includes(res.status)) {
      await res.text().catch(() => {});
      blind = true;
      await request(noVision(plain));
      if (res.ok) NO_VISION_MODELS.add(visionKey); // 只发文字就成功了：确实是看不了图
    }
  } else await request(blind ? noVision(plain) : plain);
  if (!res.ok) {
    const err = await httpError(res);
    if (models.length > 1) err.message += `\n主模型和备用模型都没成功（试过：${models.join('、')}）`;
    // 模型名不对时（厂商经常改名），顺便列出这个接口支持的模型，方便改
    if ((res.status === 400 || res.status === 404) && /model/i.test(err.message)) {
      const ids = await listModels(base, headers, signal).catch(() => []);
      if (ids.length) err.message += `\n这个接口支持的模型：${ids.slice(0, 20).join('、')}`;
    }
    throw err;
  }
  // 一般是流式（SSE）；有的本机服务不支持流式、直接返回整段 JSON，也能读
  let usage = null;
  const onEvent = (j) => {
    if (!j || typeof j !== 'object') return;
    if (j.usage && typeof j.usage === 'object') usage = j.usage;
    const c = j.choices && j.choices[0];
    const r = c && ((c.delta && (c.delta.reasoning_content || c.delta.reasoning)) || (c.message && (c.message.reasoning_content || c.message.reasoning)));
    if (typeof r === 'string' && r) onThinking(r); // DeepSeek 等推理模型的思考过程：不进群聊，单独存
  };
  let text = await readReply(res, { onDelta, onEvent, full: ['choices.0.message.content', 'choices.0.text'], delta: ['choices.0.delta.content', 'choices.0.text'], cumulative: false });
  if (usage) {
    const cached = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
    onUsage({ in: Math.max(0, (usage.prompt_tokens || 0) - cached), cache: cached, out: usage.completion_tokens || 0 });
  }
  if (used !== models[0] && text) {
    const note = `\n\n*（${models[0] || '主模型'} 正忙，这次由备用模型 ${used} 回答）*`;
    text += note; onDelta(note);
  }
  if (blind && text) {
    const note = `\n\n*（${agent.model || '这个模型'} 看不了图片，这次只发了文字）*`;
    text += note; onDelta(note);
  }
  return text;
}

async function listModels(base, headers, signal) {
  const res = await fetchOrExplain(base + '/models', { signal, headers });
  if (!res.ok) return [];
  const j = await res.json();
  return (Array.isArray(j.data) ? j.data : []).map((m) => m && m.id).filter(Boolean);
}

module.exports = { callOpenAI };
