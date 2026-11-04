"use client";

/**
 * Live Create screen. Extends the screen generated from the prototype and replaces its SIMULATED data
 * (credit maths, scene plan, progress ticks, regenerate) with the real API (/api/*).
 * Everything not overridden here is the prototype's own behaviour, unchanged.
 */
import { detectLanguage } from "@clipnova/core";
import { useState } from "react";
import { Component, STYLES } from "../_screens/Main";

const MODE: Record<string, "t2v" | "i2v" | "v2v"> = { text: "t2v", image: "i2v", video: "v2v" };
const LANG: Record<string, string> = { English: "en", Hindi: "hi", Marathi: "mr", Kannada: "kn", Gujarati: "gu", Bengali: "bn" };
const POLL_MS = 600;
const NOT_ENOUGH = "Not enough credits for this video. Pick a cheaper model, shorten it, or get more credits.";
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);

interface Api { ok: boolean; status: number; data: any }
type Notice = (msg: string) => void;

const STAGES = ["Checking your idea & reserving credits", "Rendering scenes", "Stitching your video"];
const STAGE_INDEX: Record<string, number> = { checking: 0, rendering: 1, finishing: 2, done: 3 };
const STAGE_LABEL: Record<string, string> = { checking: "Checking your idea…", rendering: "Rendering scenes…", finishing: "Stitching your video…", done: "Done" };

function title(idea: string): string {
  const words = idea.trim().split(/\s+/).slice(0, 5).join(" ").replace(/[—–,.;:!?]+$/, "");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Your video";
}

class LiveMain extends Component {
  poll: ReturnType<typeof setTimeout> | null = null;
  quoteTimer: ReturnType<typeof setTimeout> | null = null;
  mounted = false;
  quoteKey = "";
  modelsKey = "";
  pollFails = 0;

  constructor(props: any) {
    super(props);
    this.state = {
      ...this.state,
      live: { me: null, quote: null, quoteError: "", models: null, plan: null, detected: null, planError: "", genError: "", starting: false, job: null, genKey: uid(), regenBusy: {} },
    };
  }

  // The prototype's simulated progress timer is intentionally NOT started here.
  override componentDidMount() {
    this.mounted = true;
    this.refreshAll();
  }
  override componentDidUpdate() {
    this.refreshAll();
  }
  override componentWillUnmount() {
    this.mounted = false;
    this.stopPoll();
    if (this.quoteTimer) clearTimeout(this.quoteTimer);
    super.componentWillUnmount();
  }

  // ---------- plumbing ----------
  setLive(patch: Record<string, unknown>) {
    this.setState((st: any) => ({ live: { ...st.live, ...patch } }));
  }
  notice(msg: string) {
    (this.props.onNotice as Notice | undefined)?.(msg);
  }
  planId(): string {
    return this.props.plan ?? "free";
  }
  async api(path: string, method = "GET", body?: unknown): Promise<Api> {
    const extra = { plan: this.planId(), ...(this.props.region ? { region: this.props.region } : {}) };
    const url = method === "GET" ? `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams(extra as Record<string, string>)}` : path;
    try {
      const res = await fetch(url, {
        method, headers: { "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify({ ...extra, ...(body as object) }),
      });
      const data = await res.json().catch(() => ({ error: "Unexpected response from the server." }));
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: { error: "Network problem. Check your connection and try again." } };
    }
  }

  /** The chosen model, falling back to Auto when the server says it isn't available for this mode, shape or region. */
  effModel(): string {
    const s = this.state;
    const m = s.live.models?.find((x: any) => x.id === s.model);
    return s.model !== "auto" && m && !m.available ? "auto" : s.model;
  }
  inputs() {
    const s = this.state;
    return {
      mode: MODE[s.mode], durationSeconds: s.dur, aspectRatio: s.aspect, modelId: this.effModel(),
      addons: { voice: !!s.voice, music: !!s.music, sfx: !!s.sfx },
    };
  }

  refreshAll() {
    if (!this.mounted) return;
    const s = this.state;
    const mKey = `${MODE[s.mode]}|${s.aspect}`;
    if (mKey !== this.modelsKey) {
      this.modelsKey = mKey;
      this.api(`/api/models?mode=${MODE[s.mode]}&aspect=${encodeURIComponent(s.aspect)}`).then((r) => {
        if (this.mounted && this.modelsKey === mKey && r.ok) this.setLive({ models: r.data.models });
      });
    }
    const qKey = JSON.stringify(this.inputs());
    if (qKey !== this.quoteKey) {
      this.quoteKey = qKey;
      if (this.quoteTimer) clearTimeout(this.quoteTimer);
      this.quoteTimer = setTimeout(async () => {
        const r = await this.api("/api/quote", "POST", JSON.parse(qKey));
        if (!this.mounted || this.quoteKey !== qKey) return;
        const live = this.state.live;
        if (r.ok && r.data.quote) this.setLive({ quote: r.data, quoteError: "", me: { ...(live.me ?? {}), plan: live.me?.plan, balance: r.data.balance } });
        else this.setLive({ quote: null, quoteError: r.data.error ?? "Couldn't get the price.", me: live.me && r.data.balance ? { ...live.me, balance: r.data.balance } : live.me });
      }, 120);
    }
    if (!this.state.live.me && !this.meRequested) {
      this.meRequested = true;
      this.api("/api/me").then((r) => { if (this.mounted && r.ok) this.setLive({ me: r.data }); });
    }
  }
  meRequested = false;

  // ---------- plan ----------
  async doPlan() {
    const s = this.state;
    if (s.live.planning) return;
    this.setLive({ planning: true, planError: "" });
    const r = await this.api("/api/plan", "POST", {
      ...this.inputs(), description: s.idea, creativePrompt: s.prompt, language: LANG[s.lang] ?? "en", category: s.cat,
      mood: s.f.mood, camera: s.f.camera, motion: s.f.motion, background: s.f.background, style: s.f.style, characters: s.f.characters,
    });
    if (!this.mounted) return;
    if (!r.ok) {
      this.setLive({ planning: false, planError: r.data.error ?? "Couldn't plan your video." });
      this.notice(r.data.error ?? "Couldn't plan your video.");
      return;
    }
    this.setState((st: any) => ({ step: "plan", editing: -1, edits: {}, live: { ...st.live, planning: false, plan: r.data.plan, detected: r.data.detected, planError: "", genError: "" } }));
  }

  /** The reviewed plan with the user's scene edits applied. */
  effectivePlan() {
    const { live, edits } = this.state;
    return { ...live.plan, scenes: live.plan.scenes.map((sc: any) => ({ ...sc, action: (edits[sc.index] ?? sc.action).trim() || sc.action })) };
  }

  // ---------- generate ----------
  async doGenerate() {
    const L = this.state.live;
    if (L.starting || !L.plan) return;
    this.setLive({ starting: true, genError: "" });
    const r = await this.api("/api/generations", "POST", { ...this.inputs(), idempotencyKey: L.genKey, creativePlan: this.effectivePlan() });
    if (!this.mounted) return;
    if (!r.ok) {
      this.setLive({ starting: false, genError: r.data.error ?? "Couldn't start your video." });
      this.notice(r.data.error ?? "Couldn't start your video.");
      return;
    }
    this.pollFails = 0;
    this.setState((st: any) => ({ step: "generating", tick: 0, regen: {}, rating: null, live: { ...st.live, starting: false, job: { id: r.data.id, status: "running", stage: "checking", progress: 0, scenes: [] } } }));
    this.startPolling(r.data.id);
  }

  stopPoll() {
    if (this.poll) clearTimeout(this.poll);
    this.poll = null;
  }
  startPolling(id: string) {
    this.stopPoll();
    const tick = async () => {
      const r = await this.api(`/api/generations/${id}`);
      if (!this.mounted) return;
      if (!r.ok) {
        this.pollFails++;
        if (r.status === 404 || this.pollFails > 8) return this.fail("We lost track of your video. If credits were held they are returned automatically.");
      } else {
        this.pollFails = 0;
        const d = r.data;
        const me = this.state.live.me;
        this.setLive({ job: d, me: me ? { ...me, balance: d.balance } : me });
        if (d.status !== "running") return this.finish(d);
      }
      this.poll = setTimeout(tick, POLL_MS);
    };
    this.poll = setTimeout(tick, 150);
  }
  fail(msg: string) {
    this.stopPoll();
    this.setState((st: any) => ({ step: "plan", live: { ...st.live, genError: msg, genKey: uid() } }));
    this.notice(msg);
  }
  finish(d: any) {
    this.stopPoll();
    if (d.status === "succeeded" || d.status === "partial") {
      this.setState((st: any) => ({ step: "done", created: true, live: { ...st.live, genKey: uid() } }));
      if (d.status === "partial") this.notice("Some scenes couldn't be rendered. You were only charged for the scenes that worked — regenerate the rest below.");
      return;
    }
    const code = d.error?.code;
    const reason = d.error?.reasons?.[0];
    const msg = code === "INSUFFICIENT_CREDITS" ? NOT_ENOUGH
      : code === "MODERATION_BLOCKED" ? "This idea can't be turned into a video. Please change it and try again."
      : code === "NO_MODEL" ? "No model is available for this video in your region. Try another model or shape."
      : code === "CONCURRENCY_LIMIT" ? "You already have a video rendering. Wait for it to finish, or upgrade for more at once."
      : d.status === "failed" ? "We couldn't render your video. You were not charged."
      : reason ?? "Something went wrong. You were not charged.";
    this.fail(msg);
  }

  async doRegen(index: number) {
    const L = this.state.live;
    if (L.regenBusy[index]) return;
    this.setLive({ regenBusy: { ...L.regenBusy, [index]: true } });
    const r = await this.api(`/api/generations/${L.job.id}/scenes/${index}/regenerate`, "POST", { idempotencyKey: uid() });
    if (!this.mounted) return;
    if (!r.ok) this.notice(r.status === 402 ? "Not enough credits to regenerate this scene." : r.data.error ?? "Couldn't regenerate this scene.");
    else if (!r.data.ok) this.notice("That scene couldn't be regenerated. You were not charged.");
    const fresh = await this.api(`/api/generations/${L.job.id}`);
    if (!this.mounted) return;
    this.setState((st: any) => ({
      live: { ...st.live, job: fresh.ok ? fresh.data : st.live.job, me: st.live.me && fresh.ok ? { ...st.live.me, balance: fresh.data.balance } : st.live.me, regenBusy: { ...st.live.regenBusy, [index]: false } },
    }));
  }

  // ---------- view model ----------
  override renderVals(): any {
    const v = super.renderVals();
    const s = this.state;
    const L = s.live;
    const plan = L.plan;
    const job = L.job;
    const edits = s.edits ?? {};

    // credits and cost: the server is the source of truth
    const total: number = L.quote?.quote?.total ?? v.total;
    const startBal: number = L.me?.plan?.monthlyCredits ?? v.balance;
    const balance: number = L.me?.balance?.available ?? v.balance;
    const lines: { label: string; credits: number }[] = L.quote?.quote?.lines ?? [];
    const sum = (...labels: string[]) => lines.filter((l) => labels.includes(l.label)).reduce((a, l) => a + l.credits, 0);
    const costLines = L.quote?.quote ? [
      { label: lines[0]?.label ?? "Video", value: `${lines[0]?.credits ?? 0} cr` },
      { label: "Voiceover", value: s.voice ? `${sum("Voiceover")} cr` : "Off" },
      { label: "Music + sound effects", value: s.music || s.sfx ? `${sum("Music", "Sound effects")} cr` : "Off" },
      { label: "Captions", value: s.captions ? "Free" : "Off" },
    ] : v.costLines;
    const cantGen = total > balance;

    const avail = new Map<string, { available: boolean; reason?: string }>((L.models ?? []).map((m: any) => [m.id, m]));
    const byName = new Map<string, boolean>((L.models ?? []).map((m: any) => [m.name, m.available]));
    const models = v.models.map((m: any) => {
      const a = avail.get(m.id);
      return a && !a.available ? { ...m, off: true, note: a.reason ?? m.note } : m;
    });
    const savings = v.savings.filter((x: any) => byName.get(x.name) !== false);

    // plan step
    let start = 0;
    const planned = (plan?.scenes ?? []).map((sc: any, i: number) => {
      const from = start;
      start += sc.durationSeconds;
      const text = edits[i] ?? sc.action;
      const names = (sc.characterIds ?? []).map((id: string) => plan.characters.find((c: any) => c.id === id)?.name).filter(Boolean);
      return {
        index: i, text, num: i + 1, time: `${from}–${start}s`, camera: sc.camera ?? "AI decides", chars: names.join(", ") || "—", audio: (sc.sfx ?? []).join(", ") || "—",
        inputId: `scene-${i}`, editing: s.editing === i, notEditing: s.editing !== i, editLabel: s.editing === i ? "Done" : "Edit",
        toggleEdit: () => this.setState({ editing: s.editing === i ? -1 : i }),
        onText: (e: any) => this.setState({ edits: { ...this.state.edits, [i]: e.target.value } }),
      };
    });
    const detected = L.detected ?? detectLanguage(s.idea);

    // generating + done: real job state
    const jobScenes: any[] = job?.scenes ?? [];
    const textFor = (i: number) => edits[i] ?? plan?.scenes?.[i]?.action ?? jobScenes[i]?.action ?? "";
    const stageIdx = STAGE_INDEX[job?.stage ?? "checking"] ?? 0;
    const stages = STAGES.map((label, i) => ({ label, done: i < stageIdx, active: i === stageIdx, todo: i > stageIdx, fg: i <= stageIdx ? "#F5F4F7" : "#A5A2AF" }));
    const genScenes = jobScenes.map((sc) => {
      const base = { num: sc.index + 1, text: textFor(sc.index), isDone: false, isRetry: false, isRendering: false, status: "Queued", color: "#A5A2AF" };
      if (sc.state === "rendering") return { ...base, isRendering: true, color: "#C4B5FD", status: `Rendering · ${sc.progress}%${sc.modelName ? ` · ${sc.modelName}` : ""}` };
      if (sc.state === "retrying") return { ...base, isRetry: true, color: "#FBBF24", status: `Retrying · attempt ${sc.attempt + 1}` };
      if (sc.state === "done") return { ...base, isDone: true, color: "#34D399", status: sc.attempt > 1 ? `Done (after ${sc.attempt - 1} retr${sc.attempt > 2 ? "ies" : "y"})` : "Done" };
      if (sc.state === "failed") return { ...base, color: "#F87171", status: "Couldn't render · refunded" };
      return base;
    });
    let t0 = 0;
    const doneScenes = jobScenes.map((sc) => {
      const from = t0;
      t0 += sc.durationSeconds;
      const busy = !!L.regenBusy[sc.index] || !!sc.busy;
      return { num: sc.index + 1, text: textFor(sc.index), time: `${from}–${t0}s`, cost: sc.regenCredits, busy, idle: !busy, regen: () => this.doRegen(sc.index) };
    });
    const pct = job?.progress ?? 0;
    const rate = (up: boolean) => () => {
      this.setState({ rating: up ? "up" : "down" });
      if (job?.id) this.api(`/api/generations/${job.id}/rating`, "POST", { value: up ? "up" : "down" });
    };

    return {
      ...v,
      total, costLines, balance, balanceAfter: balance - total, cantGen,
      balancePct: `${Math.max(0, Math.min(100, Math.round((balance / Math.max(1, startBal)) * 100)))}%`,
      balanceAria: `${balance} of ${startBal} credits left`,
      videosLeft: Math.max(0, Math.floor(balance / Math.max(1, total))),
      blockGen: L.genError || (cantGen ? NOT_ENOUGH : ""),
      usedName: L.quote?.modelUsed ?? v.usedName,
      models, savings, hasSavings: savings.length > 0,
      detectedLang: detected.label,
      blockMsg: v.blockMsg || L.planError || (L.quoteError && !v.blockMsg ? L.quoteError : ""),
      cantPlan: !!v.blockMsg || L.planning,
      goPlan: () => this.doPlan(),
      goGenerate: () => this.doGenerate(),
      newVideo: () => {
        this.stopPoll();
        v.newVideo();
        this.setLive({ plan: null, job: null, planError: "", genError: "", genKey: uid(), regenBusy: {} });
      },
      ...(plan ? {
        scenes: planned, sceneCount: planned.length,
        intent: [
          { k: "Genre", v: s.cat }, { k: "Tone", v: s.f.mood || "—" }, { k: "Input language", v: detected.label },
          { k: "Planner", v: "Basic · AI planner coming soon" },
        ],
        characters: plan.characters.map((c: any) => ({ initial: c.name.charAt(0).toUpperCase(), name: c.name, desc: c.appearance })),
        script: s.idea, caption: planned.at(-1)?.text.slice(0, 28) ?? "",
      } : {}),
      jobId: job?.id ? `#${job.id}` : v.jobId,
      pct, pctNum: pct, pctW: `${pct}%`, stageLabel: STAGE_LABEL[job?.stage ?? "checking"],
      stages, genScenes, doneScenes,
      projectTitle: title(s.idea),
      rateUp: rate(true), rateDown: rate(false),
    };
  }
}

function DemoBanner() {
  return (
    <div role="note" style={{ background: "#19191F", borderBottom: "1px solid #FBBF24", color: "#FBBF24", fontSize: 13, fontWeight: 600, padding: "8px 16px", textAlign: "center" }}>
      Demo mode: videos are simulated (no real AI video yet), uploads aren&apos;t stored, and safety checks are off.
    </div>
  );
}

export default function MainLiveScreen(props: { plan?: string; region?: string }) {
  const [notice, setNotice] = useState("");
  const show = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((cur) => (cur === msg ? "" : cur)), 7000);
  };
  return (
    <>
      <style>{STYLES}</style>
      <DemoBanner />
      <LiveMain {...props} onNotice={show} />
      {notice && (
        <div role="alert" style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", maxWidth: "min(560px, calc(100vw - 32px))", background: "#222129", border: "1px solid #FBBF24", color: "#F5F4F7", borderRadius: 12, padding: "12px 16px", fontSize: 14, zIndex: 100, boxShadow: "0 8px 24px rgba(0,0,0,.4)" }}>
          {notice}
        </div>
      )}
    </>
  );
}
