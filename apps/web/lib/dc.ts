import React from "react";

/**
 * Base class for the generated prototype screens (see tools/dc2react.mjs).
 * The prototype's logic classes implement renderVals(); the generated template() renders them.
 */
export class DCLogic<P = any, S = any> extends React.Component<P, S> {
  renderVals(): any { return {}; }
  template(_v: any): React.ReactNode { return null; }
  override render() { return this.template(this.renderVals()); }
}

/** Parses an inline CSS declaration string (with live values filled in) into a React style object. */
export function css(text: string): React.CSSProperties {
  const out: Record<string, string> = {};
  let cur = "", depth = 0, quote = "";
  const decls: string[] = [];
  for (const ch of text) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === ";" && depth === 0) { decls.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) decls.push(cur);
  for (const d of decls) {
    const i = d.indexOf(":");
    if (i < 0) continue;
    const k = d.slice(0, i).trim();
    const val = d.slice(i + 1).trim();
    if (!k || val === "" || val === "undefined" || val === "null") continue;
    const key = k.startsWith("--") ? k : k.replace(/^-webkit-/, "Webkit-").replace(/^-moz-/, "Moz-").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = val;
  }
  return out as React.CSSProperties;
}
