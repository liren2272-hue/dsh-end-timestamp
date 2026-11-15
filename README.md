# @local/dsh-end-timestamp

在 DSH 回复行（`conversation.chat.turnTail` 槽）行内追加**结束时间戳 + 用时 + 服务模型**，
覆盖 completed / interrupted（已停止）/ failed（处理失败）三类已结束的 turn。

## 结构

- **host 端**（`index.js`）：Cordis 插件，导出 `foldTurns(events)`，把原始 session 事件折成
  `{turn, startTime, endTime, kind, models}`；在 `webServer` 与 `connection.fetch` 两条路由
  各注册一个只读 POST handler（`/dsh-end-timestamp/turns` 与 `/api/dsh-end-timestamp/turns`），
  用 `ctx.get('sessionQuery')` 取服务（**不要**裸读 `ctx.sessionQuery`，会触发 ReflectService 陷阱）。
- **client 端**（`client.js`）：浏览器 bundle，`window.__ModuleLoader__.load` 结构，注入
  `conversation.chat.turnTail` 槽（`order: 100`）。`EndTimestampTail` 恒 `return null`，纯靠副作用打 DOM。

## v1.3.1（2026-11-15）——修复 MutationObserver 自激死循环

**问题**：v1.3「用时」功能在 `ensureStamp` 里对**已就位**节点调用 `insertBefore(dur, span)`。
DOM 语义上，`insertBefore` / `appendChild` 对已就位的子节点会先移除再插入，**照样发出一次
`childList` mutation**；而 `patch()` 恰好被同一个 `MutationObserver` 观察，回调以 microtask 入队，
于是 `patch → 写 DOM → mutation → patch → …` 无限循环，renderer 主线程被饿死，整个 GUI 假死
（表现为「点任意会话都卡死、插件栏目能打开、进程 CPU 仅约 40% 单核、`Responding=True`」）。

**修复（两处，都在 `client.js`）**：

1. **幂等 reposition**：只在节点不在正确槽位时才动它，已就位则一个字节都不写：
   ```js
   if (dur.parentNode !== label || dur.nextSibling !== span) {
     if (label.contains(span)) label.insertBefore(dur, span);
     else label.appendChild(dur);
   }
   const want = '，用时 ' + duration;
   if (dur.textContent !== want) dur.textContent = want;
   ```
2. **observer 双保险**：`patch()` 执行期间 `observer.disconnect()`，写完再 `observe()`，
   确保自己写的 DOM 永远不会被自己的 observer 记录。

**位置不变**：用时是**独立节点**，插在状态词之后、时间戳/模型之前，与 DSH 原生
「已完成，用时 X秒」的摆放位置一致；时间戳/模型仍在行尾，不会被「用时」挤掉。

**负向对照**：`verify_loop.cjs`（见 `docs/verify_loop.cjs`）用真实 `client.js` factory +
最小 DOM/MutationObserver 桩跑两版源码：出货版 `fired=500` 触发 LIMIT 判 `DIVERGED`，
修复版 `fired=1` 判 `CONVERGED`，证明回归被真实复现并消除，不是假绿。

## v1.3.2（2026-11-15）——用时字号、字体与 DSH 完全对齐

**问题**：v1.3.1 的「用时」节点写死了 `font-size:12px`，且没有设字体。而 DSH 自己渲染时长的样式是：

```css
.hE4tRW_label          { font-size: inherit; }
.hE4tRW_durationNumber { font-family: var(--ds-font-family-code);
                         font-variant-numeric: tabular-nums; }
```

结果已停止/出错这类新填的「用时」，字号比 DSH 原生的偏小、字体也对不上。

**修复（`client.js`）**：

1. 用时节点**去掉 `font-size`**，让它继承 label 的 `font-size: inherit`，与 DSH 一致。
2. **拆成数字段与单位段**：数字段用 `--ds-font-family-code` + `tabular-nums`（等宽数字），单位词
   （小时/分/秒）保留回复行字体——这正是 DSH `durationNumber` 只作用于数字的做法。
3. 用 `data-sig` 签名做**幂等重建**：只有时长值变化时才重建 children，无变化时一个字节都不写，
   继续沿用 v1.3.1 的死循环防护（observer 断连 + 就位不重排）。

**验证**：`_selftest.mjs` 新增 G1d（用时节点无 `font-size` 覆盖）、G1e（数字段使用
`--ds-font-family-code` + `tabular-nums`），全套 `ALL PASS`；`verify_loop.cjs` 负向对照
仍为 `BEFORE=DIVERGED / AFTER=CONVERGED -> PASS`，死循环防护未被本次改动破坏。

`--ds-font-family-code` 已确认是 DSH 应用内真实定义的全局 CSS 变量。

## v1.3.3（2026-11-15）——用时颜色与字号对齐 DSH 真实渲染

**问题**：v1.3.2 的用时节点写了 `opacity:.72`，整串又没有设颜色，于是「用时」比 DSH 原生的更浅；
用户反馈「字号还是有一点小、颜色浅了」。

**从 app.asar 取证的 DSH 真实规则**：

```css
.hE4tRW_root           { color: var(--dsw-alias-label-tertiary); font-size: var(--dsh-content-font-size,14px); }
.hE4tRW_label          { font-size: inherit; }
.hE4tRW_durationNumber { font-family: var(--ds-font-family-code); font-variant-numeric: tabular-nums; }
```

关键点：DSH 的时长**没有任何 opacity**，颜色来自按钮根的 `--dsw-alias-label-tertiary`
（亮色 `--dsw-static-neutral-bluish-600`，暗色 `-400`），字号继承根（14px），只有数字段用代码字体。

**修复（`client.js`）**：用时节点样式从 `opacity:.72;white-space:nowrap;` 改为
`white-space:nowrap;color:var(--dsw-alias-label-tertiary);`——去掉透明度、显式取根节点颜色，
字号继续继承 label，数字段仍用 `--ds-font-family-code` + `tabular-nums`。

**验证**：`_selftest.mjs` 新增 **G1f**（用时节点无 `opacity` 且使用 `--dsw-alias-label-tertiary`），
全套 `ALL PASS`；死循环回归（真实 `MutationObserver` 子进程，shipped fired=1 / broken fired=60）
仍 `PASS`，本次颜色改动未破坏 v1.3.1 的收敛防护。

## 本插件的专属雷区（改之前必读）

1. **`turnTail` 是高频重渲染区，任何 DOM 写必须幂等**：写之前先比对目标状态，已达标就不动。
2. **`insertBefore`/`appendChild` 对已就位节点仍发 mutation**：禁用裸调用，先判
   `parentNode` / `nextSibling` / `contains`。
3. **自己观察自己写的 DOM 必须断开观察**：写前 `disconnect()`、写完再 `observe()`。
4. **别写全局 `window.CSS` / `globalThis.CSS`**：客户端模块与官方 bundle 共享作用域，
   顶层 `var CSS` 会遮蔽原生 `CSS.supports`。插件里的 `const CSS = [...]` 都在 `factory()` 内，安全。
5. **host 路由与 `FOLD_PATHS` 同步改**：`client.js` 的 `FOLD_PATHS` 与 `index.js` 的 `PATH`/`API_PATH` 两处。
6. **Turn 标识是 `.turn` 不是 `.id`**：选择器用 `String(turn.turn)`。

## 生效方式

- **客户端插件**（`client.js` + `locale/`）是桌面端启动时打包进 bundle 的，**改完源码必须重启
  DSH 桌面端才生效**。**绝不 `taskkill` 强制重启**，只告知用户、等用户自己操作。
- **宿主侧** Cordis 插件改完，用端口监听 + HTTP 响应确认生效（POST 路由 200 = 启用，405 = 禁用）。
