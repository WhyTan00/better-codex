# Visual showcase / 可视化展示

This page documents the static visuals shipped with the public repository. It
is intentionally bilingual so a GitHub reader can understand both the product
story and the safety boundary.

本页说明公开仓库中随附的静态视觉素材，并保持中英双语，方便 GitHub 读者同时
理解产品故事和公开边界。

## Workbench overview / 工作台总览

![Workbench overview](media/workbench-overview.png)

The overview shows the public interaction contract: the native Harness owns
threads, turns, queue state, and writer ownership; the workbench adds
navigation, bounded local projections, and plugin cards.

总览图展示公开交互契约：原生 Harness 负责线程、回合、队列状态和写入所有权；
工作台只增加导航、有边界的本地投影和插件卡片。

## Quant Research / 量化研究

![Quant Research](media/quant-research-demo.png)

This is a synthetic, paper-only cockpit. The numbers, curve, candidate IDs, and
period labels are illustrative. There is no broker connection, account data,
order route, or live-trading behavior in the image or the public demo.

这是合成的纸面研究工作台。数字、曲线、候选 ID 和时间段都是示意内容；图片和
公开 Demo 不包含券商连接、账户数据、下单路由或实盘行为。

## Video Production / 视频制作

![Video Production](media/video-production-demo.png)

This is a static view of the video plugin contract: storyboard cards, a
Remotion timeline, and a local render result. It is a product explanation, not
a copy of a private media library or a production endpoint.

这是视频插件契约的静态展示：分镜卡片、Remotion 时间线和本地渲染结果。它用于
解释产品，不是私人媒体库或生产端点的复制品。

## Rebuild the image assets / 重新生成图片素材

The SVG files are the editable source of truth. The PNG files are generated
static copies for convenient GitHub rendering:

SVG 文件是可编辑的源文件，PNG 是方便 GitHub 直接展示的静态副本：

```bash
magick -background '#080c17' docs/media/workbench-overview.svg -resize 1600x1000 docs/media/workbench-overview.png
magick -background '#080c17' docs/media/quant-research-demo.svg -resize 1600x1000 docs/media/quant-research-demo.png
magick -background '#080c17' docs/media/video-production-demo.svg -resize 1600x1000 docs/media/video-production-demo.png
```

The explainer video remains deterministic and code-authored through Remotion:
see [`video/src/BetterCodexVideo.tsx`](../video/src/BetterCodexVideo.tsx) and
the rendered [MP4](../video/out/better-codex-explainer.mp4).

讲解视频继续使用 Remotion 确定性地由代码生成，见
[`video/src/BetterCodexVideo.tsx`](../video/src/BetterCodexVideo.tsx) 和已渲染的
[MP4](../video/out/better-codex-explainer.mp4)。
