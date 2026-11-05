# Agent Hub · 本地多智能体协作台

让多个 AI 智能体在同一个群聊里**一起讨论、头脑风暴、分工完成任务**。全部在本机运行，聊天记录和配置都存在本地。

**网站：<https://l531001482-max.github.io/Agent-hub/>**

> **English:** Agent Hub is a self-hosted web app where multiple AI agents (Claude Code, Codex, DeepSeek, any OpenAI-compatible API, local models via Ollama / LM Studio / MLX / llama.cpp, or your own HTTP program) chat in one room. Three modes: free discussion, brainstorm, and *collab*, where a lead agent splits the job into a dependency-aware task board (with a live flowchart), members work in parallel and hand off their conclusions, sources and files, and the lead merges the result. Per-agent token usage and monthly budgets included. Node.js, no build step, two optional dependencies. The UI and docs are currently in Chinese.

![分工协作：任务清单流程图](docs/screenshot-light.png)

<details><summary>深色模式</summary>

![深色模式](docs/screenshot-dark.png)

</details>

（截图是用演示智能体跑的，没有接真实模型。）

## 功能

- **三种协作模式**：自由讨论、头脑风暴（先独立出点子再互评）、分工协作（负责人拆任务 → 没有依赖关系的同时做 → 整合）
- **任务清单和流程图**：子任务有依赖、状态，能先确认分工再开工，失败的可以单独重做
- **AI 之间交接**：交接单、思考过程节选、查过的网页和写出的文件都会传给下一位
- **什么模型都能接**：Claude Code、Codex（用本机登录的账号）、Claude API、DeepSeek 等 OpenAI 兼容接口、本机模型（能自动查找、自动启动）、自定义 JSON 接口、推理脚本、自己写的 HTTP 程序
- **用量和预算**：每条回复记 token 和花费，每个智能体能设每月预算
- **上传文件**：图片、PDF、Office、视频（自动截帧）、大文件（最大 1GB）
- **手机访问**：同一 Wi-Fi 下扫码打开，要输访问码

## 需要什么

| | 必需 / 可选 | 说明 |
|---|---|---|
| Node.js ≥ 20.3 | 必需 | `node -v` 查看版本 |
| macOS | 推荐 | 主要在 macOS 上开发和测试。Linux、Windows 用 `npm start` 也能跑，但双击启动的 `start.command`、扫描版 PDF、HEIC 图片、`.doc` 文字提取只能在 Mac 上用；Claude Code、Codex 的「宽权限」只在 macOS 上测过 |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | 可选 | 用 Claude Code 智能体时要装，并且先在终端里运行 `claude` 登录 |
| [Codex CLI](https://github.com/openai/codex) | 可选 | 用 Codex 智能体时要装，并且先登录 |
| ffmpeg | 可选 | 上传视频时用来读时长、截画面（`brew install ffmpeg`） |
| 各家 API Key | 可选 | DeepSeek、Claude API 等，在界面里填 |

一个模型都没有也能先试：添加智能体时选「演示模式」，不调用任何模型。

## 快速开始

```bash
git clone https://github.com/l531001482-max/Agent-hub.git
cd Agent-hub
npm install      # 只有用 Claude API 智能体、手机访问的二维码时才必须
npm start
```

打开 <http://localhost:8787>，按 `Ctrl+C` 停止。macOS 上也可以直接**双击 `start.command`**：第一次运行会自动安装依赖，然后打开浏览器。

默认自带 Claude Code、Codex、DeepSeek 三个智能体：Claude Code、Codex 用本机登录的账号，DeepSeek 要填 API Key（点左侧智能体 → 粘贴 Key → **测试连接** → 保存）。

> **安全默认值**：第一次启动时，Claude Code、Codex 都是「只聊天」，不能读写文件、不能运行命令；服务只监听本机（`127.0.0.1`）。要放开权限或用手机访问，看下面「Claude Code 的安全边界」和「在手机上用」，先弄清楚风险再开。

运行测试（只用演示智能体，不调用任何模型）：`npm test`

## 在手机上用

1. 在 `.env` 里写 `HOST=0.0.0.0`（复制 `.env.example` 为 `.env` 再改），重新启动 Agent Hub。手机和电脑连同一个 Wi-Fi。
2. 在电脑上的 Agent Hub 网页里点左下角 **「手机访问」**，用手机相机扫二维码打开，第一次会自动登录，之后一直保持登录。
3. 想像 App 一样用：Safari 里点「分享」→「添加到主屏幕」。从主屏幕打开时如果要登录，输入弹窗里显示的访问码（形如 `ABCD-EFGH`）。

安全：在电脑本机打开 localhost 不用登录；手机等其他设备必须先用访问码登录（访问码输错 10 次会锁 10 分钟）。访问码、开关、已登录的设备只能在电脑上看和改：「换一个访问码」会让所有手机重新登录，「关闭手机访问」后局域网里谁都打不开。手机上看不到 API Key。

连不上时检查：
- 电脑开着 VPN 时，要在 VPN 设置里打开「本地网络共享 / Local network sharing」，否则 VPN 会挡住手机。
- 双击 `start.command` 启动时，Agent Hub 开着就不让 Mac 自动睡眠（关掉终端窗口就恢复）；合上盖子仍会睡眠，手机就连不上了。
- 学校、咖啡店的公共 Wi-Fi 常常不让设备互相访问；不在同一个 Wi-Fi 时（比如用流量）连不上，需要另装 Tailscale 之类的组网工具。

## 三种协作模式

| 模式 | 流程 |
|---|---|
| 💬 自由讨论 | 成员按顺序轮流发言，可设多轮。消息里写 `@名字` 只让被点名的人回答，`@所有人` 让全员回答 |
| 💡 头脑风暴 | 第 1 轮各自独立出点子（互相看不到，避免跟风）→ 后续轮次互评改进 → 主持人总结推荐前 3 名 |
| 🧩 分工协作 | 负责人按每个成员擅长什么、能做什么拆任务派活 → 不互相依赖的子任务同时开工，有依赖的自动排队 → 负责人整合成最终交付物。上方的「任务清单」能看流程图 |

- 右上角「成员」设置：谁参与、发言顺序（按勾选顺序）、负责人/主持人、讨论轮数。
- 运行中可以随时**插话**（下一位发言者会先回应你），或点**停止**。
- 可以建多个房间，每个房间的成员和模式各自独立。

### 任务清单和工作流（分工协作）

借鉴自 [Paperclip](https://paperclip.ing) 的「工单」：负责人分好的子任务存成一张清单，显示在聊天上方。

- **按擅长分工**：分工时，负责人能看到每个成员的角色设定和实际能力（能不能联网、运行命令、改文件，还是只能聊天），每个子任务会写上「为什么交给他」。想让某个 AI 专门干某类活，就在它的「角色设定」里写清楚擅长什么。
- **工作流**：每个子任务可以写「要等哪几步做完」。不互相依赖的同时开工（同一个成员一次只做一件），有依赖的等前面做完再开始。负责人没写依赖时就按顺序一个接一个，前一步失败了后面照做；写明要等的那一步失败了，后面的就不开始，清单上会说明原因。
- **流程图**：清单右上角切换「流程图 / 列表 · 编辑」。流程图从「分工」到各个子任务再到「整合」，箭头表示谁等谁；进行中的节点有那个 AI 自己颜色的小圆点，完成打勾，失败标红，点节点跳到它的产出。
- **先确认再开工**：「成员」设置里勾上「负责人分好工后先给我确认，再开工」，分工出来后会停下等你。在「列表 · 编辑」里可以改内容、换人、删掉或新增子任务，点编号按钮调整「等这些做完」，再点「开始执行」。分错了也可以直接发消息让负责人重新分工。
- **失败、停止都不用从头来**：点「重做没完成的」只重做没完成的几个，再整合一次。点了停止、或者 Agent Hub 重启了，清单停在原地，点「继续」接着做。做完的子任务也能单独「重做」。
- 运行中不能改清单；清空聊天时清单一起清掉。

### AI 之间怎么交接（减少传话损耗）

- **交接单**：分工协作的子任务、自由讨论里不止一个人发言时，每个 AI 在发言最后写一段「【交接】」：结论、依据和来源、做了哪些假设、哪里没把握、提醒下一位什么。网页上显示成正文下面的「交接给后面的成员」框。
- **思考过程**：DeepSeek 等推理模型、本机模型的 `<think>`、Claude Code 和 Codex 报出来的推理（它们在默认设置下大多不报），单独存下来，在发言上面折叠显示「思考过程 · N 字」，不混进正文。同一轮里后面的 AI 能看到前面的思考过程节选（一般 1200 字，它要等的子任务给 3000 字，太长时留开头和结尾）。跑在 Anthropic 官方 Claude 上的成员（用 Claude 账号的 Claude Code、官方接口的 Anthropic）不给：输入里带着其他模型的思考过程时，可能被 Anthropic 的安全检查（reasoning_extraction）拦下，它们照样能看到正文、交接、资料和文件。更早轮次的只给正文和交接，省 token。
- **资料和文件**：Claude Code、Codex 查过的网页、搜过什么、写出的文件，记在发言下面，也传给后面的 AI。能自己打开文件的（Claude Code、Codex 不是「只聊天」档）只给路径；只能聊天的（比如 DeepSeek）直接附上文件内容（文本、Word、PPT、Excel，有长度上限）。`data/`、`.env`、`~/.ssh` 等读不到的地方一律不读。
- **不截断**：分工协作里，一个子任务要等的那几步的产出，连同交接、思考过程节选、资料，一定完整给它；整合时所有子任务的产出都完整给负责人。聊天记录长度上限（默认 24000 字）只用来省略更早、无关的消息。

## 用量和预算

借鉴自 [Paperclip](https://paperclip.ing) 的 budgets：每条回复都记下用了多少 token（消息时间旁边的「1.2k → 350」），能算出钱的还显示花费。左下角「用量」看今天、本月每个智能体用了多少，以及最近几个月的总数。

| 智能体 | 能记到什么 |
|---|---|
| Claude Code | token 和花费（它自己按 API 价格折算的；用订阅登录时不会真扣这么多钱，可以当额度参考） |
| Codex | token（不报花费） |
| DeepSeek 等 OpenAI 兼容接口、Claude API | token；在智能体设置里填了单价（美元 / 百万 token，看各家官网价格页）才估算花费 |
| 本机命令、自定义程序、手动转达 | 记不到 |

**预算**：点智能体 → 展开「预算和用量」，填「本月预算（美元）」或「本月 token 上限（万）」。按自然月算，每月 1 号重新开始；用到 80% 时群里提醒一次，用完后这个智能体自动跳过（分工里它的子任务标成失败，调高预算后能重做）。token 上限算的是没命中缓存的输入 + 输出。测试连接也算用量。记录在 `data/usage.json`（只有数字和名字，没有聊天内容和 Key），只留最近 13 个月。

## 上传文件

点输入框左边的**回形针**选文件，也可以把文件拖进窗口，或者直接粘贴截图（手机上点回形针能选照片和文件）。一条消息最多 10 个、每个最多 1GB（大文件会显示上传进度；传完后硬盘剩余会少于 3GB 时不收）。想改上限，在 `.env` 里写 `UPLOAD_MB=2048` 这样的值。

| 文件 | 怎么交给智能体 |
|---|---|
| 图片（png / jpg / gif / webp，iPhone 的 HEIC 自动转 JPEG，太大的自动缩小） | 直接发给能看图的模型（Claude Code、Codex、DeepSeek Flash 等）；模型看不了图时自动改成只发文字，回复末尾会注明，之后这个模型就直接只发文字 |
| 文本、代码、csv、json…（UTF-8 / GBK 都行） | 全文写进提示词，所有智能体都能读（单个文件最多 6 万字，超出的截掉并注明） |
| Word（docx）、PPT（pptx）、Excel（xlsx） | 提取文字写进提示词（Windows 上也行） |
| PDF | 提取文字；扫描件（没有文字）的前 5 页转成图片发给能看图的模型。需要 Mac |
| .doc / .rtf / .odt | 用 Mac 自带的 textutil 提取文字 |
| 视频（mp4 / mov / webm / mkv…） | 用 ffmpeg 读出时长和分辨率，均匀截 6 张画面发给能看图的模型（模型看到的只是这几帧，声音听不到）；mp4、mov、webm 在网页上能直接播放、拖进度条。没装 ffmpeg 时只告诉模型文件名和大小 |
| 超过 30MB 的其他文件 | 只保存原文件、不读内容；Claude Code、Codex 能在工作目录的 `上传的文件/` 里打开 |
| 其他（zip、音频…） | 读不了内容，只告诉模型文件名和大小；网页上点一下能下载 |

- 追问时不用重新上传：最近一次发的文件一直带着，聊天记录再长也不会被省略。
- Claude Code、Codex 设成「只读 / 可改文件」（Claude Code 还有「可用 Skill」）时，原文件还会复制到工作目录的 `上传的文件/` 里，可以直接打开或修改。
- 文件存在 `data/uploads/<房间 id>/`；清空聊天记录或删除房间时一起删掉。网页上图片直接显示，其他文件只能下载（不会在浏览器里打开）。

## 添加智能体

### 方式一：在界面里添加
左侧「智能体」旁的 ＋ → 填名字、头像、**角色设定**（人设决定它的思考角度）→ 选模型预设 → 保存。本机正在运行的模型（Ollama、LM Studio、MLX 等）点「查找本机正在运行的模型」就能直接选，见下文「接入本地模型、自己训练的模型、专精模型」。

### 方式二：直接编辑 `data/agents.json`
在数组里加一项，保存后**刷新网页**即可（`id` 不用写，会自动生成）：

```json
{
  "name": "法务顾问",
  "avatar": "⚖️",
  "color": "#0ea5e9",
  "persona": "企业法务，擅长合同风险审查，回答严谨并注明依据。",
  "provider": "openai",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-flash",
  "apiKey": "env:DEEPSEEK_API_KEY"
}
```

| 字段 | 说明 |
|---|---|
| `name` / `avatar` / `color` | 名字、头像（emoji）、颜色 |
| `persona` | 角色设定：身份、擅长什么、说话风格 |
| `provider` | `openai`（OpenAI 兼容）、`anthropic`（Claude API）、`claude-code`（本机 Claude Code）、`codex`（本机 Codex）、`relay`（手动转达）、`rest`（自定义 JSON 接口）、`command`（本机命令 / 推理脚本）、`http`（自定义程序）、`mock`（演示） |
| `baseUrl` | 接口地址；Claude 留空即官方地址 |
| `model` | 模型名 |
| `apiKey` | 直接写 Key，或写 `env:变量名` 从环境变量 / `.env` 文件读取 |
| `temperature` | 可选，仅 OpenAI 兼容接口 |
| `effort` | 可选，仅 Claude：`low` / `medium` / `high` / `xhigh` / `max` |
| `maxTokens` | 可选，单次回复长度上限 |
| `toolMode` / `workdir` | 仅 Claude Code、Codex：工具权限（Claude Code：`chat` / `read` / `edit` / `skills` / `wide`；Codex：`chat` / `read` / `edit` / `wide`）和工作目录 |
| `writeDirs` | 仅 `wide` 档：工作目录以外还能写的文件夹（一行一个，留空 = 只能写工作目录） |
| `mailbox` | 仅手动转达：信箱名（英文） |
| `bodyTemplate` / `headers` / `responsePath` | 仅自定义 JSON 接口：请求体模板、请求头（都是 JSON，可以用 `{{变量}}`）、回复所在位置（比如 `data.reply`，留空自动识别） |
| `command` / `inputFormat` | 仅本机命令：要运行的命令、标准输入格式（`text` / `json`）；工作目录也用 `workdir`（默认主目录） |
| `startCommand` | OpenAI 兼容 / 自定义 JSON 接口 / 自定义程序：连不上时自动运行的启动命令（比如 `mlx_lm.server --model ~/models/我的模型 --port 8080`），闲置 15 分钟自动关掉 |
| `historyChars` | 最多带多少字聊天记录（默认 24000；本机小模型建议 4000–8000） |
| `contextMode` | 发给它的内容：`full`（默认，群聊记录 + 发言要求）、`latest`（只发最新一条 + 人设）、`raw`（原样转发那条消息） |
| `systemMode` | 系统提示词：`system`（默认）、`merge`（合并进用户消息）、`none`（不发） |
| `messageFormat` | `single`（默认，整段聊天记录放进一条消息）、`multi`（拆成多轮对话） |
| `thinking` | `hide`（默认，隐藏 `<think>…</think>` 思考过程）、`keep` |
| `stop` / `extraBody` | 停止词（一行一个）；额外参数（JSON，合并进请求，仅 OpenAI 兼容） |
| `onlyWhenMentioned` | `true` = 只在被 @ 时发言（专精模型） |
| `budgetUsd` / `budgetTokens` | 本月预算（美元）/ 本月 token 上限（个数），用完自动跳过 |
| `priceIn` / `priceOut` | 输入 / 输出单价（美元每百万 token），用来估算花费 |

### 支持的模型服务

| 服务 | provider | baseUrl | 模型示例 |
|---|---|---|---|
| DeepSeek | openai | `https://api.deepseek.com` | `deepseek-flash`（便宜，能看图）、`deepseek-v4-pro`（更强，只看文字） |
| Grok（xAI） | openai | `https://api.x.ai/v1` | `grok-4.3`、`grok-4.7` |
| Gemini（Google） | openai | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.8-flash` 等 |
| Claude | anthropic | 留空 | `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5` |
| 本机 Claude Code | claude-code | 不需要 | 留空 = Claude Code 默认模型 |
| 本机 Codex | codex | 不需要 | `gpt-6.1-sol`、`gpt-6-astra`（要填：不读 `~/.codex/config.toml`） |
| 其他没有接口的 App（如 Claude App） | relay | 不需要 | 不需要 |
| Ollama（本机，免费） | openai | `http://localhost:11434/v1` | `qwen3:4b`（8GB 内存建议 4B 以下） |
| LM Studio（本机，免费） | openai | `http://localhost:1234/v1` | LM Studio 里显示的名字 |
| MLX（本机，自己微调的模型） | openai | `http://localhost:8080/v1` | 留空 = 启动命令里的模型 |
| llama.cpp（GGUF 文件） | openai | `http://localhost:8080/v1` | 留空 |
| vLLM / LLaMA-Factory / SGLang（服务器上的模型） | openai | `http://服务器地址:8000/v1` | 部署时的名字 |
| 其他格式的接口（Ollama 原生、llama.cpp `/completion`、Dify、FastAPI……） | rest | 完整接口地址 | 见下文「自定义 JSON 接口」 |
| 推理脚本（`python infer.py`） | command | 不需要 | 可选 |

> 模型名会随厂商更新变化，以各平台控制台为准。国内网络通常无法直连 OpenAI / Claude 官方接口。

**关于 Claude**：使用官方 SDK（`@anthropic-ai/sdk`）。Key 留空时自动读取 `ANTHROPIC_API_KEY`。新一代 Claude 模型不支持温度参数，所以不会发送。直连官方接口时，对 `claude-opus-5-5` / `claude-sonnet-5-5` / `claude-opus-5` / `claude-fable-5-1` 会开启服务端「拒答兜底」（`fallbacks: "default"`）：请求被安全策略拒绝时，由 Anthropic 推荐的模型接着回答；使用自定义接口地址时不开启。如果不想要，删掉 `providers/anthropic.js` 里 `FALLBACK_MODELS` 的内容即可。

## 接入本机的 Claude Code、Codex、Claude App

| 应用 | 接入方式 | 说明 |
|---|---|---|
| Claude Code | `claude-code`，全自动 | 通过官方无界面模式 `claude -p` 调用，用你在 Claude Code 里登录的账号，不需要 API Key，消耗同一个账号的额度 |
| Codex | `codex`，全自动 | 通过官方无界面模式 `codex exec` 调用，用你在 Codex 里登录的 ChatGPT 账号，不需要 API Key，消耗同一个账号的额度 |
| Claude 桌面 App | 没有开放接口 | 想让真正的 App 参与，就用 `relay` 手动转达 |

**Claude Code 的安全边界**：每次调用都会加上这几项。`--restricted`：不能运行命令，文件操作只限工作目录。`--strict-mcp-config`：不加载 MCP，不能控制电脑。`--no-session-persistence`：不保存会话记录。工具权限有四档：
- `chat`：只聊天，不用任何工具。
- `read`：只读工作目录里的文件。
- `edit`：可以在工作目录里新建、修改文件。
- `skills`（可用 Skill）：在 `edit` 的基础上，能用你装进 Claude Code 的 skill（`~/.claude/skills`），能搜索、读网页。命令只放行 agent-reach 的只读查询（`agent-reach read …`、`agent-reach <平台> <动作> …`、`channels`、`doctor`、`check`）；安装、登录、更新、卸载、配置 Key 都要你自己在终端里运行，用 `&&`、`;`、`$( )` 拼别的命令也会被拒绝。只能在电脑本机上打开（手机上只能关掉）。需要另外安装 [agent-reach](https://github.com/Panniantong/Agent-Reach)，不装也能用其他功能。

- `wide`（宽权限）：在 `skills` 的基础上能运行任何命令、联网，能写工作目录和 `writeDirs` 里的文件夹（留空 = 只能写工作目录；想让它改你的项目，就把项目文件夹加进去，写 `~` 就是整个主目录）。Codex 也有这一档。不管写哪里，这些都不能改：Agent Hub 自己、`start.command`、`~/Library`、`~/Applications`、shell 启动脚本、`~/.ssh`、`~/.config`、`~/.local`、各 AI 的配置（`~/.claude`、`~/.codex`、`~/.agents`）；见 `providers/wide.js` 的 `PROTECT`。
- 接第三方接口：Claude Code 填了「接口地址」和 Key，就改用这个 Anthropic 格式的接口跑，不用 Claude 账号。DeepSeek 填 `https://api.deepseek.com` 会自动补成 `/anthropic`。权限档位和沙箱跟原来一样，只是没有网页搜索（那是 Anthropic 服务器上的功能），花费按 DeepSeek 的单价估算，Claude Code 自己报的花费是按 Claude 价格算的，不用。Key 不放进环境变量，由 Claude Code 运行 `providers/key-helper.js` 去 `data/` 里取，AI 自己运行的命令读不到。

工作目录默认是 `agent-hub/workspace/`。

**`wide` 的底线**（`providers/wide.js`，两边共用，命令都在系统沙箱里跑，Claude Code 不允许退出沙箱）：`agent-hub/` 自己的文件和 `start.command` 不能改（工作目录例外），`data/`、`.env`、`.backup/`、`~/.ssh`、`~/.codex/auth.json`、钥匙串、浏览器数据等读不到。其他文件读得到，联网时可能被发出去。只能在电脑本机上打开或调高，手机上只能调低。

> ⚠️ `wide` 档等于让 AI 在你的电脑上运行任意命令、联网。沙箱挡住了上面列的地方，但其他文件它读得到，网页里夹带的恶意指令也可能骗它把内容发出去。只在你信任的任务上开，别把它放在能被别人访问的网络上。

**`skills` 档怎么拿到 skill**：`--restricted` 不加载 `~/.claude/skills`，所以每次发言前，Agent Hub 把那里第一层带 `SKILL.md` 的文件夹（跟着软链接走）复制到 `.cache/skills-plugin/`，作为只在本次运行加载的插件（`--plugin-dir`）交给 Claude Code，skill 名字前面会多一个 `hub:`。没有变化时不重新复制（约 1 毫秒）；复制品可以读（skill 的参考文件要用），但不能改，所以群聊里的 Claude Code 改不到你真正的 skill。以后在终端里给 Claude Code 装了新 skill，下次发言就自动能用。agent-reach 装在 `~/.local/bin`，Agent Hub 会自己把它加进 PATH。能联网读取网页时，网页内容可能夹带骗 AI 的指令，所以别把密码、Key 之类的文件放进工作目录。

**Codex 的安全边界**：每次调用都加 `--ignore-user-config`（不加载 `~/.codex/config.toml` 里的 MCP、钩子）和 `--ephemeral`（不留会话记录），关掉网页搜索、插件、发布网站、看屏幕、子智能体等功能。三档权限（`toolMode`）：
- `chat`：只聊天，关掉命令工具，读不了文件。
- `read`：沙箱 `read-only`，能运行命令查看文件，不能写，不能联网。
- `edit`：沙箱 `workspace-write`，能运行命令，只能写工作目录，不能联网。

`read`、`edit` 的沙箱不限制「读」，Codex 能读到这台电脑上的其他文件（包括 `data/agents.json` 里的 Key），所以这两档只能在电脑本机上打开或调高，手机上只能调低。

**手动转达（relay）**：给其他没有接口的助手用。轮到它发言时，聊天里会出现「复制提示词」和粘贴框。把提示词复制给它，再把它的回复粘贴回来点「提交」，也可以「跳过」。同一份请求也会写进 `mailbox/<信箱名>/requests/<消息id>.md`。如果那个助手的定时任务能读写这台电脑上的文件，可以让它把回复写进 `mailbox/<信箱名>/replies/` 下的同名文件，这边会自动继续；编辑智能体时，「可选：让它自动回复」里有一段现成的定时任务说明。默认最多等 60 分钟（`RELAY_TIMEOUT_MS`）。

> 手动转达的成员，每一轮都要等它们回完才继续。可以把它们排在发言顺序最后，不需要时在「成员」里取消勾选。

## 接入本地模型、自己训练的模型、专精模型

不管模型是怎么跑起来的，都有办法接进来。先看你手上有什么：

| 你手上有什么 | 怎么接 |
|---|---|
| 已经在 Ollama、LM Studio、Jan 等软件里能聊天的模型 | 添加智能体 → 点 **「查找本机正在运行的模型」** → 点模型名，接口地址和模型自动填好 |
| 自己微调的模型文件（MLX 文件夹、GGUF 文件、Hugging Face 格式 + LoRA） | 用 MLX / llama.cpp / Ollama 把它跑成本地服务（命令见下），把命令填进「启动命令」：Agent Hub 第一次用到时自动启动，闲置 15 分钟自动关掉 |
| 云服务器、学校 GPU、别的电脑上的模型服务（vLLM、LLaMA-Factory、SGLang……） | 大多是 OpenAI 兼容接口：在「查找」的地址框里输入服务器地址，点模型名 |
| 不是 OpenAI 格式的接口（Ollama 原生接口、llama.cpp `/completion`、TGI、Dify、自己写的 FastAPI……） | 接口类型选 **自定义 JSON 接口**，填一个请求模板，不用写代码 |
| 只有一个推理脚本（`python infer.py`），没有服务 | 接口类型选 **本机命令**：提示词从标准输入传进去，打印出来的就是回复 |
| 要查资料、调工具、多步推理的复杂智能体 | **自定义程序**（见下一节） |

### 把自己的模型文件跑成本地服务

8GB 内存的电脑建议用 4B 以下、4bit 量化的模型（7B 的 4bit 版要 4–5GB，会很挤）。

- **MLX（Apple 芯片原生，适合用 MLX 微调的模型）**：先 `pip3 install mlx-lm`，然后
  ```bash
  mlx_lm.server --model ~/models/我的模型 --port 8080                                   # 模型文件夹（MLX 或 Hugging Face 格式）
  mlx_lm.server --model ~/models/底座模型 --adapter-path ~/models/我的适配器 --port 8080   # LoRA 微调：底座 + 适配器
  ```
  预设选「MLX」，把「启动命令」里的路径换成你的，模型名留空。MLX 默认每次最多回 512 个 token，要更长就在命令后面加 `--max-tokens 2048`。
- **GGUF 文件（llama.cpp）**：`brew install llama.cpp`，然后 `llama-server -m ~/models/我的模型.gguf --port 8080 -c 8192`（`-c` 是上下文长度）。预设选「llama.cpp」。
- **GGUF 文件（Ollama）**：新建一个文本文件 `Modelfile`，只写一行 `FROM ./我的模型.gguf`，在同一个文件夹里运行 `ollama create 我的模型 -f Modelfile`，之后「查找」就能选到它。
- **用 LLaMA-Factory、unsloth 等在云端 GPU 上训练的**：导出成合并后的完整模型（或者直接导出 GGUF），下载到 Mac 上用上面的办法跑；也可以直接在服务器上用 `llamafactory-cli api` 或 vLLM 部署，Agent Hub 连服务器地址。

> 「启动命令」和「本机命令」能在这台电脑上运行程序，所以**只能在电脑本机上设置**（手机上输入框是灰的，服务端也会拦）。提示词只通过标准输入或 HTTP 传给它们，不会拼进命令行。命令找不到时写完整路径（终端里运行 `which mlx_lm.server` 能看到）。

### 小模型 / 专精模型适配

本机小模型、自己训练的模型、只会做一件事的专精模型，常常需要调整「发什么、怎么发」。编辑智能体 → 展开 **「小模型 / 专精模型适配」**：

| 设置 | 什么时候用 |
|---|---|
| 最多带多少字聊天记录 | 本机模型的上下文常常只有 4K–8K token。群聊记录一长，开头的人设和规则会被悄悄截掉（Ollama 不报错）。建议 4000–8000；设了以后单条太长的消息也会截短 |
| 发给它的内容 | 「只发最新一条消息」：不带群聊记录，系统提示词只留人设；「原样转发」：只发那条消息本身，不加任何提示词（翻译、分类、问答这类专精模型）。分工协作时发的是它分到的子任务 |
| 系统提示词 | 「合并进用户消息」：模型不支持 system 角色（有的 Gemma、Mistral 模板会报错）；「不发送」：模型微调时已经自带人设 |
| 对话格式 | 「拆成多轮对话」：它自己说过的话作为 assistant、别人的话作为 user，适合按多轮对话微调的模型 |
| 隐藏思考过程 | 默认打开：Qwen3、DeepSeek-R1 蒸馏版等推理模型输出的 `<think>…</think>` 不进群聊 |
| 停止词、最长回复、额外参数、请求头 | 按模型需要填，比如 ChatML 模型的停止词 `<\|im_end\|>`、额外参数 `{"top_p": 0.9}`；Qwen3 在 vLLM / MLX 上不要思考：`{"chat_template_kwargs": {"enable_thinking": false}}` |
| 只在被 @ 时发言 | 在编辑框上方。专精模型平时不插话，消息里 `@它` 才回答（头脑风暴也不叫它；分工协作时负责人仍然可以把子任务派给它） |

### 自定义 JSON 接口（不用写代码）

接口类型选「自定义 JSON 接口」，填接口地址和请求体模板。模板是 JSON，里面的 `{{变量}}` 会换成这次的内容：

| 变量 | 内容 |
|---|---|
| `{{prompt}}` | 聊天记录 + 发言要求（一整段文字） |
| `{{system}}` | 系统提示词（群聊规则 + 人设） |
| `{{input}}` | 上面两个合成一段，给只收一段文字的接口 |
| `{{messages}}` | OpenAI 格式的消息数组 `[{"role": "system", …}, {"role": "user", …}]` |
| `{{message}}` | 最新一条用户消息（分工协作时是它分到的子任务） |
| `{{history}}` | 聊天记录数组（role、name、content） |
| `{{model}}` `{{max_tokens}}` `{{temperature}}` `{{stop}}` | 智能体设置里的值 |
| `{{key}}` | API Key，写在请求头里用，比如 `{"X-API-Key": "{{key}}"}`；不写时自动以 `Authorization: Bearer` 发送 |
| `{{agent}}` `{{persona}}` | 名字、人设 |

- 整个值只写一个变量（比如 `"messages": "{{messages}}"`）时保留原类型（数组、数字）；值为空时整个字段省略（没设温度就不发 temperature）。变量名写错时，保存或测试连接会提示。
- 回复是 JSON、SSE（`data: …`）、NDJSON（一行一个 JSON）还是纯文本都能自动识别，常见字段（`choices`、`message.content`、`response`、`reply`、`answer`、`generated_text`、`data.reply`……）会自动认出来。认不出时，在「回复所在位置」里写路径，比如 `data.reply`、`output.choices.0.message.content`。
- 预设里有现成的模板：Ollama 原生接口（能设上下文长度 `num_ctx`）、Alpaca 格式和 ChatML 格式的原始文本补全（给服务端没有对话模板、或者模板和训练时不一样的微调模型）、Dify 应用、通用 FastAPI。

例：Ollama 原生接口

```json
{
  "model": "{{model}}",
  "messages": "{{messages}}",
  "stream": true,
  "options": { "num_ctx": 8192, "temperature": "{{temperature}}" }
}
```

### 本机命令（推理脚本）

接口类型选「本机命令」，填要运行的命令（比如 `python3 ~/models/infer.py`）。轮到它发言时运行一次：

- 标准输入：选「纯文本」是「系统提示词 + 空行 + 聊天记录」；选「JSON」是一行 JSON，内容和下一节「自定义程序」收到的一样（含 `messages`）。
- 标准输出就是回复，边输出边显示（已经替 Python 关掉了输出缓冲）；打印的是 `{"reply": "…"}` 这样的 JSON 时只取回复文字。
- 退出码不是 0 时，聊天里显示标准错误的最后几行；点「停止」会结束整个命令（包括它启动的子进程）。
- 环境变量：`AGENT_HUB_MODEL`（模型名）、`AGENT_HUB_PURPOSE`（`reply` / `plan` / `test`）、`AGENT_HUB_AGENT`、`AGENT_HUB_MAX_TOKENS`。工作目录默认是主目录 `~`。
- 示例：`examples/my_model_cli.py`。默认是演示模式；命令写成 `MODEL=~/models/我的模型 python3 /你的路径/agent-hub/examples/my_model_cli.py` 就用 MLX 加载你的模型（LoRA 再加 `ADAPTER=适配器文件夹`）。每次发言都要重新加载一次模型（小模型几秒），经常用的话改成上面的常驻服务更快。

## 接入自己的程序（自定义 HTTP 智能体）

任何语言写的程序，只要提供一个 HTTP 接口，就能作为智能体加入群聊（比如调用自己的模型、查数据库、跑脚本、接 LangChain / AutoGen）。

轮到它发言时，Agent Hub 会发送 `POST <接口地址>`：

```json
{
  "agent": { "id": "…", "name": "记录员", "persona": "…", "model": "" },
  "purpose": "reply",
  "instruction": "现在轮到你发言……",
  "room": { "id": "…", "name": "默认房间", "mode": "chat" },
  "history": [ { "role": "user", "name": "用户", "content": "……" },
               { "role": "agent", "name": "工程师阿码", "content": "……" } ],
  "system": "完整的系统提示词",
  "prompt": "完整的用户提示词（含聊天记录）",
  "messages": [ { "role": "system", "content": "…" }, { "role": "user", "content": "…" } ],
  "message": "最新一条用户消息（分工协作时是分给它的子任务）"
}
```

`messages` 已经按智能体的「小模型 / 专精模型适配」设置排好，可以直接交给模型的对话模板（比如 `tokenizer.apply_chat_template(messages)`）。

`purpose` 可能是 `reply`（普通发言）、`plan`（分工协作中的负责人拆任务，需要返回题目要求的 JSON）或 `test`（测试连接）。

返回 JSON `{"reply": "回复内容"}`，或直接返回纯文本、SSE、NDJSON（都可以边生成边输出，格式自动识别）。填了 API Key 时会以 `Authorization: Bearer <Key>` 发送。

示例：`python3 examples/recorder_agent.py`，然后添加智能体 → 预设选「自定义程序（Agent Hub 协议）」→ 地址 `http://localhost:9000/agent`。也可以把 `python3 /你的路径/agent-hub/examples/recorder_agent.py` 填进「启动命令」，用到它时自动启动。

## 数据与安全

- 所有数据都在 `data/`：`agents.json`（**含 API Key，不要分享**）、`rooms/`（聊天记录）、`uploads/`（上传的文件）和 `access.json`（手机访问码和已登录设备）。备份就复制这个文件夹。`workspace/` 是 Claude Code、Codex 的工作目录，`mailbox/` 是手动转达的信箱。
- 能在电脑上运行程序、读写文件夹的设置（本机命令、启动命令、工作目录、可写文件夹）只能在电脑本机上改，手机登录了也改不了（输入框是灰的，服务端也会拦），但可以照常使用这些智能体。
- 默认只监听本机（`127.0.0.1`）。在 `.env` 里写 `HOST=0.0.0.0` 才能让手机访问；这时除了在电脑本机打开 localhost，其他设备都要先用访问码登录（见上面「在手机上用」）。不管哪种，都拒绝其他网站发来的写操作。登录状态存在 `data/access.json`（只存哈希）。
- **不要把 Agent Hub 直接暴露到公网**：它是给自己一个人用的，没有多用户和权限管理。
- 可选环境变量（写在 `.env` 里，参考 `.env.example`）：`PORT`、`HOST`、`HISTORY_CHARS`（每次发给模型的聊天记录长度上限，默认 24000 字）、`CALL_TIMEOUT_MS`（单次调用超时，默认 10 分钟）、`TOOL_TIMEOUT_MS`（能运行命令、改文件的 Claude Code / Codex 单次发言的时限，默认 60 分钟；发言结束时它开的命令包括后台命令都会被停掉，见 `providers/proctree.js`）、`LOCAL_SERVER_START_MS`（启动命令最多等多久，默认 3 分钟）、`LOCAL_SERVER_IDLE_MIN`（自动启动的服务闲置多久关掉，默认 15 分钟）。

## 常见问题

- **端口被占用**：服务可能已经在运行，直接打开网页；或者用 `PORT=8788 npm start` 换个端口。
- **调用失败**：401 是 Key 不对；404 或「Model Not Exist」是模型名或接口地址不对（模型名不对时，错误信息里会列出这个接口支持的模型）；「连不上」要检查网络、代理，或者本机模型 / 程序是否已经启动。
- **自定义程序第一次连接报 ETIMEDOUT**：稍等几秒再试。也看看 macOS 有没有弹出网络权限提示。
- **改了 `agents.json` 没生效**：刷新网页。格式写错时，页面顶部会提示具体错误。
- **本机模型答非所问、忘了自己是谁**：多半是聊天记录超出了它的上下文，开头的人设被截掉了。在「小模型 / 专精模型适配」里把「最多带多少字聊天记录」调到 4000–8000；用 Ollama 的话可以改用「Ollama 原生接口」预设（上下文 8192）。
- **本机模型只输出了思考、没给答案**：在长度上限以内没想完。把「最长回复」调大（MLX 默认只有 512 token），或者让它不要思考（Qwen3：额外参数填 `{"chat_template_kwargs": {"enable_thinking": false}}`）。
- **启动命令 / 本机命令报 command not found**：写完整路径（终端里运行 `which 命令名` 查看），或者先进入文件夹：`cd ~/my-model && ./run.sh`。
- **「查找」没找到我的模型**：只查常用端口（11434、1234、8080、8000、1337、5001、5000、4891、30000、8081、8090）。用了别的端口，就在地址框里输入 `http://localhost:端口`。
- **费用**：每位成员每次发言都是一次模型调用。成员越多、轮数越多，调用次数越多（约等于成员数 × 轮数，再加总结）。

## 目录结构

```
agent-hub/
├── start.command      macOS 双击启动
├── server.js          服务端：存储、编排（三种模式）、实时推送
├── handoff.js         AI 之间的交接（交接单、思考过程、资料和文件）
├── usage.js           用量和预算
├── providers/         各家模型的接入（openai / anthropic / claude-code / codex / relay / rest / command / http / mock），
│                      以及查找本机模型（discover）、自动启动本机服务（local-server）、宽权限沙箱（wide）、请求模板和回复解析
├── public/            网页界面（没有构建步骤）
├── examples/          自定义智能体示例（记录员、推理脚本 my_model_cli.py）
├── test/              冒烟测试（npm test）
├── docs/              截图
├── data/              你的智能体配置和聊天记录（自动生成，已在 .gitignore 里）
├── workspace/         Claude Code、Codex 的工作目录（自动生成）
└── mailbox/           手动转达的信箱（自动生成）
```

## 许可

[MIT](LICENSE)。网页里内嵌的图标来自 [Lucide](https://lucide.dev)（ISC 许可），见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
