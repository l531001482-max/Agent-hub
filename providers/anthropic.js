'use strict';
// Claude（Anthropic）—— 使用官方 SDK @anthropic-ai/sdk
const { claudeContent } = require('./attachments');
let Anthropic = null;
function sdk() {
  if (!Anthropic) {
    try { const mod = require('@anthropic-ai/sdk'); Anthropic = mod.default || mod; }
    catch { throw new Error('使用 Claude 需要先安装官方 SDK：在 agent-hub 目录运行 npm install'); }
  }
  return Anthropic;
}

// 这些模型在官方 Claude API 上支持服务端拒答兜底：被安全策略拒绝时自动换推荐模型重试
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

function friendlyError(e, A) {
  // 从具体到宽泛；APIConnectionError 是 APIError 的子类，必须先判断
  if (e instanceof A.AuthenticationError) return 'API Key 无效（401）。检查 Key，或在 .env 里设置 ANTHROPIC_API_KEY';
  if (e instanceof A.PermissionDeniedError) return '没有使用该模型的权限（403）：' + e.message;
  if (e instanceof A.NotFoundError) return '模型名或接口地址不存在（404）：' + e.message;
  if (e instanceof A.RateLimitError) return '触发限流（429），请稍后再试';
  if (e instanceof A.BadRequestError) return '请求参数有误（400）：' + e.message;
  if (e instanceof A.APIConnectionError) return '连不上 Claude 接口，请检查网络或代理：' + e.message;
  if (e instanceof A.APIError) return `Claude 接口错误 ${e.status || ''}：${e.message}`;
  return e.message || String(e);
}

async function callAnthropic(agent, system, prompt, { signal, onDelta, onReset, onUsage = () => {}, onThinking = () => {}, apiKey, ctx = {} }) {
  const A = sdk();
  if (!agent.model) throw new Error('没有填写模型名（model），例如 claude-opus-5-5');
  const custom = (agent.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  // 只有直连官方 API 时才开启拒答兜底；走中转/代理地址时不发这个参数
  const effective = custom || (process.env.ANTHROPIC_BASE_URL || '').trim().replace(/\/+$/, '');
  const firstParty = !effective || /^https:\/\/api\.anthropic\.com$/i.test(effective);
  // Key 留空时，SDK 会自动读取 ANTHROPIC_API_KEY 等环境变量
  const client = new A({ apiKey: apiKey || undefined, baseURL: custom || undefined });

  // 新一代 Claude 模型不支持 temperature 等采样参数，这里不传
  const params = {
    model: agent.model,
    max_tokens: Number(agent.maxTokens) || 64000,
    system,
    messages: [{ role: 'user', content: claudeContent(prompt, ctx.images) }],
  };
  if (agent.effort) params.output_config = { effort: agent.effort };

  let text = '';
  try {
    const stream = firstParty && FALLBACK_MODELS.has(agent.model)
      ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
      : client.messages.stream(params, { signal });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta' && event.delta.thinking) onThinking(event.delta.thinking);
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text;
        onDelta(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    const u = final.usage || {};
    onUsage({ in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cache: u.cache_read_input_tokens || 0, out: u.output_tokens || 0 });
    if (final.stop_reason === 'refusal') {
      onReset(); // 被拒答时丢弃已输出的半截内容
      const cat = final.stop_details && final.stop_details.category;
      throw new Error(`Claude 拒绝回答这个请求${cat ? `（类别：${cat}）` : ''}`);
    }
    if (final.stop_reason === 'max_tokens') {
      const note = '\n\n*（达到输出长度上限，内容被截断）*';
      text += note; onDelta(note);
    }
  } catch (e) {
    if (signal.aborted) throw e;
    throw new Error(friendlyError(e, A));
  }
  return text;
}

module.exports = { callAnthropic };
