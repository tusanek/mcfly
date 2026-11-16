import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { Summary, totalFrames } from './Summary.jsx';

// Один общий ролик-сводка: сцены, их текст и длина голоса приходят данными (--props), под проект код не пишется.
const FPS = 30;
const SAMPLE = { project: 'demo', date: '1 января', kind: 'Утренняя сводка', scenes: [{ key: 's0', title: 'demo', lines: ['Утренняя сводка'], duration: 2, voice: false }] };

const Root = () => (
  <Composition
    id="Summary"
    component={Summary}
    fps={FPS}
    width={1080}
    height={1920}
    durationInFrames={totalFrames(SAMPLE.scenes, FPS)}
    defaultProps={SAMPLE}
    calculateMetadata={({ props }) => ({ durationInFrames: totalFrames(props.scenes, FPS) })}
  />
);

registerRoot(Root);
