# Custom NewAPI Channel

该目录是本地自定义 NewAPI 视频协议插件，用于兼容需要 `metadata.content` 结构的 NewAPI Seedance 视频线路。

插件只负责请求与响应映射，不处理素材上传。图片、视频、音频引用应在进入协议前已经转换为 NewAPI 可识别的 URL 或 `asset://` 素材引用。

完整接口见 [docs/interface.md](docs/interface.md)。
