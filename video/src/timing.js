// Темп ролика — общий для обоих оформлений и для расчёта длины в src/video.js (sceneFrames там повторяет эту формулу).
export const VOICE_DELAY = 3; // кадров тишины перед голосом в каждой сцене
export const TAIL = 0.3; // секунд после голоса: сцена не висит в тишине

export const sceneFrames = (scene, fps) => Math.ceil((scene.duration + TAIL) * fps) + VOICE_DELAY;
export const totalFrames = (scenes, fps) => Math.max(1, scenes.reduce((sum, s) => sum + sceneFrames(s, fps), 0));
