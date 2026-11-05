'use strict';
// 演示模式：不调用任何模型，用来熟悉界面和流程
const { short, sleep } = require('./util');

async function callMock(agent, system, prompt, { signal, onDelta, ctx }) {
  let text;
  if (ctx.purpose === 'plan') {
    // 前几块同时做，最后一块等前面都做完（演示工作流）
    const n = ctx.members.length;
    const tasks = ctx.members.map((m, i) => ({ assignee: m.name, task: `从「${short(m.persona, 18)}」的角度，负责「${short(ctx.topic, 20)}」中对应的部分`, why: short(m.persona, 10) || '按专长',
      after: i === n - 1 && n > 1 ? Array.from({ length: n - 1 }, (_, j) => j + 1) : [] }));
    text = `我把任务按成员专长拆成 ${tasks.length} 块：前面几块同时做，最后一块等它们做完再收尾。\n\n\`\`\`json\n${JSON.stringify({ tasks }, null, 2)}\n\`\`\``;
  } else if (ctx.purpose === 'test') {
    text = `你好，我是${agent.name}（演示模式）。`;
  } else {
    text = `*（演示模式：还没接入真实模型）*\n\n我是**${agent.name}**，${short(agent.persona, 40)}\n关于「${short(ctx.topic, 40)}」，我的看法：\n1. 先明确目标和约束；\n2. 从我的专长出发给出具体方案；\n3. 和其他成员对齐后再推进。\n\n> 点左侧我的名字，把「模型服务」换成真实模型，我就能真正思考了。`;
  }
  for (let i = 0; i < text.length; i += 4) {
    if (signal.aborted) throw signal.reason || new Error('aborted');
    onDelta(text.slice(i, i + 4));
    await sleep(15);
  }
  return text;
}

module.exports = { callMock };
