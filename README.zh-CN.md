# Thinking effort picker（思考强度选择器）

[English](README.md) | **简体中文**

一个 DSH 插件：把输入框里的模型选择器换成一个更紧凑的选择器，顺手加上
「思考强度」档位、`Auto` 模式和每轮真实档位标签。

版本 **0.1.0**，能力范围见 [已知限制](#已知限制)。

## 它做什么

- **模型 + 档位选择器**：替换 `conversation.input.model` 槽位。菜单按 provider
  分组列出模型，底部是当前模型的真实档位（`off` / `low` / `high` / `max`，具体
  以 provider 配置为准）和一个 `Auto`。
- **方向键切档**：`←` 减小、`→` 增大，阶梯是 `[真实档位…, Auto]`。最高档再按
  `→` 落到 `Auto`，`Auto` 按 `←` 回到最高档；**两端不回绕**。
- **鼠标位置感知**：鼠标在输入框卡片内时，`←` `→` 不抢按键（留给光标移动）；
  鼠标在页面其他地方时都能切档。
- **滑动动画**：按钮里的档位小字横向滑动切换（旧字滑出、新字滑入），固定宽度
  槽位，不会撑动按钮；小字使用冷色渐变流动 + 轻辉光。
- **每轮真实档位**：`Auto` 开启时，每轮对话尾部显示**该轮实际使用的档位**
  （来自 `request/header` 事件，不是当前选择）。没有记录的一轮显示 `default`。
- **降级开关**：如果替换选择器出问题，保留插件但设置
  `localStorage['thinking-effort:no-replace'] = '1'` 后刷新，会退回一个紧凑的
  档位 chip（`conversation.input.left`）。

## 安装

把插件链接进 profile 的依赖，并在 `dsh.profile.bundles` 里列出；插件自带的
`cordis.patch.yml` 会插入 loader 行，profile 自己的 patch 不用额外加。

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "@local/thinking-effort": "link:C:/path/to/thinking-effort-plugin" },
  "dsh": { "profile": { "bundles": ["...", "@local/thinking-effort"] } }
}
```

安装后**完全重启 DSH**（Host 半边只在启动时加载）。

## 自动打分（Host 半边）

Host 提供两个同源 JSON 接口：

| 路由 | 作用 |
| --- | --- |
| `POST /thinking-effort/evaluate` | 计算本轮分数并给出目标档位；`apply: true` 时直接应用 |
| `POST /thinking-effort/turns` | 返回每一轮实际发请求时用的档位（来自 `request/header`） |

### 分数怎么来

- **failure（0–5，确定性）**：只看**最近一轮**。同名同参数的工具调用失败
  ≥2 次记一组，每组 2 分；该轮 `turn/end` 的 `reason.kind === 'error'` 再 +2；
  上限 5。
- **importance（0–10，判分调用）**：用一次很小的模型调用，把「最近的用户消息」
  和锚点比较。锚点是**正在运行的 goal 目标**，没有 goal 时取首条用户消息；
  越贴近锚点、影响面越大分越高，越偏离/越边角分越低。判分调用使用该模型的最
  低档（优先 `off`），解析失败时回退 5 分并返回 `importanceRaw` 方便排查。
- **映射**：

  ```
  total    = wI * importance + wA * failure
  maximum  = wI * 10 + wA * 5
  interval = maximum / 档位数量
  index    = floor(total / interval)   // 夹到 0 … 档位数量-1
  ```

  权重写在插件 patch 行里，**只影响比例**：

  ```yaml
  - insert:
      - id: thinking-effort
        name: '@local/thinking-effort'
        config:
          weights: { importance: 1, failure: 1 }
  ```

### 客户端什么时候调用

- 切到 `Auto` 时**立即**算一次（保证冷启动先落到中间档）；
- 每轮结束后由轮尾标签触发一次，600ms 防抖，**同一轮只算一次**；
- 接口返回 404/405 时标记为不可用并停止调用，菜单里会提示「自动评分未连接」，
  不会反复打无效请求。

### 历史真实档位

`/thinking-effort/turns` 按 `turn/start` … `turn/end` 的区间收集
`request/header` 事件，返回形如：

```json
{"ok":true,"turns":[{"turn":1,"effort":"low","seq":18,"endSeq":100}]}
```

客户端按会话缓存这份数据，用轮尾的 `seq` 匹配 `endSeq`（匹配不到时回退到
`endSeq ≤ seq` 的最后一轮，再回退到轮次编号），显示**当轮真实档位**；接口不可
用时才退回当前选择。

## 启用要点

Host 半边能起来需要满足：

1. 插件已链接进 profile 的 `node_modules`；
2. loader 里有它的行（bundle 自带 patch 已包含）；
3. `index.js` 导出 `export const inject = ['webServer']`。

第 3 条是踩过的坑：不声明依赖时，`apply` 可能先于 HTTP 服务就绪运行，
`ctx.get('webServer')` 得到 `undefined`，代码会静默 `return` —— 插件显示
`fiberPhase: active`，但路由根本没注册，所有请求落到 SPA 兜底（405）。

自检：

```powershell
curl.exe -s -X POST "http://127.0.0.1:<端口>/thinking-effort/evaluate" `
  -H "content-type: application/json" -H "sec-fetch-site: same-origin" `
  -d '{"sessionId":"probe"}'
```

返回结构化 JSON（例如 `{"ok":false,"error":"session-not-live"}`）说明路由活着；
405 说明没加载。

## 已知限制

- 每轮标签优先显示 `request/header` 记录的真实档位；接口不可用时才回退到当前
  选择。没有请求头记录的轮次（例如取消的轮）显示 `default`。
- `conversation.input.model.label` 没有转发其他插件的标签贡献。
- 菜单没有搜索框，也没有 roving focus（键盘逐项聚焦）。
- `selectModel` 在 agent 运行中可能被拒绝；响应会带 `applied: false` 和
  `applyError`，界面保留手动选择。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
