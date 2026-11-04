#!/usr/bin/env node
/**
 * Converts the approved prototype screens (design/prototype/*.dc.html, the Design-canvas "dc" format)
 * into React client components under apps/web/app/_screens/.
 *
 * - The template (<x-dc>) becomes a JSX method. Holes are dotted lookups into renderVals().
 * - <sc-for>/<sc-if> become .map()/conditionals.
 * - The prototype's own logic class is copied verbatim (it only uses state, setState, props and timers).
 * - Uploaded images (/_blob/<id>) are mapped to apps/web/public/prototype/<id>.<ext>.
 *
 * Re-run after changing a prototype file:  node tools/dc2react.mjs
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parseDocument } from "htmlparser2";
import { decodeHTML } from "entities";

const SRC = "design/prototype";
const OUT = "apps/web/app/_screens";
const ASSETS = "apps/web/public/prototype";
const ROUTES = {
  "Landing.dc.html": "/", "Main.dc.html": "/create", "Library.dc.html": "/library",
  "Pricing.dc.html": "/pricing", "ModelLab.dc.html": "/model-lab", "Admin.dc.html": "/admin",
};

const assetExt = Object.fromEntries(readdirSync(ASSETS).map((f) => [f.split(".")[0], f.split(".").slice(1).join(".")]));
const mapAssets = (s) => s.replace(/\/_blob\/([a-f0-9]{32})/g, (m, id) => (assetExt[id] ? `/prototype/${id}.${assetExt[id]}` : m));

const VOID = new Set(["img", "br", "hr", "input", "meta", "link", "source", "wbr"]);
const BOOL_ATTRS = new Set(["disabled", "checked", "hidden", "required", "readonly", "autofocus", "multiple", "selected", "controls", "autoplay", "loop", "muted", "playsinline"]);
const ATTR_MAP = {
  class: "className", for: "htmlFor", tabindex: "tabIndex", colspan: "colSpan", rowspan: "rowSpan", maxlength: "maxLength",
  readonly: "readOnly", autocomplete: "autoComplete", autofocus: "autoFocus", "accept-charset": "acceptCharset",
  "xlink:href": "href", contenteditable: "contentEditable", spellcheck: "spellCheck", crossorigin: "crossOrigin",
  playsinline: "playsInline", srcset: "srcSet", datetime: "dateTime", enterkeyhint: "enterKeyHint",
};
const SVG_KEBAB = new Set(["stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity",
  "stroke-miterlimit", "fill-opacity", "fill-rule", "clip-rule", "clip-path", "stop-color", "stop-opacity", "text-anchor", "font-size",
  "font-weight", "font-family", "marker-end", "marker-start", "marker-mid", "dominant-baseline", "alignment-baseline", "letter-spacing", "text-decoration"]);
const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const TABLEISH = new Set(["table", "thead", "tbody", "tfoot", "tr", "ul", "ol", "select", "colgroup", "svg", "defs"]);

const HOLE = /\{\{\s*([^}]*?)\s*\}\}/g;
const hasHole = (s) => /\{\{/.test(s);

/** Resolves a hole path to a JS expression, given loop variables in scope. */
function expr(path, scope) {
  path = path.trim();
  if (path === "true" || path === "false" || path === "null" || /^-?\d+(\.\d+)?$/.test(path)) return path;
  const q = path.match(/^(["'])(.*)\1$/);
  if (q) return JSON.stringify(q[2]);
  if (path.startsWith("$")) {
    const [name, ...rest] = path.split(".");
    const loop = scope.at(-1);
    if (name === "$index" && loop) return rest.length ? `${loop.idx}.${rest.join(".")}` : loop.idx;
    throw new Error(`unsupported hole ${path}`);
  }
  const parts = path.split(".");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parts[0])) throw new Error(`unsupported hole "${path}" (expressions are not allowed)`);
  const inScope = [...scope].reverse().find((s) => s.name === parts[0]);
  const root = inScope ? parts[0] : `v.${parts[0]}`;
  return [root, ...parts.slice(1)].join("?.");
}

/** "a {{x}} b" -> template literal source; a pure hole -> the bare expression. */
function interpolate(str, scope) {
  const m = str.match(/^\{\{\s*([^}]*?)\s*\}\}$/);
  if (m) return expr(m[1], scope);
  const body = str.replace(/[`\\]|\$\{/g, (c) => "\\" + c).replace(HOLE, (_, p) => "${" + expr(p, scope) + "}");
  return "`" + body + "`";
}

function splitDecls(css) {
  const out = []; let cur = ""; let depth = 0; let quote = "";
  for (const ch of css) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++; if (ch === ")") depth--;
    if (ch === ";" && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
function cssToObject(css) {
  const o = {};
  for (const d of splitDecls(css)) {
    const i = d.indexOf(":");
    if (i < 0) continue;
    let k = d.slice(0, i).trim(); const val = d.slice(i + 1).trim();
    if (!k) continue;
    k = k.startsWith("--") ? k : k.startsWith("-ms-") ? "ms" + camel(k.slice(3)) : camel(k.replace(/^-webkit-/, "Webkit-").replace(/^-moz-/, "Moz-"));
    o[k] = val.replace(/\s*!important\s*$/i, "") + (/!important/i.test(val) ? " !important" : "");
  }
  return o;
}

function attrToJsx(tag, name, value, scope) {
  if (name.startsWith("hint-")) return "";
  const lname = name;
  if (lname === "style") {
    if (!hasHole(value)) return `style={${JSON.stringify(cssToObject(value))}}`;
    return `style={css(${interpolate(value, scope)})}`;
  }
  let jsxName = ATTR_MAP[lname] ?? (SVG_KEBAB.has(lname) ? camel(lname) : lname);
  if (/^on[A-Z]/.test(jsxName) === false && /^on[a-z]/.test(jsxName)) jsxName = "on" + jsxName[2].toUpperCase() + jsxName.slice(3);
  // React's onChange is the native input event for form controls.
  if (jsxName === "onInput" && ["input", "textarea", "select"].includes(tag)) jsxName = "onChange";
  if (tag === "a" && jsxName === "href" && ROUTES[value]) return `href=${JSON.stringify(ROUTES[value])}`;
  if (value === "" && BOOL_ATTRS.has(lname)) return jsxName;
  if (hasHole(value)) return `${jsxName}={${interpolate(value, scope)}}`;
  const decoded = decodeHTML(value);
  return `${jsxName}={${JSON.stringify(decoded)}}`;
}

function nodeToJsx(node, scope, parentTag) {
  if (node.type === "comment") return "";
  if (node.type === "text") {
    const raw = decodeHTML(node.data);
    if (!raw.trim()) {
      if (raw.includes("\n") || TABLEISH.has(parentTag)) return "";
      return `{" "}`;
    }
    const parts = node.data.split(HOLE); // [text, hole, text, hole, ...]
    return parts.map((p, i) => (i % 2 ? `{${expr(p, scope)}}` : p ? `{${JSON.stringify(decodeHTML(p))}}` : "")).join("");
  }
  if (node.type !== "tag" && node.type !== "script" && node.type !== "style") return "";
  const tag = node.name;
  const attrs = node.attribs;

  if (tag === "sc-for") {
    const list = interpolate(attrs.list, scope);
    const name = attrs.as ?? "item";
    const idx = `i${scope.length}`;
    const inner = node.children.map((c) => nodeToJsx(c, [...scope, { name, idx }], parentTag)).join("");
    return `{(${list} ?? []).map((${name}: any, ${idx}: number) => (<Fragment key={${idx}}>${inner}</Fragment>))}`;
  }
  if (tag === "sc-if") {
    const cond = interpolate(attrs.value, scope);
    const inner = node.children.map((c) => nodeToJsx(c, scope, parentTag)).join("");
    return `{(${cond}) ? (<>${inner}</>) : null}`;
  }
  if (tag.startsWith("dc-") || tag.startsWith("x-")) throw new Error(`unsupported tag <${tag}>`);

  const attrSrc = Object.entries(attrs).map(([k, v]) => attrToJsx(tag, k, v, scope)).filter(Boolean).join(" ");
  const internalLink = tag === "a" && ROUTES[attrs.href];
  const jsxTag = internalLink ? "Link" : tag;
  const kids = node.children.map((c) => nodeToJsx(c, scope, tag)).join("");
  const open = `<${jsxTag}${attrSrc ? " " + attrSrc : ""}`;
  if (VOID.has(tag) || !kids) return `${open} />`;
  return `${open}>${kids}</${jsxTag}>`;
}

function convert(file) {
  const raw = mapAssets(readFileSync(join(SRC, file), "utf8"));
  const helmet = (raw.match(/<helmet>([\s\S]*?)<\/helmet>/) ?? [, ""])[1];
  const styles = [...helmet.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1].trim()).join("\n");
  const logic = (raw.match(/<script type="text\/x-dc" data-dc-script[^>]*>([\s\S]*?)<\/script>/) ?? [, ""])[1].trim();
  const tpl = (raw.match(/<x-dc>([\s\S]*?)<\/x-dc>/) ?? [, ""])[1].replace(/<helmet>[\s\S]*?<\/helmet>/, "");
  if (!logic.includes("class Component extends DCLogic")) throw new Error(`${file}: logic class not found`);
  const doc = parseDocument(tpl, { lowerCaseTags: false, lowerCaseAttributeNames: false, recognizeSelfClosing: true, decodeEntities: false });
  const jsx = doc.children.map((c) => nodeToJsx(c, [], "")).join("");
  const name = basename(file, ".dc.html");
  const src = `// GENERATED by tools/dc2react.mjs from design/prototype/${file}. Do not edit; change the prototype and re-run.
// @ts-nocheck
"use client";
import { Fragment } from "react";
import Link from "next/link";
import { DCLogic, css } from "@/lib/dc";

const STYLES = ${JSON.stringify(styles)};

/* ---- prototype logic (verbatim) ---- */
${logic}

Component.prototype.template = function (v) {
  return (<>
${jsx}
  </>);
};

export { Component, STYLES };

export default function ${name}Screen(props) {
  return (<>
    <style>{STYLES}</style>
    <Component {...props} />
  </>);
}
`;
  return { name, src };
}

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(SRC).filter((f) => f.endsWith(".dc.html")).sort()) {
  const { name, src } = convert(f);
  writeFileSync(join(OUT, `${name}.tsx`), src);
  console.log(`${f} -> ${OUT}/${name}.tsx (${src.length} bytes)`);
}
