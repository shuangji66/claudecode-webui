// 预置第三方模型提供商（源自 DSH 的 pi-ai provider catalog）。
//
// 数据来源：DSH 0.2.2 的 @earendil-works/pi-ai 内置 provider / model 目录。
// 这里只保留「添加提供商」时需要预填的字段：id、显示名、Base URL、
// 默认模型及其上下文/输出/图片能力。
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

import type { ModelSpec } from "../transport/types";

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
  /** 该端点使用 Authorization: Bearer，密钥应填到「高级设置 → Bearer 令牌」。 */
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
        "id": "claude-opus-4-5",
        "name": "Claude Opus 4.5 (latest)",
        "context_window": 200000,
        "max_output_tokens": 64000,
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
        "id": "claude-haiku-4-5",
        "name": "Claude Haiku 4.5 (latest)",
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
        "id": "claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "claude-fable-5",
        "name": "Claude Fable 5",
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
      }
    ]
  },
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "baseUrl": "https://api.deepseek.com/anthropic",
    "auth": "bearer",
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
    "models": [
      {
        "id": "deepseek-flash",
        "name": "DeepSeek-V4.1-Flash",
        "context_window": 1000000,
        "max_output_tokens": 384000,
        "supports_image": true
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek-V4-Pro",
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
      }
    ]
  },
  {
    "id": "github-copilot",
    "name": "GitHub Copilot",
    "baseUrl": "https://api.individual.githubcopilot.com",
    "auth": "bearer",
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
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
      }
    ]
  },
  {
    "id": "minimax",
    "name": "MiniMax",
    "baseUrl": "https://api.minimax.io/anthropic",
    "auth": "bearer",
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
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
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
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
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
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
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
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
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
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
      }
    ]
  },
  {
    "id": "qwen-token-plan",
    "name": "Qwen Token Plan",
    "baseUrl": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    "auth": "bearer",
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
    "models": [
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
        "id": "qwen3.6-flash",
        "name": "Qwen3.6 Flash",
        "context_window": 1000000,
        "max_output_tokens": 65536,
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
        "id": "qwen3.8-flash",
        "name": "Qwen3.8 Flash",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "deepseek-v4.1-flash",
        "name": "DeepSeek V4.1 Flash",
        "context_window": 1000000,
        "max_output_tokens": 384000,
        "supports_image": true
      }
    ]
  },
  {
    "id": "qwen-token-plan-cn",
    "name": "Qwen Token Plan CN",
    "baseUrl": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    "auth": "bearer",
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
    "models": [
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
        "id": "qwen3.6-flash",
        "name": "Qwen3.6 Flash",
        "context_window": 1000000,
        "max_output_tokens": 65536,
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
        "id": "qwen3.8-flash",
        "name": "Qwen3.8 Flash",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "deepseek-v4.1-flash",
        "name": "DeepSeek V4.1 Flash",
        "context_window": 1000000,
        "max_output_tokens": 384000,
        "supports_image": true
      }
    ]
  },
  {
    "id": "qwen-token-plan-individual",
    "name": "Qwen Token Plan Individual",
    "baseUrl": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    "auth": "bearer",
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
    "models": [
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
        "id": "qwen3.6-flash",
        "name": "Qwen3.6 Flash",
        "context_window": 1000000,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "context_window": 1000000,
        "max_output_tokens": 131072
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
    "id": "qwen-token-plan-individual-cn",
    "name": "Qwen Token Plan Individual CN",
    "baseUrl": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    "auth": "bearer",
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
    "models": [
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
        "id": "qwen3.6-flash",
        "name": "Qwen3.6 Flash",
        "context_window": 1000000,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "glm-5.3",
        "name": "GLM-5.3",
        "context_window": 1000000,
        "max_output_tokens": 131072
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
    "id": "vercel-ai-gateway",
    "name": "Vercel AI Gateway",
    "baseUrl": "https://ai-gateway.vercel.sh",
    "auth": "bearer",
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
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
      }
    ]
  },
  {
    "id": "xiaomi",
    "name": "Xiaomi",
    "baseUrl": "https://api.xiaomimimo.com/anthropic",
    "auth": "bearer",
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
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
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
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
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
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
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
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
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
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
      }
    ]
  },
  {
    "id": "zai-coding-cn",
    "name": "Z.AI Coding CN",
    "baseUrl": "https://open.bigmodel.cn/api/anthropic",
    "auth": "bearer",
    "note": "该端点使用 Bearer 认证：密钥填到「高级设置 → Bearer 令牌」。",
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
export function presetFormFields(
  preset: ProviderPreset,
  existingIds: string[],
): {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  modelMeta: Record<string, ModelSpec>;
} {
  return {
    id: uniqueProviderId(preset.id, existingIds),
    name: preset.name,
    baseUrl: preset.baseUrl,
    ...presetModels(preset),
  };
}
