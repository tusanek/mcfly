import React from 'react';
import { AbsoluteFill, Sequence, interpolate, interpolateColors, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Audio } from '@remotion/media';
import { VOICE_DELAY, sceneFrames } from './timing.js';


const C = { bg: '#0b101b', panel: '#172033', line: '#26324a', text: '#eef2f8', dim: '#93a1b8', accent: '#ffb648' };
const FONT = '-apple-system, "SF Pro Display", "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif';
const GLASS = 'rgba(255,255,255,0.045)';
const EDGE = 'rgba(255,255,255,0.09)';

/** Цвет сцены: необязательное поле "accent" в раскадровке — имя из набора или свой цвет (#rrggbb). */
const PALETTE = { amber: '#ffb648', teal: '#4fd6c4', violet: '#a990ff', blue: '#6cb6ff', coral: '#ff8f6b', green: '#7fe0a0' };
const accentOf = (scene) => PALETTE[scene.accent] || (/^#[0-9a-f]{6}$/i.test(scene.accent || '') ? scene.accent : C.accent);

const SOFT = { damping: 200 };
const POP = { damping: 13, stiffness: 140, mass: 0.8 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };

/** Значки сцен (поле "icon"): простые контурные рисунки, без внешних файлов. */
const ICONS = {
  mic: ['M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v4', 'M8 23h8'],
  moon: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'],
  sun: ['M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10z', 'M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42'],
  bell: ['M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9', 'M13.73 21a2 2 0 0 1-3.46 0'],
  repeat: ['M17 1l4 4-4 4', 'M3 11V9a4 4 0 0 1 4-4h14', 'M7 23l-4-4 4-4', 'M21 13v2a4 4 0 0 1-4 4H3'],
  calendar: ['M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M16 2v4M8 2v4M3 10h18'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M9 12l2 2 4-4'],
  edit: ['M12 20h9', 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z'],
  undo: ['M1 4v6h6', 'M3.51 15a9 9 0 1 0 2.13-9.36L1 10'],
  flag: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22v-7'],
  spark: ['M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z'],
  pulse: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  arrow: ['M5 12h14', 'M12 5l7 7-7 7'],
  check: ['M20 6L9 17l-5-5'],
  chat: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
};
const KIND_ICON = { chat: 'chat', number: 'pulse', compare: 'repeat', steps: 'check', text: 'spark' };
const Icon = ({ name, size, color, width = 2 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
    {(ICONS[name] || ICONS.spark).map((d, i) => <path key={i} d={d} />)}
  </svg>
);

/** Размер строк по объёму текста: короткая сцена — крупно, длинный пересказ — мельче, чтобы влез в экран. */
const lineSize = (lines) => {
  const chars = lines.reduce((n, l) => n + l.length, 0) + lines.length * 24;
  return chars < 120 ? 64 : chars < 240 ? 56 : chars < 380 ? 50 : 44;
};

/** Шаг появления строк: растягиваем на время речи, чтобы сцена жила, пока говорит диктор. */
const pace = (scene, fps, n, share, lo, hi) => clamp(((scene.voice || scene.duration || 3) * fps * share) / Math.max(1, n), lo, hi);

/** Шапка сцены: значок в плашке и счётчик. */
const Head = ({ scene, index, count, A, frame, fps }) => {
  const t = spring({ frame, fps, config: POP });
  const o = spring({ frame, fps, config: SOFT });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 24, opacity: o }}>
      <div style={{ width: 92, height: 92, borderRadius: 28, background: `${A}22`, border: `2px solid ${A}55`, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${0.6 + 0.4 * t}) rotate(${(1 - t) * -18}deg)` }}>
        <Icon name={scene.icon || KIND_ICON[scene.kind]} size={50} color={A} />
      </div>
      <div style={{ color: C.dim, fontSize: 38, fontWeight: 600, letterSpacing: 2 }}>
        <span style={{ color: A }}>{String(index + 1).padStart(2, '0')}</span> / {String(count).padStart(2, '0')}
      </div>
    </div>
  );
};

/** Заголовок: слова выезжают по одному. */
const Words = ({ text, frame, fps, start = 0, step = 3, style }) => (
  <div style={style}>
    {text.split(' ').map((w, i) => {
      const t = spring({ frame: frame - start - i * step, fps, config: SOFT });
      return <span key={i} style={{ display: 'inline-block', marginRight: '0.26em', opacity: t, transform: `translateY(${(1 - t) * 0.45}em)` }}>{w}</span>;
    })}
  </div>
);

/** Демонстрация: экран чата — сообщение бота печатается построчно, кнопки выскакивают под ним. */
const Chat = ({ scene, project, A, frame, fps }) => {
  const { chat } = scene;
  const t = spring({ frame: frame - 8, fps, config: SOFT });
  const size = chat.text.length < 90 ? 52 : chat.text.length < 160 ? 46 : chat.text.length < 320 ? 41 : 37;
  const rows = chat.text.split('\n');
  const step = pace(scene, fps, rows.length, 0.4, 3, 12);
  const isItem = (l) => /^\s*(\d+[.)]|[•\-–—])\s/.test(l || '');
  const lastAt = 18 + rows.length * step;
  return (
    <div style={{ background: 'rgba(6,10,18,0.72)', border: `2px solid ${EDGE}`, borderRadius: 48, padding: '30px 32px 40px', opacity: t, transform: `translateY(${(1 - t) * 60}px) scale(${0.96 + 0.04 * t})`, boxShadow: `0 40px 120px ${A}1f` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, paddingBottom: 26, marginBottom: 30, borderBottom: `2px solid ${EDGE}` }}>
        <div style={{ width: 68, height: 68, borderRadius: 34, background: `linear-gradient(135deg, ${A}, ${A}88)`, color: C.bg, fontSize: 36, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{String(project || '•').slice(0, 1).toUpperCase()}</div>
        <div style={{ color: C.text, fontSize: 36, fontWeight: 700 }}>{project}</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {[0, 1, 2].map((i) => <div key={i} style={{ width: 10, height: 10, borderRadius: 5, background: C.dim, opacity: 0.5 }} />)}
        </div>
      </div>
      {chat.text ? (
        <div style={{ background: C.panel, border: `2px solid ${EDGE}`, color: C.text, fontSize: size, lineHeight: 1.34, padding: '30px 34px', borderRadius: '34px 34px 34px 10px', maxWidth: '96%', display: 'inline-block', boxSizing: 'border-box' }}>
          {rows.map((row, i) => {
            const r = spring({ frame: frame - 18 - i * step, fps, config: SOFT });
            const title = i === 0 && rows.length > 3 && row.length < 40;
            const label = !title && row.trim() && !isItem(row) && isItem(rows[i + 1]);
            return (
              <div key={i} style={{ minHeight: row.trim() ? undefined : size * 0.5, whiteSpace: 'pre-wrap', opacity: r, transform: `translateX(${(1 - r) * -16}px)`, fontWeight: title ? 800 : label ? 700 : 400, color: label ? A : C.text, fontSize: label ? size * 0.86 : size, letterSpacing: label ? 1 : 0 }}>{row}</div>
            );
          })}
        </div>
      ) : null}
      {chat.buttons.map((row, r) => {
        const b = spring({ frame: frame - lastAt - 4 - r * 6, fps, config: POP });
        return (
          <div key={r} style={{ display: 'flex', gap: 14, marginTop: 16, opacity: clamp(b, 0, 1), transform: `scale(${0.9 + 0.1 * b})`, transformOrigin: 'left top' }}>
            {row.map((label, i) => (
              <div key={i} style={{ flex: 1, textAlign: 'center', background: `${A}26`, border: `2px solid ${A}66`, color: C.text, fontSize: 38, fontWeight: 600, padding: '22px 10px', borderRadius: 22, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                {label}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
};

/** Полоса «сделано из всего»: при малом числе — делениями, которые зажигаются по одному. */
const Bar = ({ bar, A, frame, fps, start = 8, margin = '0 0 52px' }) => {
  const total = Number(bar.total); const done = Number(bar.done);
  if (!(done > 0)) return null; // «0 из N» — пустые полоски похожи на незагруженную картинку; число есть в строках
  if (Number.isInteger(total) && total <= 16) {
    return (
      <div style={{ display: 'flex', gap: 10, margin }}>
        {Array.from({ length: total }, (_, i) => {
          const s = spring({ frame: frame - start - i * 3, fps, config: POP });
          const on = i < done;
          return <div key={i} style={{ flex: 1, height: 40, borderRadius: 12, background: on ? A : GLASS, border: on ? 'none' : `2px solid ${EDGE}`, boxSizing: 'border-box', opacity: clamp(s, 0, 1), transform: `scaleY(${0.4 + 0.6 * s})`, boxShadow: on ? `0 0 24px ${A}66` : 'none' }} />;
        })}
      </div>
    );
  }
  const t = spring({ frame: frame - start, fps, config: SOFT, durationInFrames: 40 });
  const share = clamp(done / total, 0, 1);
  return (
    <div style={{ height: 40, borderRadius: 20, background: C.line, margin, overflow: 'hidden' }}>
      <div style={{ width: `${share * t * 100}%`, height: '100%', borderRadius: 20, background: A }} />
    </div>
  );
};

/** Появление сцены: up (снизу), left (сбоку), scale (из глубины), fade (проявление). */
const enterStyle = (enter, t) => {
  if (enter === 'left') return { opacity: t, transform: `translateX(${(1 - t) * -90}px)` };
  if (enter === 'scale') return { opacity: t, transform: `scale(${0.82 + 0.18 * t})` };
  if (enter === 'fade') return { opacity: t };
  return { opacity: t, transform: `translateY(${(1 - t) * 40}px)` };
};

/** Расходящиеся кольца за крупной фразой. */
const Rings = ({ A, frame, x = '50%', y = '50%' }) => [0, 1, 2].map((i) => {
  const p = ((frame + i * 40) % 120) / 120;
  return <div key={i} style={{ position: 'absolute', left: x, top: y, width: 300 + p * 1300, height: 300 + p * 1300, marginLeft: -(150 + p * 650), marginTop: -(150 + p * 650), borderRadius: '50%', border: `3px solid ${A}`, opacity: (1 - p) * 0.22 }} />;
});

/** Зацепка и финал: одна крупная фраза, слова выезжают по одному; строки — плашками. */
const Big = ({ scene, A, frame, fps, finale }) => {
  const t = spring({ frame: frame - 2, fps, config: SOFT });
  const longest = Math.max(...scene.title.split(' ').map((w) => w.length));
  // длинное слово не должно вылезать за край: ширина поля 912, знак жирного шрифта — около 0.62 кегля
  const size = Math.min(scene.title.length > 60 ? 84 : scene.title.length > 32 ? 104 : 136, Math.floor(912 / (longest * 0.62)));
  const words = scene.title.split(' ').length;
  const after = 10 + words * 5;
  return (
    <>
      <Rings A={A} frame={frame} x={finale ? '50%' : '18%'} y={finale ? '46%' : '36%'} />
      <div style={{ width: 160, height: 12, borderRadius: 6, background: A, marginBottom: 56, transform: `scaleX(${t})`, transformOrigin: 'left', boxShadow: `0 0 30px ${A}88` }} />
      <Words text={scene.title} frame={frame} fps={fps} start={4} step={5} style={{ fontSize: size, fontWeight: 800, lineHeight: 1.04, letterSpacing: -2, color: finale ? A : C.text, textShadow: finale ? `0 0 70px ${A}66` : 'none', transform: `scale(${1 + frame * 0.00025})`, transformOrigin: 'left center' }} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 22, marginTop: 64 }}>
        {scene.lines.map((line, i) => {
          const l = spring({ frame: frame - after - i * 9, fps, config: POP });
          return (
            <div key={i} style={{ background: i === 0 ? `${A}24` : GLASS, border: `2px solid ${i === 0 ? `${A}77` : EDGE}`, color: i === 0 ? C.text : C.dim, fontSize: 54, fontWeight: i === 0 ? 700 : 500, lineHeight: 1.2, padding: '22px 36px', borderRadius: 30, opacity: clamp(l, 0, 1), transform: `translateY(${(1 - l) * 30}px)` }}>{line}</div>
          );
        })}
      </div>
      {scene.bar && scene.bar.total > 0 ? <Bar bar={scene.bar} A={A} frame={frame} fps={fps} start={after + scene.lines.length * 9 + 4} margin="54px 0 0" /> : null}
    </>
  );
};

/** Крупная цифра: число набегает от нуля, под ним подпись и огоньки — по одному на единицу. */
const BigNumber = ({ number, A, frame, fps }) => {
  const N = Number(number.value);
  const t = spring({ frame: frame - 6, fps, config: SOFT, durationInFrames: 44 });
  const value = Math.round(N * t);
  const pulse = spring({ frame: frame - 44, fps, config: { damping: 9, stiffness: 160 } });
  const dots = Number.isInteger(N) && N > 1 && N <= 60;
  return (
    <div style={{ marginBottom: 30 }}>
      <div style={{ fontSize: 340, fontWeight: 800, lineHeight: 1, letterSpacing: -10, display: 'inline-block', backgroundImage: `linear-gradient(180deg, #ffffff 5%, ${A} 72%)`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', filter: `drop-shadow(0 0 50px ${A}55)`, transform: `scale(${0.96 + 0.04 * pulse})`, transformOrigin: 'left bottom', paddingRight: 20 }}>{value}{number.unit || ''}</div>
      <div style={{ color: C.text, fontSize: 62, fontWeight: 600, lineHeight: 1.2, marginTop: 16, opacity: t }}>{number.label}</div>
      {dots ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 50 }}>
          {Array.from({ length: N }, (_, i) => {
            const on = i < value;
            return <div key={i} style={{ width: 36, height: 36, borderRadius: 12, background: on ? A : GLASS, border: on ? 'none' : `2px solid ${EDGE}`, boxSizing: 'border-box', boxShadow: on ? `0 0 18px ${A}77` : 'none', transform: `scale(${on ? 1 : 0.8})` }} />;
          })}
        </div>
      ) : null}
    </div>
  );
};

/** Было — стало: первая плашка гаснет и отступает, когда приходит вторая — подсвеченная. */
const Compare = ({ scene, A, frame, fps }) => {
  const { compare } = scene;
  const at = Math.round(clamp((scene.voice || 4) * fps * 0.38, 30, 70));
  const a = spring({ frame: frame - 8, fps, config: SOFT });
  const b = spring({ frame: frame - at, fps, config: POP });
  const bo = clamp(b, 0, 1);
  const box = { borderRadius: 36, padding: '38px 44px', fontSize: 54, lineHeight: 1.28 };
  const tag = { fontSize: 34, fontWeight: 800, letterSpacing: 4, marginBottom: 16 };
  return (
    <>
      <div style={{ ...box, background: GLASS, color: '#c3ccdc', border: `2px solid ${EDGE}`, opacity: a * (1 - 0.12 * bo), transform: `translateY(${(1 - a) * 30}px) scale(${1 - 0.04 * bo})`, transformOrigin: 'center bottom' }}>
        <div style={{ ...tag, color: C.dim }}>БЫЛО</div>
        <span style={{ backgroundImage: `linear-gradient(${C.dim}, ${C.dim})`, backgroundRepeat: 'no-repeat', backgroundPosition: '0 58%', backgroundSize: `${bo * 100}% 3px` }}>{compare.before}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', margin: '18px 0', opacity: bo, transform: `rotate(90deg) scale(${0.5 + 0.5 * b})` }}>
        <Icon name="arrow" size={76} color={A} width={2.6} />
      </div>
      <div style={{ ...box, background: `${A}1c`, color: C.text, fontWeight: 600, border: `3px solid ${A}`, boxShadow: `0 0 80px ${A}33`, opacity: bo, transform: `translateY(${(1 - b) * 50}px) scale(${0.94 + 0.06 * b})` }}>
        <div style={{ ...tag, color: A }}>СТАЛО</div>{compare.after}
      </div>
    </>
  );
};

/** Шаги или перечень: номера на общей нити, появляются по одному. */
const Steps = ({ scene, A, frame, fps }) => {
  const { lines } = scene;
  const step = pace(scene, fps, lines.length, 0.5, 10, 30);
  const grow = interpolate(frame, [10, 10 + step * lines.length], [0, 1], CLAMP);
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ position: 'absolute', left: 40, top: 42, bottom: 80, width: 4, borderRadius: 2, background: `linear-gradient(${A}, ${A}22)`, transform: `scaleY(${grow})`, transformOrigin: 'top' }} />
      {lines.map((line, i) => {
        const t = spring({ frame: frame - 8 - i * step, fps, config: POP });
        const o = clamp(t, 0, 1);
        return (
          <div key={i} style={{ display: 'flex', gap: 30, alignItems: 'flex-start', marginBottom: 34, position: 'relative' }}>
            <div style={{ flex: '0 0 84px', height: 84, borderRadius: 42, background: A, color: C.bg, fontSize: 44, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: o, transform: `scale(${0.4 + 0.6 * t})`, boxShadow: `0 0 0 10px ${C.bg}, 0 0 40px ${A}66` }}>{i + 1}</div>
            <div style={{ color: C.text, fontSize: lines.length > 4 ? 46 : 52, lineHeight: 1.26, paddingTop: 10, opacity: o, transform: `translateX(${(1 - o) * 40}px)` }}>{line}</div>
          </div>
        );
      })}
    </div>
  );
};

/** Строки текста: плашки с меткой; style: "checks" — галочки, "bubbles" — реплики владельца справа. */
const Lines = ({ scene, A, frame, fps }) => {
  const { lines } = scene;
  const size = lineSize(lines);
  const step = pace(scene, fps, lines.length, 0.5, 8, 32);
  return lines.map((line, i) => {
    const t = spring({ frame: frame - 12 - i * step, fps, config: POP });
    const o = clamp(t, 0, 1);
    if (scene.style === 'bubbles') {
      const said = /^«/.test(line);
      return said ? (
        <div key={i} style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 26, opacity: o, transform: `translateX(${(1 - t) * 80}px) scale(${0.9 + 0.1 * t})`, transformOrigin: 'right bottom' }}>
          <div style={{ background: A, color: C.bg, fontSize: 62, fontWeight: 700, lineHeight: 1.2, padding: '28px 40px', borderRadius: '38px 38px 10px 38px', boxShadow: `0 20px 60px ${A}44` }}>{line.replace(/^«|»$/g, '')}</div>
        </div>
      ) : (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 20, color: C.dim, fontSize: 48, marginTop: 30, opacity: o }}>
          <Icon name="mic" size={50} color={A} />{line}
        </div>
      );
    }
    return (
      <div key={i} style={{ display: 'flex', gap: 26, alignItems: 'flex-start', background: GLASS, border: `2px solid ${EDGE}`, borderRadius: 30, padding: '28px 32px', marginBottom: 22, opacity: o, transform: `translateY(${(1 - t) * 34}px)` }}>
        {scene.style === 'checks' ? (
          <div style={{ flex: '0 0 56px', height: 56, borderRadius: 28, background: `${A}26`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: (size * 1.28 - 56) / 2, transform: `scale(${t})` }}>
            <Icon name="check" size={34} color={A} width={3} />
          </div>
        ) : (
          <div style={{ flex: '0 0 10px', alignSelf: 'stretch', borderRadius: 5, background: A, transform: `scaleY(${o})`, transformOrigin: 'top' }} />
        )}
        <div style={{ color: C.text, fontSize: size, lineHeight: 1.28 }}>{line}</div>
      </div>
    );
  });
};

const Scene = ({ scene, index, count, project }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const frames = sceneFrames(scene, fps);
  const A = accentOf(scene);
  const head = spring({ frame: frame - 3, fps, config: SOFT });
  const out = interpolate(frame, [frames - 9, frames], [1, 0], CLAMP);
  const shell = { padding: '250px 84px 270px', justifyContent: 'center', opacity: out, transform: `translateY(${(1 - out) * -36}px) scale(${1 + (1 - out) * 0.03})` };
  const audio = scene.voice === false ? null : (
    <Sequence from={VOICE_DELAY} layout="none">
      <Audio src={staticFile(`voice/${scene.key}.wav`)} />
    </Sequence>
  );
  if (scene.kind === 'hook' || scene.kind === 'finale') {
    return (
      <AbsoluteFill style={shell}>
        {audio}
        <Big scene={scene} A={A} frame={frame} fps={fps} finale={scene.kind === 'finale'} />
      </AbsoluteFill>
    );
  }
  const special = scene.kind === 'number' && scene.number ? <BigNumber number={scene.number} A={A} frame={frame} fps={fps} />
    : scene.kind === 'compare' && scene.compare ? <Compare scene={scene} A={A} frame={frame} fps={fps} />
      : scene.kind === 'steps' ? <Steps scene={scene} A={A} frame={frame} fps={fps} /> : null;
  const isChat = scene.kind === 'chat' && scene.chat;
  const titleSize = scene.title.length > 44 ? 60 : scene.title.length > 22 ? 76 : 94;
  return (
    <AbsoluteFill style={shell}>
      {audio}
      <Head scene={scene} index={index} count={count} A={A} frame={frame} fps={fps} />
      <div style={{ color: C.text, fontSize: titleSize, fontWeight: 800, lineHeight: 1.08, letterSpacing: -1, marginTop: 30, ...enterStyle(scene.enter, head) }}>{scene.title}</div>
      <div style={{ width: 120, height: 8, borderRadius: 4, background: A, margin: '36px 0 46px', transform: `scaleX(${head})`, transformOrigin: 'left', boxShadow: `0 0 24px ${A}88` }} />
      {special}
      {isChat ? (
        <>
          <Chat scene={scene} project={project} A={A} frame={frame} fps={fps} />
          {scene.lines[0] ? (() => {
            const c = spring({ frame: frame - 34, fps, config: POP });
            return <div style={{ alignSelf: 'flex-start', marginTop: 34, background: `${A}1f`, border: `2px solid ${A}55`, color: C.text, fontSize: 40, fontWeight: 600, lineHeight: 1.25, padding: '18px 30px', borderRadius: 26, opacity: clamp(c, 0, 1), transform: `translateY(${(1 - c) * 24}px)` }}>{scene.lines[0]}</div>;
          })() : null}
        </>
      ) : null}
      {!special && !isChat && scene.bar && scene.bar.total > 0 ? <Bar bar={scene.bar} A={A} frame={frame} fps={fps} /> : null}
      {!special && !isChat ? <Lines scene={scene} A={A} frame={frame} fps={fps} /> : null}
      {special && scene.kind !== 'steps' ? scene.lines.map((line, i) => {
        const t = spring({ frame: frame - 30 - i * 8, fps, config: SOFT });
        return <div key={i} style={{ color: C.dim, fontSize: 48, lineHeight: 1.3, marginTop: 30, opacity: t }}>{line}</div>;
      }) : null}
    </AbsoluteFill>
  );
};

/** Фон: тёмная глубина, два медленно плывущих пятна в цвет сцены и мелкая сетка точек. */
const Backdrop = ({ color, frame }) => {
  const a = frame / 30;
  const blob = (x, y, r, o) => ({ position: 'absolute', left: x - r, top: y - r, width: r * 2, height: r * 2, borderRadius: '50%', background: `radial-gradient(circle, ${color} 0%, transparent 68%)`, opacity: o });
  return (
    <AbsoluteFill style={{ background: `linear-gradient(170deg, #121a2b 0%, ${C.bg} 55%, #070a12 100%)`, overflow: 'hidden' }}>
      <div style={blob(180 + Math.sin(a * 0.5) * 140, 260 + Math.cos(a * 0.4) * 120, 760, 0.2)} />
      <div style={blob(900 + Math.cos(a * 0.35) * 160, 1560 + Math.sin(a * 0.45) * 140, 680, 0.13)} />
      <AbsoluteFill style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.07) 2px, transparent 2.5px)', backgroundSize: '54px 54px', backgroundPosition: `0 ${-(frame * 0.4) % 54}px`, maskImage: 'linear-gradient(180deg, transparent 0%, #000 30%, #000 70%, transparent 100%)', WebkitMaskImage: 'linear-gradient(180deg, transparent 0%, #000 30%, #000 70%, transparent 100%)' }} />
    </AbsoluteFill>
  );
};

export const Weekly = ({ project, date, kind, scenes }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const spans = [];
  let from = 0;
  for (const scene of scenes) { const n = sceneFrames(scene, fps); spans.push({ from, n }); from += n; }
  let cur = spans.findIndex((s) => frame < s.from + s.n);
  if (cur < 0) cur = scenes.length - 1;
  const local = frame - spans[cur].from;
  const A = accentOf(scenes[cur]);
  const color = cur > 0 ? interpolateColors(local, [0, 16], [accentOf(scenes[cur - 1]), A]) : A;
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: FONT }}>
      <Backdrop color={color} frame={frame} />
      <div style={{ position: 'absolute', top: 110, left: 84, right: 84, display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: C.dim, fontSize: 38, fontWeight: 500 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <span style={{ width: 16, height: 16, borderRadius: 8, background: color, boxShadow: `0 0 18px ${color}` }} />
          {kind} · {project}
        </span>
        <span>{date}</span>
      </div>
      {scenes.map((scene, i) => (
        <Sequence key={scene.key} from={spans[i].from} durationInFrames={spans[i].n}>
          <Scene scene={scene} index={i} count={scenes.length} project={project} />
        </Sequence>
      ))}
      <div style={{ position: 'absolute', left: 84, right: 84, bottom: 124, height: 10, display: 'flex', gap: 8 }}>
        {spans.map((s, i) => {
          const fill = clamp((frame - s.from) / Math.max(1, s.n - 1), 0, 1);
          return (
            <div key={i} style={{ flexGrow: s.n, flexBasis: 0, height: '100%', borderRadius: 5, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
              <div style={{ width: `${fill * 100}%`, height: '100%', borderRadius: 5, background: i === cur ? color : 'rgba(255,255,255,0.55)' }} />
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
