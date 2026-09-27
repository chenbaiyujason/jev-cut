# 第三方来源

| 组件 | 来源 | 版本依据 | 许可位置 |
|---|---|---|---|
| FreeCut 编辑器与 headless | https://github.com/walterlow/freecut | 开发副本基于 commit `4d62e80`；本地整合修改见导出清单与Git差异 | `apps/editor/LICENSE`，原版权声明保留 |
| JIZURA 渲染子集 | https://github.com/852wa/JIZURA | `8da975f` / v0.9.0；有限适配而非完整应用 | `apps/editor/src/integrations/jizura/vendor/LICENSE` 与 `ORIGIN.md` |
| TransNetV2 推理代码 | https://github.com/soCzech/TransNetV2 | `85cef72af9a916bdfd7cc94a670c9cdfbf12d1ed` | `apps/backend/vendor/transnetv2/LICENSE` 与 `ORIGIN.md` |
| ONNX Runtime Web 浏览器运行时 | https://github.com/microsoft/onnxruntime | FreeCut 随附的浏览器运行时文件，不是模型权重 | `licenses/onnxruntime-LICENSE` |

其他依赖由各应用的 package-lock.json 标识，安装包保留其各自许可。根目录MIT许可不替换第三方版权声明。

FreeCut 引用的三个小型 Anime4K ONNX 资源由 `tools/editor-assets.json` 固定上游提交与哈希，安装时单独获取，不提交模型文件到本仓库。

决策模型、理解模型、embedding模型和TransNetV2转换权重不随Git仓库分发，使用其提供方的许可与下载规则。动漫、字幕、音乐及生成的混剪内容也不因本仓库MIT许可而获得再分发授权。
