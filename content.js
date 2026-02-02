// =====================================================
// Tabroom+ content script
// =====================================================

console.log("[Tabroom+] content script loaded");

// -----------------------------------------------------
// 0. Small helpers for chrome.storage with Promises
// -----------------------------------------------------
function storageLocalGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageLocalSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function storageSyncGet(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
}

function storageSyncSet(obj) {
  return new Promise((resolve) => chrome.storage.sync.set(obj, resolve));
}

// -----------------------------------------------------
// 1. Power score helpers (entry record page)
// -----------------------------------------------------
function tabroomPlusScoreDivision(divisionText) {
  return divisionText.includes("Open") ? 1 : 0;
}

function tabroomPlusScorePre(preText) {
  if (!preText) return 0;
  const m = preText.trim().match(/^(\d+(\.\d+)?)\s*-\s*(\d+(\.\d+)?)/);
  if (!m) return 0;
  const wins = parseFloat(m[1]);
  const losses = parseFloat(m[3]);
  return wins - losses;
}

function tabroomPlusScoreElims(cellText) {
  if (!cellText) return 0;
  const clean = cellText.trim().toUpperCase().replace(/[^WL]/g, "");
  if (!clean) return 0;
  let wins = 0,
    losses = 0;
  for (const ch of clean) {
    if (ch === "W") wins++;
    else if (ch === "L") losses++;
  }
  return 2 * wins - losses;
}

function tabroomPlusLabelFromScore(score) {
  if (score < 0) return "very low";
  if (score > 0 && score < 10) return "low";
  if (score >= 10 && score < 20) return "mid";
  if (score >= 20 && score < 30) return "high";
  return "very high";
}

// -----------------------------------------------------
// 2. NPDL rankings (TOC points) loader
// -----------------------------------------------------
const TABROOM_PLUS_RANKINGS_KEY = "tp_npdl_rankings";
const TABROOM_PLUS_RANKINGS_URL =
  "https://docs.google.com/spreadsheets/d/1oz6E9Bxw7d__DmNWJykS3VcRvJivffX7y_Jqtw7YxcU/export?format=csv&gid=887118024";

let TABROOM_PLUS_RANKINGS_CACHE = null;

// Tabroom school name → sheet school name
const TABROOM_PLUS_SCHOOL_ALIAS = {
  // Tabroom text : sheet school
  lucent: "campolindo"
};

function tabroomPlusNormalizeCode(text) {
  if (!text) return "";
  return text
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeSchoolName(raw) {
  if (!raw) return "";
  let s = raw.normalize("NFKC").trim();
  // Drop parenthetical suffixes, “(HS)” etc.
  s = s.replace(/\s*\([^)]*\)\s*$/, "");
  // Drop trailing “High / HS / School”
  s = s.replace(/\s+(high|hs|school)$/i, "");
  return s;
}

// Load CSV from Google Sheets and build a map:
//   "school ab" → points
//   "school ba" → points   (AB + BA both present)
async function tabroomPlusLoadRankings() {
  console.log("[Tabroom+] fetching rankings CSV…");
  const resp = await fetch(TABROOM_PLUS_RANKINGS_URL);
  if (!resp.ok) {
    throw new Error("HTTP " + resp.status);
  }
  const csv = await resp.text();
  const lines = csv.split(/\r?\n/);
  const map = {};

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(",");
    if (cols.length < 7) continue;

    const schoolRaw = cols[0];
    const last1 = cols[1].trim();
    const last2 = cols[2].trim();
    const pointsStr = cols[6].trim();

    if (!schoolRaw || !last1 || !last2 || !pointsStr) continue;

    const school = normalizeSchoolName(schoolRaw);
    const points = parseFloat(pointsStr);
    if (!Number.isFinite(points)) continue;

    const a = last1[0].toUpperCase();
    const b = last2[0].toUpperCase();

    const codeAB = tabroomPlusNormalizeCode(`${school} ${a}${b}`);
    const codeBA = tabroomPlusNormalizeCode(`${school} ${b}${a}`);

    if (!map[codeAB]) map[codeAB] = 0;
    if (!map[codeBA]) map[codeBA] = 0;

    map[codeAB] += points;
    map[codeBA] += points;
  }

  console.log("[Tabroom+] rankings parsed, teams:", Object.keys(map).length);
  await storageLocalSet({ [TABROOM_PLUS_RANKINGS_KEY]: map });
  TABROOM_PLUS_RANKINGS_CACHE = map;
  return map;
}

async function tabroomPlusEnsureRankingsLoaded() {
  if (TABROOM_PLUS_RANKINGS_CACHE) return TABROOM_PLUS_RANKINGS_CACHE;

  const stored = await storageLocalGet([TABROOM_PLUS_RANKINGS_KEY]);
  let map = stored[TABROOM_PLUS_RANKINGS_KEY] || {};
  if (!Object.keys(map).length) {
    map = await tabroomPlusLoadRankings();
  } else {
    console.log(
      "[Tabroom+] rankings loaded from local storage, teams:",
      Object.keys(map).length
    );
  }
  TABROOM_PLUS_RANKINGS_CACHE = map;
  return map;
}

// -----------------------------------------------------
// 3. Team name parsing for pairings → ranking lookup
// -----------------------------------------------------
function tabroomPlusParseTeamDisplay(text) {
  if (!text) return null;
  let t = text
    .normalize("NFKC")
    .trim()
    .replace(/\s*\([^)]*\)\s*$/, ""); // drop things like "(bye)", "(1-0)"

  if (!t) return null;

  const parts = t.split(/\s+/);
  if (parts.length < 2) return null;

  const letters = parts[parts.length - 1];
  if (!letters || letters.length < 2) return null;

  const a = letters[0].toUpperCase();
  const b = letters[1].toUpperCase();

  let school = parts.slice(0, -1).join(" ");
  school = school.replace(/\s+High\s+School$/i, "");
  school = school.replace(/\s+(HS|High|School)$/i, "");

  let schoolNorm = school.trim().toLowerCase();
  Object.keys(TABROOM_PLUS_SCHOOL_ALIAS).forEach((tabName) => {
    if (schoolNorm.includes(tabName)) {
      schoolNorm = TABROOM_PLUS_SCHOOL_ALIAS[tabName];
    }
  });

  const canonicalSchool = normalizeSchoolName(schoolNorm);
  const keyAB = tabroomPlusNormalizeCode(`${canonicalSchool} ${a}${b}`);
  const keyBA = tabroomPlusNormalizeCode(`${canonicalSchool} ${b}${a}`);

  return { keyAB, keyBA };
}

function tabroomPlusLookupPointsForTeam(map, displayText) {
  const parsed = tabroomPlusParseTeamDisplay(displayText);
  if (!parsed) return null;
  const { keyAB, keyBA } = parsed;
  const ptsAB = map[keyAB];
  const ptsBA = map[keyBA];

  if (typeof ptsAB === "number" && typeof ptsBA === "number") {
    return { teamCode: keyAB, points: Math.max(ptsAB, ptsBA) };
  } else if (typeof ptsAB === "number") {
    return { teamCode: keyAB, points: ptsAB };
  } else if (typeof ptsBA === "number") {
    return { teamCode: keyBA, points: ptsBA };
  }
  return null;
}

// For “Unranked” label under team name
function tabroomPlusUpdateRankLabel(cell, hasData, hasPoints) {
  if (!cell) return;
  let label = cell.querySelector(".tabroom-plus-rank-label");
  if (!hasData) {
    if (label) label.remove();
    return;
  }
  if (!label) {
    label = document.createElement("div");
    label.className = "tabroom-plus-rank-label";
    cell.appendChild(label);
  }
  if (!hasPoints) {
    label.textContent = "Unranked";
    label.style.display = "block";
  } else {
    label.textContent = "";
    label.style.display = "none";
  }
}

// -----------------------------------------------------
// 4. Judge notes (persistent)
// -----------------------------------------------------
const TABROOM_PLUS_JUDGE_NOTES_KEY = "tp_judge_notes";

function tabroomPlusGetJudgeKey(judgeCell) {
  if (!judgeCell) return null;
  const link = judgeCell.querySelector(
    'a[href*="judge"], a[href*="paradigm"], a[href*="judge.mhtml"]'
  );
  let idPart = null;

  if (link && link.href) {
    const m1 = link.href.match(/judge_id=(\d+)/);
    const m2 = link.href.match(/\/judge\/(\d+)/);
    if (m1) idPart = "id:" + m1[1];
    else if (m2) idPart = "id:" + m2[1];
  }

  const name = judgeCell.textContent.trim();
  if (idPart) return idPart;
  if (!name) return null;
  return "name:" + tabroomPlusNormalizeCode(name);
}

function tabroomPlusOpenJudgeNotesPopup(judgeCell, judgeKey, existingText, allNotes) {
  const old = document.querySelector(".tabroom-plus-judge-notes-popup");
  if (old) old.remove();

  const rect = judgeCell.getBoundingClientRect();

  const popup = document.createElement("div");
  popup.className = "tabroom-plus-judge-notes-popup";
  popup.style.top = `${window.scrollY + rect.bottom + 4}px`;
  popup.style.left = `${window.scrollX + rect.left}px`;

  const title = document.createElement("div");
  title.className = "tabroom-plus-judge-notes-title";
  title.textContent = "Judge notes";

  const textarea = document.createElement("textarea");
  textarea.className = "tabroom-plus-judge-notes-textarea";
  textarea.placeholder =
    "Prep: likes policy-heavy? Speed? Triggers? Anything you want to remember.";
  textarea.value = existingText || "";

  const actions = document.createElement("div");
  actions.className = "tabroom-plus-judge-notes-actions";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "tabroom-plus-judge-notes-save";
  saveBtn.textContent = "Save";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "tabroom-plus-judge-notes-close";
  closeBtn.textContent = "Close";

  actions.appendChild(saveBtn);
  actions.appendChild(closeBtn);

  popup.appendChild(title);
  popup.appendChild(textarea);
  popup.appendChild(actions);

  document.body.appendChild(popup);

  const handleSave = () => {
    const text = textarea.value.trim();
    const notes = allNotes || {};
    if (text) {
      notes[judgeKey] = { text, updatedAt: Date.now() };
    } else {
      delete notes[judgeKey];
    }
    storageSyncSet({ [TABROOM_PLUS_JUDGE_NOTES_KEY]: notes }).then(() => {
      popup.remove();
      const btn = judgeCell.querySelector(".tabroom-plus-judge-notes-btn");
      if (btn) {
        if (text) btn.classList.add("tabroom-plus-judge-notes-btn-has-note");
        else btn.classList.remove("tabroom-plus-judge-notes-btn-has-note");
      }
    });
  };

  saveBtn.addEventListener("click", handleSave);
  closeBtn.addEventListener("click", () => popup.remove());

  const outsideHandler = (e) => {
    if (!popup.contains(e.target)) {
      popup.remove();
      window.removeEventListener("mousedown", outsideHandler, true);
    }
  };
  window.addEventListener("mousedown", outsideHandler, true);
}

function tabroomPlusInitJudgeNotes(pairingsTable) {
  const headerRow =
    pairingsTable.querySelector("thead tr") || pairingsTable.querySelector("tr");
  if (!headerRow) return;

  const headers = Array.from(headerRow.querySelectorAll("th")).map((th) =>
    th.textContent.trim().toLowerCase()
  );
  const judgeIdx = headers.findIndex((h) => h === "judge");
  if (judgeIdx === -1) return;

  const bodyRows = Array.from(
    pairingsTable.querySelectorAll("tbody tr")
  ).filter((r) => r.querySelector("td"));
  if (!bodyRows.length) return;

  storageSyncGet([TABROOM_PLUS_JUDGE_NOTES_KEY]).then((data) => {
    const allNotes = data[TABROOM_PLUS_JUDGE_NOTES_KEY] || {};

    bodyRows.forEach((row) => {
      const cells = Array.from(row.querySelectorAll("td"));
      const judgeCell = cells[judgeIdx];
      if (!judgeCell) return;

      const judgeKey = tabroomPlusGetJudgeKey(judgeCell);
      if (!judgeKey) return;

      let btn = judgeCell.querySelector(".tabroom-plus-judge-notes-btn");
      if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tabroom-plus-judge-notes-btn";
        btn.textContent = "📝";
        judgeCell.appendChild(btn);
      }

      if (allNotes[judgeKey] && allNotes[judgeKey].text) {
        btn.classList.add("tabroom-plus-judge-notes-btn-has-note");
        btn.title = "View / edit judge notes";
      } else {
        btn.classList.remove("tabroom-plus-judge-notes-btn-has-note");
        btn.title = "Add judge notes";
      }

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        tabroomPlusOpenJudgeNotesPopup(
          judgeCell,
          judgeKey,
          allNotes[judgeKey] ? allNotes[judgeKey].text : "",
          allNotes
        );
      });
    });
  });
}

// -----------------------------------------------------
// 5. Main content script
// -----------------------------------------------------
(function () {
  // ===== header tweak: replace logo with Tabroom+ img =====
  (function () {
    const header = document.querySelector("#header, .nav, .navbar, .navbar-inverse");
    if (!header) return;

    const logo = header.querySelector(
      "a.navbar-brand, #logo, .navbar-header a, h1 a, #header h1 a"
    );
    if (!logo) return;

    logo.classList.add("tabroom-plus-logo-wrapper");

    while (logo.firstChild) logo.removeChild(logo.firstChild);

    const img = document.createElement("img");
    img.src = chrome.runtime.getURL("tabroomplus-logo.png");
    img.alt = "Tabroom+";
    img.className = "tabroom-plus-logo-img";
    logo.appendChild(img);

    const span = document.createElement("span");
    span.textContent = " Tabroom+";
    logo.appendChild(span);
  })();

  // ===== 1) Upcoming Tournaments page: stars + starred box =====
  (function () {
    const allH1 = Array.from(document.querySelectorAll("h1"));
    const heading = allH1.find(
      (h) => h.textContent.trim().toLowerCase() === "upcoming tournaments"
    );
    if (!heading) return;

    let container = heading.parentElement;
    for (let i = 0; i < 3 && container && !container.querySelector("table"); i++) {
      container = container.parentElement;
    }
    if (!container) return;
    const table = container.querySelector("table");
    if (!table) return;

    // ----- starred box at top -----
    storageSyncGet(["starredTournaments"]).then((data) => {
      const starred = data.starredTournaments || {};
      const ids = Object.keys(starred);
      if (!ids.length) return;
      if (document.querySelector(".tabroom-plus-starred-box")) return;

      const box = document.createElement("div");
      box.className = "tabroom-plus-starred-box";

      const title = document.createElement("div");
      title.className = "tabroom-plus-starred-title";
      title.textContent = "Starred Tournaments";
      box.appendChild(title);

      const list = document.createElement("ul");
      list.className = "tabroom-plus-starred-list";

      ids
        .map((id) => starred[id])
        .sort((a, b) => (b.starredAt || 0) - (a.starredAt || 0))
        .forEach((t) => {
          const li = document.createElement("li");
          li.className = "tabroom-plus-starred-item";

          const link = document.createElement("a");
          link.href = t.url;
          link.textContent = t.name || "Tournament";
          link.target = "_blank";
          link.className = "tabroom-plus-starred-link";

          const unstar = document.createElement("button");
          unstar.type = "button";
          unstar.className = "tabroom-plus-unstar-btn";
          unstar.textContent = "×";

          unstar.addEventListener("click", (e) => {
            e.preventDefault();
            delete starred[t.id];
            storageSyncSet({ starredTournaments: starred });
            li.remove();
          });

          li.appendChild(link);
          li.appendChild(unstar);
          list.appendChild(li);
        });

      box.appendChild(list);
      heading.parentElement.insertBefore(box, heading);
    });

    // ----- star column in table -----
    const headerRow = table.querySelector("thead tr") || table.querySelector("tr");
    if (!headerRow) return;

    if (!headerRow.querySelector(".tabroom-plus-star-header")) {
      const th = document.createElement("th");
      th.textContent = "★";
      th.className = "tabroom-plus-star-header";
      headerRow.insertBefore(th, headerRow.firstElementChild);
    }

    const rows = Array.from(table.querySelectorAll("tbody tr"));

    storageSyncGet(["starredTournaments"]).then((data) => {
      const starred = data.starredTournaments || {};

      rows.forEach((row) => {
        const link = row.querySelector('a[href*="tourn_id"]');
        if (!link) return;

        const tournName = link.innerText.trim();
        const tournUrl = link.href;
        const match = tournUrl.match(/tourn_id=(\d+)/);
        const tournId = match ? match[1] : tournUrl;

        const td = document.createElement("td");
        td.className = "tabroom-plus-star-cell";

        const star = document.createElement("span");
        star.className = "tabroom-plus-star";
        const isStarred = Boolean(starred[tournId]);
        star.textContent = isStarred ? "★" : "☆";

        if (isStarred) {
          row.classList.add("tabroom-plus-row-starred");
        }

        star.addEventListener("click", () => {
          if (starred[tournId]) {
            delete starred[tournId];
            star.textContent = "☆";
            row.classList.remove("tabroom-plus-row-starred");
          } else {
            starred[tournId] = {
              id: tournId,
              name: tournName,
              url: tournUrl,
              starredAt: Date.now()
            };
            star.textContent = "★";
            row.classList.add("tabroom-plus-row-starred");
          }
          storageSyncSet({ starredTournaments: starred });
        });

        td.appendChild(star);
        row.insertBefore(td, row.firstElementChild);
      });
    });
  })();

  // ===== 2) Entry record page: power score badge =====
  (function () {
    const headerDiv = document.querySelector("#team_season_header");
    const entryHeading = headerDiv ? headerDiv.querySelector("h4") : null;
    if (!entryHeading) return;

    const tables = Array.from(document.querySelectorAll("table"));
    if (tables.length < 2) return;
    const gridTable = tables[1];

    const headerRow = gridTable.querySelector("thead tr") || gridTable.querySelector("tr");
    if (!headerRow) return;

    const headers = Array.from(headerRow.querySelectorAll("th")).map((th) =>
      th.textContent.trim()
    );
    const divisionIdx = headers.findIndex((h) => h.startsWith("Division"));
    const preIdx = headers.findIndex((h) => h === "Pre" || h.startsWith("Pre"));
    const elimIdxs = ["Tri", "Dbs", "Oct", "Qrt", "Sem", "Fin"].map((label) =>
      headers.findIndex((h) => h.startsWith(label))
    );

    if (divisionIdx === -1 || preIdx === -1) return;

    let totalScore = 0;
    const bodyRows = Array.from(gridTable.querySelectorAll("tbody tr")).filter((r) =>
      r.querySelector("td")
    );

    bodyRows.forEach((row) => {
      const cells = Array.from(row.querySelectorAll("td"));
      if (!cells.length) return;

      const divisionText = cells[divisionIdx]?.textContent || "";
      const preText = cells[preIdx]?.textContent || "";
      let rowScore = 0;

      rowScore += tabroomPlusScoreDivision(divisionText);
      rowScore += tabroomPlusScorePre(preText);

      elimIdxs.forEach((idx) => {
        if (idx === -1) return;
        const t = cells[idx]?.textContent || "";
        rowScore += tabroomPlusScoreElims(t);
      });

      totalScore += rowScore;
    });

    const label = tabroomPlusLabelFromScore(totalScore);

    if (!document.querySelector(".tabroom-plus-power-badge")) {
      const badge = document.createElement("div");
      badge.className = "tabroom-plus-power-badge";
      badge.textContent = `Tabroom+ strength: ${totalScore.toFixed(1)} (${label})`;
      entryHeading.insertAdjacentElement("afterend", badge);
    }
  })();

  // ===== 3) Pairings page: strengths + judge notes =====
  (function () {
    const tables = Array.from(document.querySelectorAll("table"));
    const pairingsTable = tables.find((t) => {
      const headerRow = t.querySelector("thead tr") || t.querySelector("tr");
      if (!headerRow) return false;
      const headers = Array.from(headerRow.querySelectorAll("th")).map((th) =>
        th.textContent.trim().toLowerCase()
      );
      const hasGovOpp = headers.includes("gov") && headers.includes("opp");
      const hasAffNeg = headers.includes("aff") && headers.includes("neg");
      return hasGovOpp || hasAffNeg;
    });

    if (!pairingsTable) return;

    // Always initialise judge notes on this table
    tabroomPlusInitJudgeNotes(pairingsTable);

    if (!document.querySelector(".tabroom-plus-pairings-toolbar")) {
      const toolbar = document.createElement("div");
      toolbar.className = "tabroom-plus-pairings-toolbar";

      const analyzeBtn = document.createElement("button");
      analyzeBtn.className = "tabroom-plus-pairings-button";
      analyzeBtn.textContent = "Tabroom+: Analyze round";

      toolbar.appendChild(analyzeBtn);
      pairingsTable.parentElement.insertBefore(toolbar, pairingsTable);

      analyzeBtn.addEventListener("click", async () => {
        analyzeBtn.disabled = true;
        analyzeBtn.textContent = "Analyzing…";

        try {
          const map = await tabroomPlusEnsureRankingsLoaded();

          const headerRow =
            pairingsTable.querySelector("thead tr") ||
            pairingsTable.querySelector("tr");
          const headers = Array.from(headerRow.querySelectorAll("th")).map((th) =>
            th.textContent.trim()
          );
          const govIdx = headers.findIndex((h) => {
            const l = h.toLowerCase();
            return l === "gov" || l === "aff";
          });
          const oppIdx = headers.findIndex((h) => {
            const l = h.toLowerCase();
            return l === "opp" || l === "neg";
          });
          if (govIdx === -1 || oppIdx === -1) {
            console.log(
              "[Tabroom+] Pairings: could not find Gov/Opp or Aff/Neg columns"
            );
            analyzeBtn.disabled = false;
            analyzeBtn.textContent = "Tabroom+: Analyze round";
            return;
          }

          const bodyRows = Array.from(
            pairingsTable.querySelectorAll("tbody tr")
          ).filter((r) => r.querySelector("td"));
          const margin = 2; // within 2 pts → yellow "even" highlight

          bodyRows.forEach((row) => {
            const cells = Array.from(row.querySelectorAll("td"));
            const govCell = cells[govIdx];
            const oppCell = cells[oppIdx];
            if (!govCell || !oppCell) return;

            const govText = govCell.textContent.trim();
            const oppText = oppCell.textContent.trim();

            govCell.classList.remove(
              "tabroom-plus-strong",
              "tabroom-plus-weak",
              "tabroom-plus-even"
            );
            oppCell.classList.remove(
              "tabroom-plus-strong",
              "tabroom-plus-weak",
              "tabroom-plus-even"
            );

            const govRank = tabroomPlusLookupPointsForTeam(map, govText);
            const oppRank = tabroomPlusLookupPointsForTeam(map, oppText);

            const govHasData = !!govRank;
            const oppHasData = !!oppRank;

            const govPoints = govRank ? govRank.points : 0;
            const oppPoints = oppRank ? oppRank.points : 0;

            const govHasPoints = govHasData && govPoints > 0;
            const oppHasPoints = oppHasData && oppPoints > 0;

            // Update "Unranked" label
            tabroomPlusUpdateRankLabel(govCell, govHasData, govHasPoints);
            tabroomPlusUpdateRankLabel(oppCell, oppHasData, oppHasPoints);

            // No data for either → do nothing
            if (!govHasData && !oppHasData) return;

            // If one side has points and other doesn't, points side wins
            if (govHasPoints && !oppHasPoints) {
              govCell.classList.add("tabroom-plus-strong");
              oppCell.classList.add("tabroom-plus-weak");
              return;
            }
            if (!govHasPoints && oppHasPoints) {
              oppCell.classList.add("tabroom-plus-strong");
              govCell.classList.add("tabroom-plus-weak");
              return;
            }

            // Both have data. If both 0 → they're both unranked; no prediction.
            if (!govHasPoints && !oppHasPoints) return;

            const diff = Math.abs(govPoints - oppPoints);

            if (diff < margin) {
              govCell.classList.add("tabroom-plus-even");
              oppCell.classList.add("tabroom-plus-even");
            } else if (govPoints > oppPoints) {
              govCell.classList.add("tabroom-plus-strong");
              oppCell.classList.add("tabroom-plus-weak");
            } else if (oppPoints > govPoints) {
              oppCell.classList.add("tabroom-plus-strong");
              govCell.classList.add("tabroom-plus-weak");
            }
          });
        } catch (err) {
          console.error("[Tabroom+] error during analyze:", err);
        }

        analyzeBtn.disabled = false;
        analyzeBtn.textContent = "Tabroom+: Re-analyze round";
      });
    }
  })();
})();
