import React from 'react';
import {AbsoluteFill, Easing, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';

export const VIDEO_FPS = 30;
export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;
export const VIDEO_DURATION = 960;

type Story = {title: string; subtitle: string; scenes: string[]};
type Props = {story: Story};

const colors = {
  bg: '#080c17', panel: '#111a2b', panelSoft: 'rgba(17,26,43,.82)', line: 'rgba(194,212,238,.15)',
  text: '#edf3ff', muted: '#92a0b7', blue: '#7dd3fc', violet: '#a78bfa', green: '#34d399', amber: '#f7c978',
};

const base: React.CSSProperties = {
  background: colors.bg,
  color: colors.text,
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  overflow: 'hidden',
};

const Fade: React.FC<React.PropsWithChildren<{delay?: number; distance?: number}>> = ({children, delay = 0, distance = 18}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [delay, delay + 18], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const y = interpolate(frame, [delay, delay + 22], [distance, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return <div style={{opacity, transform: `translateY(${y}px)`}}>{children}</div>;
};

const Mark: React.FC<{size?: number}> = ({size = 64}) => (
  <div style={{width: size, height: size, borderRadius: size * .25, display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg, #173653, #382d67)', border: '1px solid rgba(125,211,252,.35)', boxShadow: '0 16px 40px rgba(59,92,160,.3)', color: colors.blue, fontSize: size * .47, fontWeight: 800}}>B</div>
);

const Dot: React.FC<{color?: string}> = ({color = colors.green}) => <span style={{display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: color, boxShadow: `0 0 0 6px ${color}20`}}/>;

const SectionLabel: React.FC<{children: React.ReactNode}> = ({children}) => <div style={{fontSize: 19, letterSpacing: '.16em', textTransform: 'uppercase', color: colors.muted}}>{children}</div>;

const BackgroundGlow: React.FC<{accent?: string}> = ({accent = '#21466f'}) => (
  <>
    <div style={{position: 'absolute', width: 1050, height: 1050, left: 1050, top: -500, borderRadius: '50%', background: `radial-gradient(circle, ${accent}70 0%, transparent 68%)`, filter: 'blur(20px)'}} />
    <div style={{position: 'absolute', width: 720, height: 720, left: -300, bottom: -420, borderRadius: '50%', background: 'radial-gradient(circle, #31245d66 0%, transparent 70%)', filter: 'blur(20px)'}} />
  </>
);

const TitleScene: React.FC<{story: Story}> = ({story}) => {
  const frame = useCurrentFrame();
  const drift = interpolate(frame, [0, 180], [0, -22], {extrapolateRight: 'clamp'});
  return <AbsoluteFill style={{...base, padding: '150px 150px', justifyContent: 'center'}}>
    <BackgroundGlow accent="#215c7d" />
    <div style={{position: 'absolute', inset: 0, opacity: .14, backgroundImage: 'linear-gradient(rgba(125,211,252,.15) 1px, transparent 1px), linear-gradient(90deg, rgba(125,211,252,.15) 1px, transparent 1px)', backgroundSize: '64px 64px', transform: `translateY(${drift}px)`}} />
    <Fade><div style={{display: 'flex', alignItems: 'center', gap: 20}}><Mark size={70}/><SectionLabel>an open workbench pattern</SectionLabel></div></Fade>
    <Fade delay={10}><h1 style={{margin: '34px 0 0', maxWidth: 1300, fontSize: 112, lineHeight: .98, letterSpacing: '-.065em', fontWeight: 800}}>{story.title}</h1></Fade>
    <Fade delay={24}><p style={{maxWidth: 1100, margin: '34px 0 0', color: colors.muted, fontSize: 38, lineHeight: 1.35}}>{story.subtitle}</p></Fade>
    <Fade delay={40}><div style={{display: 'flex', alignItems: 'center', gap: 12, marginTop: 48, color: '#bdeedb', fontSize: 21}}><Dot/> One execution owner · many clients · your workbench</div></Fade>
  </AbsoluteFill>;
};

type Node = {label: string; x: number; y: number; color: string; sub: string};
const ArchitectureScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const progress = spring({frame, fps, config: {damping: 20, stiffness: 70}});
  const nodes: Node[] = [
    {label: 'Desktop', sub: 'native client', x: 70, y: 120, color: colors.blue},
    {label: 'Web workbench', sub: 'custom shell', x: 70, y: 340, color: colors.violet},
    {label: 'Android', sub: 'background sync', x: 70, y: 560, color: colors.green},
    {label: 'Native Harness', sub: 'threads · turns · queue', x: 650, y: 330, color: colors.blue},
    {label: 'Project plugins', sub: 'documents · quant · video', x: 1330, y: 330, color: colors.amber},
  ];
  const byLabel = new Map(nodes.map((node) => [node.label, node]));
  const edges = [['Desktop', 'Native Harness'], ['Web workbench', 'Native Harness'], ['Android', 'Native Harness'], ['Native Harness', 'Project plugins']];
  return <AbsoluteFill style={{...base, padding: '100px 120px'}}>
    <BackgroundGlow accent="#263c82" />
    <Fade><SectionLabel>01 · one execution owner</SectionLabel></Fade>
    <Fade delay={10}><h2 style={{margin: '22px 0 0', fontSize: 62, letterSpacing: '-.045em'}}>Clients reconnect to the same native Harness.</h2></Fade>
    <div style={{position: 'absolute', left: 120, top: 270, width: 1680, height: 650}}>
      <svg width="1680" height="650" style={{position: 'absolute', inset: 0, overflow: 'visible'}}>
        {edges.map(([from, to], index) => {
          const a = byLabel.get(from)!; const b = byLabel.get(to)!;
          const x1 = a.x + 270, y1 = a.y + 65, x2 = b.x, y2 = b.y + 65;
          const local = interpolate(frame, [index * 10, index * 10 + 36], [0, progress], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
          return <line key={`${from}-${to}`} x1={x1} y1={y1} x2={x1 + (x2 - x1) * local} y2={y1 + (y2 - y1) * local} stroke={colors.blue} strokeWidth={5} opacity={.65} />;
        })}
      </svg>
      {nodes.map((node, index) => {
        const opacity = interpolate(frame, [index * 8, index * 8 + 20], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
        return <div key={node.label} style={{position: 'absolute', left: node.x, top: node.y, width: 270, height: 130, opacity, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 24px', border: `2px solid ${node.color}80`, borderRadius: 20, background: colors.panelSoft, boxShadow: `0 20px 55px ${node.color}16`}}><div style={{fontSize: 28, fontWeight: 700}}>{node.label}</div><div style={{marginTop: 7, color: colors.muted, fontSize: 16}}>{node.sub}</div></div>;
      })}
    </div>
    <div style={{position: 'absolute', left: 120, bottom: 78, color: colors.muted, fontSize: 21, opacity: interpolate(frame, [50, 68], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}}>The shell adds context. The Harness keeps execution, queue, and writer ownership.</div>
  </AbsoluteFill>;
};

const MiniShell: React.FC<{stage: number}> = ({stage}) => {
  const stages = ['painting locally', 'accepted by Harness', 'confirmed in thread'];
  return <div style={{display: 'grid', gridTemplateColumns: '240px 1fr 250px', height: 525, overflow: 'hidden', border: `1px solid ${colors.line}`, borderRadius: 18, background: '#0d1321', boxShadow: '0 30px 80px rgba(0,0,0,.35)'}}>
    <div style={{borderRight: `1px solid ${colors.line}`, padding: 22}}><div style={{display: 'flex', gap: 9, alignItems: 'center', fontSize: 16, fontWeight: 700}}><Mark size={30}/> whytan / Better Codex</div><div style={{marginTop: 37, color: colors.muted, fontSize: 12, letterSpacing: '.08em', textTransform: 'uppercase'}}>Pinned</div>{['Native Harness design', 'Quant Research', 'Video production'].map((item, index) => <div key={item} style={{display: 'flex', gap: 8, alignItems: 'center', padding: '14px 0', borderBottom: index === 2 ? 0 : `1px solid ${colors.line}`, fontSize: 12, color: index === 0 ? colors.text : colors.muted}}><Dot color={index === 0 ? colors.green : index === 1 ? colors.amber : colors.violet}/>{item}</div>)}<div style={{position: 'absolute', marginTop: 90, color: colors.green, fontSize: 11}}>● local projection warm</div></div>
    <div style={{padding: 26, position: 'relative'}}><div style={{color: colors.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.12em'}}>Conversation · native session</div><div style={{marginTop: 9, fontSize: 22, fontWeight: 700}}>Native Harness design</div><div style={{marginTop: 50, display: 'grid', gap: 24}}><div style={{display: 'flex', gap: 10}}><div style={{width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', background: '#25344b', color: colors.blue, fontWeight: 700}}>W</div><div><div style={{fontSize: 11, color: colors.muted}}>whytan · now</div><div style={{marginTop: 5, fontSize: 15}}>Add a quant or video view to this project.</div></div></div><div style={{display: 'flex', gap: 10}}><div style={{width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', background: '#303054', color: colors.violet}}>✦</div><div><div style={{fontSize: 11, color: colors.muted}}>Better Codex</div><div style={{marginTop: 5, fontSize: 15, lineHeight: 1.5, maxWidth: 470}}>The shell paints a bounded local projection while project adapters stay outside the canonical conversation owner.</div></div></div></div><div style={{position: 'absolute', left: 26, right: 26, bottom: 24, border: `1px solid ${colors.blue}45`, borderRadius: 10, padding: '15px 16px', color: colors.muted, fontSize: 12}}>Ask the native Harness… <span style={{float: 'right', color: colors.blue}}>Send ↗</span></div></div>
    <div style={{borderLeft: `1px solid ${colors.line}`, padding: 22, background: 'rgba(17,26,43,.5)'}}><div style={{color: colors.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.12em'}}>Workbench status</div><div style={{marginTop: 19, border: `1px solid ${colors.green}44`, borderRadius: 12, padding: 15}}><div style={{color: colors.muted, fontSize: 11}}>Native Harness</div><div style={{display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 17, color: '#baf4d8'}}><Dot/>Connected</div></div><div style={{marginTop: 12, border: `1px solid ${colors.line}`, borderRadius: 12, padding: 15}}><div style={{color: colors.muted, fontSize: 11}}>Local-first cache</div><div style={{marginTop: 9, fontSize: 27, color: colors.blue, fontFamily: 'monospace'}}>18 <span style={{fontFamily: 'inherit', fontSize: 12, color: colors.muted}}>projections warm</span></div><div style={{height: 5, marginTop: 12, borderRadius: 10, background: '#243047'}}><div style={{height: '100%', width: '74%', borderRadius: 10, background: `linear-gradient(90deg, ${colors.blue}, ${colors.violet})`}} /></div></div><div style={{marginTop: 12, color: stage === 2 ? '#baf4d8' : colors.muted, fontSize: 11}}>↗ {stages[stage]}</div></div>
  </div>;
};

const LocalFirstScene: React.FC = () => {
  const frame = useCurrentFrame();
  const stage = frame < 55 ? 0 : frame < 120 ? 1 : 2;
  return <AbsoluteFill style={{...base, padding: '92px 120px'}}>
    <BackgroundGlow accent="#145e61" />
    <Fade><SectionLabel>02 · local-first interaction</SectionLabel></Fade>
    <Fade delay={10}><h2 style={{margin: '20px 0 0', fontSize: 60, letterSpacing: '-.045em'}}>Fast on screen. Honest about state.</h2></Fade>
    <Fade delay={20}><p style={{margin: '16px 0 35px', color: colors.muted, fontSize: 24}}>A local projection paints first, then reconciles with the native event stream.</p></Fade>
    <Fade delay={28}><MiniShell stage={stage}/></Fade>
    <Fade delay={54}><div style={{display: 'flex', gap: 12, marginTop: 24}}>{['local', 'accepted', 'confirmed'].map((label, index) => <div key={label} style={{flex: 1, borderTop: `2px solid ${index <= stage ? colors.green : colors.line}`, paddingTop: 10, color: index <= stage ? '#baf4d8' : colors.muted, fontSize: 14}}><b>{String(index + 1).padStart(2, '0')}</b> {label}</div>)}</div></Fade>
  </AbsoluteFill>;
};

const PluginsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const lift = spring({frame, fps: VIDEO_FPS, config: {damping: 17, stiffness: 70}});
  const plugins = [{icon: '▤', title: 'Documents', text: 'Link source context quickly', color: colors.blue}, {icon: '◌', title: 'Quant Research', text: 'Synthetic paper-only cockpit', color: colors.amber}, {icon: '◉', title: 'Video Production', text: 'Remotion storyboards and renders', color: '#f8a8cf'}];
  return <AbsoluteFill style={{...base, padding: '105px 120px'}}>
    <BackgroundGlow accent="#5d3568" />
    <Fade><SectionLabel>03 · custom workbench</SectionLabel></Fade>
    <Fade delay={10}><h2 style={{margin: '20px 0 0', fontSize: 60, letterSpacing: '-.045em'}}>Your context, without a second chat database.</h2></Fade>
    <Fade delay={22}><p style={{maxWidth: 980, margin: '16px 0 54px', color: colors.muted, fontSize: 24}}>Plugins sit around the native session and stay scoped to the project data they own.</p></Fade>
    <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 35, transform: `translateY(${(1 - lift) * 30}px)`}}>
      <div style={{width: 455, height: 350, border: `1px solid ${colors.blue}55`, borderRadius: 22, background: colors.panelSoft, padding: 32}}><div style={{color: colors.muted, fontSize: 13, letterSpacing: '.12em', textTransform: 'uppercase'}}>native conversation</div><div style={{marginTop: 25, fontSize: 31, fontWeight: 700}}>One execution owner</div><div style={{marginTop: 26, display: 'grid', gap: 14}}>{['thread history', 'turn queue', 'writer lock'].map((item) => <div key={item} style={{display: 'flex', alignItems: 'center', gap: 10, color: '#c6d2e5', fontSize: 17}}><span style={{color: colors.blue}}>✓</span>{item}</div>)}</div></div>
      <div style={{width: 80, height: 2, background: `linear-gradient(90deg, ${colors.blue}, ${colors.violet})`, boxShadow: `0 0 18px ${colors.blue}`}} />
      <div style={{display: 'grid', gap: 13, width: 610}}>{plugins.map((plugin, index) => <div key={plugin.title} style={{display: 'flex', alignItems: 'center', gap: 16, border: `1px solid ${plugin.color}44`, borderRadius: 17, background: colors.panelSoft, padding: '18px 21px', opacity: interpolate(frame, [20 + index * 8, 40 + index * 8], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}}><div style={{display: 'grid', width: 42, height: 42, placeItems: 'center', borderRadius: 12, background: `${plugin.color}18`, color: plugin.color, fontSize: 20}}>{plugin.icon}</div><div><div style={{fontSize: 20, fontWeight: 700}}>{plugin.title}</div><div style={{marginTop: 3, color: colors.muted, fontSize: 14}}>{plugin.text}</div></div><span style={{marginLeft: 'auto', color: colors.green}}>↗</span></div>)}</div>
    </div>
    <div style={{position: 'absolute', bottom: 78, color: colors.muted, fontSize: 21, opacity: interpolate(frame, [64, 82], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}}>The workbench is a lens over project facts — not a competing owner.</div>
  </AbsoluteFill>;
};

const CloseScene: React.FC = ({}) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 40], [.94, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return <AbsoluteFill style={{...base, justifyContent: 'center', alignItems: 'center', textAlign: 'center'}}>
    <BackgroundGlow accent="#334d86" />
    <div style={{transform: `scale(${scale})`}}><Fade><Mark size={90}/></Fade><Fade delay={12}><h2 style={{margin: '30px 0 0', fontSize: 84, letterSpacing: '-.06em'}}>whytan / Better Codex</h2></Fade><Fade delay={25}><p style={{margin: '21px auto 0', maxWidth: 900, color: colors.muted, fontSize: 27, lineHeight: 1.5}}>A native Harness underneath.<br/>A workbench shaped around your work.</p></Fade><Fade delay={43}><div style={{display: 'inline-flex', alignItems: 'center', gap: 12, marginTop: 42, border: `1px solid ${colors.blue}55`, borderRadius: 999, padding: '12px 22px', color: colors.blue, fontSize: 19}}>github.com/TonyandWei/better-codex <span>↗</span></div></Fade></div>
  </AbsoluteFill>;
};

export const BetterCodexVideo: React.FC<Props> = () => <AbsoluteFill style={base}>
  <Sequence from={0} durationInFrames={180}><TitleScene story={{title: 'whytan / Better Codex', subtitle: 'Connect documents quickly. Keep the native Harness. Build quant and video views around your work.', scenes: []}} /></Sequence>
  <Sequence from={180} durationInFrames={200}><ArchitectureScene /></Sequence>
  <Sequence from={380} durationInFrames={220}><LocalFirstScene /></Sequence>
  <Sequence from={600} durationInFrames={210}><PluginsScene /></Sequence>
  <Sequence from={810} durationInFrames={150}><CloseScene /></Sequence>
</AbsoluteFill>;
