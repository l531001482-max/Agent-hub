#!/bin/bash
# 双击启动 Agent Hub（首次会自动安装依赖）
# 放在 agent-hub 文件夹里，或者放在它旁边（比如桌面）都可以
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE/server.js" ]; then APP="$HERE"; else APP="$HERE/agent-hub"; fi
if [ ! -f "$APP/server.js" ]; then
  echo "找不到 agent-hub 文件夹：请把 start.command 放在 agent-hub 文件夹里或它旁边"; read -n1 -p "按任意键退出"; exit 1
fi
cd "$APP"
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js，请先安装：https://nodejs.org"; read -n1 -p "按任意键退出"; exit 1
fi
if [ ! -d node_modules ] || [ ! -d node_modules/qrcode-generator ]; then
  echo "正在安装依赖…"
  npm install --no-audit --no-fund || echo "依赖安装失败：Claude 智能体和手机访问的二维码暂不可用，其他功能不受影响"
fi
PORT="${PORT:-8787}"
# Agent Hub 开着时不让 Mac 自动睡眠（睡着了手机就连不上）；关掉这个窗口就恢复。合上盖子仍会睡眠
caffeinate -i -w $$ &
(sleep 1.5 && open "http://localhost:$PORT") &
PORT="$PORT" exec node server.js
