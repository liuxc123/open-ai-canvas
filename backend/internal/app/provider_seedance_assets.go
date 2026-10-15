package app

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
	"path"
	"strings"
	"sync"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

const (
	seedanceAssetPollInitialInterval  = 2 * time.Second
	seedanceAssetPollMaxInterval      = 5 * time.Second
	seedanceAssetPollTimeout          = 5 * time.Minute
	seedanceCreateAssetTimeout        = 30 * time.Second
	seedanceAssetURLTTL               = time.Hour
	seedanceAssetPrepareConcurrency   = 3
	defaultSeedanceMaterialAPIVersion = "v1"
	seedanceMaterialAPIFormat         = "seedance-v1"
)

type seedanceCreateAssetRequest struct {
	Name          string `json:"Name"`
	AssetType     string `json:"AssetType"`
	URL           string `json:"URL"`
	GroupType     string `json:"GroupType"`
	MediaAssetsID int64  `json:"media_assets_id"`
	ModelID       string `json:"model_id"`
	ModelName     string `json:"model_name"`
}

type seedanceGetAssetRequest struct {
	ID        string `json:"Id"`
	ModelID   string `json:"model_id"`
	ModelName string `json:"model_name"`
}

type seedanceAssetUpstreamError struct {
	Code    string `json:"Code"`
	Message string `json:"Message"`
}

type seedanceCreateAssetResponse struct {
	Result struct {
		ID     string                      `json:"Id"`
		Status string                      `json:"Status"`
		Error  *seedanceAssetUpstreamError `json:"Error"`
	} `json:"Result"`
	MaterialStatus  string `json:"material_status"`
	UpstreamAssetID string `json:"upstream_asset_id"`
}

type seedanceGetAssetResponse struct {
	Result struct {
		ID     string                      `json:"Id"`
		Status string                      `json:"Status"`
		Error  *seedanceAssetUpstreamError `json:"Error"`
	} `json:"Result"`
}

type seedanceAssetReply struct {
	UpstreamAssetID string
	Status          string
	ErrorCode       string
	ErrorMessage    string
}

// SeedanceAssetPreparationFailure identifies an individual reference without
// exposing its registered signed URL or raw upstream response body to callers.
type SeedanceAssetPreparationFailure struct {
	ResourceID     string `json:"resourceId"`
	ReferenceType  string `json:"referenceType"`
	ReferenceIndex int    `json:"referenceIndex"`
	Role           string `json:"role"`
	Name           string `json:"name"`
	Stage          string `json:"stage"`
	Reason         string `json:"reason"`
	Message        string `json:"message"`
	Retryable      bool   `json:"retryable"`
}

type seedanceAssetPreparationError struct {
	Failures []SeedanceAssetPreparationFailure
}

func (e *seedanceAssetPreparationError) Error() string {
	parts := make([]string, 0, len(e.Failures))
	for _, failure := range e.Failures {
		label := firstNonEmptyString(failure.Name, failure.ResourceID, "素材")
		position := fmt.Sprintf("%s #%d", firstNonEmptyString(failure.ReferenceType, "参考素材"), failure.ReferenceIndex+1)
		if failure.Role != "" {
			position += " / " + failure.Role
		}
		parts = append(parts, fmt.Sprintf("%s（%s，%s）：%s", label, position, failure.Stage, failure.Message))
	}
	return "Seedance 素材准备失败：" + strings.Join(parts, "；")
}

func isSeedanceAssetVideoConfig(config providerConfig) bool {
	return strings.TrimSpace(config.InterfaceType) == "custom-newapi-channel"
}

// prepareSeedanceAssetReferences turns owned resource references into the
// asset:// identifiers consumed by the custom NewAPI plugin. It deliberately
// does not trust arbitrary URL/DataURL inputs as material-upload sources.
func (s *Service) prepareSeedanceAssetReferences(ctx context.Context, userID string, input *canvasGenerationInput) error {
	if input == nil || input.Mode != "video" || !isSeedanceAssetVideoConfig(input.Config) {
		return nil
	}
	type reference struct {
		media         *providerMedia
		index         int
		referenceType string
	}
	references := make([]reference, 0, len(input.ReferenceImages)+len(input.ReferenceVideos)+len(input.ReferenceAudios))
	for index := range input.ReferenceImages {
		references = append(references, reference{media: &input.ReferenceImages[index], index: index, referenceType: "图片"})
	}
	for index := range input.ReferenceVideos {
		references = append(references, reference{media: &input.ReferenceVideos[index], index: index, referenceType: "视频"})
	}
	for index := range input.ReferenceAudios {
		references = append(references, reference{media: &input.ReferenceAudios[index], index: index, referenceType: "音频"})
	}
	if taskID := taskExecutionID(ctx); taskID != "" && len(references) > 0 {
		_ = s.repo.UpdateTaskProgress(taskID, "正在准备 Seedance 素材", 0)
	}
	var (
		failures []SeedanceAssetPreparationFailure
		mu       sync.Mutex
		wg       sync.WaitGroup
		jobs     = make(chan reference)
	)
	worker := func() {
		defer wg.Done()
		for item := range jobs {
			media := item.media
			if strings.HasPrefix(strings.TrimSpace(media.URL), "asset://") {
				continue
			}
			resourceID := seedanceAssetResourceID(*media)
			if resourceID == "" {
				continue
			}
			asset, stage, err := s.ensureSeedanceAsset(ctx, userID, resourceID, input.Config)
			if err != nil {
				failure := SeedanceAssetPreparationFailure{
					ResourceID: resourceID, ReferenceType: item.referenceType, ReferenceIndex: item.index, Role: media.Role, Name: media.Name,
					Stage: stage, Reason: seedanceAssetFailureReason(err), Message: seedanceAssetSafeMessage(err.Error()), Retryable: seedanceAssetRetryable(err),
				}
				mu.Lock()
				failures = append(failures, failure)
				mu.Unlock()
				continue
			}
			if asset == nil || strings.TrimSpace(asset.UpstreamAssetID) == "" {
				mu.Lock()
				failures = append(failures, SeedanceAssetPreparationFailure{ResourceID: resourceID, ReferenceType: item.referenceType, ReferenceIndex: item.index, Role: media.Role, Name: media.Name, Stage: "get_asset", Reason: "upstream_asset_missing", Message: "上游素材 ID 缺失", Retryable: true})
				mu.Unlock()
				continue
			}
			media.URL = "asset://" + asset.UpstreamAssetID
			media.DataURL = ""
		}
	}
	workers := seedanceAssetPrepareConcurrency
	if len(references) < workers {
		workers = len(references)
	}
	for index := 0; index < workers; index++ {
		wg.Add(1)
		go worker()
	}
	for _, item := range references {
		jobs <- item
	}
	close(jobs)
	wg.Wait()
	if len(failures) > 0 {
		return &seedanceAssetPreparationError{Failures: failures}
	}
	if taskID := taskExecutionID(ctx); taskID != "" && len(references) > 0 {
		_ = s.repo.UpdateTaskProgress(taskID, "作品创作中", 0)
	}
	return nil
}

func seedanceAssetResourceID(media providerMedia) string {
	if !strings.HasPrefix(strings.TrimSpace(media.StorageKey), "resource:") {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(media.StorageKey, "resource:"))
}

func (s *Service) ensureSeedanceAsset(ctx context.Context, userID, resourceID string, config providerConfig) (*model.SeedanceAsset, string, error) {
	resource, err := s.Resource(userID, resourceID)
	if err != nil {
		return nil, "read_resource", fmt.Errorf("读取素材失败：%w", err)
	}
	if resource.Status != model.ResourceStatusReady {
		return nil, "read_resource", errors.New("素材尚未上传完成")
	}
	assetType, err := seedanceAssetType(resource.Kind)
	if err != nil {
		return nil, "create_asset", err
	}
	resourceHash, err := s.seedanceResourceHash(resource)
	if err != nil {
		return nil, "read_resource", fmt.Errorf("计算素材内容标识失败：%w", err)
	}
	accountFingerprint := seedanceAccountFingerprint(config)
	binding, err := s.repo.SeedanceAssetByIdentity(userID, resource.ID, accountFingerprint)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, "create_asset", err
	}
	if binding != nil {
		if binding.ResourceHash != resourceHash {
			binding.Status = "expired"
			binding.ErrorResponse = "素材内容已变更，等待重新注册"
			if err := s.repo.SaveSeedanceAsset(binding); err != nil {
				return nil, "create_asset", err
			}
		}
		switch binding.Status {
		case "approved":
			return binding, "", nil
		case "submitted", "processing":
			return s.waitForSeedanceAsset(ctx, binding, config)
		case "submitting":
			return s.waitForSeedanceRegistration(ctx, binding, config)
		case "failed", "expired":
			claimed, claimErr := s.repo.ClaimSeedanceAssetRetry(binding, time.Now())
			if claimErr != nil {
				return nil, "create_asset", claimErr
			}
			if !claimed {
				binding, err = s.repo.SeedanceAssetByIdentity(userID, resource.ID, accountFingerprint)
				if err != nil {
					return nil, "create_asset", err
				}
				return s.waitForSeedanceRegistration(ctx, binding, config)
			}
			binding.UpstreamAssetID = ""
			binding.Status = "submitting"
			binding.ErrorResponse = ""
			binding.ApprovedAt = nil
		}
	}
	if binding == nil {
		binding = &model.SeedanceAsset{
			ID: newID(), UserID: userID, ResourceID: resource.ID, Name: seedanceAssetName(resource), AssetType: assetType, ResourceHash: resourceHash,
			ChannelID: config.ChannelID, AccountFingerprint: accountFingerprint, MaterialBaseURL: seedanceMaterialBaseURL(config),
			MaterialAPIVersion: seedanceMaterialAPIVersion(config), MaterialAPIFormat: seedanceMaterialAPIFormat, GroupType: "AIGC", Status: "submitting",
		}
		created, createErr := s.repo.CreateSeedanceAsset(binding)
		if createErr != nil {
			return nil, "create_asset", createErr
		}
		if !created {
			binding, err = s.repo.SeedanceAssetByIdentity(userID, resource.ID, accountFingerprint)
			if err != nil {
				return nil, "create_asset", err
			}
			return s.waitForSeedanceRegistration(ctx, binding, config)
		}
	}

	resourceURL, err := s.providerResourceURL(resource, time.Now().Add(seedanceAssetURLTTL))
	if err != nil {
		return nil, "create_asset", s.failSeedanceAsset(binding, fmt.Errorf("生成上游素材地址失败：%w", err))
	}
	binding.Name = seedanceAssetName(resource)
	binding.AssetType = assetType
	binding.URL = resourceURL
	binding.ResourceHash = resourceHash
	binding.ChannelID = config.ChannelID
	binding.MaterialBaseURL = seedanceMaterialBaseURL(config)
	binding.MaterialAPIVersion = seedanceMaterialAPIVersion(config)
	binding.MaterialAPIFormat = seedanceMaterialAPIFormat
	binding.GroupType = "AIGC"
	binding.MediaAssetsID = int(binding.Seq)
	binding.ErrorResponse = ""
	if err := s.repo.SaveSeedanceAsset(binding); err != nil {
		return nil, "create_asset", err
	}
	reply, err := s.callSeedanceCreateAsset(ctx, config, seedanceCreateAssetRequest{
		Name: seedanceAssetName(resource), AssetType: assetType, URL: resourceURL, GroupType: "AIGC",
		MediaAssetsID: binding.Seq, ModelID: config.Model, ModelName: config.Model,
	})
	if err != nil {
		return nil, "create_asset", s.failSeedanceAsset(binding, fmt.Errorf("调用 create_asset 失败：%w", err))
	}
	if reply.UpstreamAssetID == "" {
		return nil, "create_asset", s.failSeedanceAsset(binding, errors.New(firstNonEmptyString(reply.ErrorMessage, "上游没有返回素材 ID")))
	}
	binding.UpstreamAssetID = reply.UpstreamAssetID
	binding.Status = reply.Status
	binding.ErrorResponse = reply.ErrorMessage
	if err := s.repo.SaveSeedanceAsset(binding); err != nil {
		return nil, "create_asset", err
	}
	if binding.Status == "failed" {
		return nil, "create_asset", errors.New(firstNonEmptyString(binding.ErrorResponse, "上游拒绝素材注册"))
	}
	return s.waitForSeedanceAsset(ctx, binding, config)
}

func (s *Service) waitForSeedanceRegistration(ctx context.Context, binding *model.SeedanceAsset, config providerConfig) (*model.SeedanceAsset, string, error) {
	deadline := time.Now().Add(seedanceCreateAssetTimeout)
	for time.Now().Before(deadline) {
		if binding.UpstreamAssetID != "" || binding.Status != "submitting" {
			return s.waitForSeedanceAsset(ctx, binding, config)
		}
		if err := sleepContext(ctx, 500*time.Millisecond); err != nil {
			return nil, "create_asset", err
		}
		latest, err := s.repo.SeedanceAssetByIdentity(binding.UserID, binding.ResourceID, binding.AccountFingerprint)
		if err != nil {
			return nil, "create_asset", err
		}
		binding = latest
	}
	return nil, "create_asset", errors.New("等待其他任务注册素材超时，请稍后重试")
}

func (s *Service) waitForSeedanceAsset(ctx context.Context, binding *model.SeedanceAsset, config providerConfig) (*model.SeedanceAsset, string, error) {
	if binding == nil {
		return nil, "get_asset", errors.New("素材记录缺少上游素材 ID")
	}
	if binding.Status == "failed" || binding.Status == "expired" {
		return nil, "get_asset", errors.New(firstNonEmptyString(binding.ErrorResponse, "上游素材不可用"))
	}
	if binding.UpstreamAssetID == "" {
		return nil, "get_asset", errors.New("素材记录缺少上游素材 ID")
	}
	deadline := time.Now().Add(seedanceAssetPollTimeout)
	interval := seedanceAssetPollInitialInterval
	for time.Now().Before(deadline) {
		switch binding.Status {
		case "approved":
			return binding, "", nil
		case "failed", "expired":
			return nil, "get_asset", errors.New(firstNonEmptyString(binding.ErrorResponse, "上游素材不可用"))
		}
		if format := strings.TrimSpace(binding.MaterialAPIFormat); format != "" && format != seedanceMaterialAPIFormat {
			return nil, "get_asset", fmt.Errorf("不支持的 Seedance 素材协议格式：%s", format)
		}
		reply, err := s.callSeedanceGetAsset(ctx, config, binding.MaterialBaseURL, binding.UpstreamAssetID)
		if err != nil {
			var httpErr providerHTTPError
			if errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusNotFound {
				binding.Status = "expired"
				binding.ErrorResponse = "上游素材已不存在，请重新提交"
				_ = s.repo.SaveSeedanceAsset(binding)
			}
			return nil, "get_asset", err
		}
		binding.Status = reply.Status
		binding.ErrorResponse = reply.ErrorMessage
		if reply.Status == "approved" {
			now := time.Now()
			binding.ApprovedAt = &now
			binding.ErrorResponse = ""
		}
		if err := s.repo.SaveSeedanceAsset(binding); err != nil {
			return nil, "get_asset", err
		}
		if binding.Status == "approved" {
			return binding, "", nil
		}
		if binding.Status == "failed" {
			return nil, "get_asset", errors.New(firstNonEmptyString(binding.ErrorResponse, "上游素材审核失败"))
		}
		if err := sleepContext(ctx, interval); err != nil {
			return nil, "get_asset", err
		}
		if interval < seedanceAssetPollMaxInterval {
			interval += time.Second
		}
	}
	binding.Status = "expired"
	binding.ErrorResponse = "等待上游素材可用超时"
	_ = s.repo.SaveSeedanceAsset(binding)
	return nil, "timeout", errors.New(binding.ErrorResponse)
}

func (s *Service) failSeedanceAsset(binding *model.SeedanceAsset, err error) error {
	binding.Status = "failed"
	binding.ErrorResponse = seedanceAssetSafeMessage(err.Error())
	if saveErr := s.repo.SaveSeedanceAsset(binding); saveErr != nil {
		return saveErr
	}
	return err
}

func (s *Service) seedanceResourceHash(resource *model.Resource) (string, error) {
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

func seedanceAssetType(kind string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "image":
		return "Image", nil
	case "video":
		return "Video", nil
	case "audio":
		return "Audio", nil
	default:
		return "", fmt.Errorf("Seedance 不支持该素材类型：%s", kind)
	}
}

func seedanceAssetName(resource *model.Resource) string {
	name := path.Base(strings.TrimSpace(resource.ObjectKey))
	if name == "." || name == "/" || name == "" {
		name = resource.ID
	}
	return truncateRunes(name, 240)
}

func seedanceMaterialBaseURL(config providerConfig) string {
	if base := strings.TrimRight(strings.TrimSpace(config.MaterialBaseURL), "/"); base != "" {
		return base
	}
	base := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	return strings.TrimSuffix(base, "/v1")
}

func seedanceMaterialAPIVersion(config providerConfig) string {
	if version := strings.TrimSpace(config.MaterialAPIVersion); version != "" {
		return version
	}
	return defaultSeedanceMaterialAPIVersion
}

func seedanceAccountFingerprint(config providerConfig) string {
	raw := strings.TrimSpace(config.ChannelID) + "\n" + seedanceMaterialBaseURL(config) + "\n" + strings.TrimSpace(config.APIKey) + "\n" + seedanceMaterialAPIVersion(config) + "\n" + seedanceMaterialAPIFormat + "\n" + strings.TrimSpace(config.Model)
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func (s *Service) callSeedanceCreateAsset(ctx context.Context, config providerConfig, payload seedanceCreateAssetRequest) (seedanceAssetReply, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return seedanceAssetReply{}, err
	}
	requestContext, cancel := context.WithTimeout(withoutProviderAnalytics(ctx), seedanceCreateAssetTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestContext, http.MethodPost, seedanceMaterialBaseURL(config)+"/api/material/create_asset", bytes.NewReader(data))
	if err != nil {
		return seedanceAssetReply{}, err
	}
	ApplyOutboundHeaders(req, config.Headers)
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	req.Header.Set("Content-Type", "application/json")
	return parseSeedanceCreateAssetResponse(doSeedanceAssetJSON(req))
}

func (s *Service) callSeedanceGetAsset(ctx context.Context, config providerConfig, materialBaseURL string, assetID string) (seedanceAssetReply, error) {
	data, err := json.Marshal(seedanceGetAssetRequest{ID: assetID, ModelID: config.Model, ModelName: config.Model})
	if err != nil {
		return seedanceAssetReply{}, err
	}
	baseURL := strings.TrimRight(strings.TrimSpace(materialBaseURL), "/")
	if baseURL == "" {
		baseURL = seedanceMaterialBaseURL(config)
	}
	req, err := http.NewRequestWithContext(withoutProviderAnalytics(ctx), http.MethodPost, baseURL+"/api/material/get_asset", bytes.NewReader(data))
	if err != nil {
		return seedanceAssetReply{}, err
	}
	ApplyOutboundHeaders(req, config.Headers)
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	req.Header.Set("Content-Type", "application/json")
	return parseSeedanceGetAssetResponse(doSeedanceAssetJSON(req))
}

func doSeedanceAssetJSON(req *http.Request) ([]byte, error) {
	data, mimeType, err := doBinary(req)
	if err != nil {
		return nil, err
	}
	if !strings.Contains(strings.ToLower(mimeType), "json") && !json.Valid(data) {
		return nil, providerResponseDecodeError{Err: fmt.Errorf("素材接口返回非 JSON 内容：%s", mimeType)}
	}
	return data, nil
}

func parseSeedanceCreateAssetResponse(body []byte, requestErr error) (seedanceAssetReply, error) {
	if requestErr != nil {
		return seedanceAssetReply{}, requestErr
	}
	var response seedanceCreateAssetResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return seedanceAssetReply{}, providerResponseDecodeError{Err: err}
	}
	reply := seedanceAssetReply{UpstreamAssetID: firstNonEmptyString(response.Result.ID, response.UpstreamAssetID), Status: seedanceAssetStatus(firstNonEmptyString(response.Result.Status, response.MaterialStatus))}
	if response.Result.Error != nil {
		reply.ErrorCode = truncateRunes(strings.TrimSpace(response.Result.Error.Code), 80)
		reply.ErrorMessage = seedanceAssetSafeMessage(response.Result.Error.Message)
	}
	if reply.Status == "failed" && reply.ErrorMessage == "" {
		reply.ErrorMessage = "上游拒绝素材注册"
	}
	return reply, nil
}

func parseSeedanceGetAssetResponse(body []byte, requestErr error) (seedanceAssetReply, error) {
	if requestErr != nil {
		return seedanceAssetReply{}, requestErr
	}
	var response seedanceGetAssetResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return seedanceAssetReply{}, providerResponseDecodeError{Err: err}
	}
	reply := seedanceAssetReply{UpstreamAssetID: strings.TrimSpace(response.Result.ID), Status: seedanceAssetStatus(response.Result.Status)}
	if response.Result.Error != nil {
		reply.ErrorCode = truncateRunes(strings.TrimSpace(response.Result.Error.Code), 80)
		reply.ErrorMessage = seedanceAssetSafeMessage(response.Result.Error.Message)
	}
	if strings.TrimSpace(response.Result.Status) == "" && reply.ErrorMessage == "" {
		return seedanceAssetReply{}, errors.New("上游素材状态缺失")
	}
	if reply.Status == "failed" && reply.ErrorMessage == "" {
		reply.ErrorMessage = "上游素材审核失败"
	}
	return reply, nil
}

func seedanceAssetStatus(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "submitted":
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

func seedanceAssetSafeMessage(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	return truncateRunes(providerPayloadErrorMessage(value), 500)
}

func seedanceAssetFailureReason(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "upstream_timeout"
	}
	var httpErr providerHTTPError
	if errors.As(err, &httpErr) {
		return fmt.Sprintf("upstream_http_%d", httpErr.StatusCode)
	}
	return "upstream_asset_failed"
}

func seedanceAssetRetryable(err error) bool {
	if errors.Is(err, context.Canceled) {
		return false
	}
	var httpErr providerHTTPError
	if errors.As(err, &httpErr) {
		return httpErr.StatusCode == http.StatusTooManyRequests || httpErr.StatusCode >= http.StatusInternalServerError
	}
	return true
}
