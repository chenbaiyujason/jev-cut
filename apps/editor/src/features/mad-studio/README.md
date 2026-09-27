# MAD Studio 前端桥

`npm run dev:mad` 启动在 `http://127.0.0.1:8796/mad`，主入口 `/` 自动跳转。完整 Freecut 编辑器的多轨、效果、转场、色彩、文字、关键帧、导出入口均保留。

## 与本地后端协作

- `/mad-api/*` 代理到 `http://127.0.0.1:8794/api/*`。
- `/mad-media/*` 代理到对应本机素材。浏览器播放器使用 HTTP Range，不要求预先导入整套视频。
- 首次打开自动创建专属 OPFS 目录 `winnow-mad-studio`。它只保存工程、素材元数据和缓存；完整可移植工程由后端保存。
- `GET studio/project` 返回 `{revision, project, media}`，`project` 为完整 Freecut 工程，`media` 每项包含 `{mediaId,url,metadata}`。
- 手工编辑通过 `PUT studio/project {baseRevision,project}` 自动回传。仅播放、缩放、滚动不会创建新版本。
- 每 1.4 秒读取版本更新，后端 Agent 修改作为单个可撤销操作应用于活跃主时间轴，保留此前手工编辑历史。进入子合成时延后应用，返回主时间轴后继续。
- `409` 不覆盖本地编辑；草稿保存在 OPFS，用户可“保存草稿并载入远端”。
- 音乐生成按钮默认偏好为空：`POST generate` → 等待 `GET jobs/:id` 完成 → `POST studio/import`。生成期间发生手工修改时保留手工版本，不替换时间轴。

## 验证

`npx vp test run src/features/mad-studio/api.test.ts src/features/media-library/utils/workspace-health.test.ts`

测试包含：播放不产生编辑版本、实际内容修改产生版本、同源媒体约束、409 语义、远程素材 HEAD 健康检查。

OPFS 草稿属于当前浏览器和站点；清除站点数据会清除草稿。后端项目是跨浏览器和 Agent 的共同持久化来源。
