# JIZURA 文字 PV 图层

使用 Freecut 原生 `text` item，附加 `jizura` 配置。没有独立视频导出器，
没有 iframe，预览和导出都通过相同的 `renderJizuraFrame` 调用固定版本
`J.Renderer.frame`。模型不需要生成脚本或了解底层 860 个部件。

通过现有 `/edit` 的 `addItem` 操作写入：

```json
{
  "op": "addItem",
  "item": {
    "id": "pv-accent-1",
    "type": "text",
    "trackId": "pv-track",
    "label": "重音文字",
    "text": "决心",
    "color": "#ffffff",
    "from": 90,
    "durationInFrames": 18,
    "transform": { "x": 0, "y": 0, "width": 1920, "height": 1080, "rotation": 0, "opacity": 1 },
    "jizura": {
      "version": 1,
      "preset": "impact",
      "seed": 731,
      "intensity": 0.8,
      "transparent": true,
      "centerFree": false,
      "accentColor": "#ff3366",
      "backgroundColor": "#101018"
    }
  }
}
```

- `from` / `durationInFrames` 均为 Freecut 项目帧；例如 30 fps 下上述文字从
  3 秒开始，持续 0.6 秒。移动、裁剪、关键帧 transform 使用原生操作。
- `impact` 是大字冲击，允许文字越过画面边缘，建议 2–4 个汉字。
  `kinetic` 是逐词堆叠；`quiet` 适合留白文字。首轮只开放这三个预设。
- `text` 按普通文本处理，`*`、`/`、`#` 等不解释为 JIZURA 原生歌词语法。
- `transparent:true` 将文字合成在下层素材上；`false` 可作为有背景的文字插片。
  `centerFree:true` 使用 JIZURA 左右/上下留白，给中间角色让出空间。
- `seed` 固定整个计划与颗粒/纸张随机源，按项目帧重入渲染，跳转不依赖历史播放。
- 字体使用本机 Microsoft YaHei / Yu Gothic / Arial、SimSun / Yu Mincho、Consolas
  和系统 fallback；不下载 Google Fonts。跨机器像素一致需字体也一致。
- 项目 JSON 与 bundle schema、store 保存/恢复已覆盖此字段。

验证：`npx vp test run src/integrations/jizura/spec.test.ts`；构建后运行
`node src/integrations/jizura/headless-smoke.mjs`。后者只生成固定 3 秒测试片，
检查不同帧的变化、重载后同帧哈希、三个预设的实际文字像素、透明合成和
Freecut 导出。证据保存在 `artifacts/jizura-smoke/`。
