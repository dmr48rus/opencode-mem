#!/bin/sh
# Проба: судит ли локальная модель о противоречиях так, как это нужно.
#
# Запуск на сервере памяти (Linux, Docker):
#     sudo sh probe-llm-contradiction.sh small   # Qwen3-0.6B  Q4_K_M,  378 МБ
#     sudo sh probe-llm-contradiction.sh mid     # Qwen3-1.7B  Q4_K_M, 1056 МБ
#     sudo sh probe-llm-contradiction.sh big     # Qwen3-4B    Q4_K_M, 2382 МБ
#
# Ответ модели - одно слово из трёх: ПРОТИВОРЕЧАТ / СОВМЕСТИМЫ / НЕ СВЯЗАНЫ.
# Три варианта вместо двух важны: на вопрос с двумя вариантами маленькая модель
# отвечает "да" на всё подряд (измерено: 6 из 6 "да" на Qwen3-0.6B).
#
# Каждая пара спрашивается в обоих порядках: если модель меняет ответ при
# перестановке записей, она как судья ненадёжна.
#
# Считается итог: сколько из случаев угадано, и сколько ответов совпало при
# обоих порядках.
set -e

# Версия пробы. На сервере лежит копия: если номер не тот - скрипт старый,
# и его результаты нельзя сравнивать с новыми.
PROBE_VERSION=3

PRESET="${1:-small}"
IMAGE="${LLAMA_IMAGE:-ghcr.io/ggml-org/llama.cpp:server}"
PORT="${PORT:-8099}"
CACHE="${LLAMA_CACHE:-/root/.cache/llama}"
NAME="llm-judge"

case "$PRESET" in
  small) REPO="unsloth/Qwen3-0.6B-GGUF"; FILE="Qwen3-0.6B-Q4_K_M.gguf" ;;
  mid)   REPO="unsloth/Qwen3-1.7B-GGUF"; FILE="Qwen3-1.7B-Q4_K_M.gguf" ;;
  big)   REPO="unsloth/Qwen3-4B-GGUF";   FILE="Qwen3-4B-Q4_K_M.gguf" ;;
  # Не-Qwen кандидат: Gemma 3 умеет отвечать сразу, без режима размышления,
  # поэтому ответ не остаётся пустым из-за съеденного лимита.
  gemma) REPO="unsloth/gemma-3-1b-it-GGUF"; FILE="gemma-3-1b-it-Q4_K_M.gguf" ;;
  *)     REPO="$PRESET"; FILE="${2:-}" ;;
esac

echo "репозиторий: $REPO"
echo "файл:        $FILE"
echo "версия пробы: $PROBE_VERSION (трёхвариантный ответ, проверка порядка, --parallel 1)"

mkdir -p "$CACHE"
TARGET="$CACHE/$FILE"
if [ ! -f "$TARGET" ]; then
  echo "=== скачивание ==="
  DL=$(date +%s)
  curl -L --fail --retry 3 -o "$TARGET" \
    "https://huggingface.co/$REPO/resolve/main/$FILE" || {
      echo "НЕ СКАЧАЛОСЬ: $REPO/$FILE"
      exit 1
    }
  echo "=== скачано за $(( $(date +%s) - DL )) с ==="
fi
ls -la "$TARGET"

docker rm -f "$NAME" >/dev/null 2>&1 || true
# --parallel 1: один слот контекста вместо четырёх - иначе под KV-кэш уходит
# вчетверо больше памяти, чем нужно.
docker run -d --name "$NAME" -p "$PORT:8080" \
  -v "$CACHE:/root/.cache/llama" \
  "$IMAGE" -m "/root/.cache/llama/$FILE" --host 0.0.0.0 --port 8080 \
  --ctx-size 4096 --parallel 1 -ngl 0 >/dev/null

i=0
while [ "$i" -lt 120 ]; do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  i=$((i + 1))
  sleep 1
done
if ! curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "сервер не поднялся:"
  docker logs "$NAME" 2>&1 | tail -20
  exit 1
fi
echo "=== модель поднята ==="

# ask <запись1> <запись2> -> печатает первое слово ответа
ask() {
  BODY=$(cat <<JSON
{"messages":[{"role":"system","content":"Ты проверяешь две записи из памяти. Ответь ТОЛЬКО одним словом: ПРОТИВОРЕЧАТ, если записи говорят разное об одном и том же; СОВМЕСТИМЫ, если записи говорят одно и то же или одна уточняет другую; НЕ СВЯЗАНЫ, если записи о разном."},{"role":"user","content":"Запись 1: $1\nЗапись 2: $2"}],"max_tokens":16,"temperature":0,"chat_template_kwargs":{"enable_thinking":false}}
JSON
)
  RESP=$(curl -s "http://127.0.0.1:$PORT/v1/chat/completions" \
    -H "Content-Type: application/json" -d "$BODY")
  # Ответ приходит капсом ("СОВМЕСТИМЫ"), а вариант "не связаны" состоит из
  # двух слов - поэтому ответ приводится к нижнему регистру и сравнивается по
  # вхождению, а не по первому слову.
  printf '%s' "$RESP" | grep -o '"content":"[^"]*"' | head -1 \
    | sed 's/"content":"//;s/"$//' \
    | tr 'A-Z' 'a-z' | tr -d '.,!?' | tr -s ' '
}

SCORE=0
TOTAL=0
CONSISTENT=0

run_case() {
  EXPECT="$1"
  A="$2"
  B="$3"
  TOTAL=$((TOTAL + 1))
  R1=$(ask "$A" "$B")
  R2=$(ask "$B" "$A")
  OK1="нет"; OK2="нет"
  case "$R1" in *"$EXPECT"*) OK1="да"; SCORE=$((SCORE + 1)) ;; esac
  case "$R2" in *"$EXPECT"*) OK2="да"; SCORE=$((SCORE + 1)) ;; esac
  # Метка про порядок: "да" - ответ изменился, когда записи переставили.
  if [ "$R1" = "$R2" ]; then CONSISTENT=$((CONSISTENT + 1)); C="нет"; else C="да"; fi
  printf '  ждём %-11s | %-11s | второй порядок: %-11s | порядок меняет: %s\n' \
    "$EXPECT" "$R1" "$R2" "$C"
  printf '      %s\n' "$A"
  printf '      %s\n' "$B"
}

echo "=== 1. разные значения ==="
run_case "противоречат" "порт панели управления в проекте hermes 9119" "порт панели управления в проекте hermes 18801"

echo "=== 2. отрицание общего термина ==="
run_case "противоречат" "сборка hermes не требует установки пакета" "сборка hermes требует установки пакета"

echo "=== 3. ПЕРЕФРАЗ отрицания (лексический детектор пропускает) ==="
run_case "противоречат" "сборка hermes не требует установки пакета" "для сборки hermes пакет устанавливать не нужно"

echo "=== 4. одно и то же разными словами ==="
run_case "совместимы" "порядок сборки hermes и запуск шлюза" "после сборки hermes запускается шлюз"

echo "=== 5. разные темы ==="
run_case "не связаны" "порядок сборки hermes и запуск шлюза" "правило: окончания строк в проекте LF, кроме bat"

echo "=== 6. уточнение, а не противоречие ==="
run_case "совместимы" "в кластере пять записей" "в кластере пять записей и три шарда"

echo "=== 7. разные значения, в обратном порядке ==="
run_case "противоречат" "в памяти 1518 записей в 28 шардах" "в памяти 1519 записей в 28 шардах"

echo
echo "=== итог ==="
echo "угадано: $SCORE из $((TOTAL * 2)) ответов (включая оба порядка)"
echo "порядок не меняет ответ: $CONSISTENT из $TOTAL"
echo "=== память контейнера ==="
docker stats --no-stream --format "память: {{.MemUsage}}" "$NAME"
echo "контейнер оставлен: docker logs $NAME | docker rm -f $NAME"
