import { useEffect, useState } from "react";
import { api } from "./api";
import { Spinner } from "./ui.jsx";
import { IconRefresh, IconShieldCheck, IconCheck, IconAlert, IconEye, IconEyeOff, IconZap } from "./icons.jsx";

const PRESETS = [
  { name: "LM Studio", url: "http://127.0.0.1:1234/v1", tip: "Default LM Studio local server" },
  { name: "Ollama", url: "http://127.0.0.1:11434/v1", tip: "Default Ollama endpoint" },
  { name: "Bionic", url: "http://127.0.0.1:1234/v1", tip: "Bionic local engine" },
  { name: "OpenAI compatible", url: "https://api.openai.com/v1", tip: "Requires an API key" },
];

function Row({ title, desc, children, stack }) {
  return (
    <div className={"set-row " + (stack ? "stack" : "")}>
      <div className="set-label">
        <h3>{title}</h3>
        {desc && <p>{desc}</p>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

export default function Settings({ settings, bionic, detect, save, notify }) {
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [timeout, setTimeoutVal] = useState(240);
  const [perTask, setPerTask] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setUrl(settings.base_url || "");
    setApiKey(settings.api_key || "");
    setTimeoutVal(settings.timeout || 240);
    setPerTask(Boolean(settings.review_model || settings.refactor_model));
  }, [settings]);

  if (!settings) {
    return (
      <section className="page">
        <div className="skeleton-list"><div className="skeleton" /><div className="skeleton" /></div>
      </section>
    );
  }

  const dirty =
    url !== (settings.base_url || "") ||
    apiKey !== (settings.api_key || "") ||
    Number(timeout) !== (settings.timeout || 240);

  const connect = async () => {
    setTesting(true);
    setResult(null);
    try {
      await save({ base_url: url, api_key: apiKey, timeout: Number(timeout) });
      const res = await api.testConnection();
      setResult(res);
      await detect();
      notify(res.success ? `Connected in ${res.latency_ms} ms` : `Connection failed: ${res.error}`, res.success ? "success" : "error");
    } catch (e) { notify(e.message, "error"); }
    setTesting(false);
  };

  const togglePerTask = async (on) => {
    setPerTask(on);
    if (!on) { await save({ review_model: "", refactor_model: "" }); notify("Task-specific models turned off", "info"); }
  };

  const taskSelect = (key, label) => (
    <label className="field">
      <span>{label}</span>
      <select value={settings[key] || ""} onChange={(e) => { save({ [key]: e.target.value }); notify(`${label} updated`, "info"); }}>
        <option value="">Same as the default model</option>
        {bionic.models.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    </label>
  );

  const activePreset = PRESETS.find((p) => p.url === url)?.name;

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="dim">Choose where the AI runs and which model it uses.</p>
        </div>
      </header>

      <div className="set-section">
        <h2>Connection</h2>

        <Row title="Provider" desc="Pick a preset or enter any OpenAI-compatible endpoint.">
          <div className="pills" role="group" aria-label="Provider presets">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                className={"pill " + (activePreset === p.name ? "on" : "")}
                title={p.tip}
                onClick={() => setUrl(p.url)}
              >
                {p.name}
              </button>
            ))}
          </div>
        </Row>

        <Row title="Base URL" desc="The server must expose the /v1 API.">
          <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} placeholder="http://127.0.0.1:1234/v1" aria-label="Provider base URL" />
        </Row>

        <Row title="API key" desc="Only needed for hosted providers. Leave empty for local servers.">
          <div className="input-btn">
            <input
              className="mono"
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
              autoComplete="off"
              aria-label="API key"
            />
            <button type="button" className="icon-btn" onClick={() => setShowKey(!showKey)} aria-label={showKey ? "Hide key" : "Show key"}>
              {showKey ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            </button>
          </div>
        </Row>

        <Row title="Request timeout" desc="Local models can be slow on first load.">
          <div className="input-suffix">
            <input type="number" min="10" max="600" value={timeout} onChange={(e) => setTimeoutVal(e.target.value)} aria-label="Timeout in seconds" />
            <span>seconds</span>
          </div>
        </Row>

        <div className="set-actions">
          <div className="conn-status" aria-live="polite">
            {result ? (
              result.success ? (
                <span className="good"><IconCheck size={15} /> Reached {result.base_url} in {result.latency_ms} ms, {result.models_count} model{result.models_count === 1 ? "" : "s"} loaded.</span>
              ) : (
                <span className="bad"><IconAlert size={15} /> {result.error}</span>
              )
            ) : bionic.online ? (
              <span className="good"><i className="dot up" /> Connected, {bionic.models.length} model{bionic.models.length === 1 ? "" : "s"} detected.</span>
            ) : (
              <span className="bad"><i className="dot down" /> Offline. {bionic.error || "Start LM Studio, Ollama or Bionic first."}</span>
            )}
          </div>
          <button className="btn primary" onClick={connect} disabled={testing || bionic.loading}>
            {testing ? <Spinner /> : <IconZap size={15} />}
            {testing ? "Testing…" : dirty ? "Save and test" : "Test connection"}
          </button>
        </div>
      </div>

      <div className="set-section">
        <div className="set-section-head">
          <h2>Models</h2>
          <button className="btn ghost xs" onClick={detect} disabled={bionic.loading}><IconRefresh size={13} /> Refresh</button>
        </div>

        {bionic.models.length === 0 ? (
          <div className="empty compact">
            <h3>No models reported</h3>
            <p>Start your local server and load at least one model, then press Refresh.</p>
          </div>
        ) : (
          <div className="model-list" role="radiogroup" aria-label="Default model">
            {bionic.models.map((m) => {
              const on = settings.model === m;
              return (
                <button
                  key={m}
                  role="radio"
                  aria-checked={on}
                  className={"model-row " + (on ? "on" : "")}
                  onClick={() => { save({ model: m }); notify(`Default model set to ${m}`, "success"); }}
                >
                  <span className="radio" />
                  <span className="model-id">{m}</span>
                  {on && <span className="badge">Default</span>}
                </button>
              );
            })}
          </div>
        )}

        <Row title="Use a different model per task" desc="Assign one model to reviews and another to refactors." >
          <label className="switch">
            <input type="checkbox" checked={perTask} onChange={(e) => togglePerTask(e.target.checked)} aria-label="Specialize models by task" />
            <span className="track" />
          </label>
        </Row>
        {perTask && bionic.models.length > 0 && (
          <div className="grid2">
            {taskSelect("review_model", "Review model")}
            {taskSelect("refactor_model", "Refactor model")}
          </div>
        )}
      </div>

      <div className="set-section">
        <h2>Privacy</h2>
        <div className="privacy">
          <IconShieldCheck size={20} />
          <p>
            With a local provider your code is processed entirely on this computer. No source, file contents or findings
            are sent anywhere. Audit history lives in a SQLite file in the backend folder.
          </p>
        </div>
      </div>
    </section>
  );
}
