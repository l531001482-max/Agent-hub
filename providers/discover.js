'use strict';
// 查找本机正在运行的模型服务（Ollama、LM Studio、llama.cpp、MLX、vLLM……），列出能聊天的模型，网页上点一下就能添加。
// 只是问这些服务「有哪些模型」，不会加载或下载模型。也可以查一个指定的地址（局域网里的电脑、云服务器）。
const fs = require('fs');
const os = require('os');
const path = require('path');

// 常见本机模型工具的默认端口（5000 在 macOS 上常被「隔空播放接收器」占着，查到的不是模型服务会自动跳过）
const PORTS = [
  { port: 11434, name: 'Ollama' }, { port: 1234, name: 'LM Studio' }, { port: 8080, name: 'llama.cpp / MLX' },
  { port: 8000, name: 'vLLM / LLaMA-Factory' }, { port: 1337, name: 'Jan' }, { port: 5001, name: 'KoboldCpp' },
  { port: 5000, name: 'text-generation-webui' }, { port: 4891, name: 'GPT4All' }, { port: 30000, name: 'SGLang' },
  { port: 8081, name: '本机 8081 端口' }, { port: 8090, name: '本机 8090 端口' },
];
const OWNERS = { llamacpp: 'llama.cpp', vllm: 'vLLM', sglang: 'SGLang', koboldcpp: 'KoboldCpp' };
const NOT_CHAT = /embed|\bbge\b|bge-|\be5-|gte-|rerank|whisper|\btts\b/i; // 向量、重排、语音模型不能聊天
const gb = (n) => (n > 0 ? (n / 1073741824).toFixed(1) + 'GB' : '');

async function getJson(url, ms = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return null; }
    return await res.json();
  } catch { return null; }
}

// 问一个地址有哪些模型；base 是 http://主机:端口（不带 /v1）
async function probe(base, name = '') {
  if (name === 'Ollama') {
    const j = await getJson(base + '/api/tags');
    if (j && Array.isArray(j.models)) {
      return {
        name, baseUrl: base + '/v1',
        models: j.models.map((m) => {
          const d = m.details || {};
          return { id: m.name || m.model, chat: !NOT_CHAT.test(m.name || '') && !/bert/i.test(d.family || ''), note: [d.parameter_size, d.quantization_level, gb(m.size)].filter(Boolean).join(' · ') };
        }),
      };
    }
  }
  if (name === 'LM Studio') {
    const j = await getJson(base + '/api/v0/models'); // LM Studio 自己的接口能看出模型类型和是否已加载
    if (j && Array.isArray(j.data)) {
      return {
        name, baseUrl: base + '/v1',
        models: j.data.map((m) => ({ id: m.id, chat: m.type ? m.type !== 'embeddings' : !NOT_CHAT.test(m.id), note: [m.state === 'loaded' ? '已加载' : '', m.quantization, m.max_context_length ? `上下文 ${m.max_context_length}` : ''].filter(Boolean).join(' · ') })),
      };
    }
  }
  for (const [p, suffix] of [['/v1/models', '/v1'], ['/models', '']]) {
    const j = await getJson(base + p);
    const list = j && (Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : null);
    if (!list) continue;
    const owner = list.map((m) => m && OWNERS[m.owned_by]).find(Boolean);
    const models = list.map((m) => (typeof m === 'string' ? m : m && (m.id || m.name || m.model))).filter(Boolean).map((id) => ({ id, chat: !NOT_CHAT.test(id), note: '' }));
    return { name: owner || name || base, baseUrl: base + suffix, models };
  }
  // 服务开着但列不出模型（比如没下载过 Hugging Face 模型时 mlx_lm.server 的模型列表会出错）：
  // /health 回 {"status": …} 的就是模型服务（mlx_lm.server、llama-server 都这样），用它启动时加载的模型
  const h = await getJson(base + '/health');
  if (h && typeof h === 'object' && 'status' in h) return { name: name || base, baseUrl: base + '/v1', models: [{ id: '', chat: true, note: '没列出模型名，用它启动时加载的模型' }] };
  return null;
}

// 用户填的地址：http://192.168.1.8:8000、…/v1、…/v1/models、…/v1/chat/completions 都认
async function probeUrl(input) {
  let u = String(input || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  try { new URL(u); } catch { return { servers: [], hints: ['地址格式不对，应该像 http://192.168.1.8:8000'] }; }
  u = u.replace(/\/(chat\/)?completions$/, '').replace(/\/models$/, '').replace(/\/v1$/, '');
  const r = await probe(u);
  return { servers: r ? [r] : [], hints: r ? [] : [`${u} 上没找到 OpenAI 兼容的模型服务（问了 /v1/models）。如果它是别的格式的接口，接口类型选「自定义 JSON 接口」手动填。`] };
}

async function discover(url) {
  if (url) return probeUrl(url);
  const found = (await Promise.all(PORTS.map(async ({ port, name }) => {
    const r = await probe(`http://127.0.0.1:${port}`, name);
    return r && { ...r, baseUrl: r.baseUrl.replace('127.0.0.1', 'localhost') };
  }))).filter(Boolean);
  const names = new Set(found.map((s) => s.name));
  const has = (p) => fs.existsSync(p);
  const hints = [];
  if (!names.has('Ollama') && (has('/Applications/Ollama.app') || has(path.join(os.homedir(), '.ollama')))) hints.push('Ollama 已经装了但没在运行：打开 Ollama App，再点一次查找。');
  if (!names.has('LM Studio') && (has('/Applications/LM Studio.app') || has(path.join(os.homedir(), '.lmstudio')))) hints.push('LM Studio 已经装了，但它的本地服务没开：在 LM Studio 左边的「开发者」里打开 Local Server（或者在终端运行 lms server start），再点一次查找。');
  return { servers: found, hints };
}

module.exports = { discover };
