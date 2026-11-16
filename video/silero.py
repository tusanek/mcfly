"""Озвучка сцен ролика-сводки локальным синтезатором речи Silero: текст никуда не уходит.

Запуск (его делает mcfly):
  python -I silero.py <сцены.json> <папка для wav> <длительности.json> <голос> <модель.pt>
сцены.json — { "s0": "текст", ... }; на выходе <папка>/<сцена>.wav и длительности в секундах.
Голоса модели v5_ru: aidar, baya, kseniya, eugene, xenia. Ударение подсказывается знаком + перед гласной.
"""
import json
import re
import sys
import warnings
import wave
from pathlib import Path

warnings.filterwarnings("ignore")
import torch  # noqa: E402

RATE = 48000
CHUNK = 700  # длинный текст модель не берёт целиком: читаем по предложениям


def chunks(text: str) -> list[str]:
    out, cur = [], ""
    for sentence in re.split(r"(?<=[.!?…])\s+", text.strip()):
        if cur and len(cur) + len(sentence) + 1 > CHUNK:
            out.append(cur)
            cur = sentence
        else:
            cur = f"{cur} {sentence}".strip()
    return [c for c in out + [cur] if c]


def main() -> None:
    scenes_file, out_dir, durations_file, speaker, model_file = sys.argv[1:6]
    lines = json.loads(Path(scenes_file).read_text(encoding="utf-8"))
    model = torch.package.PackageImporter(model_file).load_pickle("tts_models", "model")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    pause = torch.zeros(int(RATE * 0.25))
    durations = {}
    for key, text in lines.items():
        parts = []
        for piece in chunks(text):
            parts.append(model.apply_tts(text=piece, speaker=speaker, sample_rate=RATE, put_accent=True, put_yo=True))
            parts.append(pause)
        audio = torch.cat(parts[:-1]) if parts else pause
        pcm = (audio.clamp(-1, 1) * 32767).to(torch.int16).numpy().tobytes()
        with wave.open(str(out / f"{key}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(pcm)
        durations[key] = round(len(audio) / RATE, 2)
    Path(durations_file).write_text(json.dumps(durations), encoding="utf-8")


if __name__ == "__main__":
    main()
