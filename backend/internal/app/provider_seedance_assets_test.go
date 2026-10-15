package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCallSeedanceCreateAssetUsesNewAPIContract(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/api/material/create_asset" {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		if got := request.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("authorization = %q", got)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		var body seedanceCreateAssetRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		if body.Name != "reference.png" || body.AssetType != "Image" || body.URL != "https://media.example.test/reference.png" || body.GroupType != "AIGC" || body.MediaAssetsID != 17 || body.ModelID != "seedance-2.0" || body.ModelName != "seedance-2.0" {
			t.Errorf("create body = %#v", body)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"Result":{"Id":"asset-created","Status":"Processing"}}`))
	}))
	defer server.Close()

	svc := &Service{}
	reply, err := svc.callSeedanceCreateAsset(context.Background(), providerConfig{BaseURL: "https://video.example.test/v1", MaterialBaseURL: server.URL, APIKey: "test-key"}, seedanceCreateAssetRequest{
		Name: "reference.png", AssetType: "Image", URL: "https://media.example.test/reference.png", GroupType: "AIGC", MediaAssetsID: 17, ModelID: "seedance-2.0", ModelName: "seedance-2.0",
	})
	if err != nil {
		t.Fatalf("callSeedanceCreateAsset() error = %v", err)
	}
	if reply.UpstreamAssetID != "asset-created" || reply.Status != "processing" {
		t.Fatalf("create reply = %#v", reply)
	}
}

func TestSeedanceAccountFingerprintChangesWithMaterialAPIVersion(t *testing.T) {
	base := providerConfig{ChannelID: "channel-1", BaseURL: "https://video.example.test/v1", APIKey: "test-key", Model: "seedance-2.0"}
	if got, want := seedanceAccountFingerprint(base), seedanceAccountFingerprint(providerConfig{ChannelID: base.ChannelID, BaseURL: base.BaseURL, APIKey: base.APIKey, Model: base.Model, MaterialAPIVersion: "reset-20261015"}); got == want {
		t.Fatal("material API version must change the Seedance asset account fingerprint")
	}
	if got, want := seedanceMaterialAPIVersion(base), defaultSeedanceMaterialAPIVersion; got != want {
		t.Fatalf("default material API version = %q, want %q", got, want)
	}
}

func TestCallSeedanceGetAssetUsesNewAPIContract(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/api/material/get_asset" {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		var body seedanceGetAssetRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		if body.ID != "asset-created" || body.ModelID != "seedance-2.0" || body.ModelName != "seedance-2.0" {
			t.Errorf("get body = %#v", body)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"Result":{"Id":"asset-created","Status":"Active"}}`))
	}))
	defer server.Close()

	svc := &Service{}
	reply, err := svc.callSeedanceGetAsset(context.Background(), providerConfig{BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "seedance-2.0"}, server.URL, "asset-created")
	if err != nil {
		t.Fatalf("callSeedanceGetAsset() error = %v", err)
	}
	if reply.UpstreamAssetID != "asset-created" || reply.Status != "approved" {
		t.Fatalf("get reply = %#v", reply)
	}
}

func TestParseSeedanceCreateAssetFallsBackToUpstreamAssetID(t *testing.T) {
	reply, err := parseSeedanceCreateAssetResponse([]byte(`{"upstream_asset_id":"asset-fallback","material_status":"submitted"}`), nil)
	if err != nil {
		t.Fatalf("parseSeedanceCreateAssetResponse() error = %v", err)
	}
	if reply.UpstreamAssetID != "asset-fallback" || reply.Status != "submitted" {
		t.Fatalf("reply = %#v", reply)
	}
}

func TestSeedanceAssetStatus(t *testing.T) {
	for raw, want := range map[string]string{"Submitted": "submitted", "Processing": "processing", "Active": "approved", "Rejected": "failed", "unknown": "failed"} {
		if got := seedanceAssetStatus(raw); got != want {
			t.Errorf("seedanceAssetStatus(%q) = %q, want %q", raw, got, want)
		}
	}
}
