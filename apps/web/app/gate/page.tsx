"use client";

import { useState } from "react";

export default function Gate() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    const r = await fetch("/api/gate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }).catch(() => null);
    if (r?.ok) {
      const next = new URLSearchParams(window.location.search).get("next") ?? "/create";
      window.location.href = next.startsWith("/") && !next.startsWith("//") ? next : "/create"; // same-site paths only
      return;
    }
    setError(r ? ((await r.json().catch(() => ({}))).error ?? "Something went wrong.") : "Network problem. Try again.");
    setBusy(false);
  }

  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "#101014", color: "#F5F4F7", fontFamily: "Inter, system-ui, sans-serif" }}>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: 380, background: "#19191F", border: "1px solid #34323D", borderRadius: 20, padding: 28, display: "flex", flexDirection: "column", gap: 16 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>ClipNova<span style={{ color: "#A78BFA" }}>.ai</span></h1>
        <p style={{ margin: 0, color: "#A5A2AF", fontSize: 15, lineHeight: 1.5 }}>This is a private test. Enter the access code you were given.</p>
        <label htmlFor="code" style={{ fontSize: 13, fontWeight: 600, color: "#A5A2AF" }}>Access code</label>
        <input id="code" type="password" autoComplete="off" autoFocus value={code} onChange={(e) => setCode(e.target.value)}
          style={{ minHeight: 48, borderRadius: 10, border: "1px solid #34323D", background: "#101014", color: "#F5F4F7", padding: "0 14px", fontSize: 16 }} />
        {error && <div role="alert" style={{ color: "#F87171", fontSize: 14 }}>{error}</div>}
        <button type="submit" disabled={busy || !code.trim()} style={{ minHeight: 48, borderRadius: 10, border: 0, background: "#A78BFA", color: "#101014", fontSize: 15, fontWeight: 700, cursor: "pointer", opacity: busy || !code.trim() ? 0.6 : 1 }}>
          {busy ? "Checking…" : "Continue"}
        </button>
      </form>
    </main>
  );
}
