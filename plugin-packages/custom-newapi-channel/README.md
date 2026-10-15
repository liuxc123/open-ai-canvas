# Custom NewAPI Channel

该目录是本地自定义 NewAPI 视频协议插件，用于兼容需要 `metadata.content` 结构的 NewAPI Seedance 视频线路。

插件只负责请求与响应映射，不处理素材上传。宿主会在视频请求前为受控 `resource:` 图片、视频和音频调用 NewAPI 素材接口，成功后将引用转换为 `asset://`；普通 URL 与已存在的 `asset://` 引用保持原样。

完整接口见 [docs/interface.md](docs/interface.md)。
