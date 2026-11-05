'use strict';
// 自定义 JSON 接口：不用写代码，填一个请求模板就能接任意模型服务
// （Ollama 原生接口、llama.cpp、TGI、Dify、自己写的 FastAPI / Flask……）。
// 模板里的 {{变量}} 换成这次的内容（见 template.js 和 README）；回复是 JSON、SSE、NDJSON 还是纯文本都能自动识别（见 reply.js）。
const { httpError, fetchOrExplain, toMessages, stopList } = require('./util');
const { parseTemplate, fill, fillHeaders, usesKey } = require('./template');
const { readReply } = require('./reply');

// 没填模板时发这个：自己写的服务读 prompt 或 messages 都行
const DEFAULT_BODY = { model: '{{model}}', system: '{{system}}', prompt: '{{prompt}}', messages: '{{messages}}' };

function templateVars(agent, system, prompt, apiKey, ctx = {}) {
  return {
    prompt, system, input: system ? `${system}\n\n${prompt}` : prompt,
    messages: toMessages(system, prompt, ctx), message: ctx.latest || prompt, history: ctx.history || [],
    model: agent.model || '', agent: agent.name || '', persona: agent.persona || '',
    max_tokens: Number(agent.maxTokens) > 0 ? Number(agent.maxTokens) : null,
    temperature: typeof agent.temperature === 'number' ? agent.temperature : null,
    stop: stopList(agent.stop), key: apiKey || '',
  };
}

async function callRest(agent, system, prompt, { signal, onDelta, apiKey, ctx }) {
  const url = String(agent.baseUrl || '').trim();
  if (!url) throw new Error('没有填写接口地址');
  const vars = templateVars(agent, system, prompt, apiKey, ctx);
  const body = fill(parseTemplate(agent.bodyTemplate, '请求体模板') || DEFAULT_BODY, vars);
  const headers = { 'content-type': 'application/json', ...fillHeaders(agent.headers, vars) };
  if (apiKey && !usesKey(headers, apiKey)) headers.authorization = 'Bearer ' + apiKey;
  const res = await fetchOrExplain(url, { method: 'POST', signal, headers, body: JSON.stringify(body) });
  if (!res.ok) throw await httpError(res);
  return readReply(res, { path: agent.responsePath, onDelta, hint: '可以在「回复所在位置」里写上它的位置，比如 data.reply' });
}

module.exports = { callRest, templateVars };
