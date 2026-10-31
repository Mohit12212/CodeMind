async function call(path, opts = {}) {
  let r;
  try {
    r = await fetch("/api" + path, { headers: { "Content-Type": "application/json" }, ...opts });
  } catch {
    throw new Error("Cannot reach the CodeMind backend. Ensure it is running on port 8000.");
  }
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const d = await r.json();
      msg = typeof d.detail === "string" ? d.detail : JSON.stringify(d.detail);
    } catch {}
    throw new Error(msg);
  }
  return (r.headers.get("content-type") || "").includes("json") ? r.json() : r.text();
}
const post = (path, body) => call(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  models: () => call("/models"),
  testConnection: () => call("/models/test"),
  settings: () => call("/settings"),
  saveSettings: (b) => call("/settings", { method: "PUT", body: JSON.stringify(b) }),
  review: (b) => post("/review", b),
  refactor: (b) => post("/refactor", b),
  quickfix: (b) => post("/quickfix", b),
  generateTests: (b) => post("/generate-tests", b),
  explainCode: (b) => post("/explain", b),
  runCode: (b) => post("/run", b),
  runTests: (b) => post("/run-tests", b),
  chatAssistant: (b) => post("/chat-assistant", b),
  generateCommit: (b) => post("/commit-message", b),
  scanProject: (b) => post("/project/scan", b),
  history: () => call("/history"),
  historyItem: (id) => call(`/history/${id}`),
  deleteHistory: (id) => call(`/history/${id}`, { method: "DELETE" }),
  clearHistory: () => call("/history", { method: "DELETE" }),
  report: (id) => call(`/history/${id}/report`),
  sarifReport: (id) => call(`/history/${id}/sarif`),
  htmlReportUrl: (id) => `/api/history/${id}/report-html`,
};
