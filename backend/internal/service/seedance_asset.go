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

// ===== 请求/响应结构体 =====

type seedanceCreateAssetRequest struct {
	Name          string `json:"Name"`
	AssetType     string `json:"AssetType"`
	URL           string `json:"URL"`
	GroupType     string `json:"GroupType"`
	MediaAssetsID int    `json:"media_assets_id"`
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
		ID string `json:"Id"`
	} `json:"Result"`
	MaterialStatus  string `json:"material_status"`
	MediaAssetsID   int    `json:"media_assets_id"`
	UpstreamAssetID string `json:"upstream_asset_id"`
}

type seedanceGetAssetRequest struct {
	ID string `json:"Id"`
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
		ID         string `json:"Id"`
		Name       string `json:"Name"`
		URL        string `json:"URL"`
		AssetType  string `json:"AssetType"`
		GroupID    string `json:"GroupId"`
		Status     string `json:"Status"`
		Moderation struct {
			Strategy string `json:"Strategy"`
		} `json:"Moderation"`
		CreateTime  string `json:"CreateTime"`
		UpdateTime  string `json:"UpdateTime"`
		ProjectName string `json:"ProjectName"`
	} `json:"Result"`
}

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

func (s *Service) callSeedanceCreateAsset(ctx context.Context, config providerConfig, req seedanceCreateAssetRequest) (*seedanceCreateAssetResponse, error) {
	baseURL := seedanceMaterialBaseURL(config)
	url := baseURL + "/api/material/create_asset"
	data, _ := json.Marshal(req)
	httpCtx, cancel := context.WithTimeout(ctx, seedanceCreateAssetTimeout)
	defer cancel()
	httpRequest, err := http.NewRequestWithContext(httpCtx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	httpRequest.Header.Set("Authorization", "Bearer "+config.APIKey)
	httpRequest.Header.Set("Content-Type", "application/json")
	ApplyOutboundHeaders(httpRequest, config.Headers)
	var resp seedanceCreateAssetResponse
	return &resp, doJSON(httpRequest, &resp)
}

func (s *Service) callSeedanceGetAsset(ctx context.Context, materialBaseURL string, apiKey string, upstreamAssetID string) (*seedanceGetAssetResponse, error) {
	url := strings.TrimRight(materialBaseURL, "/") + "/api/material/get_asset"
	body := seedanceGetAssetRequest{ID: upstreamAssetID}
	data, _ := json.Marshal(body)
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	httpRequest.Header.Set("Authorization", "Bearer "+apiKey)
	httpRequest.Header.Set("Content-Type", "application/json")
	var resp seedanceGetAssetResponse
	return &resp, doJSON(httpRequest, &resp)
}

// ===== 核心业务逻辑 =====

// EnsureSeedanceAsset 确保资源已在 Seedance 注册并审核通过（幂等）。
// 视频生成流程调用此函数。
func (s *Service) EnsureSeedanceAsset(ctx context.Context, userID string, resourceID string, config providerConfig) (*model.SeedanceAsset, error) {
	fingerprint := seedanceAccountFingerprint(config)

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
			return s.pollAndUpdateAsset(ctx, existing, config.APIKey)
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
	return s.registerAndPollAsset(ctx, userID, resourceID, config, fingerprint)
}

// registerAndPollAsset 执行完整的注册+轮询流程。
func (s *Service) registerAndPollAsset(ctx context.Context, userID string, resourceID string, config providerConfig, fingerprint string) (*model.SeedanceAsset, error) {
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		return nil, fmt.Errorf("读取资源失败：%w", err)
	}
	if resource.Status != model.ResourceStatusReady {
		return nil, errors.New("资源尚未上传完成")
	}
	assetType, err := resourceAssetType(resource.Kind)
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
		GroupType:          "AIGC",
		Status:             "submitting",
	}
	if err := s.repo.CreateSeedanceAsset(record); err != nil {
		return nil, fmt.Errorf("创建资产记录失败：%w", err)
	}
	// 调 create_asset
	req := seedanceCreateAssetRequest{
		Name:          name,
		AssetType:     assetType,
		URL:           signedURL,
		GroupType:     "AIGC",
		MediaAssetsID: int(record.Seq),
	}
	resp, err := s.callSeedanceCreateAsset(ctx, config, req)
	if err != nil {
		record.Status = "failed"
		record.ErrorResponse = err.Error()
		record.UpdatedAt = time.Now()
		_ = s.repo.SaveSeedanceAsset(record)
		return record, fmt.Errorf("调用 create_asset 失败：%w", err)
	}
	if strings.TrimSpace(resp.UpstreamAssetID) == "" {
		record.Status = "failed"
		record.ErrorResponse = "上游未返回资产 ID"
		record.UpdatedAt = time.Now()
		_ = s.repo.SaveSeedanceAsset(record)
		return record, errors.New("上游未返回资产 ID")
	}
	// 更新记录
	record.UpstreamAssetID = resp.UpstreamAssetID
	record.Status = defaultString(resp.MaterialStatus, "submitted")
	record.MediaAssetsID = resp.MediaAssetsID
	record.UpdatedAt = time.Now()
	if err := s.repo.SaveSeedanceAsset(record); err != nil {
		return nil, fmt.Errorf("更新资产记录失败：%w", err)
	}
	// 轮询 get_asset 直到终态
	return s.pollAndUpdateAsset(ctx, record, config.APIKey)
}

// pollAndUpdateAsset 轮询 get_asset 直到终态并更新数据库。
func (s *Service) pollAndUpdateAsset(ctx context.Context, asset *model.SeedanceAsset, apiKey string) (*model.SeedanceAsset, error) {
	if asset.UpstreamAssetID == "" {
		return asset, errors.New("资产记录缺少 upstream_asset_id，无法轮询")
	}
	status, err := s.pollSeedanceAssetStatus(ctx, asset.MaterialBaseURL, apiKey, asset.UpstreamAssetID)
	if err != nil {
		asset.Status = "failed"
		asset.ErrorResponse = err.Error()
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
func (s *Service) pollSeedanceAssetStatus(ctx context.Context, materialBaseURL string, apiKey string, upstreamAssetID string) (string, error) {
	deadline := time.Now().Add(seedanceAssetPollTimeout)
	interval := seedanceAssetPollMinInterval
	for time.Now().Before(deadline) {
		resp, err := s.callSeedanceGetAsset(ctx, materialBaseURL, apiKey, upstreamAssetID)
		if err != nil {
			return "", err
		}
		status := mapSeedanceAssetStatus(resp.Result.Status)
		switch status {
		case "approved":
			return status, nil
		case "failed":
			return status, errors.New("Seedance 资产审核失败")
		}
		if err := sleepContext(ctx, interval); err != nil {
			return "", err
		}
		interval += 1 * time.Second
		if interval > seedanceAssetPollMaxInterval {
			interval = seedanceAssetPollMaxInterval
		}
	}
	return "failed", errors.New("Seedance 资产审核超时")
}

// refreshSeedanceAssetStatus 调 get_asset 刷新单个资产状态并写回数据库。
func (s *Service) refreshSeedanceAssetStatus(ctx context.Context, asset *model.SeedanceAsset, apiKey string) (string, error) {
	if asset.UpstreamAssetID == "" {
		return asset.Status, nil
	}
	resp, err := s.callSeedanceGetAsset(ctx, asset.MaterialBaseURL, apiKey, asset.UpstreamAssetID)
	if err != nil {
		return asset.Status, err
	}
	status := mapSeedanceAssetStatus(resp.Result.Status)
	if status != asset.Status {
		asset.Status = status
		asset.UpdatedAt = time.Now()
		if status == "approved" {
			now := time.Now()
			asset.ApprovedAt = &now
			asset.ErrorResponse = ""
		} else if status == "failed" {
			asset.ErrorResponse = "审核失败"
		}
		_ = s.repo.SaveSeedanceAsset(asset)
	}
	return status, nil
}

// registerSeedanceAssetOnly 只注册不等待：create_asset + 写入 submitted 后返回。
func (s *Service) registerSeedanceAssetOnly(ctx context.Context, userID string, resourceID string, config providerConfig) (*model.SeedanceAsset, error) {
	fingerprint := seedanceAccountFingerprint(config)

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
	assetType, err := resourceAssetType(resource.Kind)
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
		GroupType:          "AIGC",
		Status:             "submitting",
	}
	if err := s.repo.CreateSeedanceAsset(record); err != nil {
		return nil, fmt.Errorf("创建资产记录失败：%w", err)
	}
	req := seedanceCreateAssetRequest{
		Name:          name,
		AssetType:     assetType,
		URL:           signedURL,
		GroupType:     "AIGC",
		MediaAssetsID: int(record.Seq),
	}
	resp, err := s.callSeedanceCreateAsset(ctx, config, req)
	if err != nil {
		record.Status = "failed"
		record.ErrorResponse = err.Error()
		record.UpdatedAt = time.Now()
		_ = s.repo.SaveSeedanceAsset(record)
		return record, fmt.Errorf("调用 create_asset 失败：%w", err)
	}
	if strings.TrimSpace(resp.UpstreamAssetID) == "" {
		record.Status = "failed"
		record.ErrorResponse = "上游未返回资产 ID"
		record.UpdatedAt = time.Now()
		_ = s.repo.SaveSeedanceAsset(record)
		return record, errors.New("上游未返回资产 ID")
	}
	record.UpstreamAssetID = resp.UpstreamAssetID
	record.Status = defaultString(resp.MaterialStatus, "submitted")
	record.MediaAssetsID = resp.MediaAssetsID
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

// RegisterSeedanceAssetsBatch 批量注册资产，不同渠道并发、同渠道串行。
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
				for _, idx := range indices {
					results[idx] = SeedanceRegisterResult{ResourceID: items[idx].ResourceID, Error: err.Error()}
				}
				return
			}
			for _, idx := range indices {
				asset, err := s.registerSeedanceAssetOnly(ctx, userID, items[idx].ResourceID, config)
				mu.Lock()
				if err != nil {
					results[idx] = SeedanceRegisterResult{ResourceID: items[idx].ResourceID, Error: err.Error()}
				} else {
					results[idx] = SeedanceRegisterResult{ResourceID: items[idx].ResourceID, Asset: asset}
				}
				mu.Unlock()
			}
		}(channelID, indices)
	}
	wg.Wait()
	return results, nil
}

// ListSeedanceAssets 批量查询资产，非终态资产并发调 get_asset 刷新。
func (s *Service) ListSeedanceAssets(ctx context.Context, userID string, channelID string, resourceIDs []string, apiKey string) ([]model.SeedanceAsset, error) {
	assets, err := s.repo.SeedanceAssetsByResourceIDs(userID, resourceIDs)
	if err != nil {
		return nil, err
	}
	var wg sync.WaitGroup
	for i := range assets {
		if assets[i].Status != "submitted" && assets[i].Status != "processing" {
			continue
		}
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			status, _ := s.refreshSeedanceAssetStatus(ctx, &assets[idx], apiKey)
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
// 分别遍历三组切片，确保修改回写到 input。
func (s *Service) ensureSeedanceAssetsForVideoGeneration(ctx context.Context, userID string, input *canvasGenerationInput) error {
	groups := [][]providerMedia{input.ReferenceImages, input.ReferenceVideos, input.ReferenceAudios}
	for _, group := range groups {
		for i := range group {
			media := &group[i]
			if strings.HasPrefix(media.URL, "asset://") || strings.HasPrefix(media.DataURL, "data:") {
				continue
			}
			resourceID := strings.TrimPrefix(media.StorageKey, "resource:")
			if resourceID == "" || resourceID == media.StorageKey {
				continue
			}
			asset, err := s.EnsureSeedanceAsset(ctx, userID, resourceID, input.Config)
			if err != nil {
				return fmt.Errorf("Seedance 资产注册失败（%s）：%w", media.Name, err)
			}
			if asset.Status != "approved" {
				return fmt.Errorf("Seedance 资产 %s 未审核通过（状态：%s）", media.Name, asset.Status)
			}
			media.URL = "asset://" + asset.UpstreamAssetID
			media.DataURL = ""
		}
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
func (s *Service) GetSeedanceAsset(ctx context.Context, userID string, assetID string, channelID string, model string) (*model.SeedanceAsset, error) {
	asset, err := s.repo.SeedanceAssetByID(userID, assetID)
	if err != nil {
		return nil, err
	}
	if asset.Status == "submitted" || asset.Status == "processing" {
		config, err := s.resolveProviderConfig(providerConfig{ChannelID: firstNonEmpty(channelID, asset.ChannelID), Model: model})
		if err == nil {
			_, _ = s.refreshSeedanceAssetStatus(ctx, asset, config.APIKey)
		}
	}
	return asset, nil
}

// ListUserSeedanceAssets 查询用户资产列表，支持 channelId 和 resourceIds 过滤。
func (s *Service) ListUserSeedanceAssets(ctx context.Context, userID string, channelID string, resourceIDs []string, model string) ([]model.SeedanceAsset, error) {
	assets, err := s.repo.SeedanceAssetsByResourceIDs(userID, resourceIDs)
	if err != nil {
		return nil, err
	}
	// 对非终态资产并发调 get_asset 刷新
	var wg sync.WaitGroup
	var mu sync.Mutex
	needConfig := false
	for i := range assets {
		if assets[i].Status == "submitted" || assets[i].Status == "processing" {
			needConfig = true
			break
		}
	}
	var apiKey string
	if needConfig {
		config, err := s.resolveProviderConfig(providerConfig{ChannelID: channelID, Model: model})
		if err == nil {
			apiKey = config.APIKey
		}
	}
	for i := range assets {
		if assets[i].Status != "submitted" && assets[i].Status != "processing" {
			continue
		}
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			status, _ := s.refreshSeedanceAssetStatus(ctx, &assets[idx], apiKey)
			if status != "" {
				mu.Lock()
				assets[idx].Status = status
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	return assets, nil
}

// VerifySeedanceAsset 触发重新验证资产状态。
func (s *Service) VerifySeedanceAsset(ctx context.Context, userID string, assetID string, channelID string, model string) (*model.SeedanceAsset, error) {
	asset, err := s.repo.SeedanceAssetByID(userID, assetID)
	if err != nil {
		return nil, err
	}
	if asset.UpstreamAssetID == "" {
		return asset, errors.New("资产尚未注册成功，无法验证")
	}
	config, err := s.resolveProviderConfig(providerConfig{ChannelID: firstNonEmpty(channelID, asset.ChannelID), Model: model})
	if err != nil {
		return nil, err
	}
	_, err = s.refreshSeedanceAssetStatus(ctx, asset, config.APIKey)
	return asset, err
}
