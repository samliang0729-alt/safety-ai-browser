/// <reference lib="webworker" />
import { AutoModelForImageTextToText, AutoProcessor, load_image } from "@huggingface/transformers";

const MODEL_ID = "onnx-community/LFM2.5-VL-450M-ONNX";
let processor: any;
let model: any;

function post(type: string, data: Record<string, unknown> = {}) {
  self.postMessage({ type, ...data });
}

async function loadModel() {
  if (processor && model) return;
  post("status", { message: "正在下載本機 AI 模型", progress: 2 });
  processor = await AutoProcessor.from_pretrained(MODEL_ID, {
    progress_callback: (item: any) => {
      if (item.status === "progress") post("status", { message: "下載並快取 AI 模型", progress: Math.max(2, Math.round(item.progress || 0)) });
    },
  });
  model = await AutoModelForImageTextToText.from_pretrained(MODEL_ID, {
    device: "webgpu",
    dtype: { embed_tokens: "fp16", decoder_model_merged: "q4f16", vision_encoder: "fp16" },
    progress_callback: (item: any) => {
      if (item.status === "progress") post("status", { message: "載入模型到顯示卡", progress: Math.max(2, Math.round(item.progress || 0)) });
    },
  } as any);
  if (processor.image_processor) processor.image_processor.do_image_splitting = false;
  post("ready", { model: MODEL_ID });
}

function parseJson(text: string) {
  const cleaned = text.replace(/```json|```/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("本機模型未回傳結構化結果");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function analyze(images: string[], context: string) {
  await loadModel();
  const reports = [];
  for (let index = 0; index < images.length; index++) {
    post("status", { message: `本機分析照片 ${index + 1}/${images.length}`, progress: Math.round((index / images.length) * 100) });
    const prompt = `${context}\n你是台灣工廠EHS巡檢員。只根據照片可直接看見的證據，檢查6S、TPM、職業安全、消防。不可臆測。請只輸出JSON，不要Markdown：{"assessment":"80字內整體評估","issues":[{"category":"6S","riskLevel":"高風險|中風險|低風險|無","description":"80字內或無","standardReference":"法規或內部EHS標準待確認","recommendation":"80字內或無"}]}。issues必須正好四項，依序為6S、TPM、職業安全、消防；無缺失時其餘欄位也填無。繁體中文。`;
    const messages = [{ role: "user", content: [{ type: "image" }, { type: "text", text: prompt }] }];
    const formatted = processor.apply_chat_template(messages, { add_generation_prompt: true });
    const image = await load_image(images[index]);
    const inputs = await processor(image, formatted, { add_special_tokens: false });
    const outputs = await model.generate({ ...inputs, max_new_tokens: 1024, do_sample: false });
    const decoded = processor.batch_decode(outputs.slice(null, [inputs.input_ids.dims.at(-1), null]), { skip_special_tokens: true })[0];
    reports.push({ photoIndex: index + 1, ...parseJson(decoded) });
  }
  const issueCount = reports.flatMap((r: any) => r.issues || []).filter((i: any) => i.description !== "無").length;
  return { overallSummary: `本次共檢視 ${images.length} 張照片，辨識 ${issueCount} 項需確認或改善事項。請由合格人員複核高風險判定及法規依據。`, reports };
}

self.onmessage = async (event: MessageEvent) => {
  try {
    if (event.data.type === "load") await loadModel();
    if (event.data.type === "analyze") {
      const result = await analyze(event.data.images, event.data.context);
      post("result", { result, model: MODEL_ID });
    }
  } catch (error) {
    post("error", { message: error instanceof Error ? error.message : "本機 AI 執行失敗" });
  }
};
