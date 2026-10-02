# DSH 兼容性结论

## 结论

Better Codex 与 DSH 在“原生执行 owner + 工作台外壳 + 项目级插件”这一层是同类
架构，但当前公开仓库不是 DSH 的发行版，也不是 DSH 插件的直接运行时。可以复用
契约、分层方法和部分只读 UI 设计；不能把私有 DSH 插件目录直接复制过来就宣称
可运行。

## 兼容性矩阵

| 层级 | 判断 | 需要做什么 |
| --- | --- | --- |
| Native front / observer / relay | 已复用为可安装核心 | 配置本机 endpoint、工作区与依赖位置；保留连接状态、事件版本、Journal 和 writer ownership |
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

从 0.2 beta 起，公开 `source/` 提供可安装的 Mac/PWA 核心，私人部署映射仍在公开边界之外：

- [`source/apps/native-codex-web/src/native-read-cache.mjs`](../source/apps/native-codex-web/src/native-read-cache.mjs) 展示了有界读缓存、generation、revision、失效标记和原生读取边界。
- [`source/apps/native-codex-web/src/official-boundary.mjs`](../source/apps/native-codex-web/src/official-boundary.mjs) 在 Native 前校验 workspace、操作与 writer 归属。
- [`source/apps/native-codex-web/src/portable-entry.mjs`](../source/apps/native-codex-web/src/portable-entry.mjs) 校验本机或 Tailscale 身份、Origin 和插件 capability。
- [`source/apps/native-codex-web/src/portable-plugins.mjs`](../source/apps/native-codex-web/src/portable-plugins.mjs) 承载项目 adapter 和本地 UI，不创建第二份业务可写事实。
- [`source/apps/native-codex-web/src/deployment-config.mjs`](../source/apps/native-codex-web/src/deployment-config.mjs) 与 [`插件文档`](plugins.md) 定义配置、根归属与插件边界。

本地安装、冷启动和协议验证已完成，详见 [验证范围](portable-validation.md)。这不表示任何私人业务数据已经接入；真实手机、TailScale 实网及登录后模型执行仍有验收缺口。

## 迁移一个只读插件的最小清单

1. 明确插件唯一事实来源、数据时效和 workspace scope。
2. 把 DSH 专用包名、import、slot、route 和 schema 替换成目标宿主的公开契约。
3. 删除凭据读取、私有路径猜测和隐式项目匹配。
4. 让 adapter 返回明确的 loading、stale、unavailable 和 confirmed 状态。
5. 用合成数据跑契约 / 语法 / 脱敏 / 路由测试，再做实际宿主和手机视觉验收。

## 公开边界

本页不提供 DSH 私有包、私有配置、运行时文件或凭据，也不授权对任何私有工作台
进行安装、重启或发布。Better Codex 的视频和截图均为公开安全的合成展示。
