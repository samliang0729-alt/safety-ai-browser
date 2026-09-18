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
  const text = clean(value).toUpperCase();
  if (text === "H" || text === "高" || text === "高風險") return "高風險";
  if (text === "M" || text === "中" || text === "中風險") return "中風險";
  if (text === "L" || text === "低" || text === "低風險") return "低風險";
  if (text === "N" || text === "無" || text === "無風險") return "無";
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
  const sources = Array.isArray(raw.i)
    ? raw.i.map((item: any[]) => ({ category: item?.[0], riskLevel: item?.[1], description: item?.[2], recommendation: item?.[3] }))
    : raw.issues;
  const issues = CATEGORIES.map((category) => {
    const source = Array.isArray(sources) ? sources.find((item: any) => categoryOf(clean(item?.category)) === category) : null;
    if (!source) throw new Error(`缺少 ${category} 判定`);
    return {
      category,
      riskLevel: riskOf(source.riskLevel),
      description: clean(source.description) || "無",
      standardReference: STANDARD_REFERENCE,
      recommendation: clean(source.recommendation) || "無",
    };
  });
  return { assessment: clean(raw.a ?? raw.assessment), issues };
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

function auditPrompt(context: string) {
  return `Inspect this factory photo using visible evidence only. Context: ${context}
Return only one compact JSON object in Traditional Chinese, without Markdown.
Keys: "a" is a concrete scene assessment; "i" is exactly four arrays in this order: 6S, TPM, 職業安全, 消防.
Each array is [category,risk,visible_problem,corrective_action]. Risk is H, M, L, or N. For no visible problem use [category,"N","無","無"]. Never copy these instructions.`;
}

async function generateText(image: any, prompt: string, maxNewTokens: number) {
  const messages = [{ role: "user", content: [{ type: "image" }, { type: "text", text: prompt }] }];
  const formatted = processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await processor(image, formatted, { add_special_tokens: false });
  const outputs = await model.generate({ ...inputs, max_new_tokens: maxNewTokens, do_sample: false, repetition_penalty: 1.05 });
  return processor.batch_decode(outputs.slice(null, [inputs.input_ids.dims.at(-1), null]), { skip_special_tokens: true })[0];
}

async function inferReport(image: any, context: string): Promise<RawReport> {
  const decoded = await generateText(image, auditPrompt(context), 320);
  const report = parseReport(decoded);
  if (!validReport(report)) throw new Error("本機模型產生了無效或空泛內容");
  return report;
}

function emptyIssue(category: Category): RawIssue {
  return { category, riskLevel: "無", description: "無", standardReference: STANDARD_REFERENCE, recommendation: "無" };
}

function pendingIssue(category: Category): RawIssue {
  return {
    category,
    riskLevel: "待確認",
    description: `本機模型未能穩定解析 ${category} 判定，請人工確認`,
    standardReference: STANDARD_REFERENCE,
    recommendation: `請依 ${category} 現場檢查表完成複核並記錄結果`,
  };
}

function parseGranularIssue(text: string, category: Category): RawIssue {
  const value = text.replace(/```(?:json)?|```/gi, "").trim();
  if (/^(N|無|無明顯缺失)[。.!！\s]*$/i.test(value)) return emptyIssue(category);

  const jsonStart = value.indexOf("{");
  const jsonEnd = value.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const raw = JSON.parse(value.slice(jsonStart, jsonEnd + 1));
      const riskLevel = riskOf(raw.r ?? raw.risk ?? raw.riskLevel);
      if (riskLevel === "無") return emptyIssue(category);
      const description = clean(raw.d ?? raw.description);
      const recommendation = clean(raw.a ?? raw.action ?? raw.recommendation);
      if (["高風險", "中風險", "低風險"].includes(riskLevel) && description.length >= 4 && recommendation.length >= 4) {
        return { category, riskLevel, description, standardReference: STANDARD_REFERENCE, recommendation };
      }
    } catch { /* try line parsing */ }
  }

  const lines = value.split(/\r?\n/).map(clean).filter(Boolean);
  for (const line of lines) {
    const parts = line.replace(/｜/g, "|").replace(/^[-*\d.、)\s]+/, "").split("|").map(clean);
    if (parts.length < 3) continue;
    const riskLevel = riskOf(parts[0]);
    if (riskLevel === "無") return emptyIssue(category);
    const description = parts[1];
    const recommendation = parts.slice(2).join("，");
    if (["高風險", "中風險", "低風險"].includes(riskLevel) && description.length >= 4 && recommendation.length >= 4 && !PLACEHOLDER_TEXT.test(description + recommendation)) {
      return { category, riskLevel, description, standardReference: STANDARD_REFERENCE, recommendation };
    }
  }
  throw new Error(`${category} 輸出無法解析`);
}

function categoryPrompt(category: Category, context: string, retry = false) {
  return `${retry ? "Answer again. " : ""}Look at the factory photo and inspect ONLY ${category}. Use visible evidence only. Context: ${context}
Output exactly one line: N when no visible problem, otherwise H|problem|action, M|problem|action, or L|problem|action. Write problem and action in Traditional Chinese. No explanation, template, or Markdown.`;
}

async function inferGranularReport(image: any, context: string, photoIndex: number, photoCount: number): Promise<RawReport> {
  const issues: RawIssue[] = [];
  for (let index = 0; index < CATEGORIES.length; index++) {
    const category = CATEGORIES[index];
    const progress = Math.round(((photoIndex + (index + 1) / CATEGORIES.length) / photoCount) * 100);
    post("status", { message: `照片 ${photoIndex + 1} 改用分項辨識：${category}`, progress });
    try {
      const first = await generateText(image, categoryPrompt(category, context), 120);
      issues.push(parseGranularIssue(first, category));
    } catch {
      try {
        const retry = await generateText(image, categoryPrompt(category, context, true), 120);
        issues.push(parseGranularIssue(retry, category));
      } catch {
        issues.push(pendingIssue(category));
      }
    }
  }

  const confirmed = issues.filter((issue) => issue.description !== "無" && issue.riskLevel !== "待確認");
  const pending = issues.filter((issue) => issue.riskLevel === "待確認");
  const assessment = confirmed.length
    ? `照片辨識到 ${confirmed.length} 項可見缺失，主要為：${confirmed.slice(0, 2).map((issue) => issue.description).join("；")}。`
    : pending.length
      ? `照片未取得完整的結構化判定，其中 ${pending.length} 類需要人工複核。`
      : "照片中未辨識到明確的 6S、TPM、職業安全或消防缺失，仍請現場人員複核。";
  return { assessment, issues };
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
      post("status", { message: `照片 ${index + 1} 整體格式未通過，改用四類分項辨識`, progress: Math.round(((index + 0.2) / images.length) * 100) });
      report = await inferGranularReport(image, context, index, images.length);
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
