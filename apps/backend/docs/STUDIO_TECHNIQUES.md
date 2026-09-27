# 面向 Agent 与 Winnow 的剪辑手法接口

`studio-techniques.mjs` 把有限的剪辑意图编译成真实 Freecut headless 操作。编译过程不调用模型、不请求网络、不改项目；服务端在检查项目 revision 后把返回的 `ops` 原子提交给 Freecut。不要让模型绕过此层直接生成任意 `updateItem` 或着色器代码。

```js
import { describeCapabilities, compileTechnique } from './studio-techniques.mjs';
const capabilities = describeCapabilities(); // 可直接发给 Agent 的 JSON 能力清单
const proposal = compileTechnique(request, projectWithCatalog);
// proposal = {version, requestId, technique, ops, explanation, checks, occurrences}
// 编译失败抛 TechniqueValidationError，包含 code/message/details。
```

## 身份和时钟

| 字段 | 含义 |
| --- | --- |
| `assetId` | 原始素材身份，一集视频只对应一个资产 |
| `shotId` | 素材内的镜头身份及安全源区间 |
| `occurrenceId` | 时间轴上的一次使用，对应 Freecut `item.id`；同镜头可出现多次 |
| `from`、`durationInFrames` | 项目帧率下的整数帧；结尾不包含 |
| `localFrame` | 相对于当前 occurrence 起点的项目整数帧 |
| `sourceIn`、`sourceOut` | 素材原生帧率下的整数帧；结尾不包含 |
| `volumeDb` | 分贝，范围 `[-60, 6]`；不是线性 gain；新视频默认 `-60` 并静音内嵌音轨 |

项目保持 Freecut 原生结构，编译时附加索引：

```js
const projectWithCatalog = {
  ...freecutProject,
  madCatalog: {
    assets: [{
      assetId: 'episode-01', mediaId: 'media-01',
      sourceFps: 24000 / 1001, sourceDurationFrames: 35000,
      src: '/media/episode-01.mp4', width: 1920, height: 1080,
    }],
    shots: [{
      shotId: 'episode-01-shot-08', assetId: 'episode-01',
      sourceIn: 1000, sourceOut: 1200,
      safeRanges: [{sourceIn: 1004, sourceOut: 1196}],
    }],
  },
};
```

`safeRanges` 可把原切镜残影/叠化边缘剔除。不填时只使用镜头边界，**不代表边缘已复检**。编译器只能执行索引提供的边界，不能靠编译器修复漏检的切镜。现有 occurrence 必须保留 `item.mad = {assetId,shotId,occurrenceId}`，以及原生 `sourceStart/sourceEnd/sourceFps`。新建 occurrence 自动带有这些身份。

源帧和项目帧按 `timelineFrames * sourceFps * speed / projectFps` 换算；可显示时长向下取整，需要的源帧向上取整。因此 23.976 fps 素材进入 30 fps 工程时，不会因为向下截断而漏查最后一帧。恒速允许 `[0.25,4]`；复杂变速曲线、倒放和与现有程序动画的叠加先显式拒绝。

## 手法示例

### 有意重复、回环和碎切

```js
{
  technique: 'repeat', requestId: 'accent-repeat-01',
  trackId: 'mad-video', from: 240, count: 3,
  segment: { shotId: 'episode-01-shot-08', sourceIn: 1040, sourceOut: 1044 },
}
```

`repeat`/`reprise` 允许 `gapFrames`，间隔可以已有其他镜头；新片段本身仍不能撞到未指定替换的内容。`stutter` 必须连续，每段最多 0.5 秒、最少 2 项目帧。重复次数限制 2–8。不再借用旧选片器的“同镜头永不复用”规则。

### A1 → B → A2 → C → A3

```js
{
  technique: 'intercut', requestId: 'abaca-01', trackId: 'mad-video', from: 300,
  replaceOccurrenceIds: ['old-occurrence-01'],
  segments: [
    { shotId: 'A', sourceIn: 1000, sourceOut: 1012 },
    { shotId: 'B', sourceIn: 2000, sourceOut: 2006 },
    { shotId: 'A', sourceIn: 1012, sourceOut: 1024 },
    { shotId: 'C', sourceIn: 3000, sourceOut: 3006 },
    { shotId: 'A', sourceIn: 1024, sourceOut: 1048, volumeDb: -8 },
  ],
}
```

这里的 A/B/C 需替换成真实索引 ID。`segments` 支持 2–16 个片段。既可以依次推进 A 的动作，也可以重复 A 的相同区间来回环。明确列出 `replaceOccurrenceIds` 才允许删除原项；不会自动挪动其他镜头或音乐。

### 重音强化

```js
{
  technique: 'impact', requestId: 'hit-01', occurrenceId: 'mad-abaca-01-o4',
  localFrame: 4, durationInFrames: 6, scale: 1.12, rgbAmount: 0.008, rgbAngle: 0,
}
```

输出真实宽高关键帧以及短 RGB 分离，最长 0.5 秒，结束处回到原始尺寸和零色差。若已经有缩放关键帧、属性表达式或程序动画，返回 `ANIMATION_CONFLICT`，避免悄悄覆盖或叠加成不可预测的运动。它是可控的视觉强调，是否贴合音乐仍由规划和候选比较决定。

### 转场与调色

```js
{
  technique: 'transition', requestId: 'cut-01',
  leftOccurrenceId: 'left-item', rightOccurrenceId: 'right-item',
  durationInFrames: 6, presentation: 'chromatic', alignment: 0.5,
}
{
  technique: 'grade', requestId: 'cool-01', occurrenceIds: ['left-item', 'right-item'],
  effects: [
    {gpuEffectType:'gpu-temperature', params:{temperature:-0.2,tint:0.05}},
    {gpuEffectType:'gpu-saturation', params:{amount:0.9}},
  ],
}
```

转场不移动切点，要求同轨完全相邻。除了可见片段，还检查切点后左片段的隐藏尾部和切点前右片段的隐藏头部：它们必须留在各自的安全镜头区间。持续时间过长、转场窗口相互压占或原片缺乏余量均报错，不静默缩短。这个规则可防止转场把本来裁掉的残余切镜重新露出来。

调色只开放对比、饱和度、色温/色调、黑白、曝光的有限参数，最多 4 个效果。完整白名单以 `describeCapabilities()` 为准。此层不接受外部 LUT 路径、任意 shader 或表达式。

### JIZURA 文字 PV

```js
{
  technique:'text', requestId:'word-01', trackId:'mad-titles',
  from:300, durationInFrames:24, text:'永不放弃', renderer:'jizura',
  preset:'impact', intensity:0.7, seed:42, transparent:true, centerFree:false,
  color:'#ffffff', accentColor:'#ff3366', backgroundColor:'#101018',
}
```

编译为 `addItem` 原生 `type:'text'`，保留可编辑文字；附加 `{version:1,preset,seed,intensity,transparent,centerFree,accentColor,backgroundColor}` 的 `jizura` 字段，交由新编辑器的 JIZURA 适配器渲染。`preset` 为 `impact/kinetic/quiet`；`renderer:'native'` 可创建普通文字。一个文字项最多 140 字、30 秒，输入不接受 HTML/JavaScript。

## 服务端集成约定

1. 从目标工程最新 revision 读取项目，并附加只读素材索引。
2. 调用 `compileTechnique`，返回给 Agent/Winnow 的候选需要包含解释和验证结果。
3. 使用同一 revision 提交 `ops`。revision 已变则重取工程并重新编译，不覆盖用户最新编辑。
4. `requestId` 是确定性 occurrence ID 的前缀；服务端做幂等请求处理。重复提交已应用请求会返回 ID 冲突，不能假装再次成功。
5. Freecut 原生操作执行和导出走同一个 renderer。先生成候选预览，再由 Winnow 对手法组合打分；编译器不会自行请求 Winnow 或生成新成片。

所有权：本模块只负责动作表达、边界合法性和 Freecut 编译。鼓点/主重音检测、镜头质量、情绪规划以及哪种手法更合适仍是独立决策层，不能把“操作可执行”当成“艺术效果已验证”。

## 验证

`node --test tests/studio-techniques.test.mjs` 覆盖有意复用、A/B/A/C/A、源 FPS 换算、越界与危险切镜区间、碰撞和显式替换、隐藏转场余量、过长转场、非法滤镜/参数、短效果回归静态值和 JIZURA payload。另以本机 Freecut `headless/lib/contract.mjs` 的 `editOpSchema` 验证了 5 类手法共 15 个操作；不把静态合同验证当成实际渲染通过。

2026-09-27 的真实运行验收使用当前工程的独立副本：EP2/EP8/EP10 原片安全区间，A1–B–A2–C–A3 五个 occurrence，A 镜头复用三次，加缩放/RGB 脉冲、4 帧 chromatic 转场、对比度及透明 JIZURA 文字。五类请求经本机 Freecut `/edit` 实际执行，共 21 条操作，保留了 12 个关键帧、1 个转场和 JIZURA seed。`/render` 生成 960×540、30 fps、90 视频帧的 H.264/AAC MP4（3.008 秒容器时长、2,290,664 字节），渲染约 853 ms。另检查了 5 个原生 `/frame` 抽帧，未缺素材，主项目内容哈希与 revision 保持不变。

运行暴露并修复了原生持久化把 `23.976023976` fps 保存为 `23.976` 的精度问题；编译器允许三位小数的序列化误差，安全换算仍使用索引内的精确帧率，不允许变成 25 fps 等另一帧率。对应回归测试后当前共 16 项通过。测试产物在本机忽略目录 `.local/studio/verification/`，入口 `technique-demo.json`、`technique-demo.mp4`、`technique-verification.json`；它只验证编辑能力管线，不代表新成片的艺术质量验收。
