# mcp-media-reader

一个 MCP（Model Context Protocol）服务器，让 AI 智能体能够理解音频和视频文件。由小米 [MiMo](https://platform.xiaomimimo.com/) 多模态 API 驱动。

> **仅支持小米 MiMo 模型：`mimo-v2.5` 或 `mimo-v2-omni`。不兼容其他模型或 API 提供商。**

## 背景

小米 MiMo v2.5 / v2-omni 模型具备原生音视频理解能力——音频和视频数据可直接作为 token 进入模型上下文，实现细粒度的多模态分析。然而，当前主流 AI 编程助手（如 Claude Code、Cursor 等）的文件读取接口仅支持文本和图片，尚无原生音视频输入通道。

本 MCP Server 作为**临时中转方案**，将本地音视频文件通过 MiMo API 进行分析，再以文本形式返回结果给主模型。适用于轻度音视频读取需求。其局限在于：分析结果以文本摘要形式进入主模型上下文，而非原始媒体数据，因此主模型无法像原生支持那样对音视频进行细粒度的逐帧/逐秒回溯分析。

若未来 Claude Code 等工具原生支持音视频输入，本工具的中转层将不再必要。

## 功能

为 AI 助手（如 Claude Code、Cursor 或任何兼容 MCP 的智能体）赋予以下能力：

- **读取和分析音频文件**（MP3、WAV、FLAC、M4A、OGG）
- **读取和分析视频文件**（MP4、MOV、AVI、WMV、WebM）
- **追问**已加载的媒体内容，无需重新上传
- **自主精炼**答案——通过自评估循环自动完善分析结果

与简单的"转录此文件"工具不同：本服务器将查询发送给 MiMo，评估返回结果是否足够充分，如不够则自动重新检查媒体——全部在返回结果之前完成。

## 风险提醒

使用本 MCP Server 前，请了解以下潜在风险：

- **Token 消耗**：音视频文件会被编码为 base64 发送至 MiMo API，每次调用均产生 token 费用。视频文件越大、`fps` 越高、`media_resolution` 设为 `max`，消耗越多。自主精炼循环会多次调用 API，进一步增加消耗。
- **重复发送**：当自评估判定 `need_reread: true` 时，会重新发送完整媒体数据，相当于再次消耗同等 token。
- **会话累积**：`ask_about_media` 延续对话上下文，随着轮次增加，每次请求携带的历史 token 也会增长。
- **API 费用**：MiMo API 按 token 计费，具体价格请参阅 [MiMo 定价页](https://platform.xiaomimimo.com/#/docs/pricing)。请确保了解计费规则后再使用。
- **数据安全**：本地媒体文件会被读取并以 base64 形式发送至小米 API 服务器。请勿用于处理敏感或机密内容。
- **网络传输**：大文件（视频可达数百 MB）的 base64 编码和传输可能消耗大量内存和带宽。

**建议**：通过 `max_retries` 参数控制精炼轮数，用 `query` 参数明确需求以减少不必要的调用，定期使用 `delete_session` 清理不再需要的会话。

## 工作原理

```
AI 智能体（Claude Code 等）
    │
    ├─ read_video(file, query, session_name)
    │       │
    │       │  （缺少配置时）
    │       └─ 返回 "请向用户索取 API Key / Base URL / Model"
    │       │
    │       ├─ configure(api_key, api_base, model) ──► 存储配置到内存
    │       │
    │       └─ read_video(...) ─────────────────────► 自评估循环：
    │                                                  "回答是否足够好？"
    │                                                  否 → 重新检查媒体 → 重试
    │                                                  是 → 返回结果
    │
    ├─ ask_about_media(session_name, question) ─────► 延续对话上下文
    │                                                  （无需重传媒体）
    │
    ├─ list_sessions() ────────────────────────────► 查看所有活跃会话
    │
    └─ delete_session(session_name) ───────────────► 删除会话释放内存
```

## 前置条件

- **Node.js** >= 18
- **小米 MiMo API Key** — 仅支持 `mimo-v2.5` 或 `mimo-v2-omni` 模型，在 [platform.xiaomimimo.com](https://platform.xiaomimimo.com/) 获取

## 安装

### 作为 MCP 服务器（推荐）

克隆或复制本目录，然后安装依赖：

```bash
git clone https://github.com/YOUR_USERNAME/mcp-media-reader.git
cd mcp-media-reader
npm install
```

### 通过 npx 运行（无需克隆）

```bash
npx mcp-media-reader
```

## 配置

在项目的 `.mcp.json` 文件（Claude Code 使用）或等效的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "media-reader": {
      "command": "node",
      "args": ["/path/to/mcp-media-reader/server.js"],
      "env": {
        "MIMO_API_KEY": "your-mimo-api-key",
        "MIMO_API_BASE": "https://api.xiaomimimo.com/v1",
        "MIMO_MODEL": "mimo-v2.5"
      }
    }
  }
}
```

### 首次使用：自动索取配置

所有配置项均无默认值。如果未在 `env` 中预设，首次调用任何工具时，服务器会返回缺失项列表，要求智能体向用户索取。智能体随后调用 `configure` 工具完成配置。

```
用户：分析这个视频
智能体：→ read_video(file_path="video.mp4")
       ← { missing: ["MIMO_API_KEY", "MIMO_API_BASE", "MIMO_MODEL"] }
智能体：→ （向用户询问）
用户：Key 是 tp-xxxxx，端点是 api.xiaomimimo.com/v1，用 mimo-v2.5 模型
智能体：→ configure(api_key="tp-xxxxx", api_base="https://api.xiaomimimo.com/v1", model="mimo-v2.5")
       ← "配置完成"
智能体：→ read_video(file_path="video.mp4")
       ← （分析结果）
```

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `MIMO_API_KEY` | 否* | — | MiMo API key |
| `MIMO_API_BASE` | 否* | — | MiMo API 端点（如 `https://api.xiaomimimo.com/v1`） |
| `MIMO_MODEL` | 否* | — | 模型名称（`mimo-v2.5` 或 `mimo-v2-omni`） |

*所有配置项均无默认值。可通过环境变量预设，也可通过 `configure` 工具在运行时设置。未设置时首次调用会提示用户提供。

## 智能体如何发现和使用本工具

安装后，Claude Code 等智能体会自动加载本 MCP Server 的所有工具及其描述。当遇到以下情况时，智能体会调用本工具：

1. **用户明确要求** — 如"读取这个视频"、"分析这段音频"，智能体会直接匹配到 `read_video` / `read_audio`。
2. **Read tool 失败回退** — 智能体尝试用内置的 Read tool 读取 mp4/wav 等二进制文件时会失败，随后会查找其他可用工具并发现本 MCP。

但智能体**不会主动扫描目录**判断哪些文件需要音视频分析。如果你希望智能体更主动地使用本工具，可以在项目根目录的 `CLAUDE.md` 中添加说明：

```markdown
当需要分析音频或视频文件时，使用 mcp-media-reader 的 read_audio / read_video 工具。
```

## 工具列表

### `configure`

配置 MiMo API 连接参数。由智能体在获取用户提供的设置后调用。所有参数均为可选——只需设置需要变更的项。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `api_key` | string | 否 | MiMo API key（在 https://platform.xiaomimimo.com/ 获取） |
| `api_base` | string | 否 | MiMo API 端点（如 `https://api.xiaomimimo.com/v1`） |
| `model` | string | 否 | 模型名称：`mimo-v2.5` 或 `mimo-v2-omni` |

### `read_audio`

读取并分析音频文件，支持自主精炼。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file_path` | string | 是 | 音频文件的绝对路径 |
| `query` | string | 否 | 需要提取的信息（如"转录歌词"）。省略则返回完整描述 |
| `session_name` | string | 否 | 会话名称。省略则自动生成 |
| `max_retries` | number | 否 | 最大自评估轮数（默认 3） |

### `read_video`

读取并分析视频文件，支持自主精炼。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file_path` | string | 是 | 视频文件的绝对路径 |
| `query` | string | 否 | 需要提取的信息。省略则返回完整描述 |
| `session_name` | string | 否 | 会话名称。省略则自动生成 |
| `fps` | number | 否 | 每秒抽帧数，范围 [0.1, 10]，默认 2 |
| `media_resolution` | `"default"` \| `"max"` | 否 | 分辨率档位。`max` 提升细节识别能力 |
| `max_retries` | number | 否 | 最大自评估轮数（默认 3） |

### `ask_about_media`

在已有会话中追问。复用对话上下文，无需重新上传媒体。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `session_name` | string | 是 | 要延续的会话名称（来自 `read_audio`/`read_video` 或 `list_sessions`） |
| `question` | string | 是 | 追问内容 |
| `max_retries` | number | 否 | 最大自评估轮数（默认 3） |

### `list_sessions`

列出所有活跃会话及其元数据（名称、文件、类型、对话轮次、创建时间）。无参数。

### `delete_session`

删除会话以释放内存。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `session_name` | string | 是 | 要删除的会话名称 |

## 使用示例

### 基础视频分析

```text
用户：描述一下这个视频的内容
智能体：→ read_video(file_path="/path/to/video.mp4")
       ← "视频展示了一只猫坐在窗台上..."
```

### 定向查询 + 自主精炼

```text
用户：视频里播放了哪些歌曲？
智能体：→ read_video(file_path="/path/to/video.mp4", query="列出所有歌曲名和歌手名")
       ← [MiMo 自评估，发现遗漏歌曲，重新检查视频，返回完整列表]
       ← "1. Bread - If, 2. Harry Styles - Sign of the Times..."
```

### 多轮对话

```text
用户：视频中展示了什么技术架构？
智能体：→ read_video(file_path="/path/to/video.mp4", query="技术架构", session_name="arch-video")
       ← "架构由三层组成..."

用户：具体连接了哪些 API？
智能体：→ ask_about_media(session_name="arch-video", question="连接了哪些 API？")
       ← [复用上下文，无需重传] "连接了 Spotify、天气 API、飞书 API..."
```

## 自主精炼循环

当提供 `query` 参数时，服务器会运行自动精炼循环：

1. 将媒体 + 查询发送给 MiMo
2. MiMo 返回分析结果
3. 要求 MiMo 自评估："回答是否充分回答了查询？"
4. 如果 `satisfied: false` 且 `need_reread: true` → 重发媒体数据，聚焦缺失信息追问
5. 如果 `satisfied: false` 且 `need_reread: false` → 纯文本追问（节省 token）
6. 重复直到满意或达到 `max_retries` 上限

对调用者完全透明——你只会得到一个更好的答案。

## 进度通知

服务器在每个关键步骤通过 MCP `notifications/message` 推送状态，调用方可实时监控进度：

```
[claudio-video] 开始分析...
[claudio-video] 初始分析完成。
[claudio-video] 自评估轮次 1/3...
[claudio-video] 未满足：缺少运动时段（need_reread: true）
[claudio-video] 发送精炼查询（第 4 次 API 调用）...
[claudio-video] 查询在 2 轮评估后满足。
[claudio-video] 完成。总 API 调用：4 次
```

## Token 消耗

- 音频：约 6.25 tokens/秒
- 视频：取决于 `fps` 和 `media_resolution`。详见 [MiMo 文档](https://platform.xiaomimimo.com/#/docs/usage-guide/multimodal-understanding/video-understanding)

每次精炼循环迭代都会消耗额外 token。通过 `max_retries` 控制成本。

## 支持格式

| 类型 | 格式 |
|------|------|
| 音频 | MP3、WAV、FLAC、M4A、OGG |
| 视频 | MP4、MOV、AVI、WMV、WebM |

## 许可证

MIT
