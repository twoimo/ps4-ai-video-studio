import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./pipeline.mjs";

const PUBLIC_DIR = join(ROOT, "public");

const TEMPLATE_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" };

export async function handleTemplatePage(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (url.pathname !== "/template" && url.pathname !== "/template/") return null;
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: TEMPLATE_HEADERS });
  }
  let html = await readFile(join(PUBLIC_DIR, "template", "index.html"), "utf8");
  const jsPath = join(PUBLIC_DIR, "template", "template.js");
  if (existsSync(jsPath)) {
    const info = await stat(jsPath);
    const version = String(Math.floor(info.mtimeMs / 1000));
    html = html.replaceAll("/template/template.js", `/template/template.js?v=${version}`);
  }
  return new Response(html, {
    status: 200,
    headers: TEMPLATE_HEADERS
  });
}
