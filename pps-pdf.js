/* PPS ICB — rendu PDF dans le navigateur (port de tools/gen_pps.py sur jsPDF).
 *
 * API : PpsPdf.loadFonts() -> Promise ; PpsPdf.render(proto, patient) -> jsPDF doc
 */
(function (global) {
  "use strict";

  const mm = 72 / 25.4;
  const W = 595.28, H = 841.89; // A4 en points
  const ML = 10 * mm, MR = 10 * mm, MT = 9 * mm, MB = 8 * mm;
  const CW = W - ML - MR;

  const NAVY = "#0B3D5C", TEAL = "#1A6B8A", ACCENT = "#C45C26", SOFT = "#E8F1F5", SOFT2 = "#F4F7F8";
  const LINE = "#C5D4DC", ALERT = "#8B1E1E", ALERTBG = "#F8EAEA", OK = "#1E6B3A", GOLD = "#F3E6C8";
  const BLACK = "#000000", WHITE = "#FFFFFF";

  // ---------- polices ----------
  const FONT_FILES = {
    DejaVu: "fonts/DejaVuSans.ttf",
    DejaVuBold: "fonts/DejaVuSans-Bold.ttf",
    DejaVuOblique: "fonts/DejaVuSans-Oblique.ttf",
    DejaVuBoldOblique: "fonts/DejaVuSans-BoldOblique.ttf",
  };
  const STYLE = { DejaVu: "normal", DejaVuBold: "bold", DejaVuOblique: "italic", DejaVuBoldOblique: "bolditalic" };
  const LOGO_FILE = "logo-icb.png";
  const LOGO_PX = 256; // taille d’embarquement (réduit le poids du PDF)
  let fontData = null; // nom -> base64
  let logo = null;     // {dataUrl, ratio} ou null si absent

  async function loadLogo(base) {
    try {
      const r = await fetch(base + LOGO_FILE);
      if (!r.ok) return null;
      const url = URL.createObjectURL(await r.blob());
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error("logo illisible"));
        im.src = url;
      });
      URL.revokeObjectURL(url);
      const ratio = img.naturalWidth / img.naturalHeight;
      const cv = document.createElement("canvas");
      cv.width = LOGO_PX;
      cv.height = Math.round(LOGO_PX / ratio);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      return { dataUrl: cv.toDataURL("image/png"), ratio };
    } catch (_) {
      return null;
    }
  }

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  async function loadFonts(base = "") {
    if (fontData) return fontData;
    const data = {};
    for (const [name, path] of Object.entries(FONT_FILES)) {
      try {
        const r = await fetch(base + path);
        if (r.ok) data[name] = toBase64(await r.arrayBuffer());
      } catch (_) { /* police optionnelle absente */ }
    }
    if (!data.DejaVu || !data.DejaVuBold || !data.DejaVuOblique) {
      throw new Error("Polices DejaVu introuvables (dossier fonts/). Servez le site via HTTP, pas en file://.");
    }
    fontData = data;
    logo = await loadLogo(base);
    return fontData;
  }

  function newDoc() {
    const { jsPDF } = global.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
    for (const [name, b64] of Object.entries(fontData)) {
      doc.addFileToVFS(name + ".ttf", b64);
      doc.addFont(name + ".ttf", "DejaVu", STYLE[name]);
    }
    doc.setFont("DejaVu", "normal");
    return doc;
  }

  // ---------- canvas façon ReportLab (origine en bas à gauche) ----------
  class Canvas {
    constructor(doc) {
      this.doc = doc;
      this.font = "DejaVu";
      this.size = 10;
      this.fill = BLACK;
    }
    _apply(font, size) {
      const style = fontData[font] ? STYLE[font] : (font === "DejaVuBoldOblique" ? "bold" : "normal");
      this.doc.setFont("DejaVu", style);
      this.doc.setFontSize(size);
    }
    setFont(font, size) { this.font = font; this.size = size; this._apply(font, size); }
    setFillColor(c) { this.fill = c; this.doc.setFillColor(c); this.doc.setTextColor(c); }
    setStrokeColor(c) { this.doc.setDrawColor(c); }
    setLineWidth(w) { this.doc.setLineWidth(w); }
    stringWidth(t, font, size) {
      this._apply(font, size);
      const w = this.doc.getTextWidth(t);
      this._apply(this.font, this.size);
      return w;
    }
    drawString(x, y, t) { this.doc.text(t, x, H - y); }
    drawRightString(x, y, t) { this.doc.text(t, x, H - y, { align: "right" }); }
    drawCentredString(x, y, t) { this.doc.text(t, x, H - y, { align: "center" }); }
    line(x1, y1, x2, y2) { this.doc.line(x1, H - y1, x2, H - y2); }
    rect(x, y, w, h, { fill = false, stroke = false } = {}) {
      this.doc.rect(x, H - y - h, w, h, fill && stroke ? "FD" : fill ? "F" : "S");
    }
    roundedRect(x, y, w, h, r, { fill = null, stroke = null, sw = 0.4 } = {}) {
      if (fill) this.doc.setFillColor(fill);
      if (stroke) { this.doc.setDrawColor(stroke); this.doc.setLineWidth(sw); }
      this.doc.roundedRect(x, H - y - h, w, h, r, r, fill && stroke ? "FD" : fill ? "F" : "S");
      this.doc.setFillColor(this.fill);
    }
    showPage() { this.doc.addPage(); }
    image(dataUrl, x, y, w, h) { this.doc.addImage(dataUrl, "PNG", x, H - y - h, w, h); }
  }

  function wrap(c, text, font, size, maxW) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    for (const w of words) {
      const trial = (cur + " " + w).trim();
      if (c.stringWidth(trial, font, size) <= maxW) cur = trial;
      else { if (cur) lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  }

  // ---------- Markdown léger ----------
  // run = {t, b, i, code, strike}
  const MD_INLINE = /\\([\\*_`~\[\]#>+-])|(\*\*|__)(.+?)\2|`([^`]+)`|~~(.+?)~~|(\*|_)([^*_]+?)\6|\[([^\]]+)\]\([^)]*\)/g;
  const MD_BLOCK = /^(#{1,3})\s+|^([-*+])\s+|^(\d+)[.)]\s+|^(>)\s*/;

  const run = (t, o = {}) => ({ t, b: false, i: false, code: false, strike: false, ...o });

  function mdInline(text) {
    const runs = [];
    let pos = 0;
    for (const m of String(text).matchAll(MD_INLINE)) {
      if (m.index > pos) runs.push(run(text.slice(pos, m.index)));
      if (m[1] !== undefined) runs.push(run(m[1]));
      else if (m[3] !== undefined) for (const r of mdInline(m[3])) runs.push({ ...r, b: true });
      else if (m[4] !== undefined) runs.push(run(m[4], { code: true }));
      else if (m[5] !== undefined) for (const r of mdInline(m[5])) runs.push({ ...r, strike: true });
      else if (m[7] !== undefined) for (const r of mdInline(m[7])) runs.push({ ...r, i: true });
      else if (m[8] !== undefined) runs.push(run(m[8]));
      pos = m.index + m[0].length;
    }
    if (pos < text.length) runs.push(run(text.slice(pos)));
    return runs;
  }

  function mdBlock(line) {
    const m = MD_BLOCK.exec(line);
    if (!m) return ["p", line];
    const rest = line.slice(m[0].length);
    if (m[1]) return ["h", rest];
    if (m[2]) return ["sub", rest];
    if (m[3]) return ["num", rest];
    return ["quote", rest];
  }

  const textRuns = (text, md) => (md ? mdInline(String(text || "")) : [run(String(text || ""))]);

  function fontFor(bold, italic) {
    if (bold && italic) return fontData.DejaVuBoldOblique ? "DejaVuBoldOblique" : "DejaVuBold";
    if (bold) return "DejaVuBold";
    if (italic) return "DejaVuOblique";
    return "DejaVu";
  }

  function richWrap(c, runs, size, maxW, baseBold = false, baseItalic = false) {
    const pieces = [];
    for (const r of runs) {
      const font = fontFor(r.b || baseBold, r.i || baseItalic);
      for (const tok of r.t.match(/\s+|\S+/g) || []) pieces.push({ tok, font, code: r.code, strike: r.strike });
    }
    const lines = [];
    let cur = [], curW = 0;
    const trimEnd = () => { while (cur.length && /^\s+$/.test(cur[cur.length - 1].tok)) cur.pop(); };
    for (const p of pieces) {
      const w = c.stringWidth(p.tok, p.font, size);
      if (/^\s+$/.test(p.tok)) { if (cur.length) { cur.push(p); curW += w; } continue; }
      if (cur.length && curW + w > maxW) { trimEnd(); lines.push(cur); cur = []; curW = 0; }
      cur.push(p); curW += w;
    }
    trimEnd();
    if (cur.length || !lines.length) lines.push(cur);
    return lines;
  }

  function richDraw(c, x, y, line, size, color = BLACK) {
    for (const p of line) {
      const col = p.code ? TEAL : color;
      c.setFont(p.font, size);
      c.setFillColor(col);
      c.drawString(x, y, p.tok);
      const w = c.stringWidth(p.tok, p.font, size);
      if (p.strike && !/^\s+$/.test(p.tok)) {
        c.setStrokeColor(col); c.setLineWidth(0.4);
        c.line(x, y + size * 0.3, x + w, y + size * 0.3);
      }
      x += w;
    }
  }

  // ---------- blocs de la fiche ----------
  function headerBar(c, proto) {
    const y = H - MT;
    c.roundedRect(ML, y - 16 * mm, CW, 16 * mm, 2.2 * mm, { fill: NAVY });
    c.setFillColor(WHITE);
    c.setFont("DejaVuBold", 8);
    c.drawString(ML + 4 * mm, y - 5.2 * mm, "INSTITUT DE CANCÉROLOGIE DE BOURGOGNE  ·  Dijon");
    c.setFont("DejaVu", 6.5);
    c.drawRightString(ML + CW - 4 * mm, y - 5.2 * mm, "D-ONCO-ENR002-02  ·  25/06/2026");
    c.setFont("DejaVuBold", 11);
    c.drawString(ML + 4 * mm, y - 10.4 * mm, "Plan personnalisé de soins");
    const titre = proto.titre || "";
    const tw = c.stringWidth(titre, "DejaVuBold", 8) + 6 * mm;
    const bx = ML + CW - 4 * mm - tw;
    c.roundedRect(bx, y - 12.6 * mm, tw, 5.6 * mm, 1.4 * mm, { fill: ACCENT });
    c.setFillColor(WHITE);
    c.setFont("DejaVuBold", 8);
    c.drawCentredString(bx + tw / 2, y - 10.8 * mm, titre);
    c.setFillColor("#D7E6EE");
    c.setFont("DejaVu", 6.3);
    const sub = (proto.indication || "") + "  ·  " + (proto.molecules || "");
    c.drawString(ML + 4 * mm, y - 14.6 * mm, wrap(c, sub, "DejaVu", 6.3, CW - 10 * mm)[0]);
    return y - 18.5 * mm;
  }

  function footer(c) {
    c.setFillColor(TEAL);
    c.rect(ML, MB - 0.4 * mm, CW, 0.3 * mm, { fill: true });
    c.setFillColor(NAVY);
    c.setFont("DejaVu", 6);
    c.drawString(ML, MB - 5.2 * mm, "Document interne ICB — seule la version informatique fait foi — validité 4 ans");
    c.drawRightString(ML + CW, MB - 5.2 * mm, "Propriété de l’Institut de Cancérologie de Bourgogne");
    if (logo) {
      // logo ICB centré dans le pied de page
      const h = 6 * mm, w = h * logo.ratio;
      c.image(logo.dataUrl, ML + CW / 2 - w / 2, 0.9 * mm, w, h);
    }
  }

  const DOTS = "………………";

  function fieldRow(c, y, patient) {
    const h = 16.5 * mm;
    c.roundedRect(ML, y - h, CW, h, 2 * mm, { fill: SOFT, stroke: LINE });
    const cols = [
      ["Nom", patient.nom || DOTS, 0.0, 0.18],
      ["Prénom", patient.prenom || DOTS, 0.18, 0.18],
      ["Né(e) le", patient.naissance || DOTS, 0.36, 0.16],
      ["Fiche remise le", patient.remise || DOTS, 0.52, 0.16],
      ["Remise par", patient.par || DOTS, 0.68, 0.32],
    ];
    c.setStrokeColor(LINE);
    c.setLineWidth(0.3);
    for (const [lab, val, start, width] of cols) {
      const x = ML + 3 * mm + start * (CW - 6 * mm);
      const maxw = width * (CW - 6 * mm) - 3 * mm;
      c.setFillColor(TEAL);
      c.setFont("DejaVu", 5.5);
      c.drawString(x, y - 4.0 * mm, lab.toUpperCase());
      c.setFillColor(NAVY);
      c.setFont("DejaVuBold", 7.6);
      let shown = val;
      while (c.stringWidth(shown, "DejaVuBold", 7.6) > maxw && shown.length > 3) shown = shown.slice(0, -2) + "…";
      c.drawString(x, y - 8.4 * mm, shown);
      if (start > 0) c.line(x - 1.6 * mm, y - 2.4 * mm, x - 1.6 * mm, y - h + 5.6 * mm);
    }
    c.setFillColor(TEAL);
    c.setFont("DejaVu", 5.8);
    const ref = patient.referent || DOTS, tel = patient.referent_tel || "";
    c.drawString(ML + 3 * mm, y - 13.6 * mm, `Médecin référent : ${ref}  ${tel}`);
    return y - h - 2.2 * mm;
  }

  function sectionTitle(c, y, title) {
    c.setFillColor(NAVY);
    c.setFont("DejaVuBold", 8.4);
    c.drawString(ML, y - 3.4 * mm, title.toUpperCase());
    c.setStrokeColor(TEAL);
    c.setLineWidth(0.7);
    c.line(ML, y - 4.6 * mm, ML + CW, y - 4.6 * mm);
    return y - 7.2 * mm;
  }

  function bullets(c, y, items, { size = 7.2, leading = 9.2, md = false, marker = "•  ", gap = 0.4 * mm } = {}) {
    let num = 0;
    for (const it of items || []) {
      const [kind, txt] = md ? mdBlock(it) : ["p", it];
      num = kind === "num" ? num + 1 : 0;
      let indent = 0, prefix = marker, fs = size, baseB = false, baseI = false, col = BLACK;
      if (kind === "h") { prefix = ""; fs = size + 0.8; baseB = true; col = NAVY; y -= 1.0 * mm; }
      else if (kind === "sub") { indent = 4.0 * mm; prefix = "–  "; }
      else if (kind === "num") { prefix = `${num}.  `; }
      else if (kind === "quote") { indent = 3.0 * mm; prefix = ""; baseI = true; col = "#444444"; }
      const runs = (prefix ? [run(prefix)] : []).concat(textRuns(txt, md));
      richWrap(c, runs, fs, CW - indent, baseB, baseI).forEach((line, i) => {
        richDraw(c, ML + indent + (i === 0 ? 0 : 3.2 * mm), y, line, fs, col);
        y -= leading;
      });
      y -= gap;
    }
    return y;
  }

  function drawTimeline(c, y, steps) {
    const n = steps.length;
    if (!n) return y;
    const gap = 2.4 * mm;
    const boxW = (CW - gap * (n - 1)) / n;
    // polices réduites quand la frise compte beaucoup de cases
    const ds = n >= 5 ? 5.6 : 6.2;
    const lead = n >= 5 ? 2.9 * mm : 3.2 * mm;
    const labelSize = n >= 5 ? 7 : 8;
    // détail : retours à la ligne saisis + retour automatique à la largeur de la case
    const details = steps.map((st) =>
      String(st.detail || "").split("\n").flatMap((seg) => (seg.trim() ? wrap(c, seg, "DejaVu", ds, boxW - 3 * mm) : [""]))
    );
    const maxLines = Math.max(1, ...details.map((d) => d.length));
    // hauteur adaptée au contenu (16,5 mm minimum = 2 lignes)
    const h = Math.max(16.5 * mm, 9.2 * mm + maxLines * lead + 0.9 * mm);
    steps.forEach((st, i) => {
      const x = ML + i * (boxW + gap);
      c.roundedRect(x, y - h, boxW, h, 1.8 * mm, { fill: i % 2 === 0 ? SOFT : "#DCE8EE", stroke: TEAL });
      c.setFillColor(NAVY);
      // étiquette : réduite si elle déborde de la case
      const label = st.label || "";
      let ls = labelSize;
      while (ls > 5.5 && c.stringWidth(label, "DejaVuBold", ls) > boxW - 2 * mm) ls -= 0.5;
      c.setFont("DejaVuBold", ls);
      c.drawCentredString(x + boxW / 2, y - 5.2 * mm, label);
      c.setFont("DejaVu", ds);
      c.setFillColor("#223344");
      details[i].forEach((line, j) => {
        c.drawCentredString(x + boxW / 2, y - 9.2 * mm - j * lead, line);
      });
      if (i < n - 1) {
        c.setFillColor(ACCENT);
        c.setFont("DejaVuBold", 9);
        c.drawCentredString(x + boxW + gap / 2, y - h / 2 - 1.2 * mm, "›");
      }
    });
    return y - h - 2.4 * mm;
  }

  function drawParcours(c, y, items) {
    const n = items.length;
    if (!n) return y;
    const gap = 2.2 * mm;
    const boxW = (CW - gap * (n - 1)) / n;
    const h = 12.5 * mm;
    items.forEach((it, i) => {
      const x = ML + i * (boxW + gap);
      c.roundedRect(x, y - h, boxW, h, 1.6 * mm, { fill: i % 2 ? GOLD : "#F7F0DC", stroke: "#C9A45A" });
      c.setFillColor(NAVY);
      c.setFont("DejaVuBold", 6.6);
      c.drawCentredString(x + boxW / 2, y - 4.6 * mm, it.titre || "");
      c.setFont("DejaVu", 5.8);
      wrap(c, it.texte || "", "DejaVu", 5.8, boxW - 3 * mm).slice(0, 2).forEach((line, j) => {
        c.drawCentredString(x + boxW / 2, y - 8.2 * mm - j * 3 * mm, line);
      });
    });
    return y - h - 2.2 * mm;
  }

  function alertBanner(c, y) {
    const h = 14.2 * mm;
    c.roundedRect(ML, y - h, CW, h, 2 * mm, { fill: ALERTBG, stroke: ALERT, sw: 0.8 });
    c.setFillColor(ALERT);
    c.setFont("DejaVuBold", 7.4);
    c.drawString(ML + 3 * mm, y - 4.4 * mm, "NUMÉROS UTILES");
    c.setFont("DejaVu", 6.6);
    c.setFillColor(BLACK);
    c.drawString(ML + 3 * mm, y - 8.2 * mm, "Heures ouvrables ICB  ·  lun–jeu 8h30–18h00  ·  ven 8h30–18h00");
    c.setFont("DejaVuBold", 7.4);
    c.setFillColor(ALERT);
    c.drawRightString(ML + CW - 3 * mm, y - 8.2 * mm, "03 80 67 67 80");
    c.setFont("DejaVu", 6.6);
    c.setFillColor(BLACK);
    c.drawString(ML + 3 * mm, y - 12.0 * mm, "Nuit, week-end, jours fériés  ·  Oncologie–Hématologie Clinique de Valmy (HPDB)");
    c.setFont("DejaVuBold", 7.4);
    c.setFillColor(ALERT);
    c.drawRightString(ML + CW - 3 * mm, y - 12.0 * mm, "03 80 40 01 40");
    return y - h - 2.2 * mm;
  }

  function drawTable(c, y, effets, extras, md) {
    const rows = [].concat(effets || [], extras || []);
    const colW = [12 * mm, 48 * mm, 65 * mm, CW - 12 * mm - 48 * mm - 65 * mm];
    const headers = ["", "Effet", "Prévention", "Que faire"];
    const rowHMin = 7.2 * mm;
    c.setFillColor(NAVY);
    c.rect(ML, y - 6.2 * mm, CW, 6.2 * mm, { fill: true });
    c.setFillColor(WHITE);
    c.setFont("DejaVuBold", 6.4);
    let x = ML;
    headers.forEach((h, i) => { c.drawString(x + 1.4 * mm, y - 4.4 * mm, h.toUpperCase()); x += colW[i]; });
    y -= 6.2 * mm;

    const sizes = [7.0, 6.3, 6.1, 6.1];
    const baseBold = [true, true, false, false];
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const cells = [row.freq || "", row.name || "", row.prevention || "", row.traitement || ""];
      let nlines = 1;
      const wrapped = [null];
      for (let i = 1; i < 4; i++) {
        const lines = richWrap(c, textRuns(cells[i], md), sizes[i], colW[i] - 2.6 * mm, baseBold[i]);
        wrapped.push(lines);
        nlines = Math.max(nlines, lines.length);
      }
      const rh = Math.max(rowHMin, nlines * 3.05 * mm + 2.2 * mm);
      let bg = idx % 2 === 0 ? WHITE : SOFT2;
      if (row.freq === "!") bg = "#FDECEC";
      c.setFillColor(bg);
      c.rect(ML, y - rh, CW, rh, { fill: true });
      c.setStrokeColor(LINE);
      c.setLineWidth(0.25);
      c.line(ML, y - rh, ML + CW, y - rh);
      x = ML;
      for (let i = 0; i < 4; i++) {
        if (i === 0) {
          const freq = cells[0];
          if (freq === "+") { c.setFillColor(OK); c.setFont("DejaVuBold", 7); c.drawCentredString(x + colW[0] / 2, y - 4.4 * mm, "fréquent"); }
          else if (freq === "!") { c.setFillColor(ALERT); c.setFont("DejaVuBold", 7); c.drawCentredString(x + colW[0] / 2, y - 4.4 * mm, "urgent"); }
          else { c.setFillColor(TEAL); c.setFont("DejaVuBold", 6.4); c.drawCentredString(x + colW[0] / 2, y - 4.4 * mm, "possible"); }
        } else {
          wrapped[i].forEach((line, j) => {
            richDraw(c, x + 1.3 * mm, y - 3.8 * mm - j * 3.05 * mm, line, sizes[i], i === 1 ? NAVY : BLACK);
          });
        }
        x += colW[i];
      }
      y -= rh;
      if (y < MB + 28 * mm) break;
    }
    return y;
  }

  function drawRecs(c, y, recs, md) {
    y = sectionTitle(c, y, "Recommandations générales");
    return bullets(c, y, recs, { size: 6.5, leading: 3.2 * mm, md, marker: "▸  ", gap: 0.6 * mm });
  }

  function noteConsent(c, y) {
    c.setFillColor("#555555");
    c.setFont("DejaVuOblique", 6.2);
    const txt = "Avec votre accord, ce PPS est transmis à votre médecin traitant et au service qui administre le traitement. Il pourra être adapté selon les bilans.";
    for (const line of wrap(c, txt, "DejaVuOblique", 6.2, CW)) { c.drawString(ML, y, line); y -= 3.1 * mm; }
    return y;
  }

  function render(proto, patient) {
    if (!fontData) throw new Error("Polices non chargées : appelez PpsPdf.loadFonts() d’abord.");
    patient = patient || {};
    const md = !!proto.markdown;
    const doc = newDoc();
    doc.setProperties({
      title: `PPS ${proto.titre || ""} — ${patient.nom || ""} ${patient.prenom || ""}`.trim(),
      author: "Institut de Cancérologie de Bourgogne",
    });
    const c = new Canvas(doc);

    // PAGE 1
    let y = headerBar(c, proto);
    y = fieldRow(c, y, patient);
    y = sectionTitle(c, y, "Explication du traitement");
    y = bullets(c, y, proto.explanation || [], { size: 7.3, leading: 9.4, md });
    c.setFillColor(TEAL);
    c.setFont("DejaVuBold", 7);
    const ryt = `Rythme : ${proto.rythme || ""}     ·     ${proto.duree || ""}`;
    for (const line of wrap(c, ryt, "DejaVuBold", 7, CW)) { c.drawString(ML, y, line); y -= 3.4 * mm; }
    y -= 1.4 * mm;
    if (proto.parcours && proto.parcours.length) {
      y = sectionTitle(c, y, "Parcours de soins");
      y = drawParcours(c, y, proto.parcours);
    }
    y = sectionTitle(c, y, "Déroulement d’une cure");
    y = drawTimeline(c, y, proto.timeline || []);
    y = bullets(c, y, proto.deroulement || [], { size: 7.1, leading: 9.1, md });
    y = sectionTitle(c, y, "Effets secondaires potentiels");
    y = bullets(c, y, [
      "Ils sont le plus souvent transitoires. Vous pouvez n’en ressentir aucun.",
      "Des traitements préventifs vous seront remis. Signalez tout symptôme à l’équipe.",
    ], { size: 7.0, leading: 8.8 });
    noteConsent(c, y);
    footer(c);
    c.showPage();

    // PAGE 2
    y = headerBar(c, proto);
    y = sectionTitle(c, y + 1.5 * mm, "Tableau des effets secondaires");
    y = drawTable(c, y, proto.effets, proto.extras, md);
    y -= 2.5 * mm;
    y = drawRecs(c, y, proto.recommandations || [], md);
    y -= 1.5 * mm;
    alertBanner(c, y);
    footer(c);
    return doc;
  }

  global.PpsPdf = { loadFonts, render, mdInline, mdBlock };
})(window);
