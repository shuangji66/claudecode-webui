// 预置第三方模型提供商（对齐 DSH 的 pi-ai provider catalog）。
//
// 数据来源：DSH 0.2.2 的 @earendil-works/pi-ai 内置 provider / model 目录。
// 这里只保留「添加提供商」时需要预填的字段：id、显示名、协议、Base URL、
// 默认模型及其上下文/输出/图片能力。
//
// 关键约束：本项目对话走 claude CLI，只支持 Anthropic Messages。标注
// chatCompatible=false 的预置表示其原生 API 不是 Anthropic Messages，仍可用于
// 拉取模型列表，但对话需要该服务另外提供 Anthropic 兼容端点（或改用中转）。
// 对已知的 Anthropic 兼容端点（DeepSeek / Z.AI / Kimi / Qwen / MiniMax / 小米等）
// 已直接填成对应的 /anthropic 地址。

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
  protocol: string;
  baseUrl: string;
  /** 该预置是否可直接用于 claude 对话（Anthropic Messages 兼容）。 */
  chatCompatible: boolean;
  /** Base URL 需要用户补全（账号 / 区域 / 网关路径）。 */
  needsBaseUrl?: boolean;
  /** 该端点使用 Authorization: Bearer，密钥应填到「高级设置 → Bearer 令牌」。 */
  auth?: "bearer";
  note?: string;
  models: ProviderPresetModel[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    "id": "amazon-bedrock",
    "name": "Amazon Bedrock",
    "protocol": "anthropic-messages",
    "baseUrl": "",
    "chatCompatible": false,
    "needsBaseUrl": true,
    "note": "原生 API 为 bedrock-converse-stream；请填写完整 Base URL，且 claude 对话需要 Anthropic 兼容端点。",
    "models": [
      {
        "id": "amazon.nova-2-lite-v1:0",
        "name": "Nova 2 Lite",
        "context_window": 1000000,
        "max_output_tokens": 65535,
        "supports_image": true
      },
      {
        "id": "amazon.nova-lite-v1:0",
        "name": "Nova Lite",
        "context_window": 300000,
        "max_output_tokens": 10000,
        "supports_image": true
      },
      {
        "id": "amazon.nova-micro-v1:0",
        "name": "Nova Micro",
        "context_window": 128000,
        "max_output_tokens": 10000
      },
      {
        "id": "amazon.nova-pro-v1:0",
        "name": "Nova Pro",
        "context_window": 300000,
        "max_output_tokens": 10000,
        "supports_image": true
      },
      {
        "id": "anthropic.claude-fable-5",
        "name": "Claude Fable 5",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "anthropic.claude-fable-5-1",
        "name": "Claude Fable 5.1",
        "context_window": 1000000,
        "max_output_tokens": 128000,
        "supports_image": true
      }
    ]
  },
  {
    "id": "ant-ling",
    "name": "Ant Ling",
    "protocol": "openai-completions",
    "baseUrl": "https://api.ant-ling.com/v1",
    "chatCompatible": false,
    "note": "原生 API 为 openai-completions；claude 对话需要该服务提供 Anthropic 兼容端点。",
    "models": [
      {
        "id": "Ling-2.6-1T",
        "name": "Ling 2.6 1T",
        "context_window": 262144,
        "max_output_tokens": 65536
      },
      {
        "id": "Ling-2.6-flash",
        "name": "Ling 2.6 Flash",
        "context_window": 262144,
        "max_output_tokens": 65536
      },
      {
        "id": "Ring-2.6-1T",
        "name": "Ring 2.6 1T",
        "context_window": 262144,
        "max_output_tokens": 65536
      }
    ]
  },
  {
    "id": "anthropic",
    "name": "Anthropic",
    "protocol": "anthropic-messages",
    "baseUrl": "https://api.anthropic.com",
    "chatCompatible": true,
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
    "id": "azure",
    "name": "Azure",
    "protocol": "openai-responses",
    "baseUrl": "",
    "chatCompatible": false,
    "needsBaseUrl": true,
    "note": "原生 API 为 azure-openai-responses；请填写完整 Base URL，且 claude 对话需要 Anthropic 兼容端点。",
    "models": [
      {
        "id": "chat-latest",
        "name": "Chat Latest",
        "context_window": 400000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "gpt-4",
        "name": "GPT-4",
        "context_window": 8192,
        "max_output_tokens": 8192
      },
      {
        "id": "gpt-4-turbo",
        "name": "GPT-4 Turbo",
        "context_window": 128000,
        "max_output_tokens": 4096,
        "supports_image": true
      },
      {
        "id": "gpt-4.1",
        "name": "GPT-4.1",
        "context_window": 1047576,
        "max_output_tokens": 32768,
        "supports_image": true
      },
      {
        "id": "gpt-4.1-mini",
        "name": "GPT-4.1 mini",
        "context_window": 1047576,
        "max_output_tokens": 32768,
        "supports_image": true
      },
      {
        "id": "gpt-4.1-nano",
        "name": "GPT-4.1 nano",
        "context_window": 1047576,
        "max_output_tokens": 32768,
        "supports_image": true
      }
    ]
  },
  {
    "id": "baseten",
    "name": "Baseten",
    "protocol": "openai-completions",
    "baseUrl": "https://inference.baseten.co/v1",
    "chatCompatible": false,
    "note": "原生 API 为 openai-completions；claude 对话需要该服务提供 Anthropic 兼容端点。",
    "models": [
      {
        "id": "deepseek-ai/DeepSeek-V4-Flash-0731",
        "name": "DeepSeek V4 Flash 0731",
        "context_window": 1048576,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Pro-0813",
        "name": "DeepSeek V4 Pro 0813",
        "context_window": 1048576,
        "max_output_tokens": 262144
      },
      {
        "id": "deepseek-ai/DeepSeek-V4.1-Flash",
        "name": "DeepSeek V4.1 Flash",
        "context_window": 1048576,
        "max_output_tokens": 32768,
        "supports_image": true
      },
      {
        "id": "deepseek-ai/DeepSeek-V4.1-Flash-1017",
        "name": "DeepSeek V4.1 Flash 1017",
        "context_window": 1048576,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast",
        "name": "DeepSeek V4.1 Flash 1017 Fast",
        "context_window": 1048576,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "deepseek-ai/DeepSeek-V4.1-Flash-Fast",
        "name": "DeepSeek V4.1 Flash Fast",
        "context_window": 1048576,
        "max_output_tokens": 32768,
        "supports_image": true
      }
    ]
  },
  {
    "id": "cerebras",
    "name": "Cerebras",
    "protocol": "openai-completions",
    "baseUrl": "https://api.cerebras.ai/v1",
    "chatCompatible": false,
    "note": "原生 API 为 openai-completions；claude 对话需要该服务提供 Anthropic 兼容端点。",
    "models": [
      {
        "id": "gpt-oss-120b",
        "name": "GPT OSS 120B",
        "context_window": 131072,
        "max_output_tokens": 40960
      },
      {
        "id": "qwen-3.8-27b",
        "name": "Qwen3.8 27B",
        "context_window": 131072,
        "max_output_tokens": 40960,
        "supports_image": true
      }
    ]
  },
  {
    "id": "cloudflare-ai-gateway",
    "name": "Cloudflare AI Gateway",
    "protocol": "anthropic-messages",
    "baseUrl": "",
    "chatCompatible": false,
    "needsBaseUrl": true,
    "note": "原生 API 为 anthropic-messages；请填写完整 Base URL，且 claude 对话需要 Anthropic 兼容端点。",
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
    "id": "cloudflare-workers-ai",
    "name": "Cloudflare Workers AI",
    "protocol": "openai-completions",
    "baseUrl": "",
    "chatCompatible": false,
    "needsBaseUrl": true,
    "note": "原生 API 为 openai-completions；请填写完整 Base URL，且 claude 对话需要 Anthropic 兼容端点。",
    "models": [
      {
        "id": "@cf/deepseek-ai/deepseek-v4-flash-0731",
        "name": "DeepSeek V4 Flash 0731",
        "context_window": 1048576,
        "max_output_tokens": 1048576
      },
      {
        "id": "@cf/deepseek-ai/deepseek-v4-pro-0813",
        "name": "DeepSeek V4 Pro 0813",
        "context_window": 1048576,
        "max_output_tokens": 1048576
      },
      {
        "id": "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
        "name": "DeepSeek V4.1 Flash 1017",
        "context_window": 1048576,
        "max_output_tokens": 1048576,
        "supports_image": true
      },
      {
        "id": "@cf/google/gemma-4-26b-a4b-it",
        "name": "Gemma 4 26B A4B IT",
        "context_window": 256000,
        "max_output_tokens": 16384,
        "supports_image": true
      },
      {
        "id": "@cf/ibm-granite/granite-4.0-h-micro",
        "name": "Granite 4.0 H Micro",
        "context_window": 131000,
        "max_output_tokens": 131000
      },
      {
        "id": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        "name": "Llama 3.3 70B Instruct fp8 Fast",
        "context_window": 24000,
        "max_output_tokens": 24000
      }
    ]
  },
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "protocol": "anthropic-messages",
    "baseUrl": "https://api.deepseek.com/anthropic",
    "chatCompatible": true,
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
    "protocol": "anthropic-messages",
    "baseUrl": "https://api.fireworks.ai/inference",
    "chatCompatible": true,
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
    "protocol": "anthropic-messages",
    "baseUrl": "https://api.individual.githubcopilot.com",
    "chatCompatible": true,
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
    "id": "google",
    "name": "Google",
    "protocol": "google-generative-ai",
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
    "chatCompatible": false,
    "note": "原生 API 为 google-generative-ai；claude 对话需要该服务提供 Anthropic 兼容端点。",
    "models": [
      {
        "id": "deep-research-max-preview-04-2026",
        "name": "Deep Research Max Preview (Apr-21-2026)",
        "context_window": 1048576,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "deep-research-preview-04-2026",
        "name": "Deep Research Preview (Apr-21-2026)",
        "context_window": 1048576,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "gemini-2.5-computer-use-preview-10-2025",
        "name": "Gemini 2.5 Computer Use Preview 10-2025",
        "context_window": 128000,
        "max_output_tokens": 64000,
        "supports_image": true
      },
      {
        "id": "gemini-2.5-flash",
        "name": "Gemini 2.5 Flash",
        "context_window": 1048576,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "gemini-2.5-flash-lite",
        "name": "Gemini 2.5 Flash-Lite",
        "context_window": 1048576,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "gemini-2.5-pro",
        "name": "Gemini 2.5 Pro",
        "context_window": 1048576,
        "max_output_tokens": 65536,
        "supports_image": true
      }
    ]
  },
  {
    "id": "google-vertex",
    "name": "Google Vertex AI",
    "protocol": "google-generative-ai",
    "baseUrl": "",
    "chatCompatible": false,
    "needsBaseUrl": true,
    "note": "原生 API 为 google-vertex；请填写完整 Base URL，且 claude 对话需要 Anthropic 兼容端点。",
    "models": [
      {
        "id": "gemini-2.5-flash",
        "name": "Gemini 2.5 Flash",
        "context_window": 1048576,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "gemini-2.5-flash-lite",
        "name": "Gemini 2.5 Flash-Lite",
        "context_window": 1048576,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "gemini-2.5-pro",
        "name": "Gemini 2.5 Pro",
        "context_window": 1048576,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "gemini-3-flash-preview",
        "name": "Gemini 3 Flash Preview",
        "context_window": 1048576,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "gemini-3.1-flash-lite",
        "name": "Gemini 3.1 Flash Lite",
        "context_window": 1048576,
        "max_output_tokens": 65536,
        "supports_image": true
      },
      {
        "id": "gemini-3.1-pro-preview",
        "name": "Gemini 3.1 Pro Preview",
        "context_window": 1048576,
        "max_output_tokens": 65536,
        "supports_image": true
      }
    ]
  },
  {
    "id": "groq",
    "name": "Groq",
    "protocol": "openai-completions",
    "baseUrl": "https://api.groq.com/openai/v1",
    "chatCompatible": false,
    "note": "原生 API 为 openai-completions；claude 对话需要该服务提供 Anthropic 兼容端点。",
    "models": [
      {
        "id": "llama-3.1-8b-instant",
        "name": "Llama 3.1 8B",
        "context_window": 131072,
        "max_output_tokens": 131072
      },
      {
        "id": "llama-3.3-70b-versatile",
        "name": "Llama 3.3 70B",
        "context_window": 131072,
        "max_output_tokens": 32768
      },
      {
        "id": "openai/gpt-oss-120b",
        "name": "GPT OSS 120B",
        "context_window": 131072,
        "max_output_tokens": 65536
      },
      {
        "id": "openai/gpt-oss-20b",
        "name": "GPT OSS 20B",
        "context_window": 131072,
        "max_output_tokens": 65536
      },
      {
        "id": "openai/gpt-oss-safeguard-20b",
        "name": "Safety GPT OSS 20B",
        "context_window": 131072,
        "max_output_tokens": 65536
      },
      {
        "id": "qwen/qwen3.6-27b",
        "name": "Qwen3.6 27B",
        "context_window": 131072,
        "max_output_tokens": 16384,
        "supports_image": true
      }
    ]
  },
  {
    "id": "huggingface",
    "name": "Hugging Face",
    "protocol": "openai-completions",
    "baseUrl": "https://router.huggingface.co/v1",
    "chatCompatible": false,
    "note": "原生 API 为 openai-completions；claude 对话需要该服务提供 Anthropic 兼容端点。",
    "models": [
      {
        "id": "deepseek-ai/DeepSeek-R1",
        "name": "DeepSeek-R1",
        "context_window": 64000,
        "max_output_tokens": 32768
      },
      {
        "id": "deepseek-ai/DeepSeek-R1-0528",
        "name": "DeepSeek-R1-0528",
        "context_window": 163840,
        "max_output_tokens": 32768
      },
      {
        "id": "deepseek-ai/DeepSeek-V3",
        "name": "DeepSeek-V3",
        "context_window": 64000,
        "max_output_tokens": 8192
      },
      {
        "id": "deepseek-ai/DeepSeek-V3-0324",
        "name": "DeepSeek V3 0324",
        "context_window": 163840,
        "max_output_tokens": 163840
      },
      {
        "id": "deepseek-ai/DeepSeek-V3.1",
        "name": "DeepSeek-V3.1",
        "context_window": 131072,
        "max_output_tokens": 8192
      },
      {
        "id": "deepseek-ai/DeepSeek-V3.2",
        "name": "DeepSeek-V3.2",
        "context_window": 163840,
        "max_output_tokens": 65536
      }
    ]
  },
  {
    "id": "kimi-coding",
    "name": "Kimi For Coding",
    "protocol": "openai-completions",
    "baseUrl": "https://api.kimi.com/coding/v1",
    "chatCompatible": false,
    "note": "原生 API 为 openai-completions；claude 对话需要该服务提供 Anthropic 兼容端点。",
    "models": [
      {
        "id": "k3",
        "name": "Kimi K3",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "k3-256k",
        "name": "Kimi K3-256K",
        "context_window": 262144,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "k3.1-pro",
        "name": "Kimi K3.1 Pro",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "k3.1-pro-highspeed",
        "name": "Kimi K3.1 Pro Highspeed",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "kimi-for-coding",
        "name": "kimi-for-coding",
        "context_window": 1048576,
        "max_output_tokens": 32768,
        "supports_image": true
      },
      {
        "id": "kimi-for-coding-highspeed",
        "name": "Kimi For Coding HighSpeed",
        "context_window": 262144,
        "max_output_tokens": 32768,
        "supports_image": true
      }
    ]
  },
  {
    "id": "meta",
    "name": "Meta",
    "protocol": "openai-responses",
    "baseUrl": "https://api.meta.ai/v1",
    "chatCompatible": false,
    "note": "原生 API 为 openai-responses；claude 对话需要该服务提供 Anthropic 兼容端点。",
    "models": [
      {
        "id": "muse-ember-1.0",
        "name": "Muse Ember",
        "context_window": 1048576,
        "max_output_tokens": 524288,
        "supports_image": true
      },
      {
        "id": "muse-spark-1.1",
        "name": "Muse Spark 1.1",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "muse-spark-1.2",
        "name": "Muse Spark 1.2",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "muse-spark-1.2-contributor",
        "name": "Muse Spark 1.2 Contributor",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "muse-spark-1.3",
        "name": "Muse Spark 1.3",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "muse-spark-1.3-contributor",
        "name": "Muse Spark 1.3 Contributor",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      }
    ]
  },
  {
    "id": "minimax",
    "name": "MiniMax",
    "protocol": "anthropic-messages",
    "baseUrl": "https://api.minimax.io/anthropic",
    "chatCompatible": true,
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
    "protocol": "anthropic-messages",
    "baseUrl": "https://api.minimaxi.com/anthropic",
    "chatCompatible": true,
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
    "id": "mistral",
    "name": "Mistral",
    "protocol": "openai-completions",
    "baseUrl": "https://api.mistral.ai/v1",
    "chatCompatible": false,
    "note": "原生 API 为 mistral-conversations；claude 对话需要该服务提供 Anthropic 兼容端点。",
    "models": [
      {
        "id": "codestral-2508",
        "name": "Codestral 25.08",
        "context_window": 256000,
        "max_output_tokens": 8192
      },
      {
        "id": "codestral-latest",
        "name": "Codestral (latest)",
        "context_window": 256000,
        "max_output_tokens": 4096
      },
      {
        "id": "deepseek-v4-1-flash-1017",
        "name": "DeepSeek V4.1 Flash 1017",
        "context_window": 1048576,
        "max_output_tokens": 128000
      },
      {
        "id": "devstral-2512",
        "name": "Devstral 2",
        "context_window": 262144,
        "max_output_tokens": 262144
      },
      {
        "id": "devstral-latest",
        "name": "Devstral 2",
        "context_window": 262144,
        "max_output_tokens": 262144
      },
      {
        "id": "devstral-medium-latest",
        "name": "Devstral 2 (latest)",
        "context_window": 262144,
        "max_output_tokens": 262144
      }
    ]
  },
  {
    "id": "moonshotai",
    "name": "Moonshot AI",
    "protocol": "anthropic-messages",
    "baseUrl": "https://api.moonshot.ai/anthropic",
    "chatCompatible": true,
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
    "protocol": "anthropic-messages",
    "baseUrl": "https://api.moonshot.cn/anthropic",
    "chatCompatible": true,
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
    "id": "nvidia",
    "name": "NVIDIA",
    "protocol": "openai-completions",
    "baseUrl": "https://integrate.api.nvidia.com/v1",
    "chatCompatible": false,
    "note": "原生 API 为 openai-completions；claude 对话需要该服务提供 Anthropic 兼容端点。",
    "models": [
      {
        "id": "deepseek-ai/deepseek-v4.1-flash",
        "name": "DeepSeek V4.1 Flash",
        "context_window": 1000000,
        "max_output_tokens": 384000,
        "supports_image": true
      },
      {
        "id": "google/diffusiongemma-26b-a4b-it",
        "name": "DiffusionGemma 26B A4B IT",
        "context_window": 250000,
        "max_output_tokens": 32768,
        "supports_image": true
      },
      {
        "id": "google/gemma-3-12b-it",
        "name": "Gemma 3 12B IT",
        "context_window": 131072,
        "max_output_tokens": 16384,
        "supports_image": true
      },
      {
        "id": "google/gemma-3-4b-it",
        "name": "Gemma 3 4B IT",
        "context_window": 131072,
        "max_output_tokens": 16384,
        "supports_image": true
      },
      {
        "id": "meta/llama-3.2-90b-vision-instruct",
        "name": "Llama-3.2-90B-Vision-Instruct",
        "context_window": 128000,
        "max_output_tokens": 8192,
        "supports_image": true
      },
      {
        "id": "meta/muse-glimmer-30b",
        "name": "Muse Glimmer 30B",
        "context_window": 131072,
        "max_output_tokens": 131072,
        "supports_image": true
      }
    ]
  },
  {
    "id": "openai",
    "name": "OpenAI",
    "protocol": "openai-responses",
    "baseUrl": "https://api.openai.com/v1",
    "chatCompatible": false,
    "note": "原生 API 为 openai-responses；claude 对话需要该服务提供 Anthropic 兼容端点。",
    "models": [
      {
        "id": "chat-latest",
        "name": "Chat Latest",
        "context_window": 400000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "gpt-4",
        "name": "GPT-4",
        "context_window": 8192,
        "max_output_tokens": 8192
      },
      {
        "id": "gpt-4-turbo",
        "name": "GPT-4 Turbo",
        "context_window": 128000,
        "max_output_tokens": 4096,
        "supports_image": true
      },
      {
        "id": "gpt-4.1",
        "name": "GPT-4.1",
        "context_window": 1047576,
        "max_output_tokens": 32768,
        "supports_image": true
      },
      {
        "id": "gpt-4.1-mini",
        "name": "GPT-4.1 mini",
        "context_window": 1047576,
        "max_output_tokens": 32768,
        "supports_image": true
      },
      {
        "id": "gpt-4.1-nano",
        "name": "GPT-4.1 nano",
        "context_window": 1047576,
        "max_output_tokens": 32768,
        "supports_image": true
      }
    ]
  },
  {
    "id": "openai-codex",
    "name": "OpenAI Codex",
    "protocol": "openai-responses",
    "baseUrl": "",
    "chatCompatible": false,
    "needsBaseUrl": true,
    "note": "原生 API 为 openai-codex-responses；请填写完整 Base URL，且 claude 对话需要 Anthropic 兼容端点。",
    "models": [
      {
        "id": "gpt-5.6-luna",
        "name": "GPT-5.6 Luna",
        "context_window": 272000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "gpt-5.6-sol",
        "name": "GPT-5.6 Sol",
        "context_window": 272000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "gpt-5.6-terra",
        "name": "GPT-5.6 Terra",
        "context_window": 272000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "gpt-6-astra",
        "name": "GPT-6 Astra",
        "context_window": 272000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "gpt-6-luna",
        "name": "GPT-6 Luna",
        "context_window": 272000,
        "max_output_tokens": 128000,
        "supports_image": true
      },
      {
        "id": "gpt-6-sol",
        "name": "GPT-6 Sol",
        "context_window": 272000,
        "max_output_tokens": 128000,
        "supports_image": true
      }
    ]
  },
  {
    "id": "opencode",
    "name": "OpenCode Zen",
    "protocol": "anthropic-messages",
    "baseUrl": "",
    "chatCompatible": false,
    "needsBaseUrl": true,
    "note": "原生 API 为 anthropic-messages；请填写完整 Base URL，且 claude 对话需要 Anthropic 兼容端点。",
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
    "protocol": "anthropic-messages",
    "baseUrl": "",
    "chatCompatible": false,
    "needsBaseUrl": true,
    "note": "原生 API 为 anthropic-messages；请填写完整 Base URL，且 claude 对话需要 Anthropic 兼容端点。",
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
    "protocol": "anthropic-messages",
    "baseUrl": "https://openrouter.ai/api",
    "chatCompatible": true,
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
    "protocol": "anthropic-messages",
    "baseUrl": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    "chatCompatible": true,
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
    "protocol": "anthropic-messages",
    "baseUrl": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    "chatCompatible": true,
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
    "protocol": "anthropic-messages",
    "baseUrl": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    "chatCompatible": true,
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
    "protocol": "anthropic-messages",
    "baseUrl": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    "chatCompatible": true,
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
    "id": "radius",
    "name": "Radius",
    "protocol": "anthropic-messages",
    "baseUrl": "",
    "chatCompatible": false,
    "needsBaseUrl": true,
    "note": "原生 API 为 pi-messages；请填写完整 Base URL，且 claude 对话需要 Anthropic 兼容端点。",
    "models": [
      {
        "id": "balanced",
        "name": "Balanced",
        "context_window": 1048576,
        "max_output_tokens": 262144,
        "supports_image": true
      },
      {
        "id": "cheap",
        "name": "Cheap",
        "context_window": 1000000,
        "max_output_tokens": 131072,
        "supports_image": true
      },
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
      }
    ]
  },
  {
    "id": "together",
    "name": "Together",
    "protocol": "openai-completions",
    "baseUrl": "https://api.together.ai/v1",
    "chatCompatible": false,
    "note": "原生 API 为 openai-completions；claude 对话需要该服务提供 Anthropic 兼容端点。",
    "models": [
      {
        "id": "deepseek-ai/DeepSeek-V4-Pro-0813",
        "name": "DeepSeek V4 Pro 0813",
        "context_window": 1048576,
        "max_output_tokens": 384000
      },
      {
        "id": "deepseek-ai/DeepSeek-V4.1-Flash",
        "name": "DeepSeek V4.1 Flash",
        "context_window": 1048576,
        "max_output_tokens": 384000,
        "supports_image": true
      },
      {
        "id": "meta-models/Muse-Spark-Open-816B-A42B",
        "name": "Muse Spark Open",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "MiniMaxAI/MiniMax-M3",
        "name": "MiniMax-M3",
        "context_window": 524288,
        "max_output_tokens": 524288,
        "supports_image": true
      },
      {
        "id": "moonshotai/Kimi-K3",
        "name": "Kimi K3",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      },
      {
        "id": "moonshotai/Kimi-K3.1-Pro",
        "name": "Kimi K3.1 Pro",
        "context_window": 1048576,
        "max_output_tokens": 131072,
        "supports_image": true
      }
    ]
  },
  {
    "id": "vercel-ai-gateway",
    "name": "Vercel AI Gateway",
    "protocol": "anthropic-messages",
    "baseUrl": "https://ai-gateway.vercel.sh",
    "chatCompatible": true,
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
    "id": "xai",
    "name": "xAI",
    "protocol": "openai-responses",
    "baseUrl": "https://api.x.ai/v1",
    "chatCompatible": false,
    "note": "原生 API 为 openai-responses；claude 对话需要该服务提供 Anthropic 兼容端点。",
    "models": [
      {
        "id": "grok-4.3",
        "name": "Grok 4.3",
        "context_window": 1000000,
        "max_output_tokens": 30000,
        "supports_image": true
      },
      {
        "id": "grok-4.5",
        "name": "Grok 4.5",
        "context_window": 500000,
        "max_output_tokens": 500000,
        "supports_image": true
      },
      {
        "id": "grok-4.6",
        "name": "Grok 4.6",
        "context_window": 500000,
        "max_output_tokens": 500000,
        "supports_image": true
      },
      {
        "id": "grok-4.7",
        "name": "Grok 4.7",
        "context_window": 500000,
        "max_output_tokens": 500000,
        "supports_image": true
      }
    ]
  },
  {
    "id": "xiaomi",
    "name": "Xiaomi",
    "protocol": "anthropic-messages",
    "baseUrl": "https://api.xiaomimimo.com/anthropic",
    "chatCompatible": true,
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
    "protocol": "anthropic-messages",
    "baseUrl": "https://token-plan-ams.xiaomimimo.com/anthropic",
    "chatCompatible": true,
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
    "protocol": "anthropic-messages",
    "baseUrl": "https://token-plan-cn.xiaomimimo.com/anthropic",
    "chatCompatible": true,
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
    "protocol": "anthropic-messages",
    "baseUrl": "https://token-plan-sgp.xiaomimimo.com/anthropic",
    "chatCompatible": true,
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
    "protocol": "anthropic-messages",
    "baseUrl": "https://api.z.ai/api/anthropic",
    "chatCompatible": true,
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
    "protocol": "anthropic-messages",
    "baseUrl": "https://open.bigmodel.cn/api/anthropic",
    "chatCompatible": true,
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
  protocol: string;
  baseUrl: string;
  models: string[];
  modelMeta: Record<string, ModelSpec>;
} {
  return {
    id: uniqueProviderId(preset.id, existingIds),
    name: preset.name,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    ...presetModels(preset),
  };
}
