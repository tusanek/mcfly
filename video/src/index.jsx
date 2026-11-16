import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { Daily } from './Daily.jsx';
import { Weekly } from './Weekly.jsx';
import { totalFrames } from './timing.js';

// Ролик-сводка: сцены, их текст и длина голоса приходят данными (--props), под проект код не пишется.
// Два оформления (0.15.0): Daily — утренняя сводка, Weekly — итоги недели.
const FPS = 30;
const SAMPLE = { project: 'demo', date: '1 января', kind: 'Утренняя сводка', scenes: [{ key: 's0', kind: 'text', title: 'demo', lines: ['Утренняя сводка'], duration: 2, voice: false }] };
const frames = ({ props }) => ({ durationInFrames: totalFrames(props.scenes, FPS) });

const Root = () => (
  <>
    <Composition id="Daily" component={Daily} fps={FPS} width={1080} height={1920} durationInFrames={totalFrames(SAMPLE.scenes, FPS)} defaultProps={SAMPLE} calculateMetadata={frames} />
    <Composition id="Weekly" component={Weekly} fps={FPS} width={1080} height={1920} durationInFrames={totalFrames(SAMPLE.scenes, FPS)} defaultProps={{ ...SAMPLE, kind: 'Итоги недели' }} calculateMetadata={frames} />
  </>
);

registerRoot(Root);
