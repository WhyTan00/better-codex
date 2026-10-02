# Better Codex

[下载 Mac 安装包](https://github.com/WhyTan00/better-codex/releases/download/v0.2.0-beta.2/Better-Codex-v0.2.0-beta.2-mac.zip)：解压到长期保留的位置，双击 `Install.command` 安装并启动。需要已安装并登录官方 Codex 桌面应用，首次安装会联网下载依赖。

[English](README.md) · [安装说明](docs/open-source-setup.md) · [插件开发](docs/plugins.md)

在自己的 Mac 上运行 Codex 工作台，通过 Tailscale 私网或 CVM 的 HTTPS 入口，从手机或另一台电脑继续同一个会话。

Mac 保留原生执行、审批与命令回执；本机中继传送实时事件，读取缓存可重建。网页复用官方会话界面，并加入工作区导航和可配置的项目插件。

## 安装与使用

先安装官方 Codex 桌面应用并登录，然后运行：

```sh
git clone https://github.com/WhyTan00/better-codex.git
cd better-codex
./install.sh --workspace "$HOME/Code"
"$HOME/.better-codex/start"
```

打开 `http://127.0.0.1:4173/?workspace=ai`。保留服务终端，Ctrl-C 停止本次启动的进程。也可以双击 `Install.command`，按默认目录完成安装并启动。

手机接入：Mac 与手机先安装并登录 Tailscale，停止工作台后运行：

```sh
"$HOME/.better-codex/better-codex" tailscale --enable
"$HOME/.better-codex/start"
```

用手机打开打印的 HTTPS `ts.net` 地址，可添加到主屏幕。入口同时检查 Tailscale 身份和允许的登录名；不会开启 Funnel。已有 Serve 路由冲突时会停止配置并保留原服务。

如果选择 CVM，安装器也提供 `better-codex cvm` 配置入口：生成带登录保护的 Caddy 站点和反向 SSH 隧道。Mac 保留执行和缓存，手机无需安装 Tailscale。[CVM 完整部署步骤](docs/cvm-deployment.md)。

## 按自己的项目配置

`~/.better-codex/deployment.json` 控制工作区路径、名称、端口、插件和访问方式。自带的 `project-overview` 只读取所选工作区的目录名称。

插件可以提供数据卡片或在工作台中嵌入自己的页面。项目数据和编辑事务仍由插件原系统维护，工作台不另建业务事实来源。[完整配置与排错](docs/open-source-setup.md) · [插件接口](docs/plugins.md)。

## 当前交付范围

这是 macOS 本机宿主测试版。Apple Silicon 已做隔离安装验证，Intel 尚未实机验证；手机通过 PWA 使用，本次不提供 Android APK 安装。真实手机体验与真实 Tailscale Serve 接入单独记录，不能用本地协议测试替代。[验收范围](docs/portable-validation.md)。

公开核心已同步会话恢复路径修复、自动标题服务、可选中继缓存，以及缓存首屏、重复加载图标、发送后切换会话的回调归属和模块重复初始化修复。仓库中的旧演示页面、截图和视频使用示例数据，用于说明产品，不代表真实安装结果。

安装器从上游下载并校验依赖，在本机提取官方界面资源；仓库不分发官方程序、账号、凭据或私人项目资料。官方桌面升级后可能需要更新兼容层。此项目不是 OpenAI 官方产品。

## 许可

自有代码采用 [MIT](LICENSE)。独立运行的 OpenCodex 及其修改采用 [AGPL-3.0-only](integrations/opencodex/LICENSE)，保留完整来源、固定版本和构建修改。官方资源沿用原有条款。详见 [第三方说明](THIRD_PARTY_NOTICES.md)。
