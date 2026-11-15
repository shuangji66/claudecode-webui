package settings

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// Model 是网关 /v1/models 返回的一个模型条目。
type Model struct {
	ID      string `json:"id"`
	Display string `json:"display_name,omitempty"`
	OwnedBy string `json:"owned_by,omitempty"`
}

// ModelsResult 是拉取模型列表的结果。
type ModelsResult struct {
	Models   []Model `json:"models"`
	Endpoint string  `json:"endpoint"`
	Status   int     `json:"status"`
	Detail   string  `json:"detail"`
}

// FetchModels 用给定配置向网关拉取模型列表。
//
// 各家「Anthropic 兼容」实现对该端点的返回格式并不统一，这里做宽松解析：
//   - {"data":[{"id":...}]}（Anthropic / OpenAI 风格）
//   - {"models":[...]}
//   - 顶层数组
//
// 元素里取 id / name / model 任一字段作为模型标识。
func FetchModels(ctx context.Context, v Settings) ModelsResult {
	base := strings.TrimRight(v.BaseURL, "/")
	if base == "" {
		base = DefaultBaseURL
	}
	res := ModelsResult{Endpoint: base}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		res.Detail = "地址必须以 http:// 或 https:// 开头"
		return res
	}

	client := &http.Client{Timeout: ProbeTimeout}
	status, body, err := doJSON(ctx, client, http.MethodGet, base+"/v1/models?limit=1000", v, nil)
	res.Status = status
	if err != nil {
		res.Detail = "请求失败：" + err.Error()
		return res
	}
	if status < 200 || status >= 300 {
		res.Detail = fmt.Sprintf("HTTP %d：%s", status, snippet(body))
		return res
	}

	models, err := parseModels(body)
	if err != nil {
		res.Detail = "响应解析失败：" + err.Error()
		return res
	}
	res.Models = models
	res.Detail = fmt.Sprintf("共 %d 个模型", len(models))
	return res
}

// parseModels 宽松解析模型列表响应。
func parseModels(body []byte) ([]Model, error) {
	// 先尝试对象形态
	var obj struct {
		Data   json.RawMessage `json:"data"`
		Models json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(body, &obj); err == nil {
		if len(obj.Data) > 0 {
			if m, err := decodeModelArray(obj.Data); err == nil {
				return m, nil
			}
		}
		if len(obj.Models) > 0 {
			if m, err := decodeModelArray(obj.Models); err == nil {
				return m, nil
			}
		}
	}
	// 再尝试顶层数组
	if m, err := decodeModelArray(body); err == nil {
		return m, nil
	}
	return nil, fmt.Errorf("未找到模型数组")
}

func decodeModelArray(raw json.RawMessage) ([]Model, error) {
	var items []map[string]any
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, err
	}
	out := make([]Model, 0, len(items))
	seen := make(map[string]bool, len(items))
	for _, it := range items {
		id := firstString(it, "id", "name", "model", "model_id")
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, Model{
			ID:      id,
			Display: firstString(it, "display_name", "displayName", "title", "label"),
			OwnedBy: firstString(it, "owned_by", "ownedBy", "provider"),
		})
	}
	return out, nil
}

func firstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// BuiltinAliases 是 Claude Code 内置的模型别名，也是「伪装」的目标槽位。
//
// 说明：`default` 不是模型，它表示「不指定」，会解析到 opus 槽位；
// 因此映射 default 的实际手段是设置 ANTHROPIC_MODEL。
var BuiltinAliases = []string{"default", "opus", "sonnet", "haiku"}

// ResolveAlias 返回某个别名当前会被解析到的网关模型（空表示未映射）。
func (v Settings) ResolveAlias(alias string) string {
	switch alias {
	case "default":
		// 未显式映射时，default 跟随 opus 槽位（与 CLI 行为一致）。
		if v.Model != "" {
			return v.Model
		}
		return v.OpusModel
	case "opus":
		return v.OpusModel
	case "sonnet":
		return v.SonnetModel
	case "haiku":
		return v.HaikuModel
	}
	return ""
}
