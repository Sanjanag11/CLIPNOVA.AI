import type { GenerationStatus, WorkflowEvent } from "./workflow";

export type SceneState = "queued" | "rendering" | "retrying" | "done" | "failed";

export interface JobScene {
  index: number;
  state: SceneState;
  /** 0-100 for the current attempt. */
  progress: number;
  attempt: number;
  modelId?: string;
  errorCode?: string;
}

export interface JobView {
  generationId: string;
  status: GenerationStatus;
  stage: "checking" | "rendering" | "finishing" | "done";
  scenes: JobScene[];
}

export function newJob(generationId: string, sceneCount: number): JobView {
  return {
    generationId, status: "running", stage: "checking",
    scenes: Array.from({ length: sceneCount }, (_, index) => ({ index, state: "queued" as const, progress: 0, attempt: 0 })),
  };
}

/** Folds a workflow event into the live job view (mutates and returns it). */
export function applyEvent(job: JobView, e: WorkflowEvent): JobView {
  if (e.generationId !== job.generationId) return job;
  const scene = "index" in e ? job.scenes.find((s) => s.index === e.index) : undefined;
  switch (e.type) {
    case "status":
      job.status = e.status;
      if (e.status !== "running") job.stage = "done";
      break;
    case "stage":
      job.stage = e.stage;
      break;
    case "scene_started":
      if (scene) Object.assign(scene, { state: "rendering", progress: 0, attempt: e.attempt, modelId: e.modelId, errorCode: undefined });
      break;
    case "scene_progress":
      if (scene) scene.progress = Math.max(0, Math.min(100, Math.round(e.fraction * 100)));
      break;
    case "scene_attempt_failed":
      if (scene) Object.assign(scene, { state: "retrying", progress: 0, errorCode: e.code });
      break;
    case "scene_done":
      if (scene) Object.assign(scene, e.ok ? { state: "done", progress: 100, errorCode: undefined } : { state: "failed", progress: 0 });
      break;
  }
  return job;
}

/** Overall 0-100 progress: a small share for checks, most for rendering, a little for finishing. */
export function jobProgress(job: JobView): number {
  if (job.stage === "done") return 100;
  if (job.stage === "checking") return 3;
  const rendering = job.scenes.length ? job.scenes.reduce((a, s) => a + (s.state === "done" || s.state === "failed" ? 100 : s.progress), 0) / job.scenes.length : 100;
  const pct = 5 + 0.9 * rendering;
  return Math.min(job.stage === "finishing" ? 98 : 95, Math.round(pct));
}
