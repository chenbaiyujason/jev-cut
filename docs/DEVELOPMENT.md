# 原目录开发与独立仓库发布

## 两个工作区各自负责什么

| 工作区 | 用途 |
|---|---|
| 现有后端与编辑器目录 | 继续开发、调试、模型调用、缓存和真实素材；本次不移动、不改远端、不要求提交 |
| JevCut | 可发布的源码快照、公开文档、Skill、模型契约、许可证、CI和发布适配 |

没有符号链接回开发目录，没有共享 `.git`，也不从这里启动或停止开发现场的服务。两个应用默认端口一样；并行验收时必须使用独立端口，见 SETUP.md。

## 同步

第一次指定两个源目录，路径只保存在 `.sync/local.json`：

```sh
python tools/sync-workspace.py --backend /path/to/AigameSearch/apps/winnow-mad-lab --editor /path/to/WinnowMadStudio
python tools/sync-workspace.py --apply
```

默认只检查。`--apply` 才更新发布仓库；不会反向写开发目录，也不会自动提交或推送。

工具按导出策略读取源码，连续确认源文件集合和内容没有变化，再保存本地快照。源文件一直变化时会有限重试并退出，保留原发布副本；不阻塞用户继续开发。

文件更新规则：

| 相对上次导出 | 结果 |
|---|---|
| 仅源目录变化 | 更新发布副本 |
| 仅发布副本变化 | 保留发布侧修改 |
| 两边变化但内容一致 | 接受一致内容 |
| 两边都变化且不同 | 报冲突，保留当前文件，输入版本放在 `.sync/conflicts/` |
| 源文件删除，发布侧未改 | 删除对应受管理文件 |
| 源文件删除，发布侧已改 | 报冲突，不删除 |
| 发布仓库自有文档/工具/Skill | 不在导出清单中，永不被同步覆盖 |

有冲突时整次应用不执行。可在 `.sync/snapshots/<id>/files` 查看完整输入；先人工合并或将发布侧补丁整理进 `tools/release_adapt.py`，再同步检查。不要用强制镜像命令覆盖整个目录。

`release_adapt.py` 是公开包必要的路径、素材数量、空工程和模型接入适配。它在导出时作用于副本，不修改源文件。重要适配找不到预期代码位置时，应修复适配后再发布，而不是静默删掉适配。

## 每次推送的最小流程

```sh
npm run sync
npm run audit
npm test
npm run test:sync
npm run test:backend
npm run build:editor
git diff --stat
git diff
git add .
git commit -m "Update jev editing snapshot"
git push
```

`release-manifest.json` 记录来源相对路径和哈希。`.sync` 中的源机器绝对路径、待合并文件与快照不提交。首次公开前再核对 `.local`、媒体、字幕、权重、密钥和私人截图没有进入 Git；`npm run audit` 会检查这些边界，但不等于通用秘密检测服务。

未来如果决定把 JevCut 变成唯一开发主库，再做一次明确迁移；当前没有这样做。
