package protocol

import (
	"context"
	"testing"
)

func TestCustomNewAPIChannelBuildsMetadataContent(t *testing.T) {
	adapter := officialPackageAdapter(t, "custom-newapi-channel.yingce-plugin", "custom-newapi-channel")
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model:         "seedance-2.0-v3",
		Prompt:        "cinematic close-up",
		Duration:      4,
		AspectRatio:   "9:16",
		Resolution:    "480p",
		GenerateAudio: true,
		Images: []MediaReference{
			{URL: "asset://image-1", Role: "reference_image", Order: 0},
			{URL: "asset://image-2", Role: "reference_image", Order: 1},
		},
		Audios: []MediaReference{
			{URL: "asset://audio-1", Role: "reference_audio"},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	body := manifestTestBody(t, create)
	if body["model"] != "seedance-2.0-v3" || body["prompt"] != "cinematic close-up" {
		t.Fatalf("unexpected body identity: %#v", body)
	}
	if body["seconds"] != "4" || body["duration"] != "4" || body["aspect_ratio"] != "9:16" || body["resolution"] != "480p" || body["generate_audio"] != true {
		t.Fatalf("unexpected scalar video fields: %#v", body)
	}
	images, ok := body["image_urls"].([]any)
	if !ok || len(images) != 2 || images[0] != "asset://image-1" || images[1] != "asset://image-2" {
		t.Fatalf("unexpected image_urls: %#v", body["image_urls"])
	}
	audios, ok := body["audio_urls"].([]any)
	if !ok || len(audios) != 1 || audios[0] != "asset://audio-1" {
		t.Fatalf("unexpected audio_urls: %#v", body["audio_urls"])
	}
	metadata, ok := body["metadata"].(map[string]any)
	if !ok {
		t.Fatalf("metadata missing: %#v", body["metadata"])
	}
	if metadata["generate_audio"] != true || metadata["ratio"] != "9:16" || metadata["resolution"] != "480p" {
		t.Fatalf("unexpected metadata scalars: %#v", metadata)
	}
	content, ok := metadata["content"].([]any)
	if !ok || len(content) != 4 {
		t.Fatalf("unexpected metadata content: %#v", metadata["content"])
	}
	text, ok := content[0].(map[string]any)
	if !ok || text["type"] != "text" || text["text"] != "cinematic close-up" {
		t.Fatalf("unexpected text block: %#v", content[0])
	}
	image, ok := content[1].(map[string]any)
	if !ok || image["type"] != "image_url" || image["role"] != "reference_image" {
		t.Fatalf("unexpected image block: %#v", content[1])
	}
	imageURL, ok := image["image_url"].(map[string]any)
	if !ok || imageURL["url"] != "asset://image-1" {
		t.Fatalf("unexpected image url block: %#v", image["image_url"])
	}
	audio, ok := content[3].(map[string]any)
	if !ok || audio["type"] != "audio_url" || audio["role"] != "reference_audio" {
		t.Fatalf("unexpected audio block: %#v", content[3])
	}
	audioURL, ok := audio["audio_url"].(map[string]any)
	if !ok || audioURL["url"] != "asset://audio-1" {
		t.Fatalf("unexpected audio url block: %#v", audio["audio_url"])
	}
}

func TestCustomNewAPIChannelParsesNewAPIWrappedResult(t *testing.T) {
	adapter := officialPackageAdapter(t, "custom-newapi-channel.yingce-plugin", "custom-newapi-channel")
	const resultURL = "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedance-2-0-mini/result.mp4"
	poll, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "task_qXlzEu59EdyPIv4PbhHJFWVTZ1SPZ3VS"}, []byte(`{
		"code": "success",
		"data": {
			"task_id": "task_qXlzEu59EdyPIv4PbhHJFWVTZ1SPZ3VS",
			"status": "SUCCESS",
			"result_url": "`+resultURL+`",
			"data": {
				"content": {
					"video_url": "`+resultURL+`"
				},
				"status": "succeeded"
			}
		}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if poll.Status != StatusSucceeded {
		t.Fatalf("status = %q, want %q", poll.Status, StatusSucceeded)
	}
	if poll.Result == nil || len(poll.Result.Videos) != 1 {
		t.Fatalf("result = %#v", poll.Result)
	}
	if poll.Result.Videos[0].URL != resultURL || !poll.Result.Videos[0].Ephemeral {
		t.Fatalf("videos = %#v", poll.Result.Videos)
	}
}
