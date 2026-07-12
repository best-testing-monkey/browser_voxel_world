// Minimal, dependency-free markdown -> HTML converter plus canvas
// rasterization helpers used by the screen surfaces. Markdown is rendered
// via SVG <foreignObject>; raw SVG content is drawn directly.

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="lk">$1</span>');
}

export function mdToHtml(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let list = null;   // 'ul' | 'ol'
  let code = false;

  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };

  for (const raw of lines) {
    const line = escapeHtml(raw);
    if (line.trim().startsWith('```')) {
      closeList();
      out.push(code ? '</pre>' : '<pre>');
      code = !code;
      continue;
    }
    if (code) { out.push(line + '\n'); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const n = h[1].length;
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      closeList();
      out.push('<hr>');
      continue;
    }
    const q = line.match(/^&gt;\s?(.*)$/);
    if (q) {
      closeList();
      out.push(`<blockquote>${inline(q[1])}</blockquote>`);
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === '') continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (code) out.push('</pre>');
  return out.join('');
}

function screenCss(w) {
  const u = (f) => `${Math.max(9, Math.round(w * f))}px`;
  return `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  .scr { width: 100%; height: 100%; padding: ${u(0.045)};
    background: linear-gradient(160deg, #131722, #0a0d14);
    color: #e8eaf0; font-family: 'Segoe UI', system-ui, sans-serif;
    overflow: hidden; }
  h1 { font-size: ${u(0.075)}; color: #7fc8ff; margin-bottom: ${u(0.02)}; }
  h2 { font-size: ${u(0.058)}; color: #7fc8ff; margin: ${u(0.015)} 0; }
  h3, h4 { font-size: ${u(0.046)}; color: #a8d5ff; margin: ${u(0.014)} 0; }
  p, li, blockquote { font-size: ${u(0.036)}; line-height: 1.45;
    margin: ${u(0.011)} 0; }
  ul, ol { padding-left: ${u(0.05)}; }
  code { background: #232a3a; padding: 0 ${u(0.008)}; border-radius: 4px;
    font-family: monospace; color: #ffd94a; font-size: 0.95em; }
  pre { background: #1a2030; padding: ${u(0.025)}; border-radius: 8px;
    font-family: monospace; font-size: ${u(0.032)}; color: #b9e0a5;
    white-space: pre-wrap; margin: ${u(0.015)} 0; }
  blockquote { border-left: ${u(0.007)} solid #7fc8ff;
    padding-left: ${u(0.025)}; color: #aeb9c6; font-style: italic; }
  hr { border: none; border-top: 1px solid #33405a; margin: ${u(0.02)} 0; }
  b { color: #fff; } .lk { color: #7fc8ff; text-decoration: underline; }
`;
}

function drawSvgOnCanvas(svgText, canvas) {
  return new Promise((resolve) => {
    // data: URL, not a blob URL — Chromium taints canvases drawn from
    // blob-URL SVGs that contain <foreignObject>, which would break the
    // WebGL texture upload. data: URLs stay origin-clean.
    const url = 'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(svgText);
    const img = new Image();
    img.onload = () => {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(true);
    };
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

export function rasterizeMarkdown(md, canvas) {
  const html = mdToHtml(md);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" ` +
    `height="${canvas.height}"><foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" class="scr">` +
    `<style>${screenCss(canvas.width)}</style>${html}</div>` +
    `</foreignObject></svg>`;
  return drawSvgOnCanvas(svg, canvas);
}

export function rasterizeSvg(svgText, canvas) {
  let svg = svgText;
  // Rasterization needs explicit pixel dimensions on the root element.
  const head = svg.slice(0, svg.indexOf('>') + 1);
  if (!/\swidth\s*=/.test(head)) {
    svg = svg.replace(/<svg/i,
      `<svg width="${canvas.width}" height="${canvas.height}"`);
  }
  return drawSvgOnCanvas(svg, canvas);
}
