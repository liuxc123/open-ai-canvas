package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/model"
)

const (
	seedanceAssetPollMinInterval = 2 * time.Second
	seedanceAssetPollMaxInterval = 5 * time.Second
	seedanceAssetPollTimeout     = 5 * time.Minute
	seedanceCreateAssetTimeout   = 30 * time.Second
)

// ===== 请求/响应结构体（v1 协议） =====

type seedanceCreateAssetRequest struct {
	Name          string `json:"Name"`
	AssetType     string `json:"AssetType"`
	URL           string `json:"URL"`
	GroupType     string `json:"GroupType"`
	MediaAssetsID int    `json:"media_assets_id"`
	ModelID       string `json:"model_id"`
	ModelName     string `json:"model_name"`
}

type seedanceCreateAssetResponse struct {
	ResponseMetadata struct {
		Action    string `json:"Action"`
		Region    string `json:"Region"`
		RequestID string `json:"RequestId"`
		Service   string `json:"Service"`
		Version   string `json:"Version"`
	} `json:"ResponseMetadata"`
	Result struct {
		ID      string `json:"Id"`
		GroupID string `json:"GroupId"`
		Status  string `json:"Status"`
		Error   *struct {
			Code    string `json:"Code"`
			Message string `json:"Message"`
		} `json:"Error"`
	} `json:"Result"`
	MaterialStatus  string `json:"material_status"`
	MediaAssetsID   int    `json:"media_assets_id"`
	UpstreamAssetID string `json:"upstream_asset_id"`
}

type seedanceGetAssetRequest struct {
	ID        string `json:"Id"`
	ModelID   string `json:"model_id"`
	ModelName string `json:"model_name"`
}

type seedanceGetAssetResponse struct {
	ResponseMetadata struct {
		Action    string `json:"Action"`
		Region    string `json:"Region"`
		RequestID string `json:"RequestId"`
		Service   string `json:"Service"`
		Version   string `json:"Version"`
	} `json:"ResponseMetadata"`
	Result struct {
		ID        string `json:"Id"`
		Name      string `json:"Name"`
		URL       string `json:"URL"`
		AssetType string `json:"AssetType"`
		GroupID   string `json:"GroupId"`
		Status    string `json:"Status"`
		Duration  *int   `json:"Duration"`
		Error     *struct {
			Code    string `json:"Code"`
			Message string `json:"Message"`
		} `json:"Error"`
		CreateTime string `json:"CreateTime"`
		UpdateTime string `json:"UpdateTime"`
	} `json:"Result"`
}

// ===== 协议适配器 =====

// seedanceAssetProtocol 封装某个 API 格式的素材注册协议。
// 不同上游或同一上游的不同版本，请求路径、字段名、响应结构可能不同，
// 通过 Protocol 接口隔离差异，业务层只操作统一的入参和出参。
type seedanceAssetProtocol interface {
	// CreatePath 返回注册素材的 API 路径
	CreatePath() string
	// GetPath 返回查询素材的 API 路径
	GetPath() string
	// BuildCreateRequest 将统一参数构造为该格式的请求体
	BuildCreateRequest(params seedanceAssetParams) (interface{}, error)
	// ParseCreateResponse 从该格式的响应中提取注册结果
	ParseCreateResponse(body []byte) (*seedanceAssetRegistration, error)
	// BuildGetRequest 构造查询请求体
	BuildGetRequest(upstreamAssetID string, modelName string) (interface{}, error)
	// ParseGetResponse 从查询响应中提取状态
	ParseGetResponse(body []byte) (*seedanceAssetStatusResult, error)
	// MapStatus 将上游原始状态映射为标准状态
	MapStatus(raw string) string
	// MapAssetType 将本系统 Kind 映射为上游 AssetType
	MapAssetType(kind string) (string, error)
}

// seedanceAssetParams 注册素材的统一入参（与协议格式无关）
type seedanceAssetParams struct {
	Name         string
	AssetType    string // 已映射后的上游 AssetType
	URL          string // 签名公网 URL
	GroupType    string
	Seq          int64 // 自增序列
	ResourceHash string
	ModelName    string // 模型名称（同时用于 model_id 和 model_name）
}

// seedanceAssetRegistration 注册素材的统一出参（与协议格式无关）
type seedanceAssetRegistration struct {
	UpstreamAssetID string
	Status          string // 标准化状态
	RawStatus       string // 上游原始状态
	MediaAssetsID   int
	ErrorMessage    string // 上游返回的错误信息（Status=Failed 时）
}

// seedanceAssetStatusResult 查询素材的统一出参（与协议格式无关）
type seedanceAssetStatusResult struct {
	UpstreamAssetID string
	Status          string // 标准化状态
	RawStatus       string // 上游原始状态
	Name            string
	URL             string
	CreateTime      string
	ErrorMessage    string // 上游返回的错误信息（Status=Failed 时）
}

// resolveSeedanceAssetProtocol 根据 MaterialAPIFormat 选择协议适配器。
// 空值或 "seedance-v1" 走 v1 协议；未来新增格式只需加 case 和实现文件。
func resolveSeedanceAssetProtocol(apiFormat string) seedanceAssetProtocol {
	switch strings.TrimSpace(apiFormat) {
	default:
		return seedanceAssetV1{} // v1 / 空值 / 未知格式均 fallback v1
	}
}

// ===== v1 协议实现 =====

type seedanceAssetV1 struct{}

func (seedanceAssetV1) CreatePath() string { return "/api/material/create_asset" }
func (seedanceAssetV1) GetPath() string    { return "/api/material/get_asset" }

func (seedanceAssetV1) BuildCreateRequest(params seedanceAssetParams) (interface{}, error) {
	return seedanceCreateAssetRequest{
		Name:          params.Name,
		AssetType:     params.AssetType,
		URL:           params.URL,
		GroupType:     params.GroupType,
		MediaAssetsID: int(params.Seq),
		ModelID:       params.ModelName,
		ModelName:     params.ModelName,
	}, nil
}

func (seedanceAssetV1) ParseCreateResponse(body []byte) (*seedanceAssetRegistration, error) {
	var resp seedanceCreateAssetResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, err
	}
	assetID := strings.TrimSpace(resp.Result.ID)
	if assetID == "" {
		assetID = strings.TrimSpace(resp.UpstreamAssetID)
	}
	if assetID == "" {
		return nil, errors.New("上游未返回资产 ID")
	}
	// 优先使用 Result.Status，旧版兼容顶层 MaterialStatus
	rawStatus := strings.TrimSpace(resp.Result.Status)
	if rawStatus == "" {
		rawStatus = strings.TrimSpace(resp.MaterialStatus)
	}
	// 空值默认 submitted（刚提交，等待审核）
	status := "submitted"
	if rawStatus != "" {
		status = mapSeedanceAssetStatus(rawStatus)
	}
	// 提取错误信息
	errMsg := ""
	if resp.Result.Error != nil && resp.Result.Error.Message != "" {
		errMsg = resp.Result.Error.Message
	}
	return &seedanceAssetRegistration{
		UpstreamAssetID: assetID,
		Status:          status,
		RawStatus:       rawStatus,
		MediaAssetsID:   resp.MediaAssetsID,
		ErrorMessage:    errMsg,
	}, nil
}

func (seedanceAssetV1) BuildGetRequest(upstreamAssetID string, modelName string) (interface{}, error) {
	return seedanceGetAssetRequest{
		ID:        upstreamAssetID,
		ModelID:   modelName,
		ModelName: modelName,
	}, nil
}

func (seedanceAssetV1) ParseGetResponse(body []byte) (*seedanceAssetStatusResult, error) {
	var resp seedanceGetAssetResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, err
	}
	// 提取错误信息
	errMsg := ""
	if resp.Result.Error != nil && resp.Result.Error.Message != "" {
		errMsg = resp.Result.Error.Message
	}
	return &seedanceAssetStatusResult{
		UpstreamAssetID: resp.Result.ID,
		Status:          mapSeedanceAssetStatus(resp.Result.Status),
		RawStatus:       resp.Result.Status,
		Name:            resp.Result.Name,
		URL:             resp.Result.URL,
		CreateTime:      resp.Result.CreateTime,
		ErrorMessage:    errMsg,
	}, nil
}

func (seedanceAssetV1) MapStatus(raw string) string { return mapSeedanceAssetStatus(raw) }

func (seedanceAssetV1) MapAssetType(kind string) (string, error) { return resourceAssetType(kind) }

// ===== 辅助函数 =====

// seedanceMaterialBaseURL 计算资产注册 API 的 BaseURL。
// 优先使用 MaterialBaseURL，为空时回退到 BaseURL（去掉 /v1 后缀）。
func seedanceMaterialBaseURL(config providerConfig) string {
	if trimmed := strings.TrimSpace(config.MaterialBaseURL); trimmed != "" {
		return strings.TrimRight(trimmed, "/")
	}
	base := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	return strings.TrimSuffix(base, "/v1")
}

// seedanceAccountFingerprint 计算 (MaterialBaseURL + APIKey + MaterialAPIVersion) 的 SHA256 指纹。
func seedanceAccountFingerprint(config providerConfig) string {
	materialBaseURL := seedanceMaterialBaseURL(config)
	apiVersion := strings.TrimSpace(config.MaterialAPIVersion)
	if apiVersion == "" {
		apiVersion = "v1"
	}
	raw := strings.TrimSpace(materialBaseURL) + ":" + strings.TrimSpace(config.APIKey) + ":" + apiVersion
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// mapSeedanceAssetStatus 将上游 Status 映射为本系统状态。
func mapSeedanceAssetStatus(upstream string) string {
	switch strings.ToLower(strings.TrimSpace(upstream)) {
	case "submitted":
		return "submitted"
	case "processing":
		return "processing"
	case "active":
		return "approved"
	case "failed", "rejected":
		return "failed"
	default:
		return "failed"
	}
}

// resourceAssetType 将 Resource.Kind 映射为 Seedance AssetType。
func resourceAssetType(kind string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "image":
		return "Image", nil
	case "video":
		return "Video", nil
	case "audio":
		return "Audio", nil
	default:
		return "", fmt.Errorf("不支持的素材类型：%s", kind)
	}
}

// resourceHash 计算资源内容 hash，优先用 ETag，为空时回退到全量 SHA256。
func (s *Service) resourceHash(resource *model.Resource) (string, error) {
	if etag := strings.TrimSpace(resource.ETag); etag != "" {
		return "etag:" + etag, nil
	}
	_, body, err := s.OpenResource(resource.UserID, resource.ID)
	if err != nil {
		return "", err
	}
	defer body.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, body); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}

// ===== HTTP 调用 =====

// doRawJSON 发送 HTTP 请求并返回原始 JSON 字节，由 Protocol 解析。
func doRawJSON(req *http.Request) ([]byte, error) {
	data, mimeType, err := doBinary(req)
	if err != nil {
		return nil, err
	}
	if !strings.Contains(mimeType, "json") && !json.Valid(data) {
		return nil, fmt.Errorf("接口返回非 JSON 内容：%s", mimeType)
	}
	return data, nil
}

func (s *Service) callSeedanceCreateAsset(ctx context.Context, config providerConfig, protocol seedanceAssetProtocol, params seedanceAssetParams) (*seedanceAssetRegistration, error) {
	baseURL := seedanceMaterialBaseURL(config)
	url := baseURL + protocol.CreatePath()
	reqBody, err := protocol.BuildCreateRequest(params)
	if err != nil {
		return nil, err
	}
	data, _ := json.Marshal(reqBody)
	httpCtx, cancel := context.WithTimeout(ctx, seedanceCreateAssetTimeout)
	defer cancel()
	httpRequest, err := http.NewRequestWithContext(httpCtx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	httpRequest.Header.Set("Authorization", "Bearer "+config.APIKey)
	httpRequest.Header.Set("Content-Type", "application/json")
	ApplyOutboundHeaders(httpRequest, config.Headers)
	responseBody, err := doRawJSON(httpRequest)
	if err != nil {
		return nil, err
	}
	return protocol.ParseCreateResponse(responseBody)
}

func (s *Service) callSeedanceGetAsset(ctx context.Context, config providerConfig, protocol seedanceAssetProtocol, upstreamAssetID string) (*seedanceAssetStatusResult, error) {
	baseURL := seedanceMaterialBaseURL(config)
	url := strings.TrimRight(baseURL, "/") + protocol.GetPath()
	reqBody, err := protocol.BuildGetRequest(upstreamAssetID, config.Model)
	if err != nil {
		return nil, err
	}
	data, _ := json.Marshal(reqBody)
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	httpRequest.Header.Set("Authorization", "Bearer "+config.APIKey)
	httpRequest.Header.Set("Content-Type", "application/json")
	ApplyOutboundHeaders(httpRequest, config.Headers)
	responseBody, err := doRawJSON(httpRequest)
	if err != nil {
		return nil, err
	}
	return protocol.ParseGetResponse(responseBody)
}

// ===== 核心业务逻辑 =====

// EnsureSeedanceAsset 确保资源已在 Seedance 注册并审核通过（幂等）。
// 视频生成流程调用此函数。
func (s *Service) EnsureSeedanceAsset(ctx context.Context, userID string, resourceID string, config providerConfig) (*model.SeedanceAsset, error) {
	fingerprint := seedanceAccountFingerprint(config)
	protocol := resolveSeedanceAssetProtocol(config.MaterialAPIFormat)

	// 1. 查询已有记录
	existing, err := s.repo.SeedanceAssetByIdentity(userID, resourceID, fingerprint)
	if err == nil && existing != nil {
		switch existing.Status {
		case "approved":
			// 重新计算 ResourceHash 检测资源是否变更
			resource, err := s.repo.ResourceForUser(userID, resourceID)
			if err != nil {
				return nil, fmt.Errorf("读取资源失败：%w", err)
			}
			currentHash, err := s.resourceHash(resource)
			if err != nil {
				return nil, fmt.Errorf("计算资源 hash 失败：%w", err)
			}
			if currentHash == existing.ResourceHash {
				return existing, nil // hash 匹配，直接返回
			}
			// hash 不匹配，标记旧记录 expired，走注册流程
			existing.Status = "expired"
			existing.UpdatedAt = time.Now()
			_ = s.repo.SaveSeedanceAsset(existing)
		case "submitted", "processing":
			// 调 get_asset 轮询到终态
			return s.pollAndUpdateAsset(ctx, existing, config, protocol)
		case "submitting":
			// create_asset 可能仍在进行中或失败，标记 failed 重试
			existing.Status = "failed"
			existing.ErrorResponse = "submitting 状态超时，自动标记失败重试"
			existing.UpdatedAt = time.Now()
			_ = s.repo.SaveSeedanceAsset(existing)
		case "failed", "expired":
			// 走注册流程
		}
	}

	// 注册流程
	return s.registerAndPollAsset(ctx, userID, resourceID, config, fingerprint, protocol)
}

// registerAndPollAsset 执行完整的注册+轮询流程。
func (s *Service) registerAndPollAsset(ctx context.Context, userID string, resourceID string, config providerConfig, fingerprint string, protocol seedanceAssetProtocol) (*model.SeedanceAsset, error) {
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		return nil, fmt.Errorf("读取资源失败：%w", err)
	}
	if resource.Status != model.ResourceStatusReady {
		return nil, errors.New("资源尚未上传完成")
	}
	assetType, err := protocol.MapAssetType(resource.Kind)
	if err != nil {
		return nil, err
	}
	// 生成签名公网 URL
	signedURL, err := s.directResourceURL(resource, time.Now().Add(providerResourceURLTTL))
	if err != nil {
		return nil, fmt.Errorf("生成资源签名 URL 失败：%w", err)
	}
	// 计算 resource_hash
	hash, err := s.resourceHash(resource)
	if err != nil {
		return nil, fmt.Errorf("计算资源 hash 失败：%w", err)
	}
	// 文件名：取 ObjectKey 的最后一段
	name := resource.ObjectKey
	if idx := strings.LastIndex(name, "/"); idx >= 0 {
		name = name[idx+1:]
	}
	if name == "" {
		name = resourceID
	}
	apiVersion := strings.TrimSpace(config.MaterialAPIVersion)
	if apiVersion == "" {
		apiVersion = "v1"
	}
	apiFormat := strings.TrimSpace(config.MaterialAPIFormat)
	// 先写入 SeedanceAsset 记录获取 Seq
	record := &model.SeedanceAsset{
		ID:                 newID(),
		UserID:             userID,
		ResourceID:         resourceID,
		Name:               name,
		AssetType:          assetType,
		URL:                signedURL,
		ResourceHash:       hash,
		ChannelID:          config.ChannelID,
		AccountFingerprint: fingerprint,
		MaterialBaseURL:    seedanceMaterialBaseURL(config),
		MaterialAPIVersion: apiVersion,
		MaterialAPIFormat:  apiFormat,
		GroupType:          "AIGC",
		Status:             "submitting",
	}
	if err := s.repo.CreateSeedanceAsset(record); err != nil {
		// 并发场景：另一个 goroutine 可能已创建同一 (userID, resourceID, fingerprint) 的记录
		if existing, findErr := s.repo.SeedanceAssetByIdentity(userID, resourceID, fingerprint); findErr == nil && existing != nil {
			return existing, nil
		}
		return nil, fmt.Errorf("创建资产记录失败：%w", err)
	}
	// 通过 protocol 构造请求并调用 create_asset
	reg, err := s.callSeedanceCreateAsset(ctx, config, protocol, seedanceAssetParams{
		Name:      name,
		AssetType: assetType,
		URL:       signedURL,
		GroupType: "AIGC",
		Seq:       record.Seq,
		ModelName: config.Model,
	})
	if err != nil {
		record.Status = "failed"
		record.ErrorResponse = err.Error()
		record.UpdatedAt = time.Now()
		_ = s.repo.SaveSeedanceAsset(record)
		return record, fmt.Errorf("调用 create_asset 失败：%w", err)
	}
	// 更新记录
	record.UpstreamAssetID = reg.UpstreamAssetID
	record.Status = reg.Status
	record.MediaAssetsID = reg.MediaAssetsID
	record.ErrorResponse = reg.ErrorMessage
	record.UpdatedAt = time.Now()
	if err := s.repo.SaveSeedanceAsset(record); err != nil {
		return nil, fmt.Errorf("更新资产记录失败：%w", err)
	}
	// 轮询 get_asset 直到终态
	return s.pollAndUpdateAsset(ctx, record, config, protocol)
}

// pollAndUpdateAsset 轮询 get_asset 直到终态并更新数据库。
func (s *Service) pollAndUpdateAsset(ctx context.Context, asset *model.SeedanceAsset, config providerConfig, protocol seedanceAssetProtocol) (*model.SeedanceAsset, error) {
	if asset.UpstreamAssetID == "" {
		return asset, errors.New("资产记录缺少 upstream_asset_id，无法轮询")
	}
	status, errMsg, err := s.pollSeedanceAssetStatus(ctx, config, protocol, asset.UpstreamAssetID)
	if err != nil {
		asset.Status = "failed"
		asset.ErrorResponse = errMsg
		asset.UpdatedAt = time.Now()
		_ = s.repo.SaveSeedanceAsset(asset)
		return asset, err
	}
	asset.Status = status
	asset.ErrorResponse = ""
	if status == "approved" {
		now := time.Now()
		asset.ApprovedAt = &now
	}
	asset.UpdatedAt = time.Now()
	if err := s.repo.SaveSeedanceAsset(asset); err != nil {
		return nil, fmt.Errorf("更新资产状态失败：%w", err)
	}
	return asset, nil
}

// pollSeedanceAssetStatus 轮询 get_asset 直到 approved / failed / 超时。
// 返回 (状态, 上游错误信息, error)。
func (s *Service) pollSeedanceAssetStatus(ctx context.Context, config providerConfig, protocol seedanceAssetProtocol, upstreamAssetID string) (string, string, error) {
	deadline := time.Now().Add(seedanceAssetPollTimeout)
	interval := seedanceAssetPollMinInterval
	for time.Now().Before(deadline) {
		result, err := s.callSeedanceGetAsset(ctx, config, protocol, upstreamAssetID)
		if err != nil {
			return "", "", err
		}
		status := result.Status
		switch status {
		case "approved":
			return status, "", nil
		case "failed":
			errMsg := result.ErrorMessage
			if errMsg == "" {
				errMsg = "Seedance 资产审核失败"
			}
			return status, errMsg, errors.New(errMsg)
		}
		if err := sleepContext(ctx, interval); err != nil {
			return "", "", err
		}
		interval += 1 * time.Second
		if interval > seedanceAssetPollMaxInterval {
			interval = seedanceAssetPollMaxInterval
		}
	}
	return "failed", "Seedance 资产审核超时", errors.New("Seedance 资产审核超时")
}

// refreshSeedanceAssetStatus 调 get_asset 刷新单个资产状态并写回数据库。
func (s *Service) refreshSeedanceAssetStatus(ctx context.Context, asset *model.SeedanceAsset, config providerConfig, protocol seedanceAssetProtocol) (string, error) {
	if asset.UpstreamAssetID == "" {
		return asset.Status, nil
	}
	result, err := s.callSeedanceGetAsset(ctx, config, protocol, asset.UpstreamAssetID)
	if err != nil {
		return asset.Status, err
	}
	status := result.Status
	if status != asset.Status {
		asset.Status = status
		asset.UpdatedAt = time.Now()
		if status == "approved" {
			now := time.Now()
			asset.ApprovedAt = &now
			asset.ErrorResponse = ""
		} else if status == "failed" {
			asset.ErrorResponse = result.ErrorMessage
			if asset.ErrorResponse == "" {
				asset.ErrorResponse = "审核失败"
			}
		}
		_ = s.repo.SaveSeedanceAsset(asset)
	}
	return status, nil
}

// registerSeedanceAssetOnly 只注册不等待：create_asset + 写入 submitted 后返回。
func (s *Service) registerSeedanceAssetOnly(ctx context.Context, userID string, resourceID string, config providerConfig) (*model.SeedanceAsset, error) {
	fingerprint := seedanceAccountFingerprint(config)
	protocol := resolveSeedanceAssetProtocol(config.MaterialAPIFormat)

	// 检查是否已有终态记录
	existing, err := s.repo.SeedanceAssetByIdentity(userID, resourceID, fingerprint)
	if err == nil && existing != nil {
		if existing.Status == "approved" {
			// 检查 hash 是否匹配
			resource, err := s.repo.ResourceForUser(userID, resourceID)
			if err == nil {
				currentHash, err := s.resourceHash(resource)
				if err == nil && currentHash == existing.ResourceHash {
					return existing, nil
				}
				// hash 不匹配，标记 expired
				existing.Status = "expired"
				existing.UpdatedAt = time.Now()
				_ = s.repo.SaveSeedanceAsset(existing)
			}
		} else if existing.Status == "submitted" || existing.Status == "processing" || existing.Status == "submitting" {
			// 已在注册中，直接返回
			return existing, nil
		}
	}

	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		return nil, fmt.Errorf("读取资源失败：%w", err)
	}
	if resource.Status != model.ResourceStatusReady {
		return nil, errors.New("资源尚未上传完成")
	}
	assetType, err := protocol.MapAssetType(resource.Kind)
	if err != nil {
		return nil, err
	}
	signedURL, err := s.directResourceURL(resource, time.Now().Add(providerResourceURLTTL))
	if err != nil {
		return nil, fmt.Errorf("生成资源签名 URL 失败：%w", err)
	}
	hash, err := s.resourceHash(resource)
	if err != nil {
		return nil, fmt.Errorf("计算资源 hash 失败：%w", err)
	}
	name := resource.ObjectKey
	if idx := strings.LastIndex(name, "/"); idx >= 0 {
		name = name[idx+1:]
	}
	if name == "" {
		name = resourceID
	}
	apiVersion := strings.TrimSpace(config.MaterialAPIVersion)
	if apiVersion == "" {
		apiVersion = "v1"
	}
	apiFormat := strings.TrimSpace(config.MaterialAPIFormat)
	record := &model.SeedanceAsset{
		ID:                 newID(),
		UserID:             userID,
		ResourceID:         resourceID,
		Name:               name,
		AssetType:          assetType,
		URL:                signedURL,
		ResourceHash:       hash,
		ChannelID:          config.ChannelID,
		AccountFingerprint: fingerprint,
		MaterialBaseURL:    seedanceMaterialBaseURL(config),
		MaterialAPIVersion: apiVersion,
		MaterialAPIFormat:  apiFormat,
		GroupType:          "AIGC",
		Status:             "submitting",
	}
	if err := s.repo.CreateSeedanceAsset(record); err != nil {
		// 并发场景：另一个 goroutine 可能已创建同一 (userID, resourceID, fingerprint) 的记录
		if existing, findErr := s.repo.SeedanceAssetByIdentity(userID, resourceID, fingerprint); findErr == nil && existing != nil {
			return existing, nil
		}
		return nil, fmt.Errorf("创建资产记录失败：%w", err)
	}
	// 通过 protocol 构造请求并调用 create_asset
	reg, err := s.callSeedanceCreateAsset(ctx, config, protocol, seedanceAssetParams{
		Name:      name,
		AssetType: assetType,
		URL:       signedURL,
		GroupType: "AIGC",
		Seq:       record.Seq,
		ModelName: config.Model,
	})
	if err != nil {
		record.Status = "failed"
		record.ErrorResponse = err.Error()
		record.UpdatedAt = time.Now()
		_ = s.repo.SaveSeedanceAsset(record)
		return record, fmt.Errorf("调用 create_asset 失败：%w", err)
	}
	record.UpstreamAssetID = reg.UpstreamAssetID
	record.Status = reg.Status
	record.MediaAssetsID = reg.MediaAssetsID
	record.ErrorResponse = reg.ErrorMessage
	record.UpdatedAt = time.Now()
	if err := s.repo.SaveSeedanceAsset(record); err != nil {
		return nil, fmt.Errorf("更新资产记录失败：%w", err)
	}
	return record, nil
}

// ===== 批量操作 =====

type SeedanceRegisterItem struct {
	ResourceID string `json:"resourceId"`
	ChannelID  string `json:"channelId"`
	Model      string `json:"model"`
}

type SeedanceRegisterResult struct {
	ResourceID string              `json:"resourceId"`
	Asset      *model.SeedanceAsset `json:"asset,omitempty"`
	Error      string              `json:"error,omitempty"`
}

// RegisterSeedanceAssetsBatch 批量注册资产，不同渠道并发、同渠道内也并发。
func (s *Service) RegisterSeedanceAssetsBatch(ctx context.Context, userID string, items []SeedanceRegisterItem) ([]SeedanceRegisterResult, error) {
	results := make([]SeedanceRegisterResult, len(items))
	groups := make(map[string][]int)
	for i, item := range items {
		groups[item.ChannelID] = append(groups[item.ChannelID], i)
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	for channelID, indices := range groups {
		wg.Add(1)
		go func(channelID string, indices []int) {
			defer wg.Done()
			model := ""
			for _, idx := range indices {
				if m := items[idx].Model; m != "" {
					model = m
					break
				}
			}
			config, err := s.resolveProviderConfig(providerConfig{ChannelID: channelID, Model: model})
			if err != nil {
				mu.Lock()
				for _, idx := range indices {
					results[idx] = SeedanceRegisterResult{ResourceID: items[idx].ResourceID, Error: err.Error()}
				}
				mu.Unlock()
				return
			}
			// 同渠道内并发注册
			var innerWg sync.WaitGroup
			for _, idx := range indices {
				innerWg.Add(1)
				go func(i int) {
					defer innerWg.Done()
					asset, err := s.registerSeedanceAssetOnly(ctx, userID, items[i].ResourceID, config)
					mu.Lock()
					if err != nil {
						results[i] = SeedanceRegisterResult{ResourceID: items[i].ResourceID, Error: err.Error()}
					} else {
						results[i] = SeedanceRegisterResult{ResourceID: items[i].ResourceID, Asset: asset}
					}
					mu.Unlock()
				}(idx)
			}
			innerWg.Wait()
		}(channelID, indices)
	}
	wg.Wait()
	return results, nil
}

// ListSeedanceAssets 批量查询资产，非终态资产并发调 get_asset 刷新。
func (s *Service) ListSeedanceAssets(ctx context.Context, userID string, channelID string, resourceIDs []string, config providerConfig) ([]model.SeedanceAsset, error) {
	assets, err := s.repo.SeedanceAssetsByResourceIDs(userID, resourceIDs)
	if err != nil {
		return nil, err
	}
	protocol := resolveSeedanceAssetProtocol(config.MaterialAPIFormat)
	var wg sync.WaitGroup
	for i := range assets {
		if assets[i].Status != "submitted" && assets[i].Status != "processing" {
			continue
		}
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			status, _ := s.refreshSeedanceAssetStatus(ctx, &assets[idx], config, protocol)
			if status != "" {
				assets[idx].Status = status
			}
		}(i)
	}
	wg.Wait()
	return assets, nil
}

// ===== 视频生成流程集成 =====

// ensureSeedanceAssetsForVideoGeneration 在视频生成前确保所有参考素材已注册。
// 先并发注册所有素材，再并发轮询非终态素材，避免逐个串行等待。
func (s *Service) ensureSeedanceAssetsForVideoGeneration(ctx context.Context, userID string, input *canvasGenerationInput) error {
	type assetJob struct {
		groupIndex int
		itemIndex  int
		resourceID string
		media      *providerMedia
	}

	// 1. 收集所有需要注册的素材
	var jobs []assetJob
	groups := [][]providerMedia{input.ReferenceImages, input.ReferenceVideos, input.ReferenceAudios}
	for gi, group := range groups {
		for i := range group {
			media := &group[i]
			if strings.HasPrefix(media.URL, "asset://") || strings.HasPrefix(media.DataURL, "data:") {
				continue
			}
			resourceID := strings.TrimPrefix(media.StorageKey, "resource:")
			if resourceID == "" || resourceID == media.StorageKey {
				continue
			}
			jobs = append(jobs, assetJob{groupIndex: gi, itemIndex: i, resourceID: resourceID, media: media})
		}
	}
	if len(jobs) == 0 {
		return nil
	}

	// 2. 并发注册所有素材（EnsureSeedanceAsset 内部有幂等检查，并发安全）
	type assetResult struct {
		job  assetJob
		asset *model.SeedanceAsset
		err   error
	}
	results := make([]assetResult, len(jobs))
	var wg sync.WaitGroup
	for i, job := range jobs {
		wg.Add(1)
		go func(idx int, j assetJob) {
			defer wg.Done()
			asset, err := s.EnsureSeedanceAsset(ctx, userID, j.resourceID, input.Config)
			results[idx] = assetResult{job: j, asset: asset, err: err}
		}(i, job)
	}
	wg.Wait()

	// 3. 检查结果，回写 asset:// 引用
	for _, r := range results {
		if r.err != nil {
			return fmt.Errorf("Seedance 资产注册失败（%s）：%w", r.job.media.Name, r.err)
		}
		if r.asset.Status != "approved" {
			return fmt.Errorf("Seedance 资产 %s 未审核通过（状态：%s）", r.job.media.Name, r.asset.Status)
		}
		r.job.media.URL = "asset://" + r.asset.UpstreamAssetID
		r.job.media.DataURL = ""
	}
	return nil
}

// ===== API 请求/响应类型 =====

type SeedanceRegisterRequest struct {
	ResourceID string `json:"resourceId"`
	ChannelID  string `json:"channelId"`
	Model      string `json:"model"`
}

type SeedanceRegisterBatchRequest struct {
	Items []SeedanceRegisterItem `json:"items"`
}

type SeedanceRegisterBatchResponse struct {
	Results []SeedanceRegisterResult `json:"results"`
}

// RegisterSeedanceAsset 单个资产注册（API 入口）。
func (s *Service) RegisterSeedanceAsset(ctx context.Context, userID string, req SeedanceRegisterRequest) (*model.SeedanceAsset, error) {
	config, err := s.resolveProviderConfig(providerConfig{ChannelID: req.ChannelID, Model: req.Model})
	if err != nil {
		return nil, err
	}
	return s.registerSeedanceAssetOnly(ctx, userID, req.ResourceID, config)
}

// GetSeedanceAsset 查询单个资产状态，非终态时调 get_asset 刷新。
// 如果资产的 fingerprint 与当前渠道不匹配，视为未注册，返回 nil。
func (s *Service) GetSeedanceAsset(ctx context.Context, userID string, assetID string, channelID string, modelName string) (*model.SeedanceAsset, error) {
	asset, err := s.repo.SeedanceAssetByID(userID, assetID)
	if err != nil {
		return nil, err
	}
	// 检查 fingerprint 是否匹配当前渠道
	if strings.TrimSpace(channelID) != "" {
		config, err := s.resolveProviderConfig(providerConfig{ChannelID: firstNonEmpty(channelID, asset.ChannelID), Model: modelName})
		if err == nil {
			currentFingerprint := seedanceAccountFingerprint(config)
			if asset.AccountFingerprint != currentFingerprint {
				// 指纹不匹配，视为未注册
				return nil, nil
			}
			// fingerprint 匹配且非终态：刷新
			if asset.Status == "submitted" || asset.Status == "processing" {
				protocol := resolveSeedanceAssetProtocol(config.MaterialAPIFormat)
				_, _ = s.refreshSeedanceAssetStatus(ctx, asset, config, protocol)
			}
		}
	}
	return asset, nil
}

// ListUserSeedanceAssets 查询用户资产列表，支持 channelId 和 resourceIds 过滤。
// 使用当前渠道的 fingerprint 过滤：指纹不匹配的旧记录标记 expired 并从返回结果中排除，
// 前端收不到这些记录会将其视为"未注册"，与从未注册过的素材走相同流程。
func (s *Service) ListUserSeedanceAssets(ctx context.Context, userID string, channelID string, resourceIDs []string, modelName string) ([]model.SeedanceAsset, error) {
	assets, err := s.repo.SeedanceAssetsByResourceIDs(userID, resourceIDs)
	if err != nil {
		return nil, err
	}
	if len(assets) == 0 {
		return assets, nil
	}

	// 解析当前渠道配置，计算 fingerprint
	var currentFingerprint string
	var config providerConfig
	var protocol seedanceAssetProtocol
	if strings.TrimSpace(channelID) != "" {
		resolvedConfig, err := s.resolveProviderConfig(providerConfig{ChannelID: channelID, Model: modelName})
		if err == nil {
			config = resolvedConfig
			currentFingerprint = seedanceAccountFingerprint(config)
			protocol = resolveSeedanceAssetProtocol(config.MaterialAPIFormat)
		}
	}

	// 对每条记录检查 fingerprint 是否匹配
	var wg sync.WaitGroup
	var mu sync.Mutex
	for i := range assets {
		// fingerprint 不匹配：旧记录标记 expired 并排除，前端视为"未注册"
		if currentFingerprint != "" && assets[i].AccountFingerprint != currentFingerprint {
			if assets[i].Status != "expired" && assets[i].Status != "failed" {
				assets[i].Status = "expired"
				assets[i].UpdatedAt = time.Now()
				_ = s.repo.SaveSeedanceAsset(&assets[i])
			}
			continue
		}
		// fingerprint 匹配且非终态：并发刷新
		if assets[i].Status == "submitted" || assets[i].Status == "processing" {
			wg.Add(1)
			go func(idx int) {
				defer wg.Done()
				status, _ := s.refreshSeedanceAssetStatus(ctx, &assets[idx], config, protocol)
				if status != "" {
					mu.Lock()
					assets[idx].Status = status
					mu.Unlock()
				}
			}(i)
		}
	}
	wg.Wait()

	// 过滤掉指纹不匹配的记录，前端收不到即视为"未注册"
	filtered := make([]model.SeedanceAsset, 0, len(assets))
	for i := range assets {
		if currentFingerprint != "" && assets[i].AccountFingerprint != currentFingerprint {
			continue
		}
		filtered = append(filtered, assets[i])
	}
	if len(filtered) == 0 {
		return nil, nil
	}
	return filtered, nil
}

// VerifySeedanceAsset 触发重新验证资产状态。
func (s *Service) VerifySeedanceAsset(ctx context.Context, userID string, assetID string, channelID string, modelName string) (*model.SeedanceAsset, error) {
	asset, err := s.repo.SeedanceAssetByID(userID, assetID)
	if err != nil {
		return nil, err
	}
	if asset.UpstreamAssetID == "" {
		return asset, errors.New("资产尚未注册成功，无法验证")
	}
	config, err := s.resolveProviderConfig(providerConfig{ChannelID: firstNonEmpty(channelID, asset.ChannelID), Model: modelName})
	if err != nil {
		return nil, err
	}
	protocol := resolveSeedanceAssetProtocol(config.MaterialAPIFormat)
	_, err = s.refreshSeedanceAssetStatus(ctx, asset, config, protocol)
	return asset, err
}
