/* PPS ICB — logique de l’interface web (site statique). */
(function () {
  "use strict";

  const LS_KEY = "pps-icb.protocols";
  const $ = (sel) => document.querySelector(sel);

  const state = {
    builtin: [],      // [{id, titre, indication}] depuis protocols/index.json
    local: {},        // id -> protocole (localStorage)
    cache: {},        // id -> protocole intégré déjà chargé
    list: [],         // liste fusionnée affichée
    selected: null,
    screen: "remise",
    patient: { nom: "", prenom: "", naissance: "", remise: today(), par: "", referent: "", referent_tel: "" },
    draft: null,
    draftEditingId: null, // id du protocole chargé dans l’éditeur (null = nouveau)
    fontsReady: false,
    blobUrl: null,
    doc: null,
  };

  // ---------- utilitaires ----------
  function today() {
    const d = new Date();
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  }

  function slugify(s) {
    let out = "";
    for (const ch of String(s).toLowerCase()) {
      if (/[a-z0-9]/.test(ch)) out += ch;
      else if (ch === " " || ch === "-" || ch === "_" || ch === "/") { if (!out.endsWith("-")) out += "-"; }
    }
    return out.replace(/^-+|-+$/g, "");
  }

  function lines(s) {
    return String(s || "").split("\n").map((l) => l.trim()).filter(Boolean);
  }

  function effetsToText(effets) {
    return (effets || []).map((e) => `${e.freq || ""} | ${e.name || ""} | ${e.prevention || ""} | ${e.traitement || ""}`).join("\n");
  }

  function parseEffets(s) {
    return String(s || "").split("\n").map((chunk) => {
      const parts = chunk.split("|").map((p) => p.trim());
      if (parts.length >= 2 && parts[1]) {
        return { freq: parts[0], name: parts[1], prevention: parts[2] || "", traitement: parts[3] || "" };
      }
      return null;
    }).filter(Boolean);
  }

  function blankProtocol(id) {
    return {
      id,
      titre: "NOUVEAU PROTOCOLE",
      indication: "",
      molecules: "",
      rythme: "1 cure / 15 jours",
      duree: "",
      explanation: ["Après RCP, le traitement suivant vous est proposé."],
      parcours: [],
      timeline: [{ label: "J1", detail: "Perfusion HDJ" }, { label: "J2–J14", detail: "Repos" }],
      deroulement: [
        "48 h avant la cure : bilan biologique en ville.",
        "Jour de la cure : consultation puis perfusion en hôpital de jour.",
      ],
      effets: [],
      extras: [],
      recommandations: ["En cas de fièvre ≥ 38,5 °C : contactez l’ICB ou le service d’hospitalisation."],
      markdown: false,
    };
  }

  function normalize(p) {
    const b = blankProtocol(p.id || slugify(p.titre || "") || "protocole");
    const out = { ...b, ...p };
    for (const k of ["explanation", "deroulement", "recommandations", "parcours", "timeline", "effets", "extras"]) {
      if (!Array.isArray(out[k])) out[k] = [];
    }
    out.markdown = !!out.markdown;
    return out;
  }

  function status(msg, ok = true) {
    const el = $("#status");
    el.textContent = msg;
    el.className = "status " + (ok ? "ok" : "err");
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function download(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- stockage local ----------
  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {}; } catch (_) { return {}; }
  }
  function saveLocal() {
    localStorage.setItem(LS_KEY, JSON.stringify(state.local));
  }

  // ---------- liste des protocoles ----------
  function rebuildList() {
    const map = new Map();
    for (const e of state.builtin) map.set(e.id, { id: e.id, titre: e.titre, indication: e.indication || "", builtin: true, local: false });
    for (const [id, p] of Object.entries(state.local)) {
      const prev = map.get(id);
      map.set(id, { id, titre: p.titre || id, indication: p.indication || "", builtin: !!(prev && prev.builtin), local: true });
    }
    state.list = [...map.values()].sort((a, b) => a.titre.toLowerCase().localeCompare(b.titre.toLowerCase(), "fr"));
    if (!state.selected || !state.list.some((p) => p.id === state.selected)) {
      state.selected = state.list.length ? state.list[0].id : null;
    }
    renderList();
  }

  function renderList() {
    const ul = $("#proto-list");
    ul.innerHTML = "";
    for (const p of state.list) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = p.id === state.selected ? "active" : "";
      btn.innerHTML = `${p.local ? '<span class="badge">local</span>' : ""}${escapeHtml(p.titre)}<span class="sub">${escapeHtml(p.indication)}</span>`;
      btn.addEventListener("click", () => { state.selected = p.id; status(""); renderList(); schedulePreview(); });
      li.appendChild(btn);
      ul.appendChild(li);
    }
    const sel = $("#edit-select");
    sel.innerHTML = "";
    for (const p of state.list) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.titre + (p.local ? " (local)" : "");
      sel.appendChild(o);
    }
    if (state.draftEditingId) sel.value = state.draftEditingId;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  async function getProtocol(id) {
    if (!id) return null;
    if (state.local[id]) return normalize(state.local[id]);
    if (state.cache[id]) return state.cache[id];
    const r = await fetch(`protocols/${encodeURIComponent(id)}.json`, { cache: "no-cache" });
    if (!r.ok) throw new Error(`Protocole introuvable : protocols/${id}.json`);
    const p = normalize(await r.json());
    state.cache[id] = p;
    return p;
  }

  // ---------- aperçu PDF ----------
  async function currentProtocol() {
    if (state.screen === "editeur" && state.draft) return state.draft;
    return getProtocol(state.selected);
  }

  function pdfFilename(proto) {
    const nom = state.patient.nom.trim().replace(/ /g, "_");
    const prenom = state.patient.prenom.trim().replace(/ /g, "_");
    return nom ? `${proto.id}_${nom}_${prenom}.pdf` : `${proto.id}.pdf`;
  }

  async function refreshPreview() {
    if (!state.fontsReady) return;
    try {
      const proto = await currentProtocol();
      if (!proto) { $("#preview-info").textContent = "Aucun protocole."; return; }
      const doc = PpsPdf.render(proto, state.patient);
      state.doc = doc;
      const blob = doc.output("blob");
      if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
      state.blobUrl = URL.createObjectURL(blob);
      $("#preview").src = state.blobUrl + "#view=FitH";
      $("#preview-info").textContent = `${proto.titre} · ${pdfFilename(proto)} · ${Math.round(blob.size / 1024)} Ko`;
    } catch (e) {
      console.error(e);
      status("Erreur de rendu : " + e.message, false);
    }
  }
  const schedulePreview = debounce(refreshPreview, 350);

  // ---------- écran : remise ----------
  function bindPatientForm() {
    for (const input of document.querySelectorAll("[data-patient]")) {
      const key = input.dataset.patient;
      input.value = state.patient[key] || "";
      input.addEventListener("input", () => {
        state.patient[key] = key === "nom" ? input.value.toUpperCase() : input.value;
        if (key === "nom" && input.value !== state.patient.nom) input.value = state.patient.nom;
        schedulePreview();
      });
    }
    $("#btn-download-pdf").addEventListener("click", async () => {
      await refreshPreview();
      if (!state.doc) return;
      const proto = await currentProtocol();
      const name = pdfFilename(proto);
      state.doc.save(name);
      status(`PDF téléchargé : ${name}`);
    });
    $("#btn-print").addEventListener("click", async () => {
      await refreshPreview();
      const frame = $("#preview");
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        status("Impression lancée : choisissez recto-verso (retourner sur les bords longs).");
      } catch (_) {
        window.open(state.blobUrl, "_blank");
        status("Le PDF s’est ouvert dans un nouvel onglet : imprimez-le depuis là (recto-verso).");
      }
    });
  }

  // ---------- écran : éditeur ----------
  const F = {
    titre: () => $("#d-titre"), id: () => $("#d-id"), indication: () => $("#d-indication"),
    molecules: () => $("#d-molecules"), rythme: () => $("#d-rythme"), duree: () => $("#d-duree"),
    markdown: () => $("#d-markdown"), explanation: () => $("#d-explanation"),
    deroulement: () => $("#d-deroulement"), recommandations: () => $("#d-recommandations"),
    effets: () => $("#d-effets"),
  };

  function fillEditor(p) {
    F.titre().value = p.titre || "";
    F.id().value = p.id || "";
    F.indication().value = p.indication || "";
    F.molecules().value = p.molecules || "";
    F.rythme().value = p.rythme || "";
    F.duree().value = p.duree || "";
    F.markdown().checked = !!p.markdown;
    F.explanation().value = (p.explanation || []).join("\n");
    F.deroulement().value = (p.deroulement || []).join("\n");
    F.recommandations().value = (p.recommandations || []).join("\n");
    F.effets().value = effetsToText(p.effets);
    renderTimeline();
    updateMdHint();
    updateDeleteButton();
  }

  // ---------- frise : cases éditables ----------
  function renderTimeline() {
    const box = $("#d-timeline");
    box.innerHTML = "";
    const tl = state.draft.timeline;
    if (!tl.length) {
      const e = document.createElement("div");
      e.className = "tl-empty";
      e.textContent = "Aucune case : la frise ne sera pas imprimée.";
      box.appendChild(e);
      return;
    }
    tl.forEach((step, i) => {
      const row = document.createElement("div");
      row.className = "tl-row";
      row.dataset.index = String(i);
      row.innerHTML = `
        <label class="form-inline">Étiquette<input data-tl="label" placeholder="J1" autocomplete="off"></label>
        <label class="form-inline">Détail<textarea data-tl="detail" rows="2" placeholder="Perfusion HDJ"></textarea></label>
        <div class="tl-tools">
          <button type="button" data-act="up" title="Monter" ${i === 0 ? "disabled" : ""}>▲</button>
          <button type="button" data-act="down" title="Descendre" ${i === tl.length - 1 ? "disabled" : ""}>▼</button>
          <button type="button" class="del" data-act="del" title="Supprimer">✕</button>
        </div>`;
      row.querySelector('[data-tl="label"]').value = step.label || "";
      row.querySelector('[data-tl="detail"]').value = step.detail || "";
      box.appendChild(row);
    });
  }

  function bindTimeline() {
    const box = $("#d-timeline");
    box.addEventListener("input", (e) => {
      const key = e.target.dataset.tl;
      const row = e.target.closest(".tl-row");
      if (!key || !row) return;
      const step = state.draft.timeline[Number(row.dataset.index)];
      if (step) { step[key] = e.target.value; schedulePreview(); }
    });
    box.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      const row = e.target.closest(".tl-row");
      if (!btn || !row) return;
      const tl = state.draft.timeline;
      const i = Number(row.dataset.index);
      if (btn.dataset.act === "up" && i > 0) [tl[i - 1], tl[i]] = [tl[i], tl[i - 1]];
      else if (btn.dataset.act === "down" && i < tl.length - 1) [tl[i], tl[i + 1]] = [tl[i + 1], tl[i]];
      else if (btn.dataset.act === "del") tl.splice(i, 1);
      renderTimeline();
      schedulePreview();
    });
    $("#btn-tl-add").addEventListener("click", () => {
      if (!state.draft) return;
      state.draft.timeline.push({ label: "", detail: "" });
      renderTimeline();
      const rows = box.querySelectorAll(".tl-row");
      rows[rows.length - 1].querySelector('[data-tl="label"]').focus();
      schedulePreview();
    });
  }

  function readEditor() {
    const d = state.draft;
    d.titre = F.titre().value;
    d.id = slugify(F.id().value);
    d.indication = F.indication().value;
    d.molecules = F.molecules().value;
    d.rythme = F.rythme().value;
    d.duree = F.duree().value;
    d.markdown = F.markdown().checked;
    d.explanation = lines(F.explanation().value);
    d.deroulement = lines(F.deroulement().value);
    d.recommandations = lines(F.recommandations().value);
    d.effets = parseEffets(F.effets().value);
  }

  function updateMdHint() {
    $("#md-hint").textContent = F.markdown().checked
      ? "Une ligne = une puce. Markdown actif : **gras**, *italique*, # titre, - sous-puce, 1. numéroté, > remarque."
      : "Une ligne = une puce. Le texte est imprimé tel quel (cochez Markdown pour la mise en forme).";
  }

  function updateDeleteButton() {
    const id = state.draft && state.draft.id;
    $("#btn-delete-local").hidden = !(id && state.local[id]);
  }

  async function loadIntoEditor(id) {
    try {
      const p = await getProtocol(id);
      if (!p) return;
      state.draft = JSON.parse(JSON.stringify(p));
      state.draftEditingId = id;
      fillEditor(state.draft);
      $("#edit-select").value = id;
      status("Protocole chargé dans l’éditeur.");
      schedulePreview();
    } catch (e) {
      status(e.message, false);
    }
  }

  function newProtocol() {
    const id = `nouveau-${state.list.length + 1}`;
    state.draft = blankProtocol(id);
    state.draftEditingId = null;
    showScreen("editeur", { keepDraft: true });
    fillEditor(state.draft);
    status("Nouveau protocole — renseignez les champs puis enregistrez.");
    F.titre().focus();
    F.titre().select();
    schedulePreview();
  }

  function bindEditor() {
    const onEdit = () => { readEditor(); updateDeleteButton(); schedulePreview(); };
    for (const k of ["titre", "id", "indication", "molecules", "rythme", "duree", "explanation", "deroulement", "recommandations", "effets"]) {
      F[k]().addEventListener("input", onEdit);
    }
    F.titre().addEventListener("input", () => {
      // nouveau protocole : le slug suit le titre
      if (!state.draftEditingId) { F.id().value = slugify(F.titre().value); readEditor(); }
    });
    F.id().addEventListener("blur", () => { F.id().value = slugify(F.id().value); });
    F.markdown().addEventListener("change", () => { readEditor(); updateMdHint(); schedulePreview(); });

    $("#edit-select").addEventListener("change", (e) => loadIntoEditor(e.target.value));
    $("#btn-new").addEventListener("click", newProtocol);
    $("#btn-new-2").addEventListener("click", newProtocol);

    $("#btn-save").addEventListener("click", () => {
      readEditor();
      const d = state.draft;
      if (!d.id) { status("Identifiant du protocole vide.", false); return; }
      if (!d.titre.trim()) { status("Titre du protocole vide.", false); return; }
      state.local[d.id] = JSON.parse(JSON.stringify(d));
      saveLocal();
      state.draftEditingId = d.id;
      state.selected = d.id;
      rebuildList();
      updateDeleteButton();
      status(`Protocole enregistré dans ce navigateur : ${d.id}. Téléchargez le JSON pour l’ajouter au site.`);
    });

    $("#btn-download-json").addEventListener("click", () => {
      readEditor();
      const d = state.draft;
      if (!d.id) { status("Identifiant du protocole vide.", false); return; }
      download(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }), `${d.id}.json`);
      status(`JSON téléchargé : ${d.id}.json — à déposer dans protocols/ et à référencer dans protocols/index.json.`);
    });

    $("#btn-delete-local").addEventListener("click", () => {
      const id = state.draft && state.draft.id;
      if (!id || !state.local[id]) return;
      if (!confirm(`Supprimer la copie locale de « ${id} » ?`)) return;
      delete state.local[id];
      saveLocal();
      rebuildList();
      if (state.list.some((p) => p.id === id)) loadIntoEditor(id);
      else newProtocol();
      status(`Copie locale supprimée : ${id}.`);
    });
  }

  // ---------- import JSON ----------
  function bindFileInputs() {
    for (const sel of ["#file-json", "#file-json-2"]) {
      $(sel).addEventListener("change", async (e) => {
        const file = e.target.files[0];
        e.target.value = "";
        if (!file) return;
        try {
          const raw = JSON.parse(await file.text());
          if (Array.isArray(raw)) throw new Error("Ce fichier est une liste (index.json ?), pas un protocole.");
          if (!raw.titre) throw new Error("JSON invalide : champ « titre » manquant.");
          const p = normalize(raw);
          if (!p.id) p.id = slugify(file.name.replace(/\.json$/i, "")) || "protocole";
          state.local[p.id] = p;
          saveLocal();
          state.selected = p.id;
          rebuildList();
          if (state.screen === "editeur") await loadIntoEditor(p.id);
          else schedulePreview();
          status(`Protocole chargé et conservé dans ce navigateur : ${p.titre} (${p.id}).`);
        } catch (err) {
          status(`Impossible de charger ${file.name} : ${err.message}`, false);
        }
      });
    }
  }

  // ---------- navigation ----------
  function showScreen(name, { keepDraft = false } = {}) {
    state.screen = name;
    $("#screen-remise").hidden = name !== "remise";
    $("#screen-editeur").hidden = name !== "editeur";
    $("#nav-remise").classList.toggle("active", name === "remise");
    $("#nav-editeur").classList.toggle("active", name === "editeur");
    if (name === "editeur" && !keepDraft) {
      if (state.selected) loadIntoEditor(state.selected);
      else newProtocol();
    } else {
      schedulePreview();
    }
  }

  // ---------- démarrage ----------
  async function init() {
    state.local = loadLocal();
    bindPatientForm();
    bindEditor();
    bindTimeline();
    bindFileInputs();
    $("#nav-remise").addEventListener("click", () => showScreen("remise"));
    $("#nav-editeur").addEventListener("click", () => showScreen("editeur"));

    try {
      const r = await fetch("protocols/index.json", { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      state.builtin = await r.json();
      status(`${state.builtin.length} protocoles intégrés chargés.`);
    } catch (e) {
      state.builtin = [];
      status("Liste des protocoles intégrés indisponible (" + e.message + "). Servez le site en HTTP ou chargez un JSON.", false);
    }
    rebuildList();

    try {
      await PpsPdf.loadFonts();
      state.fontsReady = true;
      await refreshPreview();
    } catch (e) {
      status(e.message, false);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
