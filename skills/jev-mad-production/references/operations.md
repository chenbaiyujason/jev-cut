# 执行手册

所有命令从 JevCut 仓库根目录执行。命令成功后还要检查该阶段的产物；不依赖某个开发者机器上的私有路径、角色或11集数据。

## 环境与服务

检查 `node --version`、`python --version`、`ffmpeg -version`、`ffprobe -version`。固定的 NumPy/Librosa 依赖需要 Python 3.12+；推荐3.13。Windows 可用 `py -0p` 查找解释器；macOS/Linux 使用已安装的合格版本。缺工具时按操作系统的可信安装渠道安装，不使用其他工程的 node_modules 或搬动其虚拟环境。

```sh
npm run setup
```

此命令只安装 Node 依赖、复制空配置并下载编辑器需要的小型模型资产；不会安装 Python、FFmpeg 或 jev 服务。

Windows（PowerShell 7，下面以已安装3.13为例）：

```powershell
py -3.13 -m venv apps/backend/.venv
apps/backend/.venv/Scripts/python.exe -m pip install -r apps/backend/requirements.txt -r requirements-vision.txt
node tools/download-detector.mjs
npm run doctor -- --stage environment
```

macOS/Linux：

```sh
python3.13 -m venv apps/backend/.venv
apps/backend/.venv/bin/python -m pip install -r apps/backend/requirements.txt -r requirements-vision.txt
node tools/download-detector.mjs
npm run doctor -- --stage environment
```

如选择3.12，替换解释器命令即可。`MAD_PYTHON` 是进程环境中的媒体解释器覆盖；默认使用仓库的 `.venv`。独立视觉环境可通过私有 `.env` 中的 `MAD_VISION_PYTHON` 指定。不要把带引号的字符串当作解释器路径写入简单 dotenv 文件。

配置文件：`apps/backend/localdevenv/.env`。解析器使用逐行 `KEY=value`，不展开 shell 变量；不要输出整份配置验证 Key。

| 角色 | 配置 | 完成条件 |
|---|---|---|
| 画面/音频理解、音乐规划 | `GEMINI_BASE_URL`、`GEMINI_API_KEY`、`GEMINI_MODEL` | 服务支持项目使用的 Gemini 原生请求及视频/音频输入；模型 ID 必须是提供商实际支持的 |
| 可选多模态向量 | `GEMINI_EMBEDDING_MODEL`、`MAD_EMBEDDING_ENABLED` | 当前实现输出768维，支持文字/图像输入；不能随便换成任意维度的文本向量接口 |
| jev 决策 | `JEV_DECISION_URL`、`JEV_DECISION_PATH`、可选 `JEV_API_KEY`/`JEV_MODEL` | 接受 state/questions 并返回合法 answers；只有聊天接口时需要适配器 |

`JEV_SUPPORTS_IMAGES` 是服务能力声明；在线视觉复核默认关闭。纯文本模型设为 false；需要明确允许忽略图片请求时才设置 `JEV_IMAGE_POLICY=text-only`。详见仓库 `docs/MODELS.md`。

```sh
npm run doctor -- --models
```

该命令会向配置的服务发送少量纯文本请求，可能计费；不上传素材。它只证明基本接口可用，后面的真实 pilot 才检查视频/音频理解链路。embedding 的文本探测不代表图片向量已经验证，正式 embedding 阶段仍需核对。

## 输入整理

建议目录：`data/raw/` 存视频与对齐字幕，`data/music/` 存配乐，`data/sources.json` 保存清单。音乐单独从工作台导入，不放进 `videos` 数组。

复制 `examples/sources.example.json` 并只保留真实存在的输入。`episode` 是唯一正整数编号，允许不连续；`file` 必填，`subtitle` 和 `language` 可选。路径相对于清单目录。可附加来源 URL、版本说明用于交接；不会自动推断下载版本。

```sh
ffprobe -v error -show_streams -show_format -of json data/raw/episode-01.mkv
```

确认音视频轨、时长、分辨率和帧率；必要时抽查实际解码。当前剪辑布局以16:9为主，其他画幅先明确保留还是加边，不静默拉伸。检测到 VFR 时先输出独立 CFR 工作副本，保留原文件，并以工作副本重新建立全部帧索引。不要复用旧帧号；字幕重新抽查三处对齐。

外置字幕必须先对齐再写进清单；没有 `subtitleOffset` 自动字段。未提供外置字幕时尝试第一条内嵌字幕流，无字幕也能继续，但语义证据要标注缺失。存在多语言字幕或非文本字幕时，先明确选择并提取成文本字幕，不默认第一条就是所需台词。

磁盘需容纳代理、图片和切镜中间数据。切镜 RGB 中间文件本身约为“帧数×48×27×3 字节”，再加代理与缓存；预留空间不能只按压缩视频大小计算。

## 阶段与完成条件

| 阶段 | 命令 | 核对产物 |
|---|---|---|
| 清单检查 | `npm run media -- --manifest data/sources.json --stage local --dry-run` | 编号与路径有效；不代表视频已解码 |
| 本地清洗 | `npm run media -- --manifest data/sources.json --stage local` | 每项 `source.json`、`boundaries.json`、`analysis-proxy.mp4`，媒体目录的 `preview.mp4` 和 `edit-preview-v2.mp4` |
| 本地验收 | `npm run doctor -- --stage local` | 切镜存在，参考帧为thumbVersion 2，剪辑代理帧数一致 |
| 模型小样本 | `npm run media -- --stage understand --pilot` | 第一份素材的一个分析块；产物是 `pilot-enriched.json`，不是全库完成 |
| 全量理解 | `npm run media -- --stage understand` | 每项 `enriched.json` 的 semanticStatus 为 complete，所有镜头完成 |
| 向量 | `npm run media -- --stage embedding` | 实际清单完成后写 `vector-index.json` 与其引用的向量文件；模型/维度/条目覆盖一致 |
| 入库 | `npm run media -- --stage index` | `library.json` 和 `full-corpus.json`；保留已有配乐与工程，不误清空它们 |
| 入库验收 | `npm run doctor -- --stage index` | 清单、语义、代理与向量覆盖通过；关闭向量时明确报告文字检索 |

处理文件位于 `apps/backend/.local/catalog-v2/episode-NN/`，媒体位于 `apps/backend/.local/media/<source-id>/`。通用状态文件包括 `preprocess-status.json`、`semantic-status.json`、`embedding-status.json`；单一状态文件的“完成”不能替代清单逐项核对。

检测器使用原始帧序列。模型分析代理默认约640宽、12fps、CRF/CQ30、单声道64kbps；送入模型的采样参数与代理帧率是不同概念。三帧参考图必须在镜头内部。片头片尾检测依赖跨素材重复证据，少于三份素材时不会凭空得到同样证据，需人工/语义抽查；不能把低动作量镜头一概删除。

不使用 embedding 时：设置 `MAD_EMBEDDING_ENABLED=false`，跳过 embedding，直接 index。它会使用显式空向量占位和文字检索；不能声称已建多模态向量库。

## 失败恢复与重新处理

| 现象 | 处理 |
|---|---|
| Python/pip 版本不符 | 确认使用3.12+创建的仓库虚拟环境；不要改全局 Python 来掩盖问题 |
| 权重缺失或哈希不符 | 重跑 `node tools/download-detector.mjs`；不要跳过校验 |
| NVIDIA 编码不可用 | 代理编码会回退CPU；仍失败时检查FFmpeg是否包含libx264及输入流是否正常 |
| 字幕无法转换 | 确认字幕类型，选取可用文本轨或提供已对齐SRT；缺字幕与处理失败要分开记录 |
| VFR或帧数映射不一致 | 先规范化工作副本，再从local重新处理；不改帧率数字假装修复 |
| 模型401/403、模型ID不可用 | 修正私有配置与服务协议，先重新探测，再重跑失败阶段 |
| 理解缺失镜头/越界时间 | 查看该项语义失败记录，重跑understand；不手工标成complete |
| embedding还没发布索引 | 对照实际清单检查全部语义和thumbVersion，不靠退出码猜成功 |
| index缺文件或来源不匹配 | 修复前置阶段，不覆盖成“空库成功” |

已存在缓存不等于输入依赖未变化。当前预处理主要用视频哈希检测换片，不能自动识别所有字幕、代理参数或模型变更；完整语义也可能被直接复用。

- 视频版本、字幕对齐或预处理参数变更：最稳妥的是在新的独立工作副本处理，不与旧 `.local` 混用。必须原地处理时，先列出并备份对应单项目录及依赖，明确重建范围，不能仅删除一个 JSON 继续。
- 理解模型/提示策略变更：旧 `enriched.json` 与理解请求缓存可能仍有效命中；需要显式重新理解，不宣称改模型变量便自动重标全库。
- embedding模型变更：重新运行embedding并核对维度和模型一致，不复用另一模型的向量。
- 本 Skill 没有通用 `--force` / `--rebuild` 参数，不编造命令。

## 启动与首次剪辑

```sh
npm run dev
```

默认网页8796、API8794、合成8787。若这些端口已被开发现场使用，在 PowerShell 当前进程设置独立端口后启动：

```powershell
$env:JEV_API_PORT='18794'
$env:JEV_EDITOR_PORT='18796'
$env:JEV_ENGINE_PORT='18787'
npm run dev
```

Linux/macOS 对应使用 `JEV_API_PORT=18794 JEV_EDITOR_PORT=18796 JEV_ENGINE_PORT=18787 npm run dev`。保持启动终端运行；服务就绪后检查页面可打开、素材可播放、模型请求成功。当前主要验证平台为Windows，其他平台不能只凭路径兼容宣称端到端已验证。

首次以短片验证：导入音乐 → 从音乐新建 → 填主题与时长 → 查看逐镜排入 → 播放/导出 → 检查声音、人物与边界。自动音频分离、任意变速曲线等未完成能力，以仓库 `docs/STATUS.md` 为准。

给下一位 Agent 的交接至少写：仓库/私有配置/清单位置（不含Key）、本次源文件数量与版本、local/understand/embedding/index状态、实际模型ID、是否启用向量、抽查结论、当前工程与下一步命令。不能只交一句“环境已准备好”。
