#!/bin/sh
# Проба: тянет ли сервер (Intel N150, 4 ядра, без VRAM) локальную модель.
#
# Запуск на сервере памяти (Linux, Docker):
#     sh probe-local-llm.sh small     # Qwen3-0.6B  Q4_K_M, 378 МБ  (по умолчанию)
#     sh probe-local-llm.sh medium    # Qwen2.5-1.5B Q4_K_M, 1066 МБ
#     sh probe-local-llm.sh <repo> <file.gguf>
#
# Модель качается явно (curl) и передаётся контейнеру локальным файлом:
# образ llama.cpp:server сам из Hugging Face не качает и трактует -m как путь
# к файлу - на этом он и падал с кодом 1.
#
# Печатает: время скачивания, время загрузки модели, скорость генерации,
# память контейнера, код выхода и лог сервера. Контейнер после пробы НЕ
# удаляется: если модель не поднялась, лог остаётся доступен для разбора.
#
# Что смотреть в результате (решение принимается по цифрам, не по вкусу):
#   - скорость ниже 8 tok/s   -> на 1.5B не рассчитываем, на 3B тем более;
#   - память выше 1.8 ГБ      -> модель не влезает в отведённый бюджет;
#   - загрузка дольше минуты  -> сервер будет вставать при каждом старте.
set -e

# Версия пробы. На сервере лежит копия: если номер не тот - скрипт старый,
# и его результаты нельзя сравнивать с новыми.
PROBE_VERSION=3

PRESET="${1:-small}"
IMAGE="${LLAMA_IMAGE:-ghcr.io/ggml-org/llama.cpp:server}"
PORT="${PORT:-8099}"
CACHE="${LLAMA_CACHE:-$HOME/.cache/llama}"
NAME="llm-probe"

case "$PRESET" in
  small)
    REPO="unsloth/Qwen3-0.6B-GGUF"
    FILE="Qwen3-0.6B-Q4_K_M.gguf"
    ;;
  medium)
    REPO="Qwen/Qwen2.5-1.5B-Instruct-GGUF"
    FILE="qwen2.5-1.5b-instruct-q4_k_m.gguf"
    ;;
  *)
    REPO="$PRESET"
    FILE="${2:-}"
    ;;
esac

echo "репозиторий: $REPO"
echo "файл:        $FILE"
echo "версия пробы: $PROBE_VERSION (модель качается явно, передаётся файлом)"
echo "образ:       $IMAGE"
echo "кэш:         $CACHE"

echo "=== память хоста ==="
free -h 2>/dev/null || true

mkdir -p "$CACHE"
TARGET="$CACHE/$FILE"

if [ -f "$TARGET" ]; then
  echo "=== модель уже в кэше ==="
else
  echo "=== скачивание ==="
  DL=$(date +%s)
  if ! curl -L --fail --retry 3 -o "$TARGET" \
      "https://huggingface.co/$REPO/resolve/main/$FILE"; then
    echo "НЕ СКАЧАЛОСЬ. Если huggingface.co с сервера недоступен, скачайте файл"
    echo "на другой машине и положите сюда: $TARGET"
    exit 1
  fi
  echo "=== скачано за $(( $(date +%s) - DL )) с ==="
fi
ls -la "$TARGET"

docker pull "$IMAGE" >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true

START=$(date +%s)
# Без --rm: если модель не поднимется, контейнер и его лог должны остаться.
docker run -d --name "$NAME" -p "$PORT:8080" \
  -v "$CACHE:/root/.cache/llama" \
  "$IMAGE" -m "/root/.cache/llama/$FILE" --host 0.0.0.0 --port 8080 --ctx-size 4096 -ngl 0

# Ждём, пока сервер поднимется; отдельно меряем, сколько это заняло.
i=0
while [ "$i" -lt 120 ]; do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  # Контейнер умер - ждать бессмысленно.
  if ! docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null | grep -q true; then
    break
  fi
  i=$((i + 1))
  sleep 2
done
LOADED=$(date +%s)
echo "=== загрузка модели: $((LOADED - START)) с ==="

echo "=== состояние контейнера ==="
docker ps -a --filter "name=$NAME" --format "{{.Names}}  {{.Status}}  {{.Image}}"
echo "код выхода: $(docker inspect -f '{{.State.ExitCode}}' "$NAME" 2>/dev/null || echo 'нет')"

echo "=== лог сервера (хвост) ==="
docker logs "$NAME" 2>&1 | tail -25

if ! curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "=== СЕРВЕР НЕ ПОДНЯЛСЯ ==="
  echo "лог оставлен: docker logs $NAME    убрать: docker rm -f $NAME"
  exit 1
fi

echo "=== скорость (русский запрос, 128 токенов) ==="
curl -s "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Опиши одним абзацем, зачем системе памяти хранить записи о проекте и что она должна забывать."}],"max_tokens":128,"temperature":0}' \
  -w "\n=== время ответа: %{time_total} с ===\n" | tail -6

echo "=== второй запрос (кэш прогрет) ==="
curl -s "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Ещё один абзац о том же, но иначе."}],"max_tokens":128,"temperature":0}' \
  -w "\n=== время ответа: %{time_total} с ===\n" | tail -4

echo "=== память контейнера ==="
docker stats --no-stream --format "память: {{.MemUsage}}  cpu: {{.CPUPerc}}" "$NAME"

echo "=== проба закончена, модель осталась в кэше: $CACHE ==="
echo "контейнер оставлен: docker logs $NAME | docker rm -f $NAME"
