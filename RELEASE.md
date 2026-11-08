# 发布前检查清单（0.1.0）

## 一、必须先决定的三件事

1. **npm 包名 / scope**
   现在 `package.json` 里是 `@local/thinking-effort`，`@local` 不是可发布的 scope。
   发布前改成你自己的 npm scope，例如 `@jiangjiang/thinking-effort` 或 `dsh-thinking-effort`。
   ⚠️ 改名会断开当前 profile 里 `node_modules/@local/thinking-effort` 的软链，
   改完要重新 link 并重启 DSH。

2. **许可证**
   已放 MIT（`LICENSE`，版权人写的「江江」）。如果要换协议或署名，直接改这两个文件。

3. **Host 半边是否进 0.1.0**
   见下面「可行性结论」：0.1.0 实际只有 UI + 手动切换。
   要么把 auto 评分留到 0.2.0 并在 README 里保留「未接线」说明，
   要么先接线、重启验证后再发。

## 二、可行性结论（本机实测）

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| 客户端 bundle 加载 | ✅ | `conversation.input.model` occupant `active: true` |
| 替换模型选择器（模型列表可选） | ✅（待用户目视确认） | 目录用 `useSyncExternalStore` + `directory.load()` |
| 手动 ←/→ 切档，含 Auto、不回绕 | ✅ | 代码 `ladder = levels + Auto`，clamp |
| 鼠标在输入框内时屏蔽方向键 | ✅（实现完成） | `mousemove` + 包含 `textarea` 的祖先容器矩形判定 |
| 小字彩虹 + 横向滑动 | ✅ | `.tef-eff` 渐变 + `tef-eff-*` 关键帧 |
| 每轮档位标签（0 高度展开 / 淡入淡出） | ✅ | `.tef-turn` max-height 0 → 28px |
| 每轮标签显示「历史真实档位」 | ❌ | 当前显示会话当前档位 |
| auto 打分（importance/failure） | ✅ 实测 | `importance 7 (judge) + failure 2 = total 9 → index 2 → high`，`applied: true` |
| 客户端调用打分路由 | ✅ 已接线 | Auto 时立即调用；每轮结束由 turnTail 触发（600ms 防抖、同轮一次） |

**结论：** 0.1.0 可以作为「思考强度选择器（手动 + Auto 标记 + 每轮标签）」发布；
自动切换是 0.2.0 的工作。

## 三、发布前机械验证（每次改完都跑）

```powershell
node --check "C:\Users\HUAWEI\Desktop\Result showcase\thinking-effort-plugin\client.js"
node --check "C:\Users\HUAWEI\Desktop\Result showcase\thinking-effort-plugin\index.js"
node -e "const fs=require('fs');const p='C:\Users\HUAWEI\Desktop\Result showcase\thinking-effort-plugin\package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));console.log(j.name,j.version,j.files.length)"
```

- [ ] 两个 `node --check` 通过
- [ ] `package.json`、`locale/*.json` 能被 JSON.parse
- [ ] `exports` / `files` 里的每个路径都存在
- [ ] `cordis.patch.yml` 的 `name` 与 `package.json` 的 `name` 一致
- [ ] 刷新页面后：可选模型、←/→ 切档、彩虹小字滑动、每轮标签显隐
- [ ] 关掉 auto 后，对话下方不再留空白

## 四、已知限制（README 已同步）

- 每轮标签不是历史真实档位，是当前档位。
- `conversation.input.model.label` 未转发。
- 菜单没有搜索框、没有 roving focus。
- Host 半边未在运行时验证过。

## 五、建议的提交信息

```
feat: thinking-effort picker 0.1.0

- replace conversation.input.model with model + effort menu
- arrow cycling over real levels + Auto, no wrap, mouse-aware
- sliding rainbow effort word, per-turn effort tag
- host scoring half kept behind a documented 0.2.0 boundary
```
