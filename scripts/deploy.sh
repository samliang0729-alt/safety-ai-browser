#!/usr/bin/env sh
set -eu
if [ ! -f .env ]; then
  cp .env.example .env
  echo "已建立 .env。請修改 POSTGRES_PASSWORD 後重新執行。"
  exit 1
fi
git pull --ff-only
if [ "${1:-}" = "--gpu" ]; then
  docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
else
  docker compose up -d --build
fi
docker compose ps
echo "完成。請開啟 http://localhost:8080"
