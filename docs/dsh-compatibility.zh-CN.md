# DSH 兼容性结论

## 结论

Better Codex 与 DSH 在“原生执行 owner + 工作台外壳 + 项目级插件”这一层是同类
架构，但当前公开仓库不是 DSH 的发行版，也不是 DSH 插件的直接运行时。可以复用
契约、分层方法和部分只读 UI 设计；不能把私有 DSH 插件目录直接复制过来就宣称
可运行。

## 兼容性矩阵

| 层级 | 判断 | 需要做什么 |
| --- | --- | --- |
| Harness / adapter 契约 | 可复用思路 | 保留连接状态、事件版本、队列和 writer ownership；按目标宿主重写 transport adapter |
| 简单只读插件 | 可适配 | 重绑 package metadata、模块导入、slot / route、schema 和项目数据来源，再跑 mock Harness 与视觉验证 |
| 量化、持仓、日程插件 | 不能直接复用 | 必须接入各自的权威事实来源、workspace scope、时间/版本信息与安全门；公开示例只能使用合成或只读投影 |
| Native Codex、session archive、fallback bridge | 不可直接搬运 | 这些能力绑定特定宿主、客户端 runtime、会话生命周期或私有 provider 边界，应重新设计 adapter |
| 凭据、SSO、生产 runtime | 不在公开边界内 | 不复制 OAuth、cookie、API key、私有路由、设备状态或个人运行时；只在受保护部署中由宿主提供 |

## 为什么不是 drop-in

DSH 插件一般不只包含一个 React 组件。它还可能依赖：

- DSH 的包名与共享模块导入；
- `ctx.tools`、`ctx.webServer`、`ctx.slots` 等宿主注入面；
- 私有 slot 名、路由、schema、workspace registry 和项目文件；
- 宿主侧会话、凭据、运行时和发布生命周期。

因此，直接复制代码最容易出现“能加载但事实来源错了”“UI 出来了但没有 writer
或权限边界”“route 可访问但泄露私有数据”这三类问题。正确的复用单位是能力
合同和 adapter 边界，不是私有目录。

## 公开仓库里的对应证据

公开 `source/` 只保留经过脱敏的参考实现：

- [`source/apps/native-codex-web/src/native-read-cache.mjs`](../source/apps/native-codex-web/src/native-read-cache.mjs) 展示了有界读缓存、generation、revision、失效标记和原生读取边界。
- [`source/apps/native-codex-web/src/sync-projection.mjs`](../source/apps/native-codex-web/src/sync-projection.mjs) 只输出公开展示投影，过滤凭据、系统消息和原始工具参数/输出。
- [`source/plugins/native-harness/index.mjs`](../source/plugins/native-harness/index.mjs) 展示了由插件注册 HTTP 边界、持有原生 adapter，而不是创建第二个执行 host。
- [`source/plugins/workbench-shell/index.mjs`](../source/plugins/workbench-shell/index.mjs) 展示了 shell 如何注册 PWA、导航和项目域 surface；它不等于某个 DSH 私有插件的运行时。
- [`source/apps/native-codex-web/src/registry.mjs`](../source/apps/native-codex-web/src/registry.mjs) 展示了 workspace、路径归属和插件 allow-list 的公开占位实现。

这些文件证明的是公开设计边界，不证明任何真实 provider、DSH 私有 host 或生产
数据已经接入。

## 迁移一个只读插件的最小清单

1. 明确插件唯一事实来源、数据时效和 workspace scope。
2. 把 DSH 专用包名、import、slot、route 和 schema 替换成目标宿主的公开契约。
3. 删除凭据读取、私有路径猜测和隐式项目匹配。
4. 让 adapter 返回明确的 loading、stale、unavailable 和 confirmed 状态。
5. 用合成数据跑契约 / 语法 / 脱敏 / 路由测试，再做实际宿主和手机视觉验收。

## 公开边界

本页不提供 DSH 私有包、私有配置、运行时文件或凭据，也不授权对任何私有工作台
进行安装、重启或发布。Better Codex 的视频和截图均为公开安全的合成展示。
