import React from 'react';
import {AbsoluteFill, Easing, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';

export const ZH_VERTICAL_FPS = 30;
export const ZH_VERTICAL_WIDTH = 1080;
export const ZH_VERTICAL_HEIGHT = 1920;
export const ZH_VERTICAL_DURATION = 1980;

type Story = {
  title: string;
  subtitle: string;
  compatibility: string;
};

type Props = {story: Story};

const colors = {
  bg: '#08111d',
  panel: '#101d2d',
  panelSoft: 'rgba(16, 29, 45, .86)',
  line: 'rgba(207, 225, 245, .16)',
  text: '#f3f7ff',
  muted: '#a5b3c6',
  cyan: '#76ddff',
  violet: '#b9a2ff',
  green: '#48e2aa',
  amber: '#ffd27c',
  red: '#ff929b',
};

const fontFamily = '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Noto Sans SC", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const base: React.CSSProperties = {
  background: colors.bg,
  color: colors.text,
  fontFamily,
  overflow: 'hidden',
};

const Fade: React.FC<React.PropsWithChildren<{delay?: number; distance?: number; duration?: number}>> = ({children, delay = 0, distance = 22, duration = 18}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [delay, delay + duration], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});
  const y = interpolate(frame, [delay, delay + duration + 4], [distance, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});
  return <div style={{opacity, transform: `translateY(${y}px)`}}>{children}</div>;
};

const Mark: React.FC<{size?: number}> = ({size = 66}) => (
  <div style={{width: size, height: size, borderRadius: size * .24, display: 'grid', placeItems: 'center', flex: 'none', background: 'linear-gradient(135deg, #1a4260, #422f70)', border: '1px solid rgba(118,221,255,.42)', boxShadow: '0 15px 45px rgba(63,120,185,.3)', color: colors.cyan, fontSize: size * .47, fontWeight: 850}}>B</div>
);

const Dot: React.FC<{color?: string; size?: number}> = ({color = colors.green, size = 12}) => <span style={{display: 'inline-block', width: size, height: size, borderRadius: '50%', flex: 'none', background: color, boxShadow: `0 0 0 6px ${color}1c`}}/>;

const Background: React.FC<{accent?: string}> = ({accent = '#235b7e'}) => {
  const frame = useCurrentFrame();
  const drift = interpolate(frame, [0, 180], [0, -30], {extrapolateRight: 'clamp'});
  return <>
    <div style={{position: 'absolute', inset: 0, background: `radial-gradient(circle at 95% 0%, ${accent}73 0%, transparent 39%), radial-gradient(circle at 0% 100%, #31245d70 0%, transparent 43%)`}} />
    <div style={{position: 'absolute', inset: -80, opacity: .17, backgroundImage: 'linear-gradient(rgba(118,221,255,.16) 1px, transparent 1px), linear-gradient(90deg, rgba(118,221,255,.16) 1px, transparent 1px)', backgroundSize: '72px 72px', transform: `translateY(${drift}px)`}} />
    <div style={{position: 'absolute', left: -260, top: 610, width: 520, height: 520, borderRadius: '50%', border: `1px solid ${colors.cyan}22`, boxShadow: `0 0 0 60px ${colors.cyan}08, 0 0 0 120px ${colors.cyan}04`}} />
  </>;
};

const Footer: React.FC<{label?: string}> = ({label = 'whytan / Better Codex · 本地优先 AI 工作台'}) => (
  <div style={{position: 'absolute', left: 86, right: 86, bottom: 62, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, color: colors.muted, fontSize: 20, letterSpacing: '.02em'}}>
    <span>{label}</span><span style={{color: colors.cyan}}>●</span>
  </div>
);

const Kicker: React.FC<{children: React.ReactNode}> = ({children}) => <div style={{fontSize: 19, lineHeight: 1.4, letterSpacing: '.13em', textTransform: 'uppercase', color: colors.muted}}>{children}</div>;

const Header: React.FC<{number: string; kicker: string; title: string; summary?: string; accent?: string}> = ({number, kicker, title, summary, accent = colors.cyan}) => (
  <div style={{position: 'relative', zIndex: 1}}>
    <Fade><div style={{display: 'flex', alignItems: 'center', gap: 15}}><span style={{color: accent, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 22}}>{number}</span><Kicker>{kicker}</Kicker></div></Fade>
    <Fade delay={8}><h2 style={{margin: '25px 0 0', maxWidth: 900, fontSize: 67, lineHeight: 1.12, letterSpacing: '-.055em', fontWeight: 800}}>{title}</h2></Fade>
    {summary ? <Fade delay={19}><p style={{maxWidth: 870, margin: '20px 0 0', color: colors.muted, fontSize: 28, lineHeight: 1.52}}>{summary}</p></Fade> : null}
  </div>
);

const GlassCard: React.FC<React.PropsWithChildren<{accent?: string; style?: React.CSSProperties}>> = ({children, accent = colors.cyan, style}) => <div style={{border: `1px solid ${accent}4d`, borderRadius: 22, background: colors.panelSoft, boxShadow: `0 25px 80px ${accent}0d`, ...style}}>{children}</div>;

const TinyTag: React.FC<{children: React.ReactNode; color?: string}> = ({children, color = colors.cyan}) => <span style={{display: 'inline-flex', alignItems: 'center', gap: 9, padding: '8px 13px', border: `1px solid ${color}55`, borderRadius: 999, color, background: `${color}0e`, fontSize: 18, lineHeight: 1.2}}><Dot color={color} size={9}/>{children}</span>;

const IntroScene: React.FC<{story: Story}> = ({story}) => {
  const frame = useCurrentFrame();
  const pulse = 1 + Math.sin(frame / 18) * .012;
  const cardOpacity = interpolate(frame, [62, 82], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return <AbsoluteFill style={{...base, padding: '112px 86px'}}>
    <Background accent="#206782" />
    <div style={{position: 'relative', zIndex: 1}}>
      <Fade><div style={{display: 'flex', alignItems: 'center', gap: 17}}><Mark/><div><Kicker>中文竖屏版 · 约 66 秒</Kicker><div style={{marginTop: 6, color: colors.cyan, fontSize: 25, fontWeight: 700}}>Better Codex</div></div></div></Fade>
      <Fade delay={12}><h1 style={{margin: '72px 0 0', maxWidth: 910, fontSize: 98, lineHeight: 1.04, letterSpacing: '-.075em', fontWeight: 850}}>把 AI 工作台<br/><span style={{color: colors.cyan}}>做成一层镜头</span></h1></Fade>
      <Fade delay={28}><p style={{maxWidth: 850, margin: '28px 0 0', color: colors.muted, fontSize: 34, lineHeight: 1.45}}>{story.subtitle}</p></Fade>
      <Fade delay={46}><div style={{display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 38}}><TinyTag>一个执行 owner</TinyTag><TinyTag color={colors.green}>本地先画</TinyTag><TinyTag color={colors.violet}>项目级插件</TinyTag></div></Fade>
    </div>
    <GlassCard accent={colors.violet} style={{position: 'absolute', left: 86, right: 86, bottom: 235, minHeight: 420, padding: 30, opacity: cardOpacity, transform: `scale(${pulse}) translateY(${(1 - cardOpacity) * 22}px)`}}>
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, color: colors.muted, fontSize: 18}}><span>一条消息的真实路径</span><span style={{color: colors.green}}>状态可解释</span></div>
      <div style={{display: 'grid', gap: 16, marginTop: 28}}>
        {[['01', '界面先出现', 'local projection', colors.cyan], ['02', 'Harness 接收', 'accepted by native host', colors.violet], ['03', '事件确认', 'canonical thread confirmed', colors.green]].map(([number, label, detail, color], index) => <div key={String(number)} style={{display: 'grid', gridTemplateColumns: '62px 1fr auto', alignItems: 'center', gap: 16, padding: '20px 18px', borderRadius: 16, background: `${color}0b`, border: `1px solid ${color}32`, opacity: interpolate(frame, [72 + index * 8, 92 + index * 8], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}}><span style={{color: String(color), fontFamily: 'ui-monospace, monospace', fontSize: 20}}>{number}</span><div><div style={{fontSize: 25, fontWeight: 750}}>{label}</div><div style={{marginTop: 5, color: colors.muted, fontSize: 17}}>{detail}</div></div><span style={{color: String(color), fontSize: 28}}>{index === 2 ? '✓' : '→'}</span></div>)}
      </div>
    </GlassCard>
    <Footer label="whytan / Better Codex · 不是另建一个聊天数据库"/>
  </AbsoluteFill>;
};

const ArchitectureScene: React.FC = () => {
  const frame = useCurrentFrame();
  const lift = spring({frame, fps: ZH_VERTICAL_FPS, config: {damping: 18, stiffness: 70}});
  const noteOpacity = interpolate(frame, [76, 94], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return <AbsoluteFill style={{...base, padding: '105px 86px'}}>
    <Background accent="#2d4d91" />
    <Header number="01" kicker="先分清边界" title="谁负责执行？谁负责体验？" summary="工作台不是第二个聊天系统。它应该是一层镜头，围绕同一个原生 Harness 做导航、缓存和项目视图。" />
    <div style={{position: 'relative', zIndex: 1, display: 'grid', gap: 18, marginTop: 62, transform: `translateY(${(1 - lift) * 26}px)`}}>
      <GlassCard accent={colors.cyan} style={{padding: 28}}><div style={{display: 'flex', alignItems: 'center', gap: 16}}><div style={{display: 'grid', width: 56, height: 56, placeItems: 'center', borderRadius: 16, background: `${colors.cyan}18`, color: colors.cyan, fontSize: 28, fontWeight: 800}}>H</div><div><div style={{fontSize: 29, fontWeight: 800}}>Native Harness</div><div style={{marginTop: 6, color: colors.muted, fontSize: 19}}>thread · turn · queue · writer ownership</div></div></div><div style={{display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 24}}><TinyTag>唯一执行 owner</TinyTag><TinyTag color={colors.green}>原生事件</TinyTag><TinyTag color={colors.violet}>Stop / queue</TinyTag></div></GlassCard>
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'center', height: 52, color: colors.cyan, fontSize: 32}}>↓ <span style={{marginLeft: 10, color: colors.muted, fontSize: 19}}>公开契约，而不是私有 RPC</span></div>
      <GlassCard accent={colors.violet} style={{padding: 28}}><div style={{display: 'flex', alignItems: 'center', gap: 16}}><div style={{display: 'grid', width: 56, height: 56, placeItems: 'center', borderRadius: 16, background: `${colors.violet}18`, color: colors.violet, fontSize: 28, fontWeight: 800}}>W</div><div><div style={{fontSize: 29, fontWeight: 800}}>Better Codex Workbench</div><div style={{marginTop: 6, color: colors.muted, fontSize: 19}}>navigation · local projection · project plugins</div></div></div><div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11, marginTop: 24}}>{['快速切项目', '显示缓存状态', '复用原生会话', '挂载 scoped adapter'].map((label, index) => <div key={label} style={{padding: '13px 14px', borderRadius: 12, background: `${colors.violet}0c`, color: '#d9d0ff', fontSize: 18}}><span style={{color: colors.violet}}>✓</span> {label}</div>)}</div></GlassCard>
    </div>
    <div style={{position: 'absolute', left: 86, right: 86, bottom: 205, padding: '18px 21px', borderLeft: `3px solid ${colors.amber}`, background: `${colors.amber}0d`, color: '#ffe3a8', fontSize: 22, lineHeight: 1.45, opacity: noteOpacity, transform: `translateY(${(1 - noteOpacity) * 18}px)`}}>关键原则：外壳可以换，执行所有权不能分裂。</div>
    <Footer label="01 / 一个执行 owner · 多个可恢复界面"/>
  </AbsoluteFill>;
};

const CacheState: React.FC<{number: string; title: string; text: string; color: string; active: boolean}> = ({number, title, text, color, active}) => <div style={{padding: 20, borderRadius: 18, border: `1px solid ${active ? color : colors.line}`, background: active ? `${color}12` : 'rgba(16,29,45,.5)', opacity: active ? 1 : .55, transform: active ? 'scale(1.02)' : 'scale(1)', transition: 'none'}}><div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14}}><span style={{fontFamily: 'ui-monospace, monospace', color, fontSize: 18}}>{number}</span><Dot color={active ? color : colors.muted} size={10}/></div><div style={{marginTop: 20, fontSize: 26, fontWeight: 800}}>{title}</div><div style={{marginTop: 9, color: colors.muted, fontSize: 18, lineHeight: 1.45}}>{text}</div></div>;

const CacheScene: React.FC = () => {
  const frame = useCurrentFrame();
  const stage = frame < 106 ? 0 : frame < 218 ? 1 : 2;
  const breathe = interpolate(frame, [0, 80, 160, 240], [0, 1, 0, 1], {extrapolateRight: 'clamp'});
  return <AbsoluteFill style={{...base, padding: '105px 86px'}}>
    <Background accent="#146c68" />
    <Header number="02" kicker="缓存与体验" title="本地先画，事件再收敛" summary="速度来自读副本和预热；可信度来自版本、确认时间和明确的 stale 状态。" accent={colors.green}/>
    <Fade delay={32}><div style={{position: 'relative', zIndex: 1, display: 'grid', gap: 14, marginTop: 48}}>
      <CacheState number="01 / PAINT" title="先把可用画面交给用户" text="Pinned list、最近页和本地 projection 先出屏；不等整条链路才开始渲染。" color={colors.cyan} active={stage === 0}/>
      <div style={{height: 25, paddingLeft: 30, color: colors.cyan, fontSize: 28}}>↓</div>
      <CacheState number="02 / RECONCILE" title="只合并更新版本" text="监听 Harness 事件，按 revision / generation 合并；飞行中的旧读取不能覆盖新状态。" color={colors.violet} active={stage === 1}/>
      <div style={{height: 25, paddingLeft: 30, color: colors.violet, fontSize: 28}}>↓</div>
      <CacheState number="03 / CONFIRM" title="原生确认后再说完成" text="accepted 不等于 confirmed。队列、writer 和 canonical thread 的事实分开显示。" color={colors.green} active={stage === 2}/>
    </div></Fade>
    <GlassCard accent={colors.amber} style={{position: 'absolute', left: 86, right: 86, bottom: 198, padding: 22, opacity: interpolate(frame, [78, 96], [0, .92], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}), transform: `translateY(${interpolate(frame, [78, 96], [18, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}px)`}}><div style={{display: 'flex', alignItems: 'center', gap: 12, color: '#ffe2a0', fontSize: 21, fontWeight: 750}}><span style={{fontSize: 26}}>↗</span>体验优化的三个小动作</div><div style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 9, marginTop: 15}}>{[['预热', '空闲时读下一页'], ['限界', '缓存有上限'], ['标明', '新鲜度与 stale']].map(([title, text]) => <div key={title} style={{padding: 12, borderRadius: 12, background: `${colors.amber}0b`, color: colors.muted, fontSize: 16, lineHeight: 1.4}}><div style={{color: '#ffe2a0', fontSize: 18, fontWeight: 750}}>{title}</div><div style={{marginTop: 4}}>{text}</div></div>)}</div></GlassCard>
    <div style={{position: 'absolute', top: 1010, right: 86, color: `${colors.green}${Math.round(90 + breathe * 80).toString(16)}`, fontSize: 17}}>cache = read replica · not a second owner</div>
    <Footer label="02 / 快，不靠假装完成"/>
  </AbsoluteFill>;
};

const ExperienceScene: React.FC = () => {
  const frame = useCurrentFrame();
  const cards = [
    {title: '少等待', text: '先出列表，再按需读详情', icon: '01', color: colors.cyan},
    {title: '少误报', text: 'accepted / confirmed 分开', icon: '02', color: colors.green},
    {title: '少重复', text: '重连后继续同一执行 owner', icon: '03', color: colors.violet},
  ];
  return <AbsoluteFill style={{...base, padding: '105px 86px'}}>
    <Background accent="#4f346d" />
    <Header number="03" kicker="用户体验" title="真正的快，是少一次重新理解" summary="切页、刷新、断线重连，都从同一份事实重新收敛，而不是让用户猜任务到底去哪了。" accent={colors.violet}/>
    <div style={{position: 'relative', zIndex: 1, display: 'grid', gap: 14, marginTop: 62}}>{cards.map((card, index) => <Fade key={card.title} delay={32 + index * 12}><GlassCard accent={card.color} style={{display: 'grid', gridTemplateColumns: '65px 1fr', gap: 16, padding: 25}}><div style={{display: 'grid', width: 56, height: 56, placeItems: 'center', borderRadius: 15, background: `${card.color}18`, color: card.color, fontFamily: 'ui-monospace, monospace', fontSize: 17}}>{card.icon}</div><div><div style={{fontSize: 30, fontWeight: 800}}>{card.title}</div><div style={{marginTop: 8, color: colors.muted, fontSize: 20, lineHeight: 1.45}}>{card.text}</div></div></GlassCard></Fade>)}</div>
    <Fade delay={92}><div style={{position: 'relative', zIndex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15, marginTop: 28}}><div style={{padding: 21, borderRadius: 17, background: `${colors.green}0c`, border: `1px solid ${colors.green}35`}}><div style={{color: colors.green, fontSize: 18, fontWeight: 750}}>诚实状态</div><div style={{marginTop: 9, fontSize: 19, lineHeight: 1.45}}>“已送达”可以很快；“已完成”必须有证据。</div></div><div style={{padding: 21, borderRadius: 17, background: `${colors.red}0c`, border: `1px solid ${colors.red}35`}}><div style={{color: colors.red, fontSize: 18, fontWeight: 750}}>避免陷阱</div><div style={{marginTop: 9, fontSize: 19, lineHeight: 1.45}}>不复制会话，不创建隐形 writer。</div></div></div></Fade>
    <Footer label="03 / 让用户知道现在发生了什么"/>
  </AbsoluteFill>;
};

const BuildStep: React.FC<{number: string; title: string; text: string; color: string; index: number}> = ({number, title, text, color, index}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [24 + index * 13, 45 + index * 13], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const x = interpolate(frame, [24 + index * 13, 45 + index * 13], [30, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return <div style={{display: 'grid', gridTemplateColumns: '62px 1fr', gap: 14, alignItems: 'start', opacity, transform: `translateX(${x}px)`}}><div style={{display: 'grid', width: 53, height: 53, placeItems: 'center', borderRadius: 14, background: `${color}18`, border: `1px solid ${color}53`, color, fontFamily: 'ui-monospace, monospace', fontSize: 17}}>{number}</div><div style={{paddingBottom: 21, borderBottom: index === 4 ? 'none' : `1px solid ${colors.line}`}}><div style={{fontSize: 26, fontWeight: 800}}>{title}</div><div style={{marginTop: 6, color: colors.muted, fontSize: 18, lineHeight: 1.4}}>{text}</div></div></div>;
};

const BuildScene: React.FC = () => <AbsoluteFill style={{...base, padding: '105px 86px'}}>
  <Background accent="#75542d" />
  <Header number="04" kicker="定制工作台" title="从零开始，先做事实链" summary="不是先画一个漂亮首页；先把来源、adapter、缓存和验收边界写清楚，再让插件围绕它生长。" accent={colors.amber}/>
  <div style={{position: 'relative', zIndex: 1, display: 'grid', gap: 18, marginTop: 49}}>
    <BuildStep number="01" title="找准事实来源" text="谁拥有会话、持仓、分镜或任务？先锁定唯一维护来源。" color={colors.cyan} index={0}/>
    <BuildStep number="02" title="写一个有边界的 adapter" text="把私有数据映射成公开契约，保留来源时间、版本和失败状态。" color={colors.violet} index={1}/>
    <BuildStep number="03" title="让 shell 只负责体验" text="导航、预热、缓存投影、状态卡片；不把界面变成第二个数据库。" color={colors.green} index={2}/>
    <BuildStep number="04" title="插件只拿 scoped context" text="量化、视频、日程各自读自己的项目数据，不能跨域猜身份。" color={colors.amber} index={3}/>
    <BuildStep number="05" title="最后才做发布门禁" text="脱敏扫描、语法、契约、渲染和公开链接逐层验证。" color={colors.red} index={4}/>
  </div>
  <div style={{position: 'absolute', left: 86, right: 86, bottom: 190, display: 'flex', gap: 10, flexWrap: 'wrap', opacity: interpolate(useCurrentFrame(), [105, 123], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}), transform: `translateY(${interpolate(useCurrentFrame(), [105, 123], [18, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}px)`}}><TinyTag color={colors.amber}>量化：合成 / paper only</TinyTag><TinyTag color={colors.violet}>视频：Remotion / local preview</TinyTag></div>
  <Footer label="04 / 先事实链，再界面"/>
</AbsoluteFill>;

const CompatibilityRow: React.FC<{label: string; result: string; detail: string; color: string; index: number}> = ({label, result, detail, color, index}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [20 + index * 12, 40 + index * 12], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return <div style={{display: 'grid', gridTemplateColumns: '1fr auto', gap: 13, padding: '17px 0', borderBottom: `1px solid ${colors.line}`, opacity}}><div><div style={{fontSize: 21, fontWeight: 750}}>{label}</div><div style={{marginTop: 5, color: colors.muted, fontSize: 16, lineHeight: 1.35}}>{detail}</div></div><div style={{alignSelf: 'center', padding: '8px 11px', borderRadius: 9, background: `${color}13`, border: `1px solid ${color}42`, color, fontSize: 17, fontWeight: 750, whiteSpace: 'nowrap'}}>{result}</div></div>;
};

const DshCompatibilityScene: React.FC<{story: Story}> = ({story}) => <AbsoluteFill style={{...base, padding: '105px 86px'}}>
  <Background accent="#673f63" />
  <Header number="05" kicker="DSH 兼容性" title="能不能直接复用 DSH 插件？" summary={story.compatibility} accent={colors.red}/>
  <GlassCard accent={colors.red} style={{position: 'relative', zIndex: 1, marginTop: 43, padding: '10px 23px 4px'}}>
    <CompatibilityRow label="契约 / 架构思路" result="可复用" detail="Harness、scoped adapter、本地投影这些原则相通。" color={colors.green} index={0}/>
    <CompatibilityRow label="简单只读插件" result="可适配" detail="重绑 package、slot、路由和公开数据 schema 后再接入。" color={colors.cyan} index={1}/>
    <CompatibilityRow label="量化 / 持仓 / 日程" result="需重接" detail="必须接项目自己的事实来源、权限和安全门。" color={colors.amber} index={2}/>
    <CompatibilityRow label="Native Codex / runtime" result="不可直搬" detail="绑定宿主、私有包、凭据或会话生命周期，不能当 drop-in。" color={colors.red} index={3}/>
  </GlassCard>
  <Fade delay={90}><div style={{position: 'relative', zIndex: 1, marginTop: 25, padding: '20px 21px', borderRadius: 18, background: `${colors.amber}0d`, border: `1px solid ${colors.amber}36`, color: '#ffe4aa', fontSize: 21, lineHeight: 1.5}}><span style={{fontWeight: 800}}>一句话：</span>复用的是能力边界和设计方法，不是把 DSH 私有插件目录复制过来。</div></Fade>
  <Fade delay={110}><div style={{position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 12, marginTop: 28, color: colors.muted, fontSize: 19}}><Dot color={colors.green}/> Better Codex public snapshot = sanitized reference，不是 DSH binary distribution</div></Fade>
  <Footer label="05 / 可复用 ≠ 可直接搬运"/>
</AbsoluteFill>;

const CloseScene: React.FC = () => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 42], [.94, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return <AbsoluteFill style={{...base, alignItems: 'center', justifyContent: 'center', padding: '110px 86px', textAlign: 'center'}}>
    <Background accent="#27567e" />
    <div style={{position: 'relative', zIndex: 1, transform: `scale(${scale})`}}>
      <Fade><Mark size={92}/></Fade>
      <Fade delay={12}><h2 style={{margin: '34px 0 0', fontSize: 78, lineHeight: 1.08, letterSpacing: '-.07em', fontWeight: 850}}>Better Codex</h2></Fade>
      <Fade delay={28}><p style={{margin: '24px auto 0', maxWidth: 810, color: colors.muted, fontSize: 29, lineHeight: 1.6}}>一个执行 owner<br/>一份诚实状态<br/>一组围绕项目生长的插件</p></Fade>
      <Fade delay={57}><div style={{display: 'inline-flex', alignItems: 'center', gap: 11, marginTop: 44, padding: '14px 20px', border: `1px solid ${colors.cyan}55`, borderRadius: 999, color: colors.cyan, fontSize: 18}}>github.com/TonyandWei/better-codex <span>↗</span></div></Fade>
      <Fade delay={75}><div style={{marginTop: 32, color: colors.muted, fontSize: 17}}>开源参考 · 非官方产品 · 不含凭据</div></Fade>
    </div>
    <Footer label="whytan / Better Codex · 把复杂性放在正确的边界里"/>
  </AbsoluteFill>;
};

export const BetterCodexZhVertical: React.FC<Props> = ({story}) => <AbsoluteFill style={base}>
  <Sequence from={0} durationInFrames={180}><IntroScene story={story}/></Sequence>
  <Sequence from={180} durationInFrames={270}><ArchitectureScene/></Sequence>
  <Sequence from={450} durationInFrames={390}><CacheScene/></Sequence>
  <Sequence from={840} durationInFrames={300}><ExperienceScene/></Sequence>
  <Sequence from={1140} durationInFrames={330}><BuildScene/></Sequence>
  <Sequence from={1470} durationInFrames={330}><DshCompatibilityScene story={story}/></Sequence>
  <Sequence from={1800} durationInFrames={180}><CloseScene/></Sequence>
</AbsoluteFill>;
