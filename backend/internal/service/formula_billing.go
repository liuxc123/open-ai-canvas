package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/model"

	"github.com/expr-lang/expr"
)

const (
	maxFormulaLength = 500
	maxFormulaNodes  = 200
)

// EvaluateFormula 根据公式配置从请求 body 和 headers 中提取变量并计算费用（微积分）。
// 公式中可直接引用 body.xxx 访问请求体字段，headers["xxx"] 访问请求头。
// 结果单位为微积分（已乘以 CreditScale），向上取整。
func EvaluateFormula(config *model.FormulaBillingConfig, body map[string]any, headers map[string]string) (int64, error) {
	if config == nil || strings.TrimSpace(config.Formula) == "" {
		return 0, errors.New("公式计费配置为空")
	}
	if len(config.Formula) > maxFormulaLength {
		return 0, fmt.Errorf("公式长度超过 %d 字符限制", maxFormulaLength)
	}

	env := map[string]any{
		"body":    body,
		"headers": normalizeHeaderMap(headers),
	}

	program, err := expr.Compile(config.Formula,
		expr.AsFloat64(),
		expr.Env(env),
		expr.MaxNodes(maxFormulaNodes),
	)
	if err != nil {
		return 0, fmt.Errorf("公式语法错误: %w", err)
	}

	result, err := expr.Run(program, env)
	if err != nil {
		return 0, fmt.Errorf("公式求值失败: %w", err)
	}

	credits, ok := result.(float64)
	if !ok {
		return 0, errors.New("公式结果不是有效数值")
	}
	if math.IsNaN(credits) || math.IsInf(credits, 0) {
		return 0, errors.New("公式结果为 NaN 或无穷大")
	}
	if credits < 0 {
		return 0, errors.New("公式计费金额不能小于 0")
	}

	// 公式结果单位为积分，转为微积分
	microcredits := credits * float64(CreditScale)
	if microcredits > float64(math.MaxInt64) {
		return 0, errors.New("公式计费金额溢出")
	}
	return int64(math.Ceil(microcredits)), nil
}

// ValidateFormula 在保存配置时校验公式语法和结果类型。
func ValidateFormula(formula string) error {
	formula = strings.TrimSpace(formula)
	if formula == "" {
		return errors.New("计算公式不能为空")
	}
	if len(formula) > maxFormulaLength {
		return fmt.Errorf("公式长度超过 %d 字符限制", maxFormulaLength)
	}

	env := map[string]any{
		"body":    map[string]any{},
		"headers": map[string]string{},
	}

	_, err := expr.Compile(formula,
		expr.AsFloat64(),
		expr.Env(env),
		expr.MaxNodes(maxFormulaNodes),
	)
	if err != nil {
		return fmt.Errorf("公式语法错误: %w", err)
	}
	return nil
}

// formulaAmountMicrocredits 根据公式配置和倍率计算最终微积分金额。
func formulaAmountMicrocredits(config *model.FormulaBillingConfig, body map[string]any, headers map[string]string, multiplierBPS int64) (int64, error) {
	base, err := EvaluateFormula(config, body, headers)
	if err != nil {
		return 0, err
	}
	if multiplierBPS <= 0 {
		return 0, errors.New("公式计费倍率无效")
	}
	if base > (1<<63-1-9_999)/multiplierBPS {
		return 0, errors.New("公式计费金额溢出")
	}
	finalAmount := (base*multiplierBPS + 9_999) / 10_000
	// 价格计算日志
	formulaBodyJSON, _ := json.Marshal(map[string]any{
		"duration":   body["duration"],
		"seconds":    body["seconds"],
		"resolution": body["resolution"],
		"size":       body["size"],
		"quality":    body["quality"],
		"model":      body["model"],
	})
	log.Printf("[DEBUG] 公式计费：公式=%s | body=%s | 基础微积分=%d | 倍率=%d/10000 | 最终微积分=%d (%.6f 积分)",
		config.Formula, string(formulaBodyJSON), base, multiplierBPS, finalAmount, float64(finalAmount)/float64(CreditScale))
	return finalAmount, nil
}

// parseRequestBody 将原始 JSON body 解析为 map。
func parseRequestBody(raw []byte) map[string]any {
	if len(raw) == 0 {
		return map[string]any{}
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return map[string]any{}
	}
	if body == nil {
		return map[string]any{}
	}
	return body
}

// normalizeHeaderMap 将 headers 转为大小写不敏感的查找 map。
func normalizeHeaderMap(headers map[string]string) map[string]string {
	if headers == nil {
		return map[string]string{}
	}
	result := make(map[string]string, len(headers))
	for k, v := range headers {
		result[strings.ToLower(k)] = v
	}
	return result
}

// parseFormulaConfig 从 JSON 字符串反序列化公式配置。
func parseFormulaConfig(jsonStr string) *model.FormulaBillingConfig {
	jsonStr = strings.TrimSpace(jsonStr)
	if jsonStr == "" {
		return nil
	}
	var config model.FormulaBillingConfig
	if err := json.Unmarshal([]byte(jsonStr), &config); err != nil {
		return nil
	}
	if strings.TrimSpace(config.Formula) == "" {
		return nil
	}
	return &config
}

// serializeFormulaConfig 将公式配置序列化为 JSON 字符串。
func serializeFormulaConfig(config *model.FormulaBillingConfig) string {
	if config == nil || strings.TrimSpace(config.Formula) == "" {
		return ""
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return ""
	}
	return string(encoded)
}

// normalizeFormulaBody 将任务输入中的 config 字段规范化为公式可引用的 body 结构。
// 任务路径的 input 结构为 {mode, config:{videoSeconds, vquality, size, model, ...}}，
// 而公式引用的是 body.duration / body.resolution 等字段（与代理路径的请求体一致）。
// 此函数在保留原始 input 的基础上，补充这些规范化字段，使公式在两条路径下都能正常工作。
func normalizeFormulaBody(input map[string]any, config map[string]any) map[string]any {
	if input == nil {
		return map[string]any{}
	}
	body := make(map[string]any, len(input)+8)
	for k, v := range input {
		body[k] = v
	}
	if config == nil {
		return body
	}
	// duration / seconds：从 config.videoSeconds 规范化
	videoSeconds := strings.TrimSpace(fmt.Sprint(config["videoSeconds"]))
	seconds, err := strconv.Atoi(videoSeconds)
	if err != nil || seconds <= 0 {
		seconds = 5
	}
	if _, exists := body["duration"]; !exists {
		body["duration"] = seconds
	}
	if _, exists := body["seconds"]; !exists {
		body["seconds"] = videoSeconds
	}
	// resolution：从 config.vquality 规范化为 "720p" 格式
	if _, exists := body["resolution"]; !exists {
		body["resolution"] = normalizeVideoResolution(fmt.Sprint(config["vquality"]))
	}
	// 其他常用字段
	if _, exists := body["size"]; !exists {
		body["size"] = fmt.Sprint(config["size"])
	}
	if _, exists := body["quality"]; !exists {
		body["quality"] = fmt.Sprint(config["vquality"])
	}
	if _, exists := body["model"]; !exists {
		body["model"] = fmt.Sprint(config["model"])
	}
	return body
}
