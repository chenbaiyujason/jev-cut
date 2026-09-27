# 安装与运行

## 1. Node 与应用

Node.js 22+，推荐使用仓库实际验证的 Node 24。执行 `npm run setup` 安装前后端依赖并创建空配置。编辑 `apps/backend/localdevenv/.env`。`npm run dev` 启动API、编辑器与合成服务；默认端口8794、8796、8787。

FreeCut 的编译还引用三个小型 Anime4K 模型。`setup` 从固定上游提交下载并校验它们；文件被Git忽略，不放进本仓库历史。单独安装依赖时需运行 `node tools/download-editor-assets.mjs` 后再构建。

并行验收不要抢占开发现场端口：

```powershell
# PowerShell 7
$env:JEV_API_PORT='18794'
$env:JEV_EDITOR_PORT='18796'
$env:JEV_ENGINE_PORT='18787'
npm run dev
```

```sh
# Linux/macOS
JEV_API_PORT=18794 JEV_EDITOR_PORT=18796 JEV_ENGINE_PORT=18787 npm run dev
```

启动器遇到已占用端口会退出，不替用户关闭已有服务。模型服务地址单独由 JEV_DECISION_URL 指定。

## 2. FFmpeg 与 Python

先确保 `ffmpeg -version` 和 `ffprobe -version` 可运行。创建独立Python环境：

```sh
python -m venv apps/backend/.venv
# Windows
apps/backend/.venv/Scripts/python.exe -m pip install -r apps/backend/requirements.txt -r requirements-vision.txt
# Linux/macOS
apps/backend/.venv/bin/python -m pip install -r apps/backend/requirements.txt -r requirements-vision.txt
```

GPU版PyTorch需匹配自己的驱动环境；CPU也能运行切镜但速度不同。若另用视觉环境，在本地配置中设置 `MAD_VISION_PYTHON`；媒体进程可由启动环境 `MAD_PYTHON` 指定。

```sh
node tools/download-detector.mjs
```

该工具从固定revision下载TransNetV2转换权重并校验SHA-256，保存在忽略的`.local/models`。不下载或重分发决策模型权重。

## 3. 准备自己的视频与字幕

将 `examples/sources.example.json` 复制到 `data/sources.json`。文件路径相对于清单所在目录，例如 `data/raw/episode-01.mkv` 写作 `raw/episode-01.mkv`。每个视频使用唯一正整数episode编号，不要求固定集数。

外置字幕可省略，此时尝试读取第一条内嵌字幕流；没有字幕也可继续，但必须在理解结果中承认对白证据较弱。外置字幕由使用者确认版本和时间偏移，不能把“同剧名”当成已经对齐。

```sh
npm run media -- --manifest data/sources.json --stage local --dry-run
npm run media -- --manifest data/sources.json --stage local
```

此阶段创建真实镜头边界、保留时间映射的代理、原声/字幕索引和镜头参考图。先抽样检查，再调用理解模型。

```sh
npm run media -- --stage understand
npm run media -- --stage embedding
npm run media -- --stage index
```

理解阶段会把压缩的视频与原声发送给配置的API。Embedding输入为语义文档与图像。配置文件仅写在忽略目录，不把Key贴入Skill或代码。

索引阶段会更新发布副本的媒体库，建议在这个副本的开发服务启动前运行；它不会触及原开发目录。失败保留缓存，修复后重跑对应阶段，不先删除全库。

不使用embedding时可跳过该阶段；索引会明确记录向量不可用，检索使用文本证据。已有视频编号不能无提示换成另一份视频；字幕或分析参数变更也需要人工确认并重建受影响缓存。

## 4. 创建与验证剪辑

启动应用，导入自己的音乐，从项目菜单进入“从音乐新建剪辑”。给主角/主题即可，音乐仍决定节奏。之后在右侧jev剪辑面板选范围进行修改。

字幕完整性、原声音量、人物与动作连续性需实际看听。静态参考图不能证明动作裁剪正确；特效次数也不是质量指标。纯人声分离与任意节奏重排未接入的部分不要在产品说明里承诺已完成。
