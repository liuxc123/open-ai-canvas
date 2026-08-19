package model

import "time"

// SeedanceAsset 记录用户资源在 Seedance 上游的注册状态。
// 同一资源在不同账号（APIKey + MaterialBaseURL + MaterialAPIVersion）下各自独立注册，
// 通过 AccountFingerprint 复合唯一键实现换 Key / 换地址时的自动重新注册。
type SeedanceAsset struct {
	ID     string `json:"id" gorm:"primaryKey;size:36"`
	Seq    int64  `json:"seq" gorm:"autoIncrement"` // 自增序列，用作 create_asset 请求的 media_assets_id
	UserID string `json:"userId" gorm:"index;size:36;uniqueIndex:idx_seedance_asset_identity,priority:1"`

	// ===== 资源关联 =====
	ResourceID   string `json:"resourceId" gorm:"index;size:36;uniqueIndex:idx_seedance_asset_identity,priority:2"`
	Name         string `json:"name" gorm:"size:240"`                       // 注册时使用的文件名
	AssetType    string `json:"assetType" gorm:"size:24"`                   // Image / Video / Audio
	URL          string `json:"url"`                                        // 注册时使用的签名公网 URL（仅用于审计/排障，签名会过期）
	ResourceHash string `json:"resourceHash" gorm:"size:80;index"`         // 资源内容 hash（etag:xxx 或 sha256:xxx），检测资源是否变更

	// ===== 账号身份维度 =====
	ChannelID          string `json:"channelId" gorm:"index;size:36"`      // 本系统渠道 ID，用于反查渠道配置
	AccountFingerprint string `json:"accountFingerprint" gorm:"index;size:64;uniqueIndex:idx_seedance_asset_identity,priority:3"`
	// AccountFingerprint = SHA256(MaterialBaseURL + ":" + APIKey + ":" + MaterialAPIVersion)

	// ===== 上游 Seedance/Ark 返回 =====
	UpstreamAssetID    string `json:"upstreamAssetId" gorm:"index;size:120"`       // 响应中的 upstream_asset_id（核心：用于 asset:// 引用）
	MaterialBaseURL    string `json:"materialBaseUrl,omitempty" gorm:"size:500"`    // 注册时使用的资产 API 地址，后续 get_asset 查询用
	MaterialAPIVersion string `json:"materialApiVersion,omitempty" gorm:"size:24"`  // 注册时使用的资产 API 版本号（如 "v1"），纳入指纹计算
	MaterialAPIFormat  string `json:"materialApiFormat,omitempty" gorm:"size:32"`   // 注册时使用的资产 API 协议格式（如 "seedance-v1"），决定请求/响应字段映射

	// ===== 注册请求上下文 =====
	GroupType     string `json:"groupType" gorm:"size:24"`      // 固定 "AIGC"
	MediaAssetsID int    `json:"mediaAssetsId" gorm:"index"`     // 请求中的 media_assets_id

	// ===== 状态 =====
	Status        string     `json:"status" gorm:"index;size:24"` // submitting / submitted / processing / approved / failed / expired
	ErrorResponse string     `json:"errorResponse,omitempty" gorm:"type:text"`
	ApprovedAt    *time.Time `json:"approvedAt"`                  // 审核通过时间

	CreatedAt time.Time `json:"createdAt" gorm:"index"`
	UpdatedAt time.Time `json:"updatedAt"`
}
