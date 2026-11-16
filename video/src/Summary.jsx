import React from 'react';
import { AbsoluteFill, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Audio } from '@remotion/media';

const VOICE_DELAY = 3; // кадров тишины перед голосом в каждой сцене
const TAIL = 0.3; // секунд после голоса: сцена не висит в тишине

export const sceneFrames = (scene, fps) => Math.ceil((scene.duration + TAIL) * fps) + VOICE_DELAY;
export const totalFrames = (scenes, fps) => Math.max(1, scenes.reduce((sum, s) => sum + sceneFrames(s, fps), 0));

const C = { bg: '#0e1420', panel: '#172033', line: '#26324a', text: '#eef2f8', dim: '#93a1b8', accent: '#ffb648' };
const FONT = '-apple-system, "SF Pro Display", "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif';

/** Размер строк по объёму текста: короткая сцена — крупно, длинный пересказ — мельче, чтобы влез в экран. */
const lineSize = (lines) => {
  const chars = lines.reduce((n, l) => n + l.length, 0) + lines.length * 24;
  return chars < 120 ? 72 : chars < 240 ? 62 : chars < 380 ? 53 : 46;
};

/** Демонстрация: схематичный экран чата — сообщение бота и кнопки под ним, как в образце из описания изменения. */
const Chat = ({ chat, frame, fps }) => {
  const t = spring({ frame: frame - 10, fps, config: { damping: 200 } });
  const size = chat.text.length < 160 ? 46 : chat.text.length < 320 ? 40 : 35;
  return (
    <div style={{ background: '#0a0f19', border: `2px solid ${C.line}`, borderRadius: 44, padding: '40px 36px 44px', opacity: t, transform: `translateY(${(1 - t) * 40}px)` }}>
      {chat.text ? (
        <div style={{ background: C.panel, color: C.text, fontSize: size, lineHeight: 1.34, padding: '30px 34px', borderRadius: '34px 34px 34px 10px', whiteSpace: 'pre-wrap', maxWidth: '94%' }}>
          {chat.text}
        </div>
      ) : null}
      {chat.buttons.map((row, r) => {
        const b = spring({ frame: frame - 22 - r * 6, fps, config: { damping: 200 } });
        return (
          <div key={r} style={{ display: 'flex', gap: 14, marginTop: 14, opacity: b }}>
            {row.map((label, i) => (
              <div key={i} style={{ flex: 1, textAlign: 'center', background: C.line, color: C.text, fontSize: 36, fontWeight: 600, padding: '22px 10px', borderRadius: 20, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                {label}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
};

/** Полоса «сделано из всего»: заполняется на глазах — цели, успешные прогоны, занятый лимит. */
const Bar = ({ bar, frame, fps }) => {
  const t = spring({ frame: frame - 8, fps, config: { damping: 200 }, durationInFrames: 40 });
  const share = Math.max(0, Math.min(1, bar.done / bar.total));
  return (
    <div style={{ height: 44, borderRadius: 22, background: C.line, marginBottom: 56, overflow: 'hidden' }}>
      <div style={{ width: `${share * t * 100}%`, height: '100%', borderRadius: 22, background: C.accent }} />
    </div>
  );
};

const Scene = ({ scene, index, count }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const frames = sceneFrames(scene, fps);
  const size = lineSize(scene.lines);
  const head = spring({ frame, fps, config: { damping: 200 } });
  const out = interpolate(frame, [frames - 8, frames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ padding: '240px 84px 260px', justifyContent: 'center', opacity: out }}>
      {scene.voice === false ? null : (
        <Sequence from={VOICE_DELAY} layout="none">
          <Audio src={staticFile(`voice/${scene.key}.wav`)} />
        </Sequence>
      )}
      <div style={{ color: C.accent, fontSize: 40, fontWeight: 600, letterSpacing: 1, opacity: head }}>
        {index + 1} / {count}
      </div>
      <div style={{ color: C.text, fontSize: scene.title.length > 44 ? 62 : scene.title.length > 22 ? 78 : 96, fontWeight: 800, lineHeight: 1.08, marginTop: 18, opacity: head, transform: `translateY(${(1 - head) * 40}px)` }}>
        {scene.title}
      </div>
      <div style={{ width: 120, height: 8, borderRadius: 4, background: C.accent, margin: '44px 0 52px', transform: `scaleX(${head})`, transformOrigin: 'left' }} />
      {scene.kind === 'chat' && scene.chat ? (
        <>
          {scene.lines[0] ? <div style={{ color: C.dim, fontSize: 40, marginBottom: 36, opacity: head }}>{scene.lines[0]}</div> : null}
          <Chat chat={scene.chat} frame={frame} fps={fps} />
        </>
      ) : null}
      {scene.kind !== 'chat' && scene.bar && scene.bar.total > 0 ? <Bar bar={scene.bar} frame={frame} fps={fps} /> : null}
      {scene.kind === 'chat' && scene.chat ? null : scene.lines.map((line, i) => {
        const t = spring({ frame: frame - 6 - i * 7, fps, config: { damping: 200 } });
        return (
          <div key={i} style={{ color: C.text, fontSize: size, lineHeight: 1.32, marginBottom: size * 0.62, opacity: t, transform: `translateY(${(1 - t) * 30}px)` }}>
            {line}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

export const Summary = ({ project, date, kind, scenes }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  let from = 0;
  return (
    <AbsoluteFill style={{ background: `radial-gradient(120% 70% at 20% 0%, ${C.panel} 0%, ${C.bg} 62%)`, fontFamily: FONT }}>
      <div style={{ position: 'absolute', top: 110, left: 84, right: 84, display: 'flex', justifyContent: 'space-between', color: C.dim, fontSize: 38, fontWeight: 500 }}>
        <span>{kind} · {project}</span>
        <span>{date}</span>
      </div>
      {scenes.map((scene, i) => {
        const frames = sceneFrames(scene, fps);
        const seq = (
          <Sequence key={scene.key} from={from} durationInFrames={frames}>
            <Scene scene={scene} index={i} count={scenes.length} />
          </Sequence>
        );
        from += frames;
        return seq;
      })}
      <div style={{ position: 'absolute', left: 84, right: 84, bottom: 120, height: 10, borderRadius: 5, background: C.line }}>
        <div style={{ width: `${(frame / Math.max(1, durationInFrames - 1)) * 100}%`, height: '100%', borderRadius: 5, background: C.accent }} />
      </div>
    </AbsoluteFill>
  );
};
