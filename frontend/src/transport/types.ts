// 与后端 / claude CLI 之间的线上协议类型。
//
// 后端把一个 claude 会话的事件统一包成 WireEvent 推给前端：
//   { kind, sid?, data }
// 前端上行命令是 ClientCommand。

export type WireEventKind =
  | "session.snapshot"
  | "session.ready"
  | "session.state"
  | "cli"
  | "permission"
  | "error"
  | "closed"
  | "pong";

export interface WireEvent {
  kind: WireEventKind | string;
  sid?: string;
  data?: unknown;
}

/** initialize 回包（后端原样透传 CLI 的响应）。 */
export interface InitPayload {
  claude_code_version?: string;
  models?: ModelInfo[];
  commands?: CommandInfo[];
  agents?: AgentInfo[];
  output_style?: string;
  current_permission_mode?: string;
  account?: { tokenSource?: string; apiProvider?: string };
  session_state?: string;
  capabilities?: string[];
  [k: string]: unknown;
}

export interface ModelInfo {
  value: string;
  displayName?: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
}

export interface CommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  builtin?: boolean;
}

export interface AgentInfo {
  name: string;
  description?: string;
}

/** 后端推来的权限请求（can_use_tool）。 */
export interface PermissionPayload {
  request_id: string;
  tool_name: string;
  display_name?: string;
  description?: string;
  input?: unknown;
  blocked_path?: string;
  tool_use_id?: string;
  permission_suggestions?: PermissionSuggestion[];
}

export type PermissionSuggestion =
  | { type: "addRules"; rules?: { toolName: string; ruleContent?: string }[]; behavior?: string; destination?: string }
  | { type: "addDirectories"; directories?: string[]; destination?: string }
  | { type: "setMode"; mode?: string; destination?: string }
  | { type: string; [k: string]: unknown };

export interface SessionInfo {
  id: string;
  cwd: string;
  state: string;
  /** 创建会话时选中的提供商 / 模型（后端记录，用于判断能否热切换）。 */
  provider?: string;
  model?: string;
  created_at?: string;
  last_active?: string;
}

export interface SnapshotPayload {
  info: { id: string; cwd: string; state: string };
  init?: InitPayload;
}

/** 前端上行命令。 */
export type ClientCommand =
  | { kind: "prompt"; text: string }
  | { kind: "interrupt" }
  | { kind: "model"; model: string }
  | { kind: "permission_mode"; mode: string }
  | {
      kind: "permission";
      request_id: string;
      allow: boolean;
      updated_input?: unknown;
      updated_permissions?: unknown;
      message?: string;
    }
  | { kind: "ping" };

/** 一个第三方模型提供商的脱敏视图。 */
export interface PublicProvider {
  id: string;
  name: string;
  protocol: string;
  base_url: string;
  api_key_set: boolean;
  api_key_masked: string;
  auth_token_set: boolean;
  models_path: string;
  models: string[];
}

/** 当前选中的模型（= claude CLI 的默认模型）。 */
export interface Selection {
  provider: string;
  model: string;
}

/** 后端 /api/settings 的脱敏视图（密钥永不回传）。 */
export interface PublicSettings {
  providers: PublicProvider[];
  selected: Selection;
  permission_mode: string;
  auto_compact_window: string;
  disable_unknown_model_window: boolean;
  path: string;
}

/** 端点连通性探测结果。 */
export interface ProbeResult {
  ok: boolean;
  endpoint: string;
  method: string;
  status: number;
  latency_ms: number;
  detail: string;
}

/** 网关模型列表条目。 */
export interface GatewayModel {
  id: string;
  display_name?: string;
  owned_by?: string;
}

/** /api/settings/models 的响应。 */
export interface ModelsResult {
  models: GatewayModel[] | null;
  endpoint: string;
  protocol: string;
  supported: boolean;
  status: number;
  detail: string;
  /** 解析失败时的响应体片段，便于判断网关到底返回了什么。 */
  raw?: string;
  /** 尝试过的路径。 */
  tried?: string[];
  /** 每个候选路径的探测结果。 */
  attempts?: { path: string; status: number; note: string }[];
}

/** 一条已授权目录（工作区）。 */
export interface WorkspaceEntry {
  path: string;
  name: string;
  last_used: string;
  /** 读取时实时探测：目录可能被移动 / 卸载。 */
  exists: boolean;
}

/** GET /api/workspaces 的响应。 */
export interface WorkspacesPayload {
  workspaces: WorkspaceEntry[];
  current: string;
  /** CCWEB_PROJECTS_ROOT，目录选择器的默认起点。 */
  root: string;
}

/** 目录选择器里的一行。 */
export interface FsEntry {
  name: string;
  path: string;
}

/** GET /api/fs/list 的响应。 */
export interface FsListing {
  path: string;
  parent: string;
  entries: FsEntry[];
  roots: string[];
}
