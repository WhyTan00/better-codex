# Better Codex · whytan

[English](README.md) · [中文说明](README.zh-CN.md)

Better Codex 是一个公开的原生 AI 工作台参考实现：底层保留一个执行所有权，
界面采用本地优先交互，再把项目范围内的插件放在原生对话渲染器周围。

这是 **whytan** 的社区项目。它不是 OpenAI 官方产品，也不包含供应商凭据或
真实供应商连接器。

## 仓库内容

- `packages/harness-contract`：原生 Harness 适配器、线程摘要、事件、队列控制
  与缓存快照的供应商无关契约。
- `apps/demo`：无需登录的浏览器 Demo，包含合成对话、本地优先发送、工作区切换
  和项目插件卡片。
- `source/`：经过白名单和脱敏处理的 Web、同步、插件及 Android 集成边界参考源。
- `docs/media/`：公开安全的静态工作台、量化研究和视频制作展示图；其中所有数值
  都是合成或示意数据。
- `video/`：使用 Remotion 编写的确定性产品讲解视频源项目。
- [`video/out/better-codex-explainer.mp4`](video/out/better-codex-explainer.mp4)：
  已渲染的 32 秒讲解视频。

## 可视化展示

下面的图片是静态公开素材，用来解释产品结构，不包含真实会话、持仓、证券代码、
本地路径、凭据、生产端点或私有媒体。

![工作台总览](docs/media/workbench-overview.png)

*工作台总览：一个原生 Harness，加上本地优先状态和有边界的项目插件。*

![量化研究 Demo](docs/media/quant-research-demo.png)

*量化研究：只展示合成的纸面研究证据，实时交易和券商动作均已关闭。*

![视频制作 Demo](docs/media/video-production-demo.png)

*视频制作：静态 Remotion 分镜和本地渲染状态。*

中英双语的视觉说明见
[docs/visual-showcase.md](docs/visual-showcase.md)。

## 运行 Demo

```bash
pnpm install
pnpm demo
```

打开 <http://localhost:4173>。Demo 使用内存中的 Mock Harness，无需网络请求或
账号即可运行。

完整配置说明（包括替换 Mock Harness 和添加插件）见
[docs/open-source-setup.md](docs/open-source-setup.md)。

## 渲染讲解视频

视频使用确定性的 React/Remotion 场景表达架构、本地优先状态变化、项目适配器和
界面标签，便于复现和审阅。

```bash
pnpm video:install
pnpm video:typecheck
pnpm video:render
```

生成的 MP4 位于 `video/out/better-codex-explainer.mp4`，并作为轻量发布产物保留在
仓库中。

## 公开边界

私有实现包含真实会话、运行时状态、凭据、设备发布文件和受保护服务路由；这些内容
不会复制到这里。添加适配器或部署示例前，请阅读
[docs/public-boundary.md](docs/public-boundary.md)。

README 中的量化和视频截图是合成的公开 Demo，不表示本仓库可以登录券商、提交订单、
访问私人媒体库或部署生产渲染器。

## 许可证

MIT，见 [LICENSE](LICENSE)。
