#!/usr/bin/env python3
"""示例：自定义智能体「记录员」—— 不调用大模型，按规则整理各成员的最新观点。

运行：python3 examples/recorder_agent.py        （监听 http://localhost:9000/agent）
接入：Agent Hub 里添加智能体 → 预设选「自定义程序（Agent Hub 协议）」→ 地址填 http://localhost:9000/agent

把 reply() 换成任何逻辑都行：调用自己的模型、查数据库、跑脚本、接 LangChain / AutoGen 等框架……
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 9000


def reply(req):
    if req.get("purpose") == "test":
        return "你好，我是记录员（自定义程序），连接正常。"
    latest = {}
    for m in req.get("history", []):
        text = (m.get("content") or "").strip()
        if m.get("role") == "agent" and text:
            latest[m.get("name", "?")] = text.splitlines()[0][:60]
    latest.pop((req.get("agent") or {}).get("name"), None)  # 不记录自己
    if not latest:
        return "还没有其他成员发言，暂时没什么可记录的。"
    return "📝 **会议纪要（各成员最新观点）**\n" + "\n".join(f"- **{n}**：{t}" for n, t in latest.items())


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except ValueError:
            req = {}
        body = json.dumps({"reply": reply(req)}, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"记录员已启动：http://localhost:{PORT}/agent")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
