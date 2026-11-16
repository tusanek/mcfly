import React from 'react';
import { AbsoluteFill, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Audio } from '@remotion/media';

const VOICE_DELAY = 8; // кадров тишины перед голосом в каждой сцене
const TAIL = 0.9; // секунд после голоса

export const sceneFrames = (scene, fps) => Math.ceil((scene.duration + TAIL) * fps) + VOICE_DELAY;
export const totalFrames = (scenes, fps) => Math.max(1, scenes.reduce((sum, s) => sum + sceneFrames(s, fps), 0));

const C = { bg: '#0e1420', panel: '#172033', line: '#26324a', text: '#eef2f8', dim: '#93a1b8', accent: '#ffb648' };
const FONT = '-apple-system, "SF Pro Display", "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif';

/** Размер строк по объёму текста: короткая сцена — крупно, длинный пересказ — мельче, чтобы влез в экран. */
const lineSize = (lines) => {
  const chars = lines.reduce((n, l) => n + l.length, 0) + lines.length * 24;
  return chars < 120 ? 72 : chars < 240 ? 62 : chars < 380 ? 53 : 46;
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
      <div style={{ color: C.text, fontSize: scene.title.length > 22 ? 78 : 96, fontWeight: 800, lineHeight: 1.08, marginTop: 18, opacity: head, transform: `translateY(${(1 - head) * 40}px)` }}>
        {scene.title}
      </div>
      <div style={{ width: 120, height: 8, borderRadius: 4, background: C.accent, margin: '44px 0 52px', transform: `scaleX(${head})`, transformOrigin: 'left' }} />
      {scene.lines.map((line, i) => {
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
