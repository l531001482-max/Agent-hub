'use strict';
// 自定义程序：把你自己写的智能体（任何语言）包装成一个 HTTP 接口接进来。
// 请求：POST <接口地址>，JSON 见 README「接入自己的程序」
// 响应：JSON {"reply": "..."}，或者直接返回纯文本 / SSE / NDJSON（可以边生成边输出），格式自动识别
const { httpError, fetchOrExplain, toMessages } = require('./util');
const { readReply } = require('./reply');

// 发给自定义程序的 JSON；「本机命令」选 JSON 输入时，标准输入里也是这个
function payloadFor(agent, system, prompt, ctx = {}) {
  return {
    agent: { id: agent.id, name: agent.name, persona: agent.persona || '', model: agent.model || '' },
    purpose: ctx.purpose || 'reply', instruction: ctx.instruction || '',
    room: ctx.room || null, history: ctx.history || [], system, prompt,
    messages: toMessages(system, prompt, ctx), message: ctx.latest || prompt,
  };
}

async function callHttp(agent, system, prompt, { signal, onDelta, apiKey, ctx }) {
  if (!agent.baseUrl) throw new Error('没有填写程序的接口地址');
  const res = await fetchOrExplain(agent.baseUrl.trim(), {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
    body: JSON.stringify(payloadFor(agent, system, prompt, ctx)),
  });
  if (!res.ok) throw await httpError(res);
  return readReply(res, { onDelta, hint: '请返回 {"reply": "回复内容"}' });
}

module.exports = { callHttp, payloadFor };
