// 预置第三方模型提供商（源自 DSH 的 pi-ai provider catalog）。
//
// 数据来源：DSH 0.2.2-rc.5 的 @earendil-works/pi-ai（1.5.2）内置 provider /
// model 目录。这里只保留两个用途需要的数据：添加提供商时的 id、显示名、Base URL，
// 以及「获取可用模型」在本地挑选时的模型清单（含上下文/输出/图片能力）。
//
// 模型清单取该 provider 在 catalog 里的 chat 模型：有 `anthropic-messages`
// 分组就用它（CLI 发的就是这个协议），没有就用该 provider 唯一的对话分组
// （DeepSeek / Kimi / Qwen / 小米 / Z.AI 等的 `/anthropic` 端点与自家目录同源）。
// 只排除两类不是「另一个可选模型」的条目：部署变体（`-batch` / `-fast` /
// `-spot` / `-ultrafast` / `:batch` / `:free`）与带日期快照的别名
// （`-20251001` 这类，同一个模型的旧快照）。OpenCode Go 的 `gemini-4-argon`
// 是 catalog 里另立 Gemini 分组的条目，此前已收录且可用，保留在末尾。
//
// 新增/改版时按同一份数据重跑即可，不要手工逐条挑——手工挑会漏掉新代际
// （上一版就漏了 claude-opus-4-7 / 4-8 / 5、claude-sonnet-5、haiku-5-5 等）。
//
// 这份 `models` **不是**「选中预置就写进表单的默认值」：预置只填身份与 Base URL，
// 模型在「获取可用模型」的弹窗里勾选（对齐 DSH）。它现在的职责是「没填 API 地址
// 或密钥时的本地候选清单」——那种状态下端点只会回 401，目录比一次注定失败的
// 请求有用；填好之后就会改为问端点，拿它自己报的列表。
//
// 收录标准只有一个：**端点说 Anthropic Messages**。claude CLI 只会发
// `POST {base}/v1/messages`，没有任何开关能让它改说 OpenAI Chat Completions、
// OpenAI Responses 或 Gemini——所以原生 API 是那些协议的服务（OpenAI / xAI /
// Groq / Mistral / Gemini / Bedrock 等）在这个应用里**注定用不了**，它们的
// 「获取模型列表」再顺畅也换不来一次能跑通的对话。那些条目已整批删除
// （19 个），不是标灰：留一个选中后必然 404 的下拉项只会制造误判。
//
// 留在目录里的两类：
//   - 已填好 Anthropic 兼容地址的（DeepSeek / Z.AI / Kimi / Qwen / MiniMax /
//     小米等的 `/anthropic` 路径，加 OpenRouter / Vercel / Fireworks 等）；
//   - 原生就是 Anthropic Messages、但地址要用户自己补的（needsBaseUrl）。

import type { AuthMethod, ModelSpec } from "../transport/types";

export interface ProviderPresetModel {
  id: string;
  name?: string;
  context_window?: number;
  max_output_tokens?: number;
  supports_image?: boolean;
}

export interface ProviderPreset {
  /** 稳定 ID，同时作为默认的提供商 ID。 */
  id: string;
  name: string;
  baseUrl: string;
  /** Base URL 需要用户补全（账号 / 区域 / 网关路径）。 */
  needsBaseUrl?: boolean;
  /**
   * 该端点的密钥发法：`bearer` = `Authorization: Bearer`（多数中转），
   * 缺省 = `x-api-key`（官方端点）。选中预置时会写进提供商的「认证方式」。
   */
  auth?: "bearer";
  note?: string;
  models: ProviderPresetModel[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    "id": "anthropic",
    "name": "Anthropic",
    "baseUrl": "https://api.anthropic.com",
    "models": [
      {
        "id": "claude-fable-5",
        "name": "Claude Fable 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-fable-5-1",
        "name": "Claude Fable 5.1",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-fable-5-2",
        "name": "Claude Fable 5.2",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-haiku-4-5",
        "name": "Claude Haiku 4.5 (latest)",
        "context_window": 200000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "claude-haiku-5-5",
        "name": "Claude Haiku 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-opus-4-5",
        "name": "Claude Opus 4.5 (latest)",
        "context_window": 200000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "claude-opus-4-6",
        "name": "Claude Opus 4.6",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-opus-4-7",
        "name": "Claude Opus 4.7",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-opus-4-8",
        "name": "Claude Opus 4.8",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-opus-5",
        "name": "Claude Opus 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-opus-5-5",
        "name": "Claude Opus 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-sonnet-4-5",
        "name": "Claude Sonnet 4.5 (latest)",
        "context_window": 200000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-sonnet-5",
        "name": "Claude Sonnet 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-sonnet-5-5",
        "name": "Claude Sonnet 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      }
    ]
  },
  {
    "id": "cloudflare-ai-gateway",
    "name": "Cloudflare AI Gateway",
    "baseUrl": "",
    "needsBaseUrl": true,
    "note": "原生 API 就是 Anthropic Messages：请填写你自己的完整 Base URL。",
    "models": [
      {
        "id": "claude-fable-5",
        "name": "Claude Fable 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-fable-5-1",
        "name": "Claude Fable 5.1",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-haiku-4-5",
        "name": "Claude Haiku 4.5 (latest)",
        "context_window": 200000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "claude-haiku-5-5",
        "name": "Claude Haiku 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-opus-4-5",
        "name": "Claude Opus 4.5 (latest)",
        "context_window": 200000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "claude-opus-4-6",
        "name": "Claude Opus 4.6",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-opus-4-7",
        "name": "Claude Opus 4.7",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-opus-4-8",
        "name": "Claude Opus 4.8",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-opus-5",
        "name": "Claude Opus 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-opus-5-5",
        "name": "Claude Opus 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-sonnet-4-5",
        "name": "Claude Sonnet 4.5 (latest)",
        "context_window": 200000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-sonnet-5",
        "name": "Claude Sonnet 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-sonnet-5-5",
        "name": "Claude Sonnet 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      }
    ]
  },
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "baseUrl": "https://api.deepseek.com/anthropic",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "deepseek-flash",
        "name": "DeepSeek V4.1 Flash",
        "context_window": 1000000,
        "max_output_tokens": 384000,
        "supports_image": true
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "context_window": 1000000,
        "max_output_tokens": 384000
      }
    ]
  },
  {
    "id": "fireworks",
    "name": "Fireworks",
    "baseUrl": "https://api.fireworks.ai/inference",
    "models": [
      {
        "id": "accounts/fireworks/models/deepseek-v4p1-flash",
        "name": "DeepSeek V4.1 Flash",
        "context_window": 1000000,
        "max_output_tokens": 384000,
        "supports_image": true
      },
      {
        "id": "accounts/fireworks/models/deepseek-v4p1-flash-1017",
        "name": "DeepSeek V4.1 Flash 1017",
        "context_window": 1000000,
        "max_output_tokens": 384000,
        "supports_image": true
      },
      {
        "id": "accounts/fireworks/models/ember-1",
        "name": "Ember-1",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "accounts/fireworks/models/minimax-m3",
        "name": "MiniMax-M3",
        "context_window": 512000,
        "max_output_tokens": 512000
      },
      {
        "id": "accounts/fireworks/models/minimax-m3p1-flash",
        "name": "MiniMax-M3.1-Flash",
        "context_window": 1000000,
        "max_output_tokens": 512000,
        "supports_image": true
      },
      {
        "id": "accounts/fireworks/models/muse-spark-open",
        "name": "Muse Spark Open",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "accounts/fireworks/models/qwen3p8-2p4t-a95b",
        "name": "Qwen3.8 2.4T A95B",
        "context_window": 262144,
        "max_output_tokens": 131072
      },
      {
        "id": "accounts/fireworks/models/qwen3p8-max",
        "name": "Qwen3.8 Max",
        "context_window": 262144,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "accounts/fireworks/routers/deepseek-flash-latest",
        "name": "DeepSeek Flash Latest",
        "context_window": 1000000,
        "max_output_tokens": 384000,
        "supports_image": true
      },
      {
        "id": "accounts/fireworks/routers/kimi-fast-latest",
        "name": "Kimi Fast Latest",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "accounts/fireworks/routers/kimi-latest",
        "name": "Kimi Latest",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "accounts/fireworks/routers/minimax-latest",
        "name": "MiniMax Latest",
        "context_window": 512000,
        "max_output_tokens": 512000
      },
      {
        "id": "accounts/fireworks/routers/qwen-max-latest",
        "name": "Qwen Max Latest (Qwen3.8 Max)",
        "context_window": 262144,
        "max_output_tokens": 131072,
        "supports_image": true
      }
    ]
  },
  {
    "id": "github-copilot",
    "name": "GitHub Copilot",
    "baseUrl": "https://api.individual.githubcopilot.com",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "claude-fable-5",
        "name": "Claude Fable 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-fable-5.1",
        "name": "Claude Fable 5.1",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-haiku-4.5",
        "name": "Claude Haiku 4.5 (latest)",
        "context_window": 200000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "claude-haiku-5.5",
        "name": "Claude Haiku 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-opus-4.8",
        "name": "Claude Opus 4.8",
        "context_window": 1000000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "claude-opus-5",
        "name": "Claude Opus 5",
        "context_window": 1000000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "claude-opus-5.5",
        "name": "Claude Opus 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-sonnet-4.6",
        "name": "Claude Sonnet 4.6",
        "context_window": 1000000,
        "max_output_tokens": 32000,
        "supports_image": true
      },
      {
        "id": "claude-sonnet-5",
        "name": "Claude Sonnet 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-sonnet-5.5",
        "name": "Claude Sonnet 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      }
    ]
  },
  {
    "id": "minimax",
    "name": "MiniMax",
    "baseUrl": "https://api.minimax.io/anthropic",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "MiniMax-M2.7",
        "name": "MiniMax-M2.7",
        "context_window": 204800,
        "max_output_tokens": 131072
      },
      {
        "id": "MiniMax-M2.7-highspeed",
        "name": "MiniMax-M2.7-highspeed",
        "context_window": 204800,
        "max_output_tokens": 131072
      },
      {
        "id": "MiniMax-M3",
        "name": "MiniMax-M3",
        "context_window": 1000000,
        "max_output_tokens": 524288,
        "supports_image": true
      },
      {
        "id": "MiniMax-M3.1-Flash",
        "name": "MiniMax-M3.1-Flash",
        "context_window": 1000000,
        "max_output_tokens": 524288,
        "supports_image": true
      }
    ]
  },
  {
    "id": "minimax-cn",
    "name": "MiniMax CN",
    "baseUrl": "https://api.minimaxi.com/anthropic",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "MiniMax-M2.7",
        "name": "MiniMax-M2.7",
        "context_window": 204800,
        "max_output_tokens": 131072
      },
      {
        "id": "MiniMax-M2.7-highspeed",
        "name": "MiniMax-M2.7-highspeed",
        "context_window": 204800,
        "max_output_tokens": 131072
      },
      {
        "id": "MiniMax-M3",
        "name": "MiniMax-M3",
        "context_window": 1000000,
        "max_output_tokens": 524288,
        "supports_image": true
      },
      {
        "id": "MiniMax-M3.1-Flash",
        "name": "MiniMax-M3.1-Flash",
        "context_window": 1000000,
        "max_output_tokens": 524288,
        "supports_image": true
      }
    ]
  },
  {
    "id": "moonshotai",
    "name": "Moonshot AI",
    "baseUrl": "https://api.moonshot.ai/anthropic",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6",
        "context_window": 262144,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code",
        "context_window": 262144,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "kimi-k2.7-code-highspeed",
        "name": "Kimi K2.7 Code HighSpeed",
        "context_window": 262144,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "kimi-k3",
        "name": "Kimi K3",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "kimi-k3.1-pro",
        "name": "Kimi K3.1 Pro",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "kimi-k3.1-pro-highspeed",
        "name": "Kimi K3.1 Pro Highspeed",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      }
    ]
  },
  {
    "id": "moonshotai-cn",
    "name": "Moonshot AI CN",
    "baseUrl": "https://api.moonshot.cn/anthropic",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6",
        "context_window": 262144,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code",
        "context_window": 262144,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "kimi-k2.7-code-highspeed",
        "name": "Kimi K2.7 Code HighSpeed",
        "context_window": 262144,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "kimi-k3",
        "name": "Kimi K3",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "kimi-k3.1-pro",
        "name": "Kimi K3.1 Pro",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "kimi-k3.1-pro-highspeed",
        "name": "Kimi K3.1 Pro Highspeed",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      }
    ]
  },
  {
    "id": "opencode",
    "name": "OpenCode Zen",
    "baseUrl": "",
    "needsBaseUrl": true,
    "note": "原生 API 就是 Anthropic Messages：请填写你自己的完整 Base URL。",
    "models": [
      {
        "id": "claude-fable-5",
        "name": "Claude Fable 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-fable-5-1",
        "name": "Claude Fable 5.1",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-fable-5-2",
        "name": "Claude Fable 5.2",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-haiku-4-5",
        "name": "Claude Haiku 4.5",
        "context_window": 200000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "claude-haiku-5-5",
        "name": "Claude Haiku 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-opus-4-5",
        "name": "Claude Opus 4.5",
        "context_window": 200000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "claude-opus-4-6",
        "name": "Claude Opus 4.6",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-opus-4-7",
        "name": "Claude Opus 4.7",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-opus-4-8",
        "name": "Claude Opus 4.8",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-opus-5",
        "name": "Claude Opus 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-opus-5-5",
        "name": "Claude Opus 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-sonnet-4-5",
        "name": "Claude Sonnet 4.5",
        "context_window": 200000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6",
        "context_window": 1000000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "claude-sonnet-5",
        "name": "Claude Sonnet 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-sonnet-5-5",
        "name": "Claude Sonnet 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "qwen3.5-plus",
        "name": "Qwen3.5 Plus",
        "context_window": 262144,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "qwen3.6-plus",
        "name": "Qwen3.6 Plus",
        "context_window": 262144,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "qwen3.8-flash",
        "name": "Qwen3.8 Flash",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      }
    ]
  },
  {
    "id": "opencode-go",
    "name": "OpenCode Go",
    "baseUrl": "",
    "needsBaseUrl": true,
    "note": "原生 API 就是 Anthropic Messages：请填写你自己的完整 Base URL。",
    "models": [
      {
        "id": "claude-haiku-5-5",
        "name": "Claude Haiku 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "minimax-m3",
        "name": "MiniMax-M3",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "qwen3.7-plus",
        "name": "Qwen3.7 Plus",
        "context_window": 1000000,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "qwen3.8-flash",
        "name": "Qwen3.8 Flash",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "qwen3.8-max",
        "name": "Qwen3.8 Max",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "gemini-4-argon",
        "name": "Gemini 4 Argon",
        "context_window": 1048576,
        "max_output_tokens": 65536,
        "supports_image": true
      }
    ]
  },
  {
    "id": "openrouter",
    "name": "OpenRouter",
    "baseUrl": "https://openrouter.ai/api",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "~anthropic/claude-fable-latest",
        "name": "Anthropic: Claude Fable Latest",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "~anthropic/claude-haiku-latest",
        "name": "Anthropic: Claude Haiku Latest",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "~anthropic/claude-opus-latest",
        "name": "Anthropic: Claude Opus Latest",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "~anthropic/claude-sonnet-latest",
        "name": "Anthropic: Claude Sonnet Latest",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-fable-5",
        "name": "Anthropic: Claude Fable 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-fable-5.1",
        "name": "Anthropic: Claude Fable 5.1",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-fable-5.2",
        "name": "Anthropic: Claude Fable 5.2",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-haiku-4.5",
        "name": "Anthropic: Claude Haiku 4.5",
        "context_window": 200000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-haiku-5.5",
        "name": "Anthropic: Claude Haiku 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-opus-4.1",
        "name": "Anthropic: Claude Opus 4.1",
        "context_window": 200000,
        "max_output_tokens": 32000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-opus-4.5",
        "name": "Anthropic: Claude Opus 4.5",
        "context_window": 200000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-opus-4.6",
        "name": "Anthropic: Claude Opus 4.6",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-opus-4.7",
        "name": "Anthropic: Claude Opus 4.7",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-opus-4.8",
        "name": "Anthropic: Claude Opus 4.8",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-opus-5",
        "name": "Anthropic: Claude Opus 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-opus-5.5",
        "name": "Anthropic: Claude Opus 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-sonnet-4.5",
        "name": "Anthropic: Claude Sonnet 4.5",
        "context_window": 1000000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-sonnet-4.6",
        "name": "Anthropic: Claude Sonnet 4.6",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-sonnet-5",
        "name": "Anthropic: Claude Sonnet 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-sonnet-5.5",
        "name": "Anthropic: Claude Sonnet 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      }
    ]
  },
  {
    "id": "qwen-token-plan",
    "name": "Qwen Token Plan",
    "baseUrl": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "deepseek-v3.2",
        "name": "DeepSeek V3.2",
        "context_window": 131072,
        "max_output_tokens": 65536
      },
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek-v4-flash-0731",
        "name": "DeepSeek V4 Flash 0731",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek-v4-pro-0813",
        "name": "DeepSeek V4 Pro 0813",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek-v4.1-flash",
        "name": "DeepSeek V4.1 Flash",
        "context_window": 1000000,
        "max_output_tokens": 384000,
        "supports_image": true
      },
      {
        "id": "deepseek-v4.1-flash-1017",
        "name": "DeepSeek V4.1 Flash 1017",
        "context_window": 1000000,
        "max_output_tokens": 384000,
        "supports_image": true
      },
      {
        "id": "glm-5",
        "name": "GLM-5",
        "context_window": 202752,
        "max_output_tokens": 16384
      },
      {
        "id": "glm-5.1",
        "name": "GLM-5.1",
        "context_window": 202752,
        "max_output_tokens": 128000
      },
      {
        "id": "glm-5.2",
        "name": "GLM-5.2",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi K2.5",
        "context_window": 262144,
        "max_output_tokens": 98304,
        "supports_image": true
      },
      {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6",
        "context_window": 262144,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code",
        "context_window": 262144,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "MiniMax-M2.5",
        "name": "MiniMax-M2.5",
        "context_window": 196608,
        "max_output_tokens": 32768
      },
      {
        "id": "qwen3.6-flash",
        "name": "Qwen3.6 Flash",
        "context_window": 1000000,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "qwen3.6-plus",
        "name": "Qwen3.6 Plus",
        "context_window": 1000000,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "qwen3.7-max",
        "name": "Qwen3.7 Max",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "qwen3.7-plus",
        "name": "Qwen3.7 Plus",
        "context_window": 1000000,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "qwen3.8-flash",
        "name": "Qwen3.8 Flash",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "qwen3.8-max",
        "name": "Qwen3.8 Max",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      }
    ]
  },
  {
    "id": "qwen-token-plan-cn",
    "name": "Qwen Token Plan CN",
    "baseUrl": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "deepseek-v3.2",
        "name": "DeepSeek V3.2",
        "context_window": 131072,
        "max_output_tokens": 65536
      },
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek-v4-flash-0731",
        "name": "DeepSeek V4 Flash 0731",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek-v4-pro-0813",
        "name": "DeepSeek V4 Pro 0813",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek-v4.1-flash",
        "name": "DeepSeek V4.1 Flash",
        "context_window": 1000000,
        "max_output_tokens": 384000,
        "supports_image": true
      },
      {
        "id": "deepseek-v4.1-flash-1017",
        "name": "DeepSeek V4.1 Flash 1017",
        "context_window": 1000000,
        "max_output_tokens": 384000,
        "supports_image": true
      },
      {
        "id": "glm-5",
        "name": "GLM-5",
        "context_window": 202752,
        "max_output_tokens": 16384
      },
      {
        "id": "glm-5.1",
        "name": "GLM-5.1",
        "context_window": 202752,
        "max_output_tokens": 128000
      },
      {
        "id": "glm-5.2",
        "name": "GLM-5.2",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi K2.5",
        "context_window": 262144,
        "max_output_tokens": 98304,
        "supports_image": true
      },
      {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6",
        "context_window": 262144,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code",
        "context_window": 262144,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "MiniMax-M2.5",
        "name": "MiniMax-M2.5",
        "context_window": 196608,
        "max_output_tokens": 32768
      },
      {
        "id": "qwen3.6-flash",
        "name": "Qwen3.6 Flash",
        "context_window": 1000000,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "qwen3.6-plus",
        "name": "Qwen3.6 Plus",
        "context_window": 1000000,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "qwen3.7-max",
        "name": "Qwen3.7 Max",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "qwen3.7-plus",
        "name": "Qwen3.7 Plus",
        "context_window": 1000000,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "qwen3.8-flash",
        "name": "Qwen3.8 Flash",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "qwen3.8-max",
        "name": "Qwen3.8 Max",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      }
    ]
  },
  {
    "id": "qwen-token-plan-individual",
    "name": "Qwen Token Plan Individual",
    "baseUrl": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "deepseek-v4-flash-0731",
        "name": "DeepSeek V4 Flash 0731",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek-v4-pro-0813",
        "name": "DeepSeek V4 Pro 0813",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "glm-5.2",
        "name": "GLM-5.2",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "qwen3.6-flash",
        "name": "Qwen3.6 Flash",
        "context_window": 1000000,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "qwen3.7-max",
        "name": "Qwen3.7 Max",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "qwen3.7-plus",
        "name": "Qwen3.7 Plus",
        "context_window": 1000000,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "qwen3.8-flash",
        "name": "Qwen3.8 Flash",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "qwen3.8-max",
        "name": "Qwen3.8 Max",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      }
    ]
  },
  {
    "id": "qwen-token-plan-individual-cn",
    "name": "Qwen Token Plan Individual CN",
    "baseUrl": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "deepseek-v4-flash-0731",
        "name": "DeepSeek V4 Flash 0731",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek-v4-pro-0813",
        "name": "DeepSeek V4 Pro 0813",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "glm-5.2",
        "name": "GLM-5.2",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "qwen3.6-flash",
        "name": "Qwen3.6 Flash",
        "context_window": 1000000,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "qwen3.7-max",
        "name": "Qwen3.7 Max",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "qwen3.7-plus",
        "name": "Qwen3.7 Plus",
        "context_window": 1000000,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "qwen3.8-flash",
        "name": "Qwen3.8 Flash",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "qwen3.8-max",
        "name": "Qwen3.8 Max",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      }
    ]
  },
  {
    "id": "vercel-ai-gateway",
    "name": "Vercel AI Gateway",
    "baseUrl": "https://ai-gateway.vercel.sh",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "alibaba/qwen-3-14b",
        "name": "Qwen3-14B",
        "context_window": 40960,
        "max_output_tokens": 16384
      },
      {
        "id": "alibaba/qwen-3-235b",
        "name": "Qwen3 235B A22B",
        "context_window": 262144,
        "max_output_tokens": 16384
      },
      {
        "id": "alibaba/qwen-3-30b",
        "name": "Qwen3-30B-A3B",
        "context_window": 40960,
        "max_output_tokens": 16384
      },
      {
        "id": "alibaba/qwen-3-32b",
        "name": "Qwen 3 32B",
        "context_window": 128000,
        "max_output_tokens": 8192
      },
      {
        "id": "alibaba/qwen3-coder",
        "name": "Qwen3 Coder 480B A35B Instruct",
        "context_window": 262144,
        "max_output_tokens": 32768
      },
      {
        "id": "alibaba/qwen3-coder-30b-a3b",
        "name": "Qwen 3 Coder 30B A3B Instruct",
        "context_window": 262144,
        "max_output_tokens": 8192
      },
      {
        "id": "alibaba/qwen3-coder-next",
        "name": "Qwen3 Coder Next",
        "context_window": 256000,
        "max_output_tokens": 256000
      },
      {
        "id": "alibaba/qwen3-max-thinking",
        "name": "Qwen 3 Max Thinking",
        "context_window": 256000,
        "max_output_tokens": 65536
      },
      {
        "id": "alibaba/qwen3-next-80b-a3b-instruct",
        "name": "Qwen3 Next 80B A3B Instruct",
        "context_window": 262114,
        "max_output_tokens": 262114
      },
      {
        "id": "alibaba/qwen3-next-80b-a3b-thinking",
        "name": "Qwen3 Next 80B A3B Thinking",
        "context_window": 262144,
        "max_output_tokens": 262144
      },
      {
        "id": "alibaba/qwen3-vl-instruct",
        "name": "Qwen3 VL 235B A22B Instruct",
        "context_window": 262144,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "alibaba/qwen3.5-flash",
        "name": "Qwen 3.5 Flash",
        "context_window": 1000000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "alibaba/qwen3.5-plus",
        "name": "Qwen 3.5 Plus",
        "context_window": 1000000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "alibaba/qwen3.6-27b",
        "name": "Qwen 3.6 27B",
        "context_window": 256000,
        "max_output_tokens": 256000,
        "supports_image": true
      },
      {
        "id": "alibaba/qwen3.6-plus",
        "name": "Qwen 3.6 Plus",
        "context_window": 1000000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "alibaba/qwen3.7-flash",
        "name": "Qwen 3.7 Flash",
        "context_window": 991000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "alibaba/qwen3.7-max",
        "name": "Qwen 3.7 Max",
        "context_window": 991000,
        "max_output_tokens": 64000
      },
      {
        "id": "alibaba/qwen3.7-plus",
        "name": "Qwen 3.7 Plus",
        "context_window": 1000000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "alibaba/qwen3.8-2.4t-a95b",
        "name": "Qwen3.8 2.4T A95B",
        "context_window": 262144,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "alibaba/qwen3.8-27b",
        "name": "Qwen3.8 27B",
        "context_window": 262144,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "alibaba/qwen3.8-flash",
        "name": "Qwen 3.8 Flash",
        "context_window": 991000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "alibaba/qwen3.8-max",
        "name": "Qwen 3.8 Max",
        "context_window": 262144,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "alibaba/qwen3.8-max-0902",
        "name": "Qwen3.8 Max 0902",
        "context_window": 991000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "alibaba/qwen3.8-max-prime",
        "name": "Qwen 3.8 Max Prime",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "alibaba/qwen3.8-omni-flash",
        "name": "Qwen 3.8 Omni Flash",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "amazon/nova-2-lite",
        "name": "Nova 2 Lite",
        "context_window": 1000000,
        "max_output_tokens": 1000000,
        "supports_image": true
      },
      {
        "id": "amazon/nova-lite",
        "name": "Nova Lite",
        "context_window": 300000,
        "max_output_tokens": 8192,
        "supports_image": true
      },
      {
        "id": "amazon/nova-micro",
        "name": "Nova Micro",
        "context_window": 128000,
        "max_output_tokens": 8192
      },
      {
        "id": "amazon/nova-pro",
        "name": "Nova Pro",
        "context_window": 300000,
        "max_output_tokens": 8192,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-fable-5",
        "name": "Claude Fable 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-fable-5.1",
        "name": "Claude Fable 5.1",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-fable-5.2",
        "name": "Claude Fable 5.2",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-haiku-4.5",
        "name": "Claude Haiku 4.5",
        "context_window": 200000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-haiku-5.5",
        "name": "Claude Haiku 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-opus-4.5",
        "name": "Claude Opus 4.5",
        "context_window": 200000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-opus-4.6",
        "name": "Claude Opus 4.6",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-opus-4.7",
        "name": "Claude Opus 4.7",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-opus-4.8",
        "name": "Claude Opus 4.8",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-opus-5",
        "name": "Claude Opus 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-opus-5.5",
        "name": "Claude Opus 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-sonnet-4.5",
        "name": "Claude Sonnet 4.5",
        "context_window": 1000000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-sonnet-4.6",
        "name": "Claude Sonnet 4.6",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-sonnet-5",
        "name": "Claude Sonnet 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic/claude-sonnet-5.5",
        "name": "Claude Sonnet 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "bytedance/seed-1.6",
        "name": "Seed 1.6",
        "context_window": 256000,
        "max_output_tokens": 32000,
        "supports_image": true
      },
      {
        "id": "bytedance/seed-1.8",
        "name": "Bytedance Seed 1.8",
        "context_window": 256000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "bytedance/seed-2.1-turbo",
        "name": "Seed 2.1 Turbo",
        "context_window": 262144,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "callstack/apex",
        "name": "Apex",
        "context_window": 262144,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "cohere/command-a",
        "name": "Command A",
        "context_window": 256000,
        "max_output_tokens": 8000
      },
      {
        "id": "deepseek/deepseek-r1",
        "name": "DeepSeek-R1",
        "context_window": 128000,
        "max_output_tokens": 8192
      },
      {
        "id": "deepseek/deepseek-v3.1",
        "name": "DeepSeek V3.1",
        "context_window": 163840,
        "max_output_tokens": 128000
      },
      {
        "id": "deepseek/deepseek-v3.2",
        "name": "DeepSeek V3.2",
        "context_window": 128000,
        "max_output_tokens": 8000
      },
      {
        "id": "deepseek/deepseek-v3.2-thinking",
        "name": "DeepSeek V3.2 Thinking",
        "context_window": 128000,
        "max_output_tokens": 8000
      },
      {
        "id": "deepseek/deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek/deepseek-v4-flash-0731",
        "name": "DeepSeek V4 Flash 0731",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek/deepseek-v4-flash-vision-exp",
        "name": "DeepSeek V4 Flash Vision Exp",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "deepseek/deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "context_window": 1048600,
        "max_output_tokens": 1048600
      },
      {
        "id": "deepseek/deepseek-v4-pro-0813",
        "name": "DeepSeek V4 Pro 0813",
        "context_window": 1000000,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek/deepseek-v4.1-flash",
        "name": "DeepSeek V4.1 Flash",
        "context_window": 1048576,
        "max_output_tokens": 32768,
        "supports_image": true
      },
      {
        "id": "deepseek/deepseek-v4.1-flash-1017",
        "name": "DeepSeek V4.1 Flash 1017",
        "context_window": 1048576,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "fireworks/ember-1",
        "name": "Ember-1",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "google/gemini-2.5-flash",
        "name": "Gemini 2.5 Flash",
        "context_window": 1000000,
        "max_output_tokens": 65535,
        "supports_image": true
      },
      {
        "id": "google/gemini-2.5-flash-lite",
        "name": "Gemini 2.5 Flash Lite",
        "context_window": 1048576,
        "max_output_tokens": 65535,
        "supports_image": true
      },
      {
        "id": "google/gemini-2.5-pro",
        "name": "Gemini 2.5 Pro",
        "context_window": 1048576,
        "max_output_tokens": 65535,
        "supports_image": true
      },
      {
        "id": "google/gemini-3-flash",
        "name": "Gemini 3 Flash",
        "context_window": 1000000,
        "max_output_tokens": 65000,
        "supports_image": true
      },
      {
        "id": "google/gemini-3.1-flash-lite",
        "name": "Gemini 3.1 Flash Lite",
        "context_window": 1000000,
        "max_output_tokens": 65000,
        "supports_image": true
      },
      {
        "id": "google/gemini-3.1-pro-preview",
        "name": "Gemini 3.1 Pro Preview",
        "context_window": 1000000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "google/gemini-3.5-flash",
        "name": "Gemini 3.5 Flash",
        "context_window": 1000000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "google/gemini-3.5-flash-lite",
        "name": "Gemini 3.5 Flash Lite",
        "context_window": 1000000,
        "max_output_tokens": 65000,
        "supports_image": true
      },
      {
        "id": "google/gemini-3.6-flash",
        "name": "Gemini 3.6 Flash",
        "context_window": 1000000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "google/gemini-3.7-flash",
        "name": "Gemini 3.7 Flash",
        "context_window": 1000000,
        "max_output_tokens": 65535,
        "supports_image": true
      },
      {
        "id": "google/gemini-3.8-flash",
        "name": "Gemini 3.8 Flash",
        "context_window": 1000000,
        "max_output_tokens": 65535,
        "supports_image": true
      },
      {
        "id": "google/gemini-4-argon",
        "name": "Gemini 4 Argon",
        "context_window": 1000000,
        "max_output_tokens": 1000000,
        "supports_image": true
      },
      {
        "id": "google/gemma-4-26b-a4b-it",
        "name": "Google Gemma 4 26B A4B",
        "context_window": 262144,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "google/gemma-4-31b-it",
        "name": "Gemma 4 31B IT",
        "context_window": 262144,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "humansand/ampersand-v0.1",
        "name": "Ampersand v0.1",
        "context_window": 1000000,
        "max_output_tokens": 32768
      },
      {
        "id": "inception/mercury-2",
        "name": "Mercury 2",
        "context_window": 128000,
        "max_output_tokens": 128000
      },
      {
        "id": "inception/mercury-2.5",
        "name": "Mercury 2.5",
        "context_window": 260000,
        "max_output_tokens": 65536
      },
      {
        "id": "inception/mercury-3",
        "name": "Mercury 3",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "inception/mercury-coder-small",
        "name": "Mercury Coder Small Beta",
        "context_window": 32000,
        "max_output_tokens": 16384
      },
      {
        "id": "inclusionai/ling-3.0-flash",
        "name": "Ling 3.0 Flash",
        "context_window": 256000,
        "max_output_tokens": 32000
      },
      {
        "id": "inclusionai/ling-3.0-flash-fin",
        "name": "Ling 3.0 Flash Fin",
        "context_window": 256000,
        "max_output_tokens": 32000
      },
      {
        "id": "inclusionai/ling-3.0-flash-sante",
        "name": "Ling 3.0 Flash Sante",
        "context_window": 256000,
        "max_output_tokens": 32000
      },
      {
        "id": "inclusionai/ling-3.0-flash-vl",
        "name": "Ling 3.0 Flash VL",
        "context_window": 256000,
        "max_output_tokens": 32000,
        "supports_image": true
      },
      {
        "id": "inclusionai/ling-3.1-flash",
        "name": "Ling 3.1 Flash",
        "context_window": 262144,
        "max_output_tokens": 32768
      },
      {
        "id": "inclusionai/ling-3.1-flash-1019",
        "name": "Ling 3.1 Flash 1019",
        "context_window": 1000000,
        "max_output_tokens": 262144
      },
      {
        "id": "interfaze/interfaze-beta",
        "name": "Interfaze Beta",
        "context_window": 1000000,
        "max_output_tokens": 32000,
        "supports_image": true
      },
      {
        "id": "liquid/lfm2.5-24b-a2b",
        "name": "LFM2.5-24B-A2B",
        "context_window": 128000,
        "max_output_tokens": 8200
      },
      {
        "id": "meituan/longcat-2.5",
        "name": "LongCat 2.5",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "meta/llama-3.1-70b",
        "name": "Llama 3.1 70B Instruct",
        "context_window": 128000,
        "max_output_tokens": 8192
      },
      {
        "id": "meta/llama-3.1-8b",
        "name": "Llama 3.1 8B Instruct",
        "context_window": 128000,
        "max_output_tokens": 8192
      },
      {
        "id": "meta/llama-3.3-70b",
        "name": "Llama 3.3 70B Instruct",
        "context_window": 128000,
        "max_output_tokens": 8192
      },
      {
        "id": "meta/llama-4-maverick",
        "name": "Llama 4 Maverick 17B Instruct",
        "context_window": 128000,
        "max_output_tokens": 8192,
        "supports_image": true
      },
      {
        "id": "meta/llama-4-scout",
        "name": "Llama 4 Scout 17B Instruct",
        "context_window": 128000,
        "max_output_tokens": 8192,
        "supports_image": true
      },
      {
        "id": "meta/muse-ember",
        "name": "Muse Ember",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "meta/muse-glimmer-30b",
        "name": "Muse Glimmer 30B",
        "context_window": 131072,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "meta/muse-spark-1.1",
        "name": "Muse Spark 1.1",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "meta/muse-spark-1.2",
        "name": "Muse Spark 1.2",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "meta/muse-spark-1.2-contributor",
        "name": "Muse Spark 1.2 Contributor",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "meta/muse-spark-1.3",
        "name": "Muse Spark 1.3",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "meta/muse-spark-1.3-contributor",
        "name": "Muse Spark 1.3 Contributor",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "meta/muse-spark-open",
        "name": "Muse Spark Open",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "meta/muse-wonder-1.0",
        "name": "Muse Wonder",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "minimax/minimax-m2",
        "name": "MiniMax M2",
        "context_window": 205000,
        "max_output_tokens": 205000
      },
      {
        "id": "minimax/minimax-m2.1",
        "name": "MiniMax M2.1",
        "context_window": 204800,
        "max_output_tokens": 131072
      },
      {
        "id": "minimax/minimax-m2.1-lightning",
        "name": "MiniMax M2.1 Lightning",
        "context_window": 204800,
        "max_output_tokens": 131072
      },
      {
        "id": "minimax/minimax-m2.5",
        "name": "MiniMax M2.5",
        "context_window": 204800,
        "max_output_tokens": 131000
      },
      {
        "id": "minimax/minimax-m2.5-highspeed",
        "name": "MiniMax M2.5 High Speed",
        "context_window": 204800,
        "max_output_tokens": 131000
      },
      {
        "id": "minimax/minimax-m2.7",
        "name": "MiniMax M2.7",
        "context_window": 204800,
        "max_output_tokens": 131000
      },
      {
        "id": "minimax/minimax-m2.7-highspeed",
        "name": "MiniMax M2.7 High Speed",
        "context_window": 204800,
        "max_output_tokens": 131100
      },
      {
        "id": "minimax/minimax-m3",
        "name": "MiniMax M3",
        "context_window": 512000,
        "max_output_tokens": 512000,
        "supports_image": true
      },
      {
        "id": "minimax/minimax-m3.1-flash",
        "name": "MiniMax-M3.1-Flash",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "mistral/codestral",
        "name": "Mistral Codestral",
        "context_window": 128000,
        "max_output_tokens": 4000
      },
      {
        "id": "mistral/ministral-14b",
        "name": "Ministral 14B",
        "context_window": 262144,
        "max_output_tokens": 256000,
        "supports_image": true
      },
      {
        "id": "mistral/ministral-3b",
        "name": "Ministral 3B",
        "context_window": 131072,
        "max_output_tokens": 4000,
        "supports_image": true
      },
      {
        "id": "mistral/ministral-8b",
        "name": "Ministral 8B",
        "context_window": 262144,
        "max_output_tokens": 4000,
        "supports_image": true
      },
      {
        "id": "mistral/mistral-large-3",
        "name": "Mistral Large 3",
        "context_window": 262144,
        "max_output_tokens": 256000,
        "supports_image": true
      },
      {
        "id": "mistral/mistral-large-4",
        "name": "Mistral Large 4",
        "context_window": 1048576,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "mistral/mistral-medium-3.5",
        "name": "Mistral Medium Latest",
        "context_window": 262144,
        "max_output_tokens": 256000,
        "supports_image": true
      },
      {
        "id": "mistral/mistral-nemo",
        "name": "Mistral Nemo 12B",
        "context_window": 131072,
        "max_output_tokens": 131072
      },
      {
        "id": "mistral/mistral-small",
        "name": "Mistral Small",
        "context_window": 262144,
        "max_output_tokens": 4000,
        "supports_image": true
      },
      {
        "id": "mixedbread/toast-1",
        "name": "Toast 1",
        "context_window": 131000,
        "max_output_tokens": 4000
      },
      {
        "id": "moonshotai/kimi-k2",
        "name": "Kimi K2 Instruct",
        "context_window": 131072,
        "max_output_tokens": 131072
      },
      {
        "id": "moonshotai/kimi-k2.5",
        "name": "Kimi K2.5",
        "context_window": 256000,
        "max_output_tokens": 256000,
        "supports_image": true
      },
      {
        "id": "moonshotai/kimi-k2.6",
        "name": "Kimi K2.6",
        "context_window": 262000,
        "max_output_tokens": 262000,
        "supports_image": true
      },
      {
        "id": "moonshotai/kimi-k2.7-code",
        "name": "Kimi K2.7 Code",
        "context_window": 256000,
        "max_output_tokens": 32768,
        "supports_image": true
      },
      {
        "id": "moonshotai/kimi-k2.7-code-highspeed",
        "name": "Kimi K2.7 Code High Speed",
        "context_window": 262144,
        "max_output_tokens": 32768,
        "supports_image": true
      },
      {
        "id": "moonshotai/kimi-k3",
        "name": "Kimi K3",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "moonshotai/kimi-k3.1-pro",
        "name": "Kimi K3.1 Pro",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "moonshotai/kimi-k3.1-pro-highspeed",
        "name": "Kimi K3.1 Pro Highspeed",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "nvidia/nemotron-3-nano-30b-a3b",
        "name": "Nemotron 3 Nano 30B A3B",
        "context_window": 262144,
        "max_output_tokens": 262144
      },
      {
        "id": "nvidia/nemotron-3-super-120b-a12b",
        "name": "NVIDIA Nemotron 3 Super 120B A12B",
        "context_window": 256000,
        "max_output_tokens": 32000
      },
      {
        "id": "nvidia/nemotron-3-ultra-550b-a55b",
        "name": "Nemotron 3 Ultra",
        "context_window": 1000000,
        "max_output_tokens": 65000
      },
      {
        "id": "nvidia/nemotron-3.5-lightning",
        "name": "Nemotron 3.5 Lightning 30B",
        "context_window": 262144,
        "max_output_tokens": 131072
      },
      {
        "id": "nvidia/nemotron-3.5-lightning-free",
        "name": "Nemotron 3.5 Lightning Free",
        "context_window": 1000000,
        "max_output_tokens": 65000
      },
      {
        "id": "nvidia/nemotron-3.5-super-vl",
        "name": "NVIDIA Nemotron 3.5 Super VL",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "nvidia/nemotron-nano-12b-v2-vl",
        "name": "Nvidia Nemotron Nano 12B V2 VL",
        "context_window": 131072,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "nvidia/nemotron-nano-9b-v2",
        "name": "Nvidia Nemotron Nano 9B V2",
        "context_window": 131072,
        "max_output_tokens": 131072
      },
      {
        "id": "openai/gpt-4.1",
        "name": "GPT-4.1",
        "context_window": 1047576,
        "max_output_tokens": 32768,
        "supports_image": true
      },
      {
        "id": "openai/gpt-4.1-mini",
        "name": "GPT-4.1 mini",
        "context_window": 1047576,
        "max_output_tokens": 32768,
        "supports_image": true
      },
      {
        "id": "openai/gpt-4.1-nano",
        "name": "GPT-4.1 nano",
        "context_window": 1047576,
        "max_output_tokens": 32768,
        "supports_image": true
      },
      {
        "id": "openai/gpt-4o",
        "name": "GPT-4o",
        "context_window": 128000,
        "max_output_tokens": 16384,
        "supports_image": true
      },
      {
        "id": "openai/gpt-4o-mini",
        "name": "GPT-4o mini",
        "context_window": 128000,
        "max_output_tokens": 16384,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5",
        "name": "GPT-5",
        "context_window": 400000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5-codex",
        "name": "GPT-5-Codex",
        "context_window": 400000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5-mini",
        "name": "GPT-5 mini",
        "context_window": 400000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5-nano",
        "name": "GPT-5 nano",
        "context_window": 400000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5-pro",
        "name": "GPT-5 pro",
        "context_window": 400000,
        "max_output_tokens": 272000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.1-codex",
        "name": "GPT-5.1-Codex",
        "context_window": 400000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.1-codex-max",
        "name": "GPT 5.1 Codex Max",
        "context_window": 400000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.1-codex-mini",
        "name": "GPT 5.1 Codex Mini",
        "context_window": 400000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.1-thinking",
        "name": "GPT 5.1 Thinking",
        "context_window": 400000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.2",
        "name": "GPT 5.2",
        "context_window": 400000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.2-codex",
        "name": "GPT 5.2 Codex",
        "context_window": 400000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.2-pro",
        "name": "GPT 5.2 ",
        "context_window": 400000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.3-codex",
        "name": "GPT 5.3 Codex",
        "context_window": 400000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.4",
        "name": "GPT 5.4",
        "context_window": 1050000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.4-mini",
        "name": "GPT 5.4 Mini",
        "context_window": 400000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.4-nano",
        "name": "GPT 5.4 Nano",
        "context_window": 400000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.4-pro",
        "name": "GPT 5.4 Pro",
        "context_window": 1050000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.5",
        "name": "GPT 5.5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.5-pro",
        "name": "GPT 5.5 Pro",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.6-luna",
        "name": "GPT 5.6 Luna",
        "context_window": 1050000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.6-sol",
        "name": "GPT 5.6 Sol",
        "context_window": 1050000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-5.6-terra",
        "name": "GPT 5.6 Terra",
        "context_window": 1050000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-6-astra",
        "name": "GPT-6 Astra",
        "context_window": 1050000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-6-luna",
        "name": "GPT-6 Luna",
        "context_window": 1050000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-6-sol",
        "name": "GPT-6 Sol",
        "context_window": 1050000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-6.1-sol",
        "name": "GPT-6.1 Sol",
        "context_window": 1050000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-6.1-terra",
        "name": "GPT-6.1 Terra",
        "context_window": 1050000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "openai/gpt-oss-120b",
        "name": "GPT OSS 120B",
        "context_window": 131072,
        "max_output_tokens": 131072
      },
      {
        "id": "openai/gpt-oss-20b",
        "name": "GPT OSS 20B",
        "context_window": 131072,
        "max_output_tokens": 8192
      },
      {
        "id": "openai/gpt-oss-safeguard-120b",
        "name": "GPT OSS Safeguard 120B",
        "context_window": 128000,
        "max_output_tokens": 16000
      },
      {
        "id": "openai/gpt-oss-safeguard-20b",
        "name": "GPT OSS Safeguard 20B",
        "context_window": 128000,
        "max_output_tokens": 16000
      },
      {
        "id": "openai/o1",
        "name": "o1",
        "context_window": 200000,
        "max_output_tokens": 100000,
        "supports_image": true
      },
      {
        "id": "openai/o3",
        "name": "o3",
        "context_window": 200000,
        "max_output_tokens": 100000,
        "supports_image": true
      },
      {
        "id": "openai/o3-mini",
        "name": "o3-mini",
        "context_window": 200000,
        "max_output_tokens": 100000
      },
      {
        "id": "openai/o3-pro",
        "name": "o3 Pro",
        "context_window": 200000,
        "max_output_tokens": 100000,
        "supports_image": true
      },
      {
        "id": "openai/o4-mini",
        "name": "o4-mini",
        "context_window": 200000,
        "max_output_tokens": 100000,
        "supports_image": true
      },
      {
        "id": "particle/particle-1",
        "name": "Particle-1",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "poolside/laguna-s-2.1",
        "name": "Laguna S 2.1",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "quiverai/arrow-2",
        "name": "Arrow 2",
        "context_window": 131072,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "quiverai/arrow-2-telos",
        "name": "Arrow 2 Telos",
        "context_window": 131072,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "reflection/beam",
        "name": "Beam 1.0",
        "context_window": 1048576,
        "max_output_tokens": 131072
      },
      {
        "id": "reflection/beam-free",
        "name": "Beam 1.0 (Free)",
        "context_window": 1048576,
        "max_output_tokens": 131072
      },
      {
        "id": "sakana/fugu-max",
        "name": "Fugu Max",
        "context_window": 1000000,
        "max_output_tokens": 1000000,
        "supports_image": true
      },
      {
        "id": "sakana/fugu-ultra",
        "name": "Fugu Ultra",
        "context_window": 1000000,
        "max_output_tokens": 1000000,
        "supports_image": true
      },
      {
        "id": "sakana/fugu-ultra-v2",
        "name": "Fugu Ultra v2",
        "context_window": 1000000,
        "max_output_tokens": 1000000,
        "supports_image": true
      },
      {
        "id": "sakana/namazu",
        "name": "Sakana Namazu",
        "context_window": 256000,
        "max_output_tokens": 256000,
        "supports_image": true
      },
      {
        "id": "spacexai/grok-4.20-multi-agent",
        "name": "Grok 4.20 Multi-Agent",
        "context_window": 2000000,
        "max_output_tokens": 2000000,
        "supports_image": true
      },
      {
        "id": "spacexai/grok-4.20-multi-agent-beta",
        "name": "Grok 4.20 Multi Agent Beta",
        "context_window": 2000000,
        "max_output_tokens": 2000000,
        "supports_image": true
      },
      {
        "id": "spacexai/grok-4.20-non-reasoning",
        "name": "Grok 4.20 Non-Reasoning",
        "context_window": 2000000,
        "max_output_tokens": 2000000,
        "supports_image": true
      },
      {
        "id": "spacexai/grok-4.20-non-reasoning-beta",
        "name": "Grok 4.20 Beta Non-Reasoning",
        "context_window": 2000000,
        "max_output_tokens": 2000000,
        "supports_image": true
      },
      {
        "id": "spacexai/grok-4.20-reasoning",
        "name": "Grok 4.20 Reasoning",
        "context_window": 2000000,
        "max_output_tokens": 2000000,
        "supports_image": true
      },
      {
        "id": "spacexai/grok-4.20-reasoning-beta",
        "name": "Grok 4.20 Beta Reasoning",
        "context_window": 2000000,
        "max_output_tokens": 2000000,
        "supports_image": true
      },
      {
        "id": "spacexai/grok-4.3",
        "name": "Grok 4.3",
        "context_window": 1000000,
        "max_output_tokens": 1000000,
        "supports_image": true
      },
      {
        "id": "spacexai/grok-4.5",
        "name": "Grok 4.5",
        "context_window": 500000,
        "max_output_tokens": 500000,
        "supports_image": true
      },
      {
        "id": "spacexai/grok-4.6",
        "name": "Grok 4.6",
        "context_window": 500000,
        "max_output_tokens": 500000,
        "supports_image": true
      },
      {
        "id": "spacexai/grok-4.7",
        "name": "Grok 4.7",
        "context_window": 500000,
        "max_output_tokens": 500000,
        "supports_image": true
      },
      {
        "id": "spacexai/grok-build-0.1",
        "name": "Grok Build 0.1",
        "context_window": 256000,
        "max_output_tokens": 256000,
        "supports_image": true
      },
      {
        "id": "spacexai/grok-voice-3.0",
        "name": "Grok Voice 3.0",
        "context_window": 4096,
        "max_output_tokens": 4096
      },
      {
        "id": "stealth/glyph-cluster",
        "name": "Glyph Cluster",
        "context_window": 256000,
        "max_output_tokens": 256000
      },
      {
        "id": "stepfun/step-3.7-flash",
        "name": "Step 3.7 Flash",
        "context_window": 256000,
        "max_output_tokens": 256000,
        "supports_image": true
      },
      {
        "id": "stepfun/step-5-preview",
        "name": "Step 5 Preview",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "tencent/hy3",
        "name": "Tencent Hy3",
        "context_window": 262144,
        "max_output_tokens": 262144
      },
      {
        "id": "tencent/hy4",
        "name": "Tencent Hy4",
        "context_window": 1024000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "tencent/hy4-preview",
        "name": "Tencent Hy4 Preview",
        "context_window": 1024000,
        "max_output_tokens": 64000
      },
      {
        "id": "thinkingmachines/inkling",
        "name": "Inkling",
        "context_window": 256000,
        "max_output_tokens": 256000,
        "supports_image": true
      },
      {
        "id": "thinkingmachines/inkling-small",
        "name": "Inkling Small",
        "context_window": 1000000,
        "max_output_tokens": 1000000,
        "supports_image": true
      },
      {
        "id": "xiaomi/mimo-v2.6-flash",
        "name": "MiMo V2.6 Flash",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "xiaomi/mimo-v2.6-pro",
        "name": "MiMo V2.6 Pro",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "xiaomi/mimo-v2.6-pro-ultraspeed",
        "name": "MiMo V2.6 Pro UltraSpeed",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "zai/glm-4.5",
        "name": "GLM 4.5",
        "context_window": 128000,
        "max_output_tokens": 96000
      },
      {
        "id": "zai/glm-4.5-air",
        "name": "GLM 4.5 Air",
        "context_window": 128000,
        "max_output_tokens": 96000
      },
      {
        "id": "zai/glm-4.5v",
        "name": "GLM 4.5V",
        "context_window": 66000,
        "max_output_tokens": 16000,
        "supports_image": true
      },
      {
        "id": "zai/glm-4.6",
        "name": "GLM 4.6",
        "context_window": 200000,
        "max_output_tokens": 96000
      },
      {
        "id": "zai/glm-4.7",
        "name": "GLM 4.7",
        "context_window": 200000,
        "max_output_tokens": 120000
      },
      {
        "id": "zai/glm-4.7-flash",
        "name": "GLM 4.7 Flash",
        "context_window": 200000,
        "max_output_tokens": 131000
      },
      {
        "id": "zai/glm-4.7-flashx",
        "name": "GLM 4.7 FlashX",
        "context_window": 200000,
        "max_output_tokens": 128000
      },
      {
        "id": "zai/glm-5",
        "name": "GLM 5",
        "context_window": 202800,
        "max_output_tokens": 131100
      },
      {
        "id": "zai/glm-5-turbo",
        "name": "GLM 5 Turbo",
        "context_window": 202800,
        "max_output_tokens": 131100
      },
      {
        "id": "zai/glm-5.1",
        "name": "GLM 5.1",
        "context_window": 202800,
        "max_output_tokens": 64000
      },
      {
        "id": "zai/glm-5.2",
        "name": "GLM 5.2",
        "context_window": 1000000,
        "max_output_tokens": 128000
      },
      {
        "id": "zai/glm-5.3",
        "name": "GLM 5.3",
        "context_window": 1000000,
        "max_output_tokens": 1000000
      },
      {
        "id": "zai/glm-5.3-flash",
        "name": "GLM 5.3 Flash",
        "context_window": 1000000,
        "max_output_tokens": 131000,
        "supports_image": true
      },
      {
        "id": "zai/glm-5.3-flashx",
        "name": "GLM 5.3 FlashX",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "zai/glm-5.3-flashx-legal",
        "name": "GLM 5.3 FlashX Legal",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "zai/glm-5v-turbo",
        "name": "GLM 5V Turbo",
        "context_window": 200000,
        "max_output_tokens": 128000,
        "supports_image": true
      }
    ]
  },
  {
    "id": "xiaomi",
    "name": "Xiaomi",
    "baseUrl": "https://api.xiaomimimo.com/anthropic",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "mimo-v2.6-flash",
        "name": "MiMo-V2.6-Flash",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "mimo-v2.6-pro",
        "name": "MiMo-V2.6-Pro",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "mimo-v2.6-pro-ultraspeed",
        "name": "MiMo-V2.6-Pro-UltraSpeed",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      }
    ]
  },
  {
    "id": "xiaomi-token-plan-ams",
    "name": "Xiaomi Token Plan AMS",
    "baseUrl": "https://token-plan-ams.xiaomimimo.com/anthropic",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "mimo-v2.6-flash",
        "name": "MiMo-V2.6-Flash",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "mimo-v2.6-pro",
        "name": "MiMo-V2.6-Pro",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      }
    ]
  },
  {
    "id": "xiaomi-token-plan-cn",
    "name": "Xiaomi Token Plan CN",
    "baseUrl": "https://token-plan-cn.xiaomimimo.com/anthropic",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "mimo-v2.6-flash",
        "name": "MiMo-V2.6-Flash",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "mimo-v2.6-pro",
        "name": "MiMo-V2.6-Pro",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      }
    ]
  },
  {
    "id": "xiaomi-token-plan-sgp",
    "name": "Xiaomi Token Plan SGP",
    "baseUrl": "https://token-plan-sgp.xiaomimimo.com/anthropic",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "mimo-v2.6-flash",
        "name": "MiMo-V2.6-Flash",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "mimo-v2.6-pro",
        "name": "MiMo-V2.6-Pro",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      }
    ]
  },
  {
    "id": "zai",
    "name": "Z.AI",
    "baseUrl": "https://api.z.ai/api/anthropic",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "glm-4.7",
        "name": "GLM-4.7",
        "context_window": 204800,
        "max_output_tokens": 131072
      },
      {
        "id": "glm-5-turbo",
        "name": "GLM-5-Turbo",
        "context_window": 200000,
        "max_output_tokens": 131072
      },
      {
        "id": "glm-5.2",
        "name": "GLM-5.2",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "glm-5.2-highspeed",
        "name": "GLM-5.2 Highspeed",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "glm-5.3-flash",
        "name": "GLM-5.3-Flash",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "glm-5.3-highspeed",
        "name": "GLM-5.3 Highspeed",
        "context_window": 1000000,
        "max_output_tokens": 131072
      }
    ]
  },
  {
    "id": "zai-coding-cn",
    "name": "Z.AI Coding CN",
    "baseUrl": "https://open.bigmodel.cn/api/anthropic",
    "auth": "bearer",
    "note": "该端点用 Bearer 认证（Authorization: Bearer）：认证方式已按它选好，填密钥即可。",
    "models": [
      {
        "id": "glm-4.6v",
        "name": "GLM-4.6V",
        "context_window": 128000,
        "max_output_tokens": 32768,
        "supports_image": true
      },
      {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "context_window": 1000000,
        "max_output_tokens": 131072
      },
      {
        "id": "glm-5.3-flash",
        "name": "GLM-5.3-Flash",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "glm-5.3-highspeed",
        "name": "GLM-5.3 Highspeed",
        "context_window": 1000000,
        "max_output_tokens": 131072
      }
    ]
  }
]

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/** 生成不与现有提供商冲突的 ID：重复时依次追加 -2、-3。 */
export function uniqueProviderId(base: string, existing: string[]): string {
  const want = base.trim();
  if (!want) return "";
  const taken = new Set(existing.map((x) => x.trim()));
  if (!taken.has(want)) return want;
  let n = 2;
  while (taken.has(`${want}-${n}`)) n += 1;
  return `${want}-${n}`;
}

/** 预置模型 → 表单里的 models / modelMeta。 */
export function presetModels(preset: ProviderPreset): { models: string[]; modelMeta: Record<string, ModelSpec> } {
  const models: string[] = [];
  const modelMeta: Record<string, ModelSpec> = {};
  for (const m of preset.models) {
    const id = m.id.trim();
    if (!id || modelMeta[id]) continue;
    models.push(id);
    modelMeta[id] = {
      name: m.name?.trim() || undefined,
      reasoning_efforts: [],
      supports_image: Boolean(m.supports_image),
      context_window: m.context_window,
      max_output_tokens: m.max_output_tokens,
    };
  }
  return { models, modelMeta };
}

/** 选中预置后要写回 ProviderForm 的字段。 */
/**
 * 选中预置后要写回 ProviderForm 的字段。
 *
 * **不含模型**：预置只填身份与端点，模型留到「获取可用模型」时在弹窗里勾选
 * （DSH 的模型页也是这个顺序）。以前这里把整份目录直接灌进表单，于是用户
 * 一选预置，几十条模型——包括这家端点未必开通的那些——就已经算配置好了，
 * 想清点只能逐条删。
 */
export function presetFormFields(
  preset: ProviderPreset,
  existingIds: string[],
): {
  id: string;
  name: string;
  baseUrl: string;
  auth: AuthMethod;
} {
  return {
    id: uniqueProviderId(preset.id, existingIds),
    name: preset.name,
    baseUrl: preset.baseUrl,
    // 每家端点认哪个头是固定的（Bearer 的分组在 auth 字段里）；没标的按
    // x-api-key，也就是官方 Anthropic 端点的行为。
    auth: preset.auth === "bearer" ? "bearer" : "x-api-key",
  };
}
