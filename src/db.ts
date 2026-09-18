import type { Audit } from "./types";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`./api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `伺服器錯誤 (${response.status})`);
  }
  return response.json();
}

export async function listAudits(): Promise<Audit[]> {
  return api<Audit[]>("/audits");
}

export async function saveAudit(audit: Audit): Promise<void> {
  await api(`/audits/${encodeURIComponent(audit.id)}`, {
    method: "PUT",
    body: JSON.stringify(audit),
  });
}

export async function clearAudits(): Promise<void> {
  await api("/audits", { method: "DELETE" });
}
