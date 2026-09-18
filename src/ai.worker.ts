/// <reference lib="webworker" />
import { AutoModelForImageTextToText, AutoProcessor, load_image } from "@huggingface/transformers";

const MODEL_ID = "onnx-community/LFM2.5-VL-450M-ONNX";
const CATEGORIES = ["6S", "TPM", "職業安全", "消防"] as const;
const STANDARD_REFERENCE = "公司內部 EHS 標準及適用法規，請由合格人員確認";
const PLACEHOLDER_TEXT = /80\s*字|整體評估|請填|請描述|或無|高風險\s*[|｜/]\s*中風險|法規或內部|待確認|對照片現況|具體(?:可見)?(?:判定|缺失|改善|動作)/;

type Category = (typeof CATEGORIES)[number];
type RawIssue = { category: Category; riskLevel: string; description: string; standardReference: string; recommendation: string };
type RawReport = { assessment: string; issues: RawIssue[] };

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
  if (processor.image_processor) {
    processor.image_processor.do_image_splitting = true;
    processor.image_processor.min_image_tokens = 32;
    processor.image_processor.max_image_tokens = 256;
  }
  post("ready", { model: MODEL_ID });
}

function clean(value: unknown) {
  return String(value ?? "").replace(/^[\s`*#-]+|[\s`]+$/g, "").trim();
}

function categoryOf(value: string): Category | null {
  const label = value.toUpperCase().replace(/\s/g, "");
  if (label.includes("6S")) return "6S";
  if (label.includes("TPM")) return "TPM";
  if (label.includes("職業安全") || label.includes("職安") || label.includes("SAFETY")) return "職業安全";
  if (label.includes("消防") || label.includes("FIRE")) return "消防";
  return null;
}

function riskOf(value: unknown) {
  const text = clean(value);
  if (text === "高" || text === "高風險") return "高風險";
  if (text === "中" || text === "中風險") return "中風險";
  if (text === "低" || text === "低風險") return "低風險";
  if (text === "無" || text === "無風險") return "無";
  return text;
}

function parseLineReport(text: string): RawReport {
  let assessment = "";
  const found = new Map<Category, RawIssue>();
  const lines = text.replace(/```[^\n]*/g, "").replace(/```/g, "").split(/\r?\n/).map(clean).filter(Boolean);

  for (const line of lines) {
    const normalized = line.replace(/｜/g, "|").replace(/^[-*\d.、)\s]+/, "");
    const parts = normalized.split("|").map(clean);
    if (/^(評估|ASSESSMENT)$/i.test(parts[0])) {
      assessment = parts.slice(1).join("，");
      continue;
    }
    const category = categoryOf(parts[0]);
    if (!category || parts.length < 4) continue;
    found.set(category, {
      category,
      riskLevel: riskOf(parts[1]),
      description: parts[2] || "無",
      standardReference: STANDARD_REFERENCE,
      recommendation: parts.slice(3).join("，") || "無",
    });
  }

  if (!assessment || found.size !== CATEGORIES.length) throw new Error("本機模型輸出格式不完整");
  return { assessment, issues: CATEGORIES.map((category) => found.get(category)!) };
}

function parseJsonReport(text: string): RawReport {
  const cleaned = text.replace(/```json|```/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("本機模型未回傳結構化結果");
  const raw = JSON.parse(cleaned.slice(start, end + 1));
  const issues = CATEGORIES.map((category) => {
    const source = Array.isArray(raw.issues) ? raw.issues.find((item: any) => categoryOf(clean(item?.category)) === category) : null;
    if (!source) throw new Error(`缺少 ${category} 判定`);
    return {
      category,
      riskLevel: riskOf(source.riskLevel),
      description: clean(source.description) || "無",
      standardReference: STANDARD_REFERENCE,
      recommendation: clean(source.recommendation) || "無",
    };
  });
  return { assessment: clean(raw.assessment), issues };
}

function parseReport(text: string): RawReport {
  try { return parseLineReport(text); }
  catch { return parseJsonReport(text); }
}

function validReport(report: RawReport) {
  if (report.assessment.length < 8 || PLACEHOLDER_TEXT.test(report.assessment)) return false;
  return report.issues.every((issue) => {
    if (!CATEGORIES.includes(issue.category)) return false;
    if (!["高風險", "中風險", "低風險", "無"].includes(issue.riskLevel)) return false;
    if (PLACEHOLDER_TEXT.test(issue.description) || PLACEHOLDER_TEXT.test(issue.recommendation)) return false;
    if (issue.riskLevel === "無") return issue.description === "無" && issue.recommendation === "無";
    return issue.description.length >= 6 && issue.recommendation.length >= 6;
  });
}

function auditPrompt(context: string, retry: boolean) {
  return `${retry ? "上次輸出未通過品質檢查，請重新觀察照片並具體回答。" : ""}
你是台灣工廠現場巡檢員。先仔細觀察照片，只能描述照片中能直接看見的物件、位置與狀態，不可猜測照片外資訊。
巡檢背景：${context}
分別檢查 6S、TPM、職業安全、消防。沒有清楚可見的缺失就填「無」。有缺失時，風險填「高風險」、「中風險」或「低風險」，描述必須指出具體物件與位置，改善必須是可執行動作。
只輸出五行純文字，不要 JSON、Markdown、標題、說明或選項。格式為：
評估|對照片現況的具體判定
6S|風險|具體可見缺失|具體改善動作
TPM|風險|具體可見缺失|具體改善動作
職業安全|風險|具體可見缺失|具體改善動作
消防|風險|具體可見缺失|具體改善動作
不可照抄題目或格式文字。每一列都必須填寫；無缺失的列固定輸出「類別|無|無|無」。使用繁體中文。`;
}

async function inferReport(image: any, context: string, retry = false): Promise<RawReport> {
  const messages = [{ role: "user", content: [{ type: "image" }, { type: "text", text: auditPrompt(context, retry) }] }];
  const formatted = processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await processor(image, formatted, { add_special_tokens: false });
  const outputs = await model.generate({ ...inputs, max_new_tokens: 420, do_sample: false, repetition_penalty: 1.05 });
  const decoded = processor.batch_decode(outputs.slice(null, [inputs.input_ids.dims.at(-1), null]), { skip_special_tokens: true })[0];
  const report = parseReport(decoded);
  if (!validReport(report)) throw new Error("本機模型產生了無效或空泛內容");
  return report;
}

async function analyze(images: string[], context: string) {
  await loadModel();
  const reports = [];
  for (let index = 0; index < images.length; index++) {
    post("status", { message: `本機分析照片 ${index + 1}/${images.length}`, progress: Math.round((index / images.length) * 100) });
    const image = await load_image(images[index]);
    let report: RawReport;
    try {
      report = await inferReport(image, context);
    } catch {
      post("status", { message: `照片 ${index + 1} 品質檢查未通過，正在自動重試`, progress: Math.round(((index + 0.5) / images.length) * 100) });
      report = await inferReport(image, context, true);
    }
    reports.push({ photoIndex: index + 1, ...report });
  }
  const issueCount = reports.flatMap((report) => report.issues).filter((issue) => issue.description !== "無").length;
  return { overallSummary: `本次共檢視 ${images.length} 張照片，辨識 ${issueCount} 項可見的待確認或改善事項。結果僅供初篩，請由合格人員複核。`, reports };
}

self.onmessage = async (event: MessageEvent) => {
  try {
    if (event.data.type === "load") await loadModel();
    if (event.data.type === "analyze") {
      const result = await analyze(event.data.images, event.data.context);
      post("result", { result, model: MODEL_ID });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "未知錯誤";
    post("error", { message: `AI 未產生可用的具體判定，請改用一張主體清楚、光線充足的照片重試。（${detail}）` });
  }
};
