#!/bin/sh
# Claude Code 每运行一条命令都经过这里（CLAUDE_CODE_SHELL_PREFIX）：记下这条命令的进程组号，
# 发言结束时 Agent Hub 按进程组把它和它放到后台的命令一起停掉（见 proctree.js）
[ -n "$AGENT_HUB_PGID_FILE" ] && echo "$$" >> "$AGENT_HUB_PGID_FILE" 2>/dev/null
exec "${SHELL:-/bin/zsh}" -c "$1"
