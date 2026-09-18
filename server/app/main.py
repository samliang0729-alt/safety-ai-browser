import asyncio
import os
from contextlib import asynccontextmanager
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import JSON, Column, DateTime, MetaData, String, Table, delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.sql import func

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+asyncpg://safety:safety@db:5432/safety")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://ollama:11434")
MODEL = os.getenv("OLLAMA_MODEL", "qwen3-vl:4b")
AI_TIMEOUT = float(os.getenv("AI_TIMEOUT_SECONDS", "600"))
ai_slots = asyncio.Semaphore(int(os.getenv("AI_CONCURRENCY", "1")))
engine = create_async_engine(DATABASE_URL, pool_pre_ping=True)
metadata = MetaData()
audits = Table(
    "audits", metadata,
    Column("id", String(64), primary_key=True),
    Column("created_at", DateTime(timezone=True), server_default=func.now(), nullable=False),
    Column("payload", JSON, nullable=False),
)


class IssueResult(BaseModel):
    category: Literal["6S", "TPM", "職業安全", "消防"]
    riskLevel: Literal["高風險", "中風險", "低風險", "待確認", "無"]
    description: str = Field(min_length=1, max_length=300)
    standardReference: str = Field(min_length=1, max_length=200)
    recommendation: str = Field(min_length=1, max_length=300)


class PhotoResult(BaseModel):
    assessment: str = Field(min_length=8, max_length=500)
    issues: list[IssueResult] = Field(min_length=4, max_length=4)

    @field_validator("issues")
    @classmethod
    def require_categories(cls, value: list[IssueResult]):
        expected = {"6S", "TPM", "職業安全", "消防"}
        if {item.category for item in value} != expected:
            raise ValueError("必須包含四個稽核類別")
        return value


class AnalyzeRequest(BaseModel):
    images: list[str] = Field(min_length=1, max_length=4)
    context: str = Field(default="", max_length=1000)

    @field_validator("images")
    @classmethod
    def validate_images(cls, value: list[str]):
        if any(not image.startswith("data:image/") for image in value):
            raise ValueError("僅接受圖片資料")
        if sum(len(image) for image in value) > 24_000_000:
            raise ValueError("圖片總容量超過限制")
        return value


@asynccontextmanager
async def lifespan(_: FastAPI):
    for attempt in range(30):
        try:
            async with engine.begin() as connection:
                await connection.run_sync(metadata.create_all)
            break
        except Exception:
            if attempt == 29:
                raise
            await asyncio.sleep(2)
    yield
    await engine.dispose()


app = FastAPI(title="安巡智控內網 API", version="2.0", lifespan=lifespan)


@app.get("/api/health")
async def health():
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(f"{OLLAMA_URL}/api/tags")
            response.raise_for_status()
            names = [model.get("name", "") for model in response.json().get("models", [])]
        model_ready = any(name == MODEL or name.startswith(f"{MODEL}:") for name in names)
        return {"ready": model_ready, "model": MODEL, "ollama": True, "database": True}
    except Exception:
        return {"ready": False, "model": MODEL, "ollama": False, "database": True}


@app.post("/api/analyze")
async def analyze(request: AnalyzeRequest):
    reports = []
    async with ai_slots:
        for index, image in enumerate(request.images, start=1):
            base64_data = image.split(",", 1)[1]
            prompt = (
                "你是台灣製造業 EHS 稽核員。只根據照片中確實可見內容判定，不可臆測。"
                "以繁體中文輸出，assessment 要具體描述現況。固定檢查 6S、TPM、職業安全、消防四類；"
                "每類若無可見缺失，riskLevel、description、standardReference、recommendation 都填『無』。"
                "若有缺失，改善建議必須是現場可執行動作，法規不確定時填『請由公司 EHS 依現行法規複核』。"
                f"照片編號：{index}。巡檢資訊：{request.context}"
            )
            body = {
                "model": MODEL,
                "stream": False,
                "format": PhotoResult.model_json_schema(),
                "options": {"temperature": 0, "num_predict": 900},
                "messages": [{"role": "user", "content": prompt, "images": [base64_data]}],
            }
            try:
                async with httpx.AsyncClient(timeout=AI_TIMEOUT) as client:
                    response = await client.post(f"{OLLAMA_URL}/api/chat", json=body)
                    response.raise_for_status()
                parsed = PhotoResult.model_validate_json(response.json()["message"]["content"])
                reports.append({"photoIndex": index, **parsed.model_dump()})
            except httpx.HTTPError as exc:
                raise HTTPException(503, "內網 AI 暫時無法回應，請稍後重試") from exc
            except Exception as exc:
                raise HTTPException(422, "AI 回傳格式不完整，請改用主體清楚、光線充足的照片") from exc
    issue_count = sum(item["description"] != "無" for report in reports for item in report["issues"])
    summary = f"本次共分析 {len(reports)} 張照片，辨識 {issue_count} 項需由合格人員複核的事項。AI 結果僅供巡檢輔助。"
    return {"overallSummary": summary, "reports": reports, "model": MODEL}


@app.get("/api/audits")
async def list_audits():
    async with engine.connect() as connection:
        rows = (await connection.execute(select(audits.c.payload).order_by(audits.c.created_at.desc()))).scalars().all()
    return rows


@app.put("/api/audits/{audit_id}")
async def save_audit(audit_id: str, payload: dict):
    if payload.get("id") != audit_id:
        raise HTTPException(400, "稽核編號不一致")
    statement = insert(audits).values(id=audit_id, payload=payload).on_conflict_do_update(
        index_elements=[audits.c.id], set_={"payload": payload}
    )
    async with engine.begin() as connection:
        await connection.execute(statement)
    return {"ok": True}


@app.delete("/api/audits")
async def clear_audits():
    async with engine.begin() as connection:
        await connection.execute(delete(audits))
    return {"ok": True}
