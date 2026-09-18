import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BarChart3, BrainCircuit, Camera, CheckCircle2, ClipboardCheck, Database, Download, LoaderCircle, MonitorCog, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { clearAudits, listAudits, saveAudit } from "./db";
import type { Audit, Issue, IssueStatus, Report, Risk } from "./types";

const LOCATIONS = ["裝配課", "加工課", "生管課", "設備課", "生技課", "總務課", "研發課"];
const WORKFLOWS = ["日常隱患排查", "新專案作業審查", "變更管理稽核"];
const FOCUSES = ["綜合稽核", "專案 6S 稽核", "設備 TPM 專項", "消防逃生專項", "職安衛防護專項"];
const STATUSES: IssueStatus[] = ["已上報", "已派發", "整改中", "待驗證", "已銷項"];
const CATEGORIES = ["6S", "TPM", "職業安全", "消防"] as const;

type WorkerState = { state: "idle" | "loading" | "ready" | "analyzing" | "error"; message: string; progress: number; model: string };

export default function App() {
  const [tab, setTab] = useState<"audit" | "tracking" | "dashboard">("audit");
  const [audits, setAudits] = useState<Audit[]>([]);
  const [workerState, setWorkerState] = useState<WorkerState>({ state: "idle", message: "尚未載入模型", progress: 0, model: "LFM2.5-VL-450M" });
  const [auditorName, setAuditorName] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [workflow, setWorkflow] = useState(WORKFLOWS[0]);
  const [locations, setLocations] = useState<string[]>([]);
  const [responsible, setResponsible] = useState("");
  const [focus, setFocus] = useState(FOCUSES[0]);
  const [notes, setNotes] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [result, setResult] = useState<{ overallSummary: string; reports: Report[] } | null>(null);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    void listAudits().then(setAudits);
    setAuditorName(localStorage.getItem("safety-auditor-name") || "");
    setEmployeeId(localStorage.getItem("safety-employee-id") || "");
    const worker = new Worker(new URL("./ai.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = async ({ data }) => {
      if (data.type === "status") setWorkerState((old) => ({ ...old, state: old.state === "analyzing" ? "analyzing" : "loading", message: data.message, progress: data.progress || 0 }));
      if (data.type === "ready") setWorkerState({ state: "ready", message: "模型已快取，可離線辨識", progress: 100, model: data.model });
      if (data.type === "error") { setWorkerState((old) => ({ ...old, state: "error", message: data.message })); setError(data.message); }
      if (data.type === "result") await finishAudit(data.result, data.model);
    };
    return () => worker.terminate();
  }, []);

  const issues = useMemo(() => audits.flatMap((audit) => audit.reports.flatMap((report) => report.issues.map((issue) => ({ ...issue, audit })))).filter((x) => x.description !== "無"), [audits]);
  const stats = useMemo(() => ({
    total: issues.length,
    open: issues.filter((x) => x.status !== "已銷項").length,
    high: issues.filter((x) => x.riskLevel === "高風險" && x.status !== "已銷項").length,
    overdue: issues.filter((x) => x.status !== "已銷項" && x.dueDate && x.dueDate < today()).length,
  }), [issues]);
  const webGpu = "gpu" in navigator;

  function loadModel() {
    if (!webGpu) return setError("此瀏覽器不支援 WebGPU，請使用最新版 Chrome 或 Edge，並確認硬體加速已開啟。");
    setError(""); setWorkerState((old) => ({ ...old, state: "loading", message: "準備下載模型", progress: 0 }));
    workerRef.current?.postMessage({ type: "load" });
  }

  async function addImages(files: FileList | null) {
    if (!files) return;
    try { const next = await Promise.all([...files].slice(0, 4 - images.length).map(compressImage)); setImages((old) => [...old, ...next]); }
    catch { setError("圖片無法讀取，請改用 JPG、PNG 或 WebP"); }
  }

  function analyze() {
    if (workerState.state !== "ready") return setError("請先下載並載入本機 AI 模型");
    if (!auditorName.trim() || !employeeId.trim() || !locations.length || !responsible.trim() || !images.length) return setError("請完成巡檢人員、工號、地點、負責人與照片欄位");
    setError(""); setResult(null);
    localStorage.setItem("safety-auditor-name", auditorName.trim()); localStorage.setItem("safety-employee-id", employeeId.trim());
    setWorkerState((old) => ({ ...old, state: "analyzing", message: "本機 AI 開始辨識", progress: 0 }));
    const context = `流程:${workflow}；地點:${locations.join("、")}；稽核焦點:${focus}；現場補充:${notes || "無"}`;
    workerRef.current?.postMessage({ type: "analyze", images, context });
  }

  async function finishAudit(raw: any, model: string) {
    try {
      const reports = normalizeReports(raw.reports);
      const audit: Audit = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), auditorName: auditorName.trim(), employeeId: employeeId.trim(), workflowType: workflow, locations, responsiblePerson: responsible.trim(), auditFocus: focus, notes, summary: String(raw.overallSummary || "本機辨識完成"), images, reports, model };
      await saveAudit(audit); setAudits((old) => [audit, ...old]); setResult({ overallSummary: audit.summary, reports });
      setWorkerState((old) => ({ ...old, state: "ready", message: "模型已快取，可離線辨識", progress: 100 }));
    } catch { setError("模型回傳格式不完整，請換一張較清楚的照片重試"); setWorkerState((old) => ({ ...old, state: "ready", message: "模型已就緒", progress: 100 })); }
  }

  async function updateIssue(audit: Audit, issueId: string, patch: Partial<Issue>) {
    const updated = { ...audit, reports: audit.reports.map((r) => ({ ...r, issues: r.issues.map((i) => i.id === issueId ? { ...i, ...patch } : i) })) };
    await saveAudit(updated); setAudits((all) => all.map((a) => a.id === audit.id ? updated : a));
  }

  async function removeAll() {
    if (!confirm("確定刪除這台電腦瀏覽器內的全部稽核紀錄？此動作無法復原。")) return;
    await clearAudits(); setAudits([]); setResult(null);
  }

  function exportCsv() {
    const q = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const head = ["稽核日期", "巡檢人員", "工號", "地點", "照片", "類別", "風險", "缺失", "改善對策", "負責人", "期限", "狀態"];
    const rows = issues.map(({ audit, ...i }) => [audit.createdAt, audit.auditorName, audit.employeeId, audit.locations.join("、"), i.photoIndex, i.category, i.riskLevel, i.description, i.recommendation, i.assignee, i.dueDate, i.status].map(q).join(","));
    download(new Blob(["\uFEFF" + [head.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" }), `安全缺失_${today()}.csv`);
  }

  return <main>
    <header><div className="brand"><span>安</span><div><b>安巡智控</b><small>GitHub Pages · 瀏覽器本機 AI · v1.2</small></div></div><div className={`status ${workerState.state}`}><BrainCircuit size={17} />{workerState.message}</div></header>
    {(workerState.state === "loading" || workerState.state === "analyzing") && <div className="progress"><span style={{ width: `${Math.max(4, workerState.progress)}%` }} /></div>}
    <div className="shell">
      <nav>{[["audit", Plus, "建立稽核"], ["tracking", ClipboardCheck, "缺失追蹤"], ["dashboard", BarChart3, "管理看板"]].map(([key, Icon, label]: any) => <button className={tab === key ? "active" : ""} onClick={() => setTab(key)} key={key}><Icon size={18} />{label}</button>)}<div className="nav-stats"><small>未結案</small><strong>{stats.open}</strong><small>逾期</small><strong className="danger">{stats.overdue}</strong></div></nav>
      <section className="content">
        {error && <div className="error"><AlertTriangle size={18} />{error}</div>}
        {!webGpu && <div className="warning"><MonitorCog /><div><b>目前瀏覽器未啟用 WebGPU</b><p>請使用最新版 Chrome／Edge 並開啟硬體加速。本系統不會把照片傳出電腦。</p></div></div>}
        {tab === "audit" && <div className="audit-grid"><section className="panel form"><Title step="01" text="巡檢資料" /><div className="two"><Field label="巡檢人員"><input value={auditorName} onChange={(e) => setAuditorName(e.target.value)} placeholder="姓名" /></Field><Field label="工號"><input value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} placeholder="員工編號" /></Field></div><Field label="管理流程"><select value={workflow} onChange={(e) => setWorkflow(e.target.value)}>{WORKFLOWS.map((x) => <option key={x}>{x}</option>)}</select></Field><Field label="地點區域"><div className="chips">{LOCATIONS.map((x) => <button className={locations.includes(x) ? "selected" : ""} onClick={() => setLocations((old) => old.includes(x) ? old.filter((v) => v !== x) : [...old, x])} key={x}>{x}</button>)}</div></Field><Field label="區域負責人"><input value={responsible} onChange={(e) => setResponsible(e.target.value)} placeholder="姓名／單位" /></Field><Field label="稽核焦點"><select value={focus} onChange={(e) => setFocus(e.target.value)}>{FOCUSES.map((x) => <option key={x}>{x}</option>)}</select></Field><Field label="現場補充"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="設備編號、作業狀態等" /></Field><Title step="02" text="現場照片" /><input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void addImages(e.target.files)} /><button className="upload" onClick={() => fileRef.current?.click()} disabled={images.length >= 4}><Camera /><b>拍照或選擇照片</b><small>最多 4 張；壓縮後僅在本機分析</small></button>{images.length > 0 && <div className="thumbs">{images.map((src, i) => <div key={i}><img src={src} alt={`照片 ${i + 1}`} /><button onClick={() => setImages((old) => old.filter((_, x) => x !== i))}><Trash2 size={15} /></button></div>)}</div>}<button className="primary" onClick={workerState.state === "idle" || workerState.state === "error" ? loadModel : analyze} disabled={!webGpu || workerState.state === "loading" || workerState.state === "analyzing"}>{workerState.state === "loading" || workerState.state === "analyzing" ? <LoaderCircle className="spin" /> : <BrainCircuit />}{workerState.state === "idle" || workerState.state === "error" ? "下載本機 AI 模型" : "開始本機 AI 辨識"}</button></section><section className="panel result">{result ? <Result result={result} /> : <Empty state={workerState.state} />}</section></div>}
        {tab === "tracking" && <section className="panel"><div className="panel-head"><div><h2>缺失閉環追蹤</h2><p>資料只保存在目前瀏覽器，共 {issues.length} 項</p></div><button onClick={exportCsv}><Download size={17} />匯出 CSV</button></div><div className="table-wrap"><table><thead><tr><th>風險</th><th>地點／缺失</th><th>改善負責人</th><th>期限</th><th>狀態</th></tr></thead><tbody>{issues.map(({ audit, ...i }) => <tr key={i.id}><td><RiskBadge level={i.riskLevel} /><small>{i.category}</small></td><td><b>{audit.locations.join("、")} · 照片{i.photoIndex}</b><p>{i.description}</p><em>對策：{i.recommendation}</em></td><td><input defaultValue={i.assignee} onBlur={(e) => void updateIssue(audit, i.id, { assignee: e.target.value })} placeholder="指派人員" /></td><td><input type="date" defaultValue={i.dueDate} onChange={(e) => void updateIssue(audit, i.id, { dueDate: e.target.value })} /></td><td><select value={i.status} onChange={(e) => void updateIssue(audit, i.id, { status: e.target.value as IssueStatus })}>{STATUSES.map((x) => <option key={x}>{x}</option>)}</select></td></tr>)}</tbody></table>{!issues.length && <div className="empty-row">尚無缺失紀錄</div>}</div></section>}
        {tab === "dashboard" && <div className="dashboard"><div className="cards"><Stat icon={ClipboardCheck} label="累計缺失" value={stats.total} /><Stat icon={ShieldCheck} label="未結案" value={stats.open} /><Stat icon={AlertTriangle} label="高風險未結" value={stats.high} danger /><Stat icon={Database} label="本機稽核" value={audits.length} /></div><section className="panel privacy"><BrainCircuit /><div><h3>完全在瀏覽器本機執行</h3><p>網站程式由 GitHub Pages 提供；AI 模型第一次下載後保存在瀏覽器快取。照片與稽核紀錄不會上傳到 GitHub或任何 API。</p></div></section><section className="panel"><div className="panel-head"><div><h2>最近稽核</h2><p>IndexedDB 本機資料</p></div><button className="destructive" onClick={() => void removeAll()}><Trash2 size={17} />清除本機資料</button></div><div className="recent">{audits.map((a) => <article key={a.id}><b>{a.locations.join("、")}</b><span>{a.workflowType}</span><p>{a.summary}</p><small>{formatDate(a.createdAt)} · {a.auditorName} ({a.employeeId}) · {a.images.length} 張</small></article>)}</div></section></div>}
      </section>
    </div>
  </main>;
}

function normalizeReports(raw: any[]): Report[] {
  if (!Array.isArray(raw)) throw new Error("invalid reports");
  const placeholders = /80\s*字|整體評估|請填|請描述|或無|高風險\s*[|｜/]\s*中風險|法規或內部|對照片現況|具體(?:可見)?(?:判定|缺失|改善|動作)/;
  return raw.map((r, idx) => {
    const assessment = String(r.assessment || "").trim();
    if (assessment.length < 8 || placeholders.test(assessment)) throw new Error("AI 評估內容未通過品質檢查");
    return { photoIndex: idx + 1, assessment, issues: CATEGORIES.map((category) => {
      const found = Array.isArray(r.issues) ? r.issues.find((x: any) => String(x.category).includes(category === "職業安全" ? "職業" : category)) : null;
      const description = String(found?.description || "無").trim();
      const recommendation = String(found?.recommendation || "無").trim();
      if (placeholders.test(description) || placeholders.test(recommendation)) throw new Error("AI 改善內容未通過品質檢查");
      return { id: crypto.randomUUID(), photoIndex: idx + 1, category, riskLevel: normalizeRisk(found?.riskLevel), description, standardReference: String(found?.standardReference || "無"), recommendation, assignee: "", dueDate: "", status: "已上報" };
    }) };
  });
}
function normalizeRisk(value: unknown): Risk { const text = String(value || "無"); return text.includes("高") ? "高風險" : text.includes("中") ? "中風險" : text.includes("低") ? "低風險" : text.includes("待") ? "待確認" : "無"; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field"><b>{label}</b>{children}</label>; }
function Title({ step, text }: { step: string; text: string }) { return <div className="title"><span>{step}</span><h2>{text}</h2></div>; }
function RiskBadge({ level }: { level: Risk }) { return <span className={`risk ${level[0]}`}>{level}</span>; }
function Empty({ state }: { state: WorkerState["state"] }) { return <div className="empty"><BrainCircuit size={42} /><h2>{state === "loading" ? "正在下載本機 AI" : state === "analyzing" ? "正在本機辨識照片" : "尚未建立本次稽核"}</h2><p>第一次需下載模型；完成後模型會保存在瀏覽器快取，照片不會離開這台電腦。</p></div>; }
function Result({ result }: { result: { overallSummary: string; reports: Report[] } }) { const count = result.reports.flatMap((r) => r.issues).filter((i) => i.description !== "無").length; return <div><div className="success"><CheckCircle2 /><div><h2>本機稽核完成</h2><p>辨識 {count} 項需複核事項</p></div></div><div className="summary"><small>綜合判定</small><p>{result.overallSummary}</p></div>{result.reports.map((r) => <article className="report" key={r.photoIndex}><h3>照片 {r.photoIndex}</h3><p>{r.assessment}</p>{r.issues.filter((i) => i.description !== "無").map((i) => <div className="issue" key={i.category}><div><RiskBadge level={i.riskLevel} /><b>{i.category}</b></div><p>{i.description}</p><em>改善：{i.recommendation}</em><small>依據：{i.standardReference}</small></div>)}</article>)}</div>; }
function Stat({ icon: Icon, label, value, danger }: any) { return <div className={`stat-card ${danger ? "danger-card" : ""}`}><Icon /><small>{label}</small><strong>{value}</strong></div>; }
function today() { return new Date().toISOString().slice(0, 10); }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function download(blob: Blob, name: string) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href); }
async function compressImage(file: File): Promise<string> { const bitmap = await createImageBitmap(file); const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height)); const canvas = document.createElement("canvas"); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale); canvas.getContext("2d", { alpha: false })!.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close(); return canvas.toDataURL("image/jpeg", .75); }
