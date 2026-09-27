# 决策模型与其他 jev 模型接入

界面品牌叫 **jev剪辑**。当前默认决策协议来自 Winnow，本项目不包含模型权重或推理引擎；模型服务单独运行。

## 更换兼容模型

修改 `apps/backend/localdevenv/.env`：

```dotenv
JEV_DECISION_URL=http://127.0.0.1:8091
JEV_DECISION_PATH=/v1/systemone
JEV_API_KEY=
JEV_MODEL=
JEV_SUPPORTS_IMAGES=true
JEV_IMAGE_POLICY=required
```

- 单模型服务：切换 `JEV_DECISION_URL` 到新模型服务地址，`JEV_MODEL` 留空。
- 多模型路由服务：仅当服务明确支持 `model` 字段时设置 `JEV_MODEL`。这里不捏造其他 jev 模型的名称或宣称它们已验证。
- 兼容旧配置：`WINNOW_URL` / `WINNOW_API_KEY` 仍可用，新的 JEV 配置优先。
- 改配置后重启发布仓库自己的服务，不要误停开发现场服务。

## 请求契约

```json
{
  "state": {"goal": "主角在失去后继续行动", "candidates": [{"id":"a","visual":"抬头直视前方"},{"id":"b","visual":"背向镜头离开"}]},
  "questions": {
    "pick": {"type":"choice","instructions":"选择符合当前段落的镜头，不能把台词概念代替画面。","criteria":{"a":null,"b":null}},
    "fit": {"type":"score","instructions":"当前镜头是否支撑段落目标？","criteria":["不合","牵强","合适","直接"]}
  },
  "winnow": {"reuse_prefix":true,"diagnostics":true}
}
```

结构化结果至少应有：

```json
{"model":"actual-provider-model-id","answers":{"pick":{"type":"choice","choice":"a"},"fit":{"type":"score","score":2.5}}}
```

`choice` 必须是给定候选 ID；`score` 必须在当前等级范围内。原生服务可能提供 logits、条件概率与置信度；适配器不会在缺失时编造这些数值。条件选择概率也不能直接当成客观正确率。

## 图像与速度

在线选镜默认关闭视觉复核，使用离线多模态理解得到的文字证据；开启视觉复核时才需要决策服务处理参考图。`JEV_SUPPORTS_IMAGES` 表示服务能力，不是视觉开关。纯文本模型应设置 `JEV_SUPPORTS_IMAGES=false`；若明确接受在收到图片请求时退回描述，可设置 `JEV_IMAGE_POLICY=text-only`，审计会标明图片被省略。不能悄悄删图仍声称做了视觉判断。

只有 `/v1/chat/completions` 的聊天模型不是此协议的直接替代品，需要另外实现：候选JSON提示、结构化解析、合法值验证、超时/取消、结果归一化。生成JSON的速度与原生有限选项决策也不能混为一谈。

不同模型上线前至少用同一组真实片段比较：选择有效率、人物/台词一致性、转场安全、延迟分位数，以及最终观看效果。不要只比较“不同于检索首位”的比例。

## 其他模型角色

理解/音乐规划配置是 `GEMINI_MODEL`，embedding 是 `GEMINI_EMBEDDING_MODEL`。这是独立于决策服务的两条接口，不会随着 `JEV_MODEL` 自动改变。模板中的开发模型名需要替换为服务商实际可用的 ID。

原始请求与结构化输出记录保存在忽略的 `.local` 下，不提交私有素材描述、图像或API密钥。源码文件 `winnow.mjs` 仍保留历史兼容名，内部 `decide` 已转到发布版适配器。
