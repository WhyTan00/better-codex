# Better Codex 中文竖屏视频

这是面向微信视频号 / 小红书的 1080×1920 竖屏字幕版，约 66 秒。它用确定性的
Remotion 场景解释缓存、体验优化、定制工作台和 DSH 兼容性，不复制私有会话、持仓、
路径、凭据或生产媒体。

## 分镜

| 时间 | 主题 | 重点 |
| --- | --- | --- |
| 00:00–00:06 | Hook | 把 AI 工作台做成一层镜头：一个执行 owner、本地先画、项目级插件 |
| 00:06–00:15 | 责任边界 | Native Harness 持有 thread、turn、queue 和 writer；工作台持有导航、投影和插件视图 |
| 00:15–00:28 | 缓存链路 | paint → reconcile → confirm；accepted 不等于 confirmed |
| 00:28–00:38 | 用户体验 | 预热、按需分页、stale 标记、重连同一 owner，减少等待和误报 |
| 00:38–00:49 | 定制工作台 | 事实来源 → adapter → shell → scoped plugin → 发布门禁 |
| 00:49–01:00 | DSH 兼容性 | 思路可复用；简单只读插件可适配；领域插件和宿主 runtime 不能直接搬运 |
| 01:00–01:06 | Close | 开源参考，不是官方产品，不含凭据 |

## 生成

```bash
pnpm video:typecheck
pnpm video:render:zh
```

输出：[`video/out/better-codex-zh-vertical.mp4`](../video/out/better-codex-zh-vertical.mp4)。

对应 Remotion 源码：[`video/src/BetterCodexZhVertical.tsx`](../video/src/BetterCodexZhVertical.tsx)。
