# 安巡智控｜公司內網 AI 版 v2.0

製造業現場安全巡檢與缺失閉環管理系統。AI、照片與稽核資料全部留在公司內網，不使用外部 AI API，也不要求使用者登入外部帳號。

## 架構

- React + Vite：巡檢、辨識結果、缺失追蹤與管理看板。
- FastAPI：統一處理 AI 推論與資料存取。
- Ollama + `qwen3-vl:4b`：內網圖片辨識，可用 CPU 或 NVIDIA GPU。
- PostgreSQL：多台電腦共用的稽核資料庫。
- Nginx：提供網站並反向代理內網 API。
- Docker Compose：一鍵啟動全部服務。

## 快速啟動

```bash
cp .env.example .env
# 請先修改 .env 的 POSTGRES_PASSWORD
docker compose up -d --build
```

開啟 `http://伺服器IP:8080`。第一次啟動會自動下載 AI 模型，完成前健康檢查會顯示 `ready: false`。

NVIDIA GPU：

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

詳細步驟請見 [部署內網版.md](./部署內網版.md)。

## 開發與驗證

```bash
pnpm install
pnpm build
python -m compileall -q server/app
docker compose config --quiet
```

每次推送到 `main`，GitHub Actions 只做自動建置驗證，不會把內網版部署到公開 GitHub Pages。公司伺服器可執行 `scripts/deploy.ps1` 或 `scripts/deploy.sh` 自動取得更新並重新建置。

## 安全界線

- 服務應僅開放給公司 LAN／VPN，並由 IT 設定防火牆與 HTTPS。
- AI 結果是巡檢輔助；高風險、法規與銷項須由合格人員複核。
- 請定期備份 PostgreSQL volume。
