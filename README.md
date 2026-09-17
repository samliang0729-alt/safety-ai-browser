# 安巡智控｜GitHub Pages 瀏覽器 AI 版

此版本不使用後端伺服器、API Key、公司帳號或 Ollama。網站可部署在 GitHub Pages，AI 模型、照片辨識與稽核資料都在使用者瀏覽器中執行。

## 運作方式

- 網站程式：GitHub Pages 靜態託管。
- 視覺模型：`onnx-community/LFM2.5-VL-450M-ONNX`。
- 執行引擎：Transformers.js 4 + WebGPU。
- 照片：壓縮後直接交給瀏覽器 Web Worker，不上傳到 GitHub 或外部 API。
- 紀錄：保存在目前瀏覽器 IndexedDB，可匯出 CSV。
- 模型：第一次使用時由 Hugging Face 官方模型倉庫下載，之後由瀏覽器快取。

完整模型權重不放在 GitHub repository，因模型由多個大型檔案組成，不適合 GitHub 一般程式碼儲存。若公司封鎖 Hugging Face，需將模型檔鏡像到公司允許的靜態檔案站，再修改 worker 的模型路徑。

## 電腦需求

- 最新版 Chrome 或 Microsoft Edge。
- 必須支援 WebGPU並開啟硬體加速。
- 建議至少 16 GB RAM、獨立顯示卡 4 GB VRAM以上。
- 手機瀏覽器、舊電腦及未支援 WebGPU的環境不建議使用。

## 本機開發

```bash
pnpm install
pnpm run dev
```

## 建置

```bash
pnpm run build
```

輸出位於 `dist/`。

## 部署到 GitHub Pages

1. 建立 GitHub repository並上傳整個專案。
2. Repository → Settings → Pages。
3. Source 選擇 `GitHub Actions`。
4. Push 到 `main` 後，`.github/workflows/deploy.yml` 會自動建置與部署。

Vite 已設定相對路徑，因此可部署到 `https://帳號.github.io/repository名稱/`。

## 資料限制

- IndexedDB 資料只存在目前瀏覽器與目前電腦，不會跨裝置同步。
- 清除網站資料、無痕模式結束或瀏覽器重設後，資料可能消失。
- 請定期匯出 CSV；若需要跨電腦共用、集中備份或不可竄改履歷，應使用內網伺服器版本。
- 450M 級本機模型的判斷能力低於大型雲端模型，所有高風險、法規依據與銷項都必須由合格人員複核。
