'use strict';
// 手动转达：给没有开放接口的助手用（比如 Claude 桌面 App）。
// 轮到它发言时，网页上会出现「复制提示词」和「粘贴回复」两个入口；
// 同时把请求写进 mailbox/<信箱名>/requests/。如果那个助手能读写这台电脑上的文件，
// 也可以让它把回复写进 mailbox/<信箱名>/replies/ 下的同名文件，这边检测到后自动继续。
const fs = require('fs');
const path = require('path');

const MAILBOX_ROOT = path.join(__dirname, '..', 'mailbox');
const pending = new Map(); // 消息 id -> { finish }

function mailboxName(agent) {
  const slug = String(agent.mailbox || agent.name || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || agent.id;
}
function mailboxDirs(agent) {
  const base = path.join(MAILBOX_ROOT, mailboxName(agent));
  return { base, requests: path.join(base, 'requests'), replies: path.join(base, 'replies') };
}

// 等这条消息的回复：网页上提交（或跳过）都算；给了 replyFile 时，信箱里出现回复文件也算
function waitForReply(id, signal, replyFile) {
  return new Promise((resolve, reject) => {
    let lastSize = -1, timer = null;
    const done = () => { clearInterval(timer); pending.delete(id); signal.removeEventListener('abort', onAbort); };
    const finish = (r) => { done(); resolve(r); };
    const onAbort = () => { done(); reject(signal.reason || new Error('aborted')); };
    if (signal.aborted) return onAbort();
    // 回复文件出现后，等大小连续两次不变（写完了）再读取
    if (replyFile) timer = setInterval(() => {
      try {
        const size = fs.statSync(replyFile).size;
        if (size > 0 && size === lastSize) finish(fs.readFileSync(replyFile, 'utf8').trim());
        lastSize = size;
      } catch {}
    }, 1500);
    signal.addEventListener('abort', onAbort, { once: true });
    pending.set(id, { finish });
  });
}

async function callRelay(agent, system, prompt, { signal, onDelta, ctx }) {
  const dirs = mailboxDirs(agent);
  if (ctx.purpose === 'test') {
    return `手动转达不需要连接测试。轮到它发言时，网页上会出现复制和粘贴框；信箱目录：${dirs.base}`;
  }
  const id = ctx.messageId;
  if (!id || !ctx.onRelay) throw new Error('手动转达只能在房间里使用');
  fs.mkdirSync(dirs.requests, { recursive: true });
  fs.mkdirSync(dirs.replies, { recursive: true });
  const reqFile = path.join(dirs.requests, id + '.md');
  const replyFile = path.join(dirs.replies, id + '.md');
  const text = `${system}\n\n${prompt}\n\n（请直接给出你在群聊里要说的话。）`;
  fs.writeFileSync(reqFile, text);
  ctx.onRelay({ prompt: text, replyFile });
  try {
    const reply = await waitForReply(id, signal, replyFile);
    onDelta(reply || '*（已跳过）*');
    return reply;
  } finally {
    fs.rmSync(reqFile, { force: true });
    fs.rmSync(replyFile, { force: true });
  }
}

// 网页上提交回复（text 为空表示跳过）；返回 false 表示这条转达已经结束或失效
function submitRelay(messageId, text) {
  const p = pending.get(messageId);
  if (!p) return false;
  p.finish(String(text || '').trim());
  return true;
}

module.exports = { callRelay, submitRelay, waitForReply, mailboxDirs, MAILBOX_ROOT };
