param([switch]$Gpu)
$ErrorActionPreference = "Stop"
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "已建立 .env。請修改 POSTGRES_PASSWORD 後重新執行。" -ForegroundColor Yellow
  exit 1
}
git pull --ff-only
if ($Gpu) {
  docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
} else {
  docker compose up -d --build
}
docker compose ps
Write-Host "完成。請開啟 http://localhost:8080" -ForegroundColor Green
