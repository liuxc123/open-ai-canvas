# Custom NewAPI Channel 接口字段

## 协议身份

- 插件 ID：`custom-newapi-channel`。
- Provider ID：`custom-newapi-channel`。
- 能力：`video`。
- 默认 Base URL：`http://127.0.0.1:3000`。
- 鉴权驱动：`bearer`。
- 创建：`POST /v1/video/generations`。
- 查询：`GET /v1/video/generations/{{taskId}}`。

## 配置字段

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `apiKey` | secret | 是 | API Key |

## 统一字段映射

| 统一字段 | 类型 | 必填 | 上游映射 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | string | 是 | `model` | 视频模型 ID。 |
| `prompt` | string | 是 | `prompt` / `metadata.content[type=text].text` | 视频提示词。 |
| `images` | media[] | 否 | `image_urls` / `metadata.content[type=image_url]` | 图片引用。 |
| `videos` | media[] | 否 | `video_urls` / `metadata.content[type=video_url]` | 视频引用。 |
| `audios` | media[] | 否 | `audio_urls` / `metadata.content[type=audio_url]` | 音频引用。 |
| `duration` | integer | 否 | `seconds` / `duration` | 时长秒数。 |
| `aspectRatio` | string | 否 | `aspect_ratio` / `metadata.ratio` | 画幅比例。 |
| `resolution` | string | 否 | `resolution` / `metadata.resolution` | 分辨率档位。 |
| `generateAudio` | boolean | 否 | `generate_audio` / `metadata.generate_audio` | 是否生成音频。 |

## 上游请求模板逐字段清单

| 上游位置 | 值或转换表达式 |
| --- | --- |
| `create.method` | `"POST"` |
| `create.path` | `"/v1/video/generations"` |
| `create.contentType` | `"application/json"` |
| `create.body.model` | `{"$ref":"request.model"}` |
| `create.body.prompt` | `{"$ref":"request.prompt"}` |
| `create.body.seconds` | `{"$toString":{"$ref":"request.duration"}}` |
| `create.body.duration` | `{"$toString":{"$ref":"request.duration"}}` |
| `create.body.aspect_ratio` | `{"$coalesce":[{"$ref":"request.aspectRatio"},"16:9"]}` |
| `create.body.resolution` | `{"$omitEmpty":{"$ref":"request.resolution"}}` |
| `create.body.generate_audio` | `{"$ref":"request.generateAudio"}` |
| `create.body.image_urls` | 图片 `request.images[].value` 列表。 |
| `create.body.video_urls` | 视频 `request.videos[].value` 列表。 |
| `create.body.audio_urls` | 音频 `request.audios[].value` 列表。 |
| `create.body.metadata.content` | text + image/video/audio block 数组，保留媒体 role。 |
| `poll.method` | `"GET"` |
| `poll.path` | `"/v1/video/generations/{{taskId}}"` |

## Provider 扩展键

- 无额外扩展键。

## 响应映射

- 任务 ID 优先读取 `data.task_id` / `data.taskId` / `task_id` / `taskId` / `data.id` / `id`。
- 状态优先读取 `status` / `state` / `data.status`，缺省为 `pending`。
- 结果视频优先读取 `data.result_url` / `data.video_url` / `data.output_url` / `data.url` / `data.metadata.url` / `data.data.content.video_url`，并兼容常见顶层 URL 字段。
- 完成后的临时媒体地址由宿主下载并持久化。

## 兼容边界

该插件只负责 NewAPI 视频生成请求结构，不上传素材、不缓存 `asset://` 绑定。素材上传与复用应由宿主在协议执行前完成，插件只消费处理后的 URL 或 `asset://` 值。

<!-- YINGCE_MANIFEST_CONTRACT_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "yingce.plugin/v2",
  "id": "custom-newapi-channel",
  "name": "Custom NewAPI Channel",
  "version": "1.0.1",
  "author": "影策 / Custom",
  "description": "自定义 NewAPI 视频协议，兼容 metadata.content 结构。",
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>",
  "permissions": [
    "generation.run",
    "media.read"
  ],
  "configuration": {
    "fields": [
      {
        "name": "apiKey",
        "type": "secret",
        "label": "API Key",
        "required": true
      }
    ]
  },
  "contributes": {
    "providers": [
      {
        "id": "custom-newapi-channel",
        "label": "Custom NewAPI Channel",
        "capabilities": [
          "video"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "http://127.0.0.1:3000",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "model",
            "description": "视频模型 ID。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "prompt/metadata.content[type=text].text",
            "description": "视频提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "mapping": "image_urls/metadata.content[type=image_url]",
            "description": "图片引用，值可以是上游可访问 URL 或 asset://。"
          },
          {
            "name": "videos",
            "type": "media[]",
            "mapping": "video_urls/metadata.content[type=video_url]",
            "description": "视频引用，值可以是上游可访问 URL 或 asset://。"
          },
          {
            "name": "audios",
            "type": "media[]",
            "mapping": "audio_urls/metadata.content[type=audio_url]",
            "description": "音频引用，值可以是上游可访问 URL 或 asset://。"
          },
          {
            "name": "duration",
            "type": "integer",
            "mapping": "seconds/duration",
            "description": "时长秒数。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "mapping": "aspect_ratio/metadata.ratio",
            "description": "画幅比例。"
          },
          {
            "name": "resolution",
            "type": "string",
            "mapping": "resolution/metadata.resolution",
            "description": "分辨率档位。"
          },
          {
            "name": "generateAudio",
            "type": "boolean",
            "mapping": "generate_audio/metadata.generate_audio",
            "description": "是否生成音频。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/v1/video/generations",
          "contentType": "application/json",
          "body": {
            "model": {
              "$ref": "request.model"
            },
            "prompt": {
              "$ref": "request.prompt"
            },
            "seconds": {
              "$toString": {
                "$ref": "request.duration"
              }
            },
            "duration": {
              "$toString": {
                "$ref": "request.duration"
              }
            },
            "aspect_ratio": {
              "$coalesce": [
                {
                  "$ref": "request.aspectRatio"
                },
                "16:9"
              ]
            },
            "resolution": {
              "$omitEmpty": {
                "$ref": "request.resolution"
              }
            },
            "generate_audio": {
              "$ref": "request.generateAudio"
            },
            "image_urls": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.images"
                    }
                  },
                  "as": "media",
                  "in": {
                    "$ref": "media.value"
                  }
                }
              }
            },
            "video_urls": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.videos"
                    }
                  },
                  "as": "media",
                  "in": {
                    "$ref": "media.value"
                  }
                }
              }
            },
            "audio_urls": {
              "$omitEmpty": {
                "$map": {
                  "from": {
                    "$sortByOrder": {
                      "$ref": "request.audios"
                    }
                  },
                  "as": "media",
                  "in": {
                    "$ref": "media.value"
                  }
                }
              }
            },
            "metadata": {
              "content": {
                "$concatArrays": [
                  [
                    {
                      "type": "text",
                      "text": {
                        "$ref": "request.prompt"
                      }
                    }
                  ],
                  {
                    "$map": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      },
                      "as": "media",
                      "in": {
                        "type": "image_url",
                        "role": {
                          "$coalesce": [
                            {
                              "$ref": "media.role"
                            },
                            "reference_image"
                          ]
                        },
                        "image_url": {
                          "url": {
                            "$ref": "media.value"
                          }
                        }
                      }
                    }
                  },
                  {
                    "$map": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.videos"
                        }
                      },
                      "as": "media",
                      "in": {
                        "type": "video_url",
                        "role": {
                          "$coalesce": [
                            {
                              "$ref": "media.role"
                            },
                            "reference_video"
                          ]
                        },
                        "video_url": {
                          "url": {
                            "$ref": "media.value"
                          }
                        }
                      }
                    }
                  },
                  {
                    "$map": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.audios"
                        }
                      },
                      "as": "media",
                      "in": {
                        "type": "audio_url",
                        "role": {
                          "$coalesce": [
                            {
                              "$ref": "media.role"
                            },
                            "reference_audio"
                          ]
                        },
                        "audio_url": {
                          "url": {
                            "$ref": "media.value"
                          }
                        }
                      }
                    }
                  }
                ]
              },
              "generate_audio": {
                "$ref": "request.generateAudio"
              },
              "ratio": {
                "$coalesce": [
                  {
                    "$ref": "request.aspectRatio"
                  },
                  "16:9"
                ]
              },
              "resolution": {
                "$omitEmpty": {
                  "$ref": "request.resolution"
                }
              }
            }
          }
        },
        "poll": {
          "method": "GET",
          "path": "/v1/video/generations/{{taskId}}",
          "contentType": "application/json"
        },
        "response": {
          "taskId": {
            "$coalesce": [
              {
                "$ref": "response.data.task_id"
              },
              {
                "$ref": "response.data.taskId"
              },
              {
                "$ref": "response.task_id"
              },
              {
                "$ref": "response.taskId"
              },
              {
                "$ref": "response.data.id"
              },
              {
                "$ref": "response.id"
              },
              {
                "$ref": "taskId"
              }
            ]
          },
          "status": {
            "$coalesce": [
              {
                "$ref": "response.status"
              },
              {
                "$ref": "response.state"
              },
              {
                "$ref": "response.data.status"
              },
              "pending"
            ]
          },
          "message": {
            "$coalesce": [
              {
                "$ref": "response.error.message"
              },
              {
                "$ref": "response.message"
              },
              {
                "$ref": "response.fail_reason"
              }
            ]
          },
          "videos": {
            "$coalesce": [
              {
                "$ref": "response.data.result_url"
              },
              {
                "$ref": "response.data.video_url"
              },
              {
                "$ref": "response.data.output_url"
              },
              {
                "$ref": "response.data.url"
              },
              {
                "$ref": "response.data.metadata.url"
              },
              {
                "$ref": "response.data.data.video_url"
              },
              {
                "$ref": "response.data.data.content.video_url"
              },
              {
                "$ref": "response.data.data.output_url"
              },
              {
                "$ref": "response.data.data.result_url"
              },
              {
                "$ref": "response.data.data.url"
              },
              {
                "$ref": "response.data.data.metadata.url"
              },
              {
                "$ref": "response.video_url"
              },
              {
                "$ref": "response.videoUrl"
              },
              {
                "$ref": "response.result_url"
              },
              {
                "$ref": "response.output_url"
              },
              {
                "$ref": "response.url"
              },
              {
                "$ref": "response.metadata.url"
              },
              {
                "$ref": "response.output.url"
              }
            ]
          },
          "errorPaths": [
            "error.code"
          ],
          "messagePaths": [
            "error.message",
            "message",
            "fail_reason"
          ],
          "resultEphemeral": true
        }
      }
    ]
  }
}
```
<!-- YINGCE_MANIFEST_CONTRACT_END -->
