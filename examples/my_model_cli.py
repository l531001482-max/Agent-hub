#!/usr/bin/env python3
"""示例：用「本机命令」把自己的模型接进 Agent Hub —— 不用写服务器。

轮到它发言时，Agent Hub 运行一次这个脚本：提示词从标准输入传进来，脚本把回复打印到标准输出，
边生成边打印（flush=True），网页上就是边出字。打印到标准错误（stderr）的内容不进群聊，出错时会显示最后几行。

接入：添加智能体 → 预设选「推理脚本（本机命令）」，命令填
    python3 ~/Desktop/agent-hub/examples/my_model_cli.py
「标准输入的格式」选 JSON 时，标准输入是一行 JSON（含 system、prompt、messages，和「自定义程序」收到的一样）；
选纯文本时就是「系统提示词 + 空行 + 聊天记录」。这个示例两种都认。

默认是演示模式（不加载模型）。接自己的模型：
- Apple 芯片 + MLX（先 pip3 install mlx-lm）：命令前面加上模型文件夹，LoRA 微调的再加适配器文件夹，比如
      MODEL=~/models/我的模型 ADAPTER=~/models/我的适配器 python3 ~/Desktop/agent-hub/examples/my_model_cli.py
  MODEL 也可以写 Hugging Face 上的名字（比如 mlx-community/Qwen3-0.6B-4bit，第一次会下载）。
  智能体的「模型名」也会传进来（环境变量 AGENT_HUB_MODEL），没写 MODEL 时用它。
- 其他框架（transformers、llama-cpp-python……）：仿照 generate_mlx() 写一个自己的生成函数。
每次发言都会重新加载一次模型（小模型几秒）；嫌慢就改用 mlx_lm.server 之类的常驻服务（预设里的「MLX」）。
"""
import json
import os
import sys
import time


def read_request():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
        if isinstance(req, dict) and "prompt" in req:
            return req
    except ValueError:
        pass
    return {"purpose": "reply", "system": "", "prompt": raw, "messages": [{"role": "user", "content": raw}]}


def generate_mlx(req, model_path):
    try:
        from mlx_lm import load, stream_generate
    except ImportError:
        sys.exit("没装 mlx-lm：在终端运行 pip3 install mlx-lm（只支持 Apple 芯片的 Mac）")
    adapter = os.environ.get("ADAPTER")
    model, tokenizer = load(os.path.expanduser(model_path), adapter_path=os.path.expanduser(adapter) if adapter else None)
    # 按模型自己的对话模板拼提示词；enable_thinking=False 让 Qwen3 这类推理模型直接回答（其他模型会忽略这个参数）
    prompt = tokenizer.apply_chat_template(req["messages"], add_generation_prompt=True, enable_thinking=False)
    max_tokens = int(os.environ.get("AGENT_HUB_MAX_TOKENS") or 1024)
    for r in stream_generate(model, tokenizer, prompt, max_tokens=max_tokens):
        yield r.text


def generate_demo(req):
    if req.get("purpose") == "test":
        yield "你好，我是一个推理脚本（演示模式，还没加载模型），连接正常。"
        return
    latest = next((m["content"] for m in reversed(req.get("messages", [])) if m.get("role") == "user"), "")
    text = (f"*（演示模式：还没接模型）*\n\n我收到了 {len(req.get('messages', []))} 条消息，"
            f"最后一条有 {len(latest)} 个字。在命令前面加上 MODEL=你的模型文件夹，我就会用它来回答。")
    for ch in text:
        yield ch
        time.sleep(0.01)


def main():
    req = read_request()
    model = os.environ.get("MODEL") or os.environ.get("AGENT_HUB_MODEL")
    for piece in generate_mlx(req, model) if model else generate_demo(req):
        print(piece, end="", flush=True)
    print()


if __name__ == "__main__":
    main()
