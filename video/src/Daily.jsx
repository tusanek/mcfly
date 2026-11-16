import React from 'react';
import { AbsoluteFill, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Audio } from '@remotion/media';
import { VOICE_DELAY, sceneFrames } from './timing.js';


const C = { bg: '#090d18', bg2: '#131c31', panel: '#172033', line: '#2a3652', text: '#f2f5fa', dim: '#9aa8c0', accent: '#ffb648' };
const FONT = '-apple-system, "SF Pro Display", "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif';

/** Цвета сцен: у каждой сцены свой акцент (поле accent в раскадровке или по виду сцены). */
const ACCENTS = {
  amber: ['#ffb648', '#ff8a3d'],
  mint: ['#5fe3b3', '#2bb7c9'],
  sky: ['#74bcff', '#6f8bff'],
  coral: ['#ff8f78', '#ff5f8a'],
  violet: ['#b9a0ff', '#7f8cff'],
};
const BY_KIND = { hook: 'amber', compare: 'mint', chat: 'sky', text: 'amber', steps: 'violet', number: 'mint', finale: 'amber' };
const accentOf = (scene) => ACCENTS[scene.accent] || (/^#[0-9a-f]{6}$/i.test(scene.accent || '') ? [scene.accent, scene.accent] : null) || ACCENTS[BY_KIND[scene.kind]] || ACCENTS.amber;

const SOFT = { damping: 200 };
const POP = { damping: 14, stiffness: 140, mass: 0.8 };
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };

/** Размер строк по объёму текста: короткая сцена — крупно, длинный пересказ — мельче, чтобы влез в экран. */
const lineSize = (lines) => {
  const chars = lines.reduce((n, l) => n + l.length, 0) + lines.length * 24;
  return chars < 120 ? 70 : chars < 240 ? 60 : chars < 380 ? 52 : 45;
};

/** Слова в «ёлочках» подсвечиваются цветом сцены — это то, что говорит человек или бот. */
const Rich = ({ text, color }) => String(text).split(/(«[^»]*»)/).map((part, i) => (
  part.startsWith('«') ? <span key={i} style={{ color, fontWeight: 700 }}>{part}</span> : <React.Fragment key={i}>{part}</React.Fragment>
));

/** Ярлык над заголовком: точка и короткое слово. */
const Tag = ({ tag, color, t }) => (
  <div style={{ display: 'inline-flex', alignSelf: 'flex-start', alignItems: 'center', gap: 16, padding: '12px 26px 12px 20px', borderRadius: 40, background: `${color}1f`, border: `2px solid ${color}55`, color, fontSize: 34, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase', marginBottom: 30, opacity: t, transform: `translateX(${(1 - t) * -30}px)` }}>
    <span style={{ width: 16, height: 16, borderRadius: 8, background: color, boxShadow: `0 0 18px ${color}` }} />
    {tag}
  </div>
);

/** Демонстрация: экран чата — шапка, «печатает…», сообщение бота и кнопки под ним. */
const Chat = ({ chat, project, frame, fps, ac }) => {
  const t = spring({ frame: frame - 6, fps, config: SOFT });
  const typing = interpolate(frame, [10, 14, 26, 30], [0, 1, 1, 0], clamp);
  const m = spring({ frame: frame - 28, fps, config: POP });
  const size = chat.text.length < 80 ? 54 : chat.text.length < 160 ? 46 : chat.text.length < 320 ? 40 : 35;
  let n = 0;
  return (
    <div style={{ background: 'rgba(8,12,22,0.78)', border: `2px solid ${C.line}`, borderRadius: 52, padding: '0 0 40px', overflow: 'hidden', boxShadow: `0 40px 120px rgba(0,0,0,0.45), 0 0 90px ${ac[0]}22`, opacity: t, transform: `translateY(${(1 - t) * 60}px) scale(${0.96 + 0.04 * t})` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '30px 36px', borderBottom: `2px solid ${C.line}`, background: 'rgba(255,255,255,0.03)' }}>
        <div style={{ width: 76, height: 76, borderRadius: 38, background: `linear-gradient(135deg, ${ac[0]}, ${ac[1]})`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <span style={{ width: 13, height: 13, borderRadius: 7, background: C.bg }} />
          <span style={{ width: 13, height: 13, borderRadius: 7, background: C.bg }} />
        </div>
        <div>
          <div style={{ color: C.text, fontSize: 38, fontWeight: 700 }}>{project}</div>
          <div style={{ color: C.dim, fontSize: 28, marginTop: 6 }}>бот</div>
        </div>
      </div>
      <div style={{ padding: '40px 36px 0', position: 'relative' }}>
        <div style={{ position: 'absolute', left: 36, top: 40, display: 'flex', gap: 12, padding: '28px 32px', borderRadius: '30px 30px 30px 10px', background: C.panel, opacity: typing }}>
          {[0, 1, 2].map((i) => (
            <span key={i} style={{ width: 18, height: 18, borderRadius: 9, background: C.dim, transform: `translateY(${Math.sin((frame - i * 4) / 2.6) * 6}px)` }} />
          ))}
        </div>
        {chat.text ? (
          <div style={{ display: 'inline-block', background: C.panel, color: C.text, fontSize: size, lineHeight: 1.34, padding: '30px 36px', borderRadius: '34px 34px 34px 10px', whiteSpace: 'pre-wrap', maxWidth: '96%', border: `2px solid ${ac[0]}44`, opacity: Math.min(1, m * 1.4), transform: `scale(${0.7 + 0.3 * m})`, transformOrigin: 'left bottom' }}>
            {chat.text}
          </div>
        ) : null}
        {chat.buttons.map((row, r) => (
          <div key={r} style={{ display: 'flex', gap: 14, marginTop: r ? 14 : 22 }}>
            {row.map((label, i) => {
              const b = spring({ frame: frame - 40 - (n++) * 4, fps, config: POP });
              return (
                <div key={i} style={{ flex: 1, textAlign: 'center', background: 'rgba(255,255,255,0.09)', border: '2px solid rgba(255,255,255,0.10)', color: C.text, fontSize: 38, fontWeight: 600, padding: '24px 10px', borderRadius: 22, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', opacity: Math.min(1, b * 1.5), transform: `scale(${0.8 + 0.2 * b})` }}>
                  {label}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

/** Полоса «сделано из всего»: заполняется на глазах — цели, успешные прогоны, занятый лимит. */
const Bar = ({ bar, frame, fps, ac }) => {
  const t = spring({ frame: frame - 8, fps, config: SOFT, durationInFrames: 40 });
  const share = Math.max(0, Math.min(1, bar.done / bar.total));
  return (
    <div style={{ height: 44, borderRadius: 22, background: C.line, marginBottom: 56, overflow: 'hidden' }}>
      <div style={{ width: `${share * t * 100}%`, height: '100%', borderRadius: 22, background: `linear-gradient(90deg, ${ac[1]}, ${ac[0]})` }} />
    </div>
  );
};

/** Появление: up (снизу), left (сбоку), scale (из глубины), fade (проявление). */
const enterStyle = (enter, t) => {
  if (enter === 'left') return { opacity: t, transform: `translateX(${(1 - t) * -90}px)` };
  if (enter === 'scale') return { opacity: t, transform: `scale(${0.82 + 0.18 * t})`, transformOrigin: 'left center' };
  if (enter === 'fade') return { opacity: t };
  return { opacity: t, transform: `translateY(${(1 - t) * 40}px)` };
};

/** Заголовок по словам: слова выезжают по очереди, отмеченные (поле mark) — цветом сцены. */
const Words = ({ text, mark, frame, fps, ac, delay = 2, step = 4, color = C.text, enter }) => {
  const marked = String(mark || '').toLowerCase().split(/\s+/).filter(Boolean);
  return text.split(/\s+/).map((word, i) => {
    const t = spring({ frame: frame - delay - i * step, fps, config: { damping: 18, stiffness: 120 } });
    const hit = marked.includes(word.toLowerCase().replace(/[.,!?:;]/g, ''));
    const move = enter === 'left' ? `translateX(${(1 - t) * -60}px)` : enter === 'scale' ? `scale(${0.6 + 0.4 * t})` : enter === 'fade' ? 'none' : `translateY(${(1 - t) * 70}px)`;
    return (
      <span key={i} style={{ display: 'inline-block', marginRight: '0.26em', opacity: Math.min(1, t * 1.3), transform: move, transformOrigin: 'left bottom', ...(hit ? { backgroundImage: `linear-gradient(100deg, ${ac[0]}, ${ac[1]})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' } : { color }) }}>
        {word}
      </span>
    );
  });
};

/** Галочка в кружке, рисуется штрихом. */
const Check = ({ t, color, size = 64 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" style={{ flex: `0 0 ${size}px` }}>
    <circle cx="32" cy="32" r="29" fill={`${color}22`} stroke={color} strokeWidth="3" opacity={t} />
    <path d="M19 33 L28 42 L46 23" fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="42" strokeDashoffset={42 * (1 - t)} />
  </svg>
);

/** Зацепка и финал: одна крупная фраза, слова по очереди; у финала строки — с галочками. */
const Big = ({ scene, frame, fps, finale, ac }) => {
  const t = spring({ frame: frame - 2, fps, config: SOFT });
  const size = scene.title.length > 60 ? 88 : scene.title.length > 32 ? 108 : scene.title.length > 18 ? 138 : 168;
  const words = scene.title.split(/\s+/).length;
  const after = 8 + words * 4;
  return (
    <>
      <div style={{ width: 180, height: 14, borderRadius: 7, background: `linear-gradient(90deg, ${ac[0]}, ${ac[1]})`, marginBottom: 60, transform: `scaleX(${t})`, transformOrigin: 'left', boxShadow: `0 0 40px ${ac[0]}88` }} />
      <div style={{ fontSize: size, fontWeight: 800, lineHeight: 1.04, letterSpacing: -3 }}>
        <Words text={scene.title} mark={finale ? scene.title : scene.mark} frame={frame} fps={fps} ac={ac} enter={scene.enter === 'fade' ? 'up' : scene.enter} />
      </div>
      {finale ? (
        <div style={{ marginTop: 76 }}>
          {scene.lines.map((line, i) => {
            const l = spring({ frame: frame - after - i * 10, fps, config: SOFT });
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 28, marginTop: i ? 30 : 0, opacity: l, transform: `translateX(${(1 - l) * -40}px)` }}>
                <Check t={spring({ frame: frame - after - 6 - i * 10, fps, config: SOFT })} color={ac[0]} size={76} />
                <div style={{ color: C.text, fontSize: 62, fontWeight: 600, lineHeight: 1.2 }}>{line}</div>
              </div>
            );
          })}
        </div>
      ) : scene.lines.length ? (() => {
        const l = spring({ frame: frame - after, fps, config: SOFT });
        return (
          <div style={{ display: 'inline-flex', alignSelf: 'flex-start', alignItems: 'center', gap: 22, marginTop: 72, padding: '20px 36px', borderRadius: 50, background: 'rgba(255,255,255,0.06)', border: `2px solid ${C.line}`, color: C.dim, fontSize: 46, fontWeight: 500, opacity: l, transform: `translateY(${(1 - l) * 30}px)` }}>
            {scene.lines.map((line, i) => (
              <React.Fragment key={i}>
                {i ? <span style={{ width: 12, height: 12, borderRadius: 6, background: ac[0] }} /> : null}
                <span style={{ color: i ? C.text : C.dim }}>{line}</span>
              </React.Fragment>
            ))}
          </div>
        );
      })() : null}
    </>
  );
};

/** Крупная цифра: число набегает от нуля, под ним загораются точки — по одной на единицу. */
const BigNumber = ({ number, frame, fps, ac }) => {
  const total = Number(number.value) || 0;
  const dots = Number.isInteger(total) && total > 1 && total <= 40;
  const span = Math.min(46, Math.max(18, total * 1.7));
  const p = interpolate(frame, [10, 10 + span], [0, total], clamp);
  const t = spring({ frame: frame - 6, fps, config: SOFT });
  const done = spring({ frame: frame - 12 - span, fps, config: POP });
  const cols = total <= 12 ? total : Math.ceil(total / Math.ceil(total / 10));
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 380, fontWeight: 800, lineHeight: 0.95, letterSpacing: -12, backgroundImage: `linear-gradient(120deg, ${ac[0]}, ${ac[1]})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', transform: `scale(${1 + 0.05 * Math.sin(Math.min(1, done) * Math.PI)})`, transformOrigin: 'left bottom', filter: `drop-shadow(0 0 60px ${ac[0]}44)` }}>
        {Math.round(p)}{number.unit || ''}
      </div>
      {dots ? (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 22, margin: '50px 0 46px', maxWidth: cols * 92 }}>
          {Array.from({ length: total }, (_, i) => {
            const d = spring({ frame: frame - 10 - (i / total) * span, fps, config: POP });
            const on = p > i + 0.5;
            return <div key={i} style={{ aspectRatio: '1', borderRadius: '50%', background: on ? `linear-gradient(135deg, ${ac[0]}, ${ac[1]})` : C.line, boxShadow: on ? `0 0 26px ${ac[0]}77` : 'none', transform: `scale(${on ? 0.6 + 0.4 * d : 0.6})` }} />;
          })}
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 26, marginTop: dots ? 0 : 30, opacity: t }}>
        <Check t={Math.min(1, Math.max(0, done))} color={ac[0]} size={80} />
        <div style={{ color: C.text, fontSize: 64, fontWeight: 600, lineHeight: 1.2 }}>{number.label}</div>
      </div>
    </div>
  );
};

/** Было — стало: два ответа-облачка; старый гаснет и зачёркивается, когда приходит новый. */
const Compare = ({ compare, frame, fps, ac }) => {
  const a = spring({ frame: frame - 8, fps, config: SOFT });
  const b = spring({ frame: frame - 44, fps, config: POP });
  const bb = Math.min(1, Math.max(0, b));
  const box = { padding: '38px 44px 44px', fontSize: 56, lineHeight: 1.26 };
  const tag = { fontSize: 34, fontWeight: 700, letterSpacing: 4, marginBottom: 18 };
  return (
    <>
      <div style={{ ...box, borderRadius: '40px 40px 40px 12px', marginRight: 60, background: 'rgba(23,32,51,0.8)', color: '#c6cfe0', border: `2px solid ${C.line}`, opacity: a * (1 - 0.1 * bb), transform: `translateY(${(1 - a) * 30}px) scale(${1 - 0.04 * bb})`, transformOrigin: 'left bottom' }}>
        <div style={{ ...tag, color: C.dim }}>БЫЛО</div>
        <span style={{ textDecoration: 'line-through', textDecorationThickness: 3, textDecorationColor: `rgba(255,143,120,${0.55 * bb})` }}>{compare.before}</span>
      </div>
      <div style={{ height: 70, display: 'flex', alignItems: 'center', paddingLeft: 60 }}>
        <div style={{ width: 6, height: 70 * bb, borderRadius: 3, background: `linear-gradient(${C.line}, ${ac[0]})` }} />
      </div>
      <div style={{ ...box, borderRadius: '12px 40px 40px 40px', marginLeft: 60, background: `linear-gradient(135deg, ${ac[0]}26, ${ac[1]}14)`, color: C.text, fontWeight: 600, border: `3px solid ${ac[0]}`, boxShadow: `0 0 90px ${ac[0]}33`, opacity: Math.min(1, bb * 1.4), transform: `translateY(${(1 - bb) * 50}px) scale(${0.9 + 0.1 * b})`, transformOrigin: 'left top' }}>
        <div style={{ ...tag, color: ac[0] }}>СТАЛО</div>{compare.after}
      </div>
    </>
  );
};

/** Шаги или перечень: номера в кружках на общей нити, появляются по одному. */
const Steps = ({ lines, frame, fps, ac }) => lines.map((line, i) => {
  const t = spring({ frame: frame - 10 - i * 22, fps, config: SOFT });
  const pop = spring({ frame: frame - 10 - i * 22, fps, config: POP });
  const thread = spring({ frame: frame - 22 - i * 22, fps, config: SOFT });
  const last = i === lines.length - 1;
  return (
    <div key={i} style={{ display: 'flex', gap: 34, alignItems: 'stretch' }}>
      <div style={{ flex: '0 0 92px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ width: 92, height: 92, borderRadius: 46, background: `linear-gradient(135deg, ${ac[0]}, ${ac[1]})`, color: C.bg, fontSize: 50, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 40px ${ac[0]}55`, transform: `scale(${pop})` }}>{i + 1}</div>
        {last ? null : <div style={{ flex: 1, width: 6, borderRadius: 3, margin: '12px 0', background: `${ac[0]}66`, transform: `scaleY(${thread})`, transformOrigin: 'top' }} />}
      </div>
      <div style={{ color: C.text, fontSize: lines.length > 4 ? 48 : lines.length > 2 ? 54 : 60, lineHeight: 1.26, paddingTop: 8, paddingBottom: last ? 0 : 54, opacity: t, transform: `translateX(${(1 - t) * 50}px)` }}>
        <Rich text={line} color={ac[0]} />
      </div>
    </div>
  );
});

/** Свечение сцены: мягкое цветное пятно, медленно плывёт; у каждой сцены своё место и цвет. */
const Glow = ({ ac, index, frame, show }) => {
  const x = [18, 82, 30, 75, 12, 88][index % 6] + Math.sin(frame / 50 + index) * 6;
  const y = [14, 30, 78, 16, 60, 70][index % 6] + Math.cos(frame / 60 + index) * 5;
  return (
    <AbsoluteFill style={{ opacity: show, background: `radial-gradient(70% 42% at ${x}% ${y}%, ${ac[0]}3d 0%, ${ac[1]}14 45%, transparent 72%), radial-gradient(50% 30% at ${100 - x}% ${100 - y}%, ${ac[1]}26 0%, transparent 70%)` }} />
  );
};

/** Кольца на фоне зацепки и финала: медленно расходятся от угла. */
const Rings = ({ ac, frame, show }) => (
  <AbsoluteFill style={{ opacity: show * 0.9 }}>
    {[0, 1, 2, 3].map((i) => {
      const r = 300 + i * 190 + (frame * 0.9) % 190;
      return <div key={i} style={{ position: 'absolute', right: -r + 170, top: 330 - r, width: r * 2, height: r * 2, borderRadius: '50%', border: `3px solid ${ac[0]}`, opacity: Math.max(0, 0.22 - r / 5200) }} />;
    })}
  </AbsoluteFill>
);

const Scene = ({ scene, index, project }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const frames = sceneFrames(scene, fps);
  const ac = accentOf(scene);
  const size = lineSize(scene.lines);
  const head = spring({ frame: frame - 2, fps, config: SOFT });
  const out = interpolate(frame, [frames - 9, frames], [1, 0], clamp);
  const show = Math.min(interpolate(frame, [0, 12], [0, 1], clamp), out);
  // Уход сцены: чуть вверх и вглубь, следующая приходит снизу — получается перелистывание.
  const wrap = { padding: '300px 84px 220px', justifyContent: 'center', opacity: out, transform: `translateY(${(1 - out) * -70}px) scale(${0.96 + 0.04 * out})` };
  const audio = scene.voice === false ? null : (
    <Sequence from={VOICE_DELAY} layout="none">
      <Audio src={staticFile(`voice/${scene.key}.wav`)} />
    </Sequence>
  );
  const tag = scene.tag ? <Tag tag={scene.tag} color={ac[0]} t={head} /> : null;
  const titleSize = scene.title.length > 44 ? 64 : scene.title.length > 22 ? 82 : 100;
  const title = (
    <div style={{ fontSize: titleSize, fontWeight: 800, lineHeight: 1.06, letterSpacing: -2 }}>
      <Words text={scene.title} mark={scene.mark} frame={frame} fps={fps} ac={ac} delay={3} step={3} enter={scene.enter} />
    </div>
  );
  const rule = <div style={{ width: 130, height: 10, borderRadius: 5, background: `linear-gradient(90deg, ${ac[0]}, ${ac[1]})`, margin: '40px 0 54px', transform: `scaleX(${head})`, transformOrigin: 'left' }} />;

  if (scene.kind === 'hook' || scene.kind === 'finale') {
    return (
      <>
        <Glow ac={ac} index={index} frame={frame} show={show} />
        <Rings ac={ac} frame={frame} show={show} />
        <AbsoluteFill style={wrap}>
          {audio}
          <Big scene={scene} frame={frame} fps={fps} finale={scene.kind === 'finale'} ac={ac} />
        </AbsoluteFill>
      </>
    );
  }
  const body = scene.kind === 'number' && scene.number ? <BigNumber number={scene.number} frame={frame} fps={fps} ac={ac} />
    : scene.kind === 'compare' && scene.compare ? <Compare compare={scene.compare} frame={frame} fps={fps} ac={ac} />
      : scene.kind === 'steps' ? <Steps lines={scene.lines} frame={frame} fps={fps} ac={ac} /> : null;
  if (body) {
    return (
      <>
        <Glow ac={ac} index={index} frame={frame} show={show} />
        <AbsoluteFill style={wrap}>
          {audio}
          {tag}
          {title}
          {rule}
          {body}
          {scene.kind === 'steps' ? null : scene.lines.map((line, i) => {
            const t = spring({ frame: frame - 30 - i * 8, fps, config: SOFT });
            return <div key={i} style={{ color: C.dim, fontSize: 48, lineHeight: 1.3, marginTop: 30, opacity: t }}>{line}</div>;
          })}
        </AbsoluteFill>
      </>
    );
  }
  const note = scene.style === 'note';
  return (
    <>
      <Glow ac={ac} index={index} frame={frame} show={show} />
      <AbsoluteFill style={wrap}>
        {audio}
        {tag}
        {title}
        {rule}
        {scene.kind === 'chat' && scene.chat ? (
          <>
            <Chat chat={scene.chat} project={project} frame={frame} fps={fps} ac={ac} />
            {scene.lines[0] ? <div style={{ color: C.dim, fontSize: 40, lineHeight: 1.3, marginTop: 36, textAlign: 'center', opacity: spring({ frame: frame - 36, fps, config: SOFT }) }}>{scene.lines[0]}</div> : null}
          </>
        ) : null}
        {scene.kind !== 'chat' && scene.bar && scene.bar.total > 0 ? <Bar bar={scene.bar} frame={frame} fps={fps} ac={ac} /> : null}
        {scene.kind === 'chat' && scene.chat ? null : scene.lines.map((line, i) => {
          const t = spring({ frame: frame - 12 - i * 9, fps, config: SOFT });
          const edge = spring({ frame: frame - 16 - i * 9, fps, config: SOFT });
          return (
            <div key={i} style={{ position: 'relative', display: 'flex', gap: 30, alignItems: 'flex-start', color: C.text, fontSize: size, lineHeight: 1.3, marginBottom: 26, padding: '44px 44px 48px 54px', borderRadius: 36, overflow: 'hidden', background: note ? `linear-gradient(135deg, ${ac[0]}24, rgba(23,32,51,0.75))` : 'rgba(23,32,51,0.72)', border: `2px solid ${note ? `${ac[0]}77` : C.line}`, boxShadow: '0 30px 90px rgba(0,0,0,0.35)', opacity: t, transform: `translateY(${(1 - t) * 44}px)` }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 12, background: `linear-gradient(${ac[0]}, ${ac[1]})`, transform: `scaleY(${edge})`, transformOrigin: 'top' }} />
              {note && i === 0 ? (
                <div style={{ flex: '0 0 84px', height: 84, borderRadius: 42, marginTop: 4, background: `linear-gradient(135deg, ${ac[0]}, ${ac[1]})`, color: C.bg, fontSize: 58, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${spring({ frame: frame - 18, fps, config: POP })})` }}>!</div>
              ) : null}
              <div><Rich text={line} color={ac[0]} /></div>
            </div>
          );
        })}
      </AbsoluteFill>
    </>
  );
};

export const Daily = ({ project, date, kind, scenes }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  let from = 0;
  const parts = scenes.map((scene) => {
    const frames = sceneFrames(scene, fps);
    const part = { scene, from, frames };
    from += frames;
    return part;
  });
  const now = parts.find((p) => frame < p.from + p.frames) || parts[parts.length - 1];
  const ac = accentOf(now.scene);
  return (
    <AbsoluteFill style={{ background: `linear-gradient(170deg, ${C.bg2} 0%, ${C.bg} 55%, #06080f 100%)`, fontFamily: FONT }}>
      <AbsoluteFill style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.055) 2px, transparent 2.5px)', backgroundSize: '54px 54px', backgroundPosition: `0 ${-(frame * 0.4) % 54}px`, maskImage: 'linear-gradient(transparent 5%, black 35%, black 65%, transparent 95%)', WebkitMaskImage: 'linear-gradient(transparent 5%, black 35%, black 65%, transparent 95%)' }} />
      {parts.map((p, i) => (
        <Sequence key={p.scene.key} from={p.from} durationInFrames={p.frames}>
          <Scene scene={p.scene} index={i} project={project} />
        </Sequence>
      ))}
      {/* Шапка: полоски-сцены, как в «историях» — видно, сколько осталось. */}
      <div style={{ position: 'absolute', top: 96, left: 84, right: 84, display: 'flex', gap: 10 }}>
        {parts.map((p, i) => {
          const fill = Math.max(0, Math.min(1, (frame - p.from) / p.frames));
          return (
            <div key={i} style={{ flex: p.frames, height: 10, borderRadius: 5, background: 'rgba(255,255,255,0.16)', overflow: 'hidden' }}>
              <div style={{ width: `${fill * 100}%`, height: '100%', borderRadius: 5, background: fill >= 1 ? 'rgba(255,255,255,0.72)' : ac[0] }} />
            </div>
          );
        })}
      </div>
      <div style={{ position: 'absolute', top: 136, left: 84, right: 84, display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: C.dim, fontSize: 36, fontWeight: 500 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ width: 18, height: 18, borderRadius: 9, background: ac[0], boxShadow: `0 0 20px ${ac[0]}` }} />
          {kind} · {project}
        </span>
        <span>{date}</span>
      </div>
    </AbsoluteFill>
  );
};
