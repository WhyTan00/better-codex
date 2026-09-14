# Better Codex explainer

This directory contains two silent, caption-led product explainers for the
**whytan / Better Codex** public project. The technical claims, architecture,
UI labels, project adapters, and transitions are rendered deterministically
with Remotion. They do not use a generative video model for exact product
facts.

这是 **whytan / Better Codex** 公开项目的两条无声字幕式产品讲解视频。架构、界面
标签、项目适配器和转场均由 Remotion 确定性渲染，不使用生成式视频模型表达精确
产品事实。

```bash
pnpm install
pnpm typecheck
pnpm render
pnpm render:zh-vertical
```

Outputs:

- `video/out/better-codex-explainer.mp4` — 1920×1080, 32 seconds.
- `video/out/better-codex-zh-vertical.mp4` — 1080×1920, approximately 66
  seconds, Chinese caption-led cut for WeChat Channels / Xiaohongshu.

The Chinese shot list and compatibility claims are in
[`docs/video-script.zh-CN.md`](../docs/video-script.zh-CN.md) and
[`docs/dsh-compatibility.zh-CN.md`](../docs/dsh-compatibility.zh-CN.md).
