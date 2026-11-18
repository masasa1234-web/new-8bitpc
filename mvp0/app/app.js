import {
  commitPage,
  completeProgram,
  correctSourceLine,
  createProgramSession,
  getProgramSignal,
  replacePage,
  updateDraft
} from "../src/program-session.js";
import {
  loadProject,
  parseProject,
  saveProject,
  serializeProject
} from "../src/project-store.js";

const sample = '10 PRINT "HELLO"\n20 GOTO 10';
const app = document.querySelector("#app");
const source = document.querySelector("#source");
const saveStatus = document.querySelector("#save-status");
const importProjectFile = document.querySelector("#import-project-file");
const exportProjectButton = document.querySelector("#export-project-button");
const importProjectButton = document.querySelector("#import-project-button");
const sourceLabel = document.querySelector("#source-label");
const sourceHelp = document.querySelector("#source-help");
const committedPages = document.querySelector("#committed-pages");
const pageCounts = document.querySelector("#page-counts");
const parsedRows = document.querySelector("#parsed-rows");
const executionLog = document.querySelector("#execution-log");
const monitorScreen = document.querySelector("#monitor-screen");
const errorCount = document.querySelector("#error-count");
const uninterpretedCount = document.querySelector("#uninterpreted-count");
const waitingCount = document.querySelector("#waiting-count");
const overallStatus = document.querySelector("#overall-status");
const completeStatus = document.querySelector("#complete-status");
const historyCount = document.querySelector("#history-count");
const correctionHistory = document.querySelector("#correction-history");
const stepCount = document.querySelector("#step-count");
const suppressionStatus = document.querySelector("#suppression-status");
const runButton = document.querySelector("#run-button");
const stopButton = document.querySelector("#stop-button");
const delimiterButton = document.querySelector("#delimiter-button");
const completeButton = document.querySelector("#complete-button");
const cancelPageEditButton = document.querySelector("#cancel-page-edit-button");
const worker = new Worker("/app/execution-worker.js", { type: "module" });
const stopDialog = document.querySelector("#stop-dialog");
const stopReason = document.querySelector("#stop-reason");
const stopLocations = document.querySelector("#stop-locations");
const suppressChoice = document.querySelector("#suppress-choice");
const suppressForRun = document.querySelector("#suppress-for-run");

let session = createProgramSession(sample);
let editingKey = null;
let editingPageNumber = null;
let analysis;
let saveTimer = null;
let saveQueue = Promise.resolve();
let pendingStopReason = null;

source.value = sample;

function appendText(parent, tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function renderPages() {
  committedPages.replaceChildren();
  for (const page of session.pages) {
    const card = document.createElement("details");
    card.className = "committed-page";
    const summary = document.createElement("summary");
    summary.textContent = `ページ ${page.pageNumber} · 原文`;
    card.append(summary);
    appendText(card, "pre", "page-source", page.raw);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "page-edit-button secondary";
    edit.textContent = editingPageNumber === page.pageNumber ? "編集中" : "このRawを編集";
    edit.disabled = editingPageNumber !== null;
    edit.addEventListener("click", () => beginPageEdit(page));
    card.append(edit);
    committedPages.append(card);
  }

  pageCounts.replaceChildren();
  if (analysis.pageCounts.length === 0) {
    appendText(pageCounts, "p", "empty-state", "区切り済みのページはありません。");
  }
  for (const counts of analysis.pageCounts) {
    appendText(
      pageCounts,
      "p",
      "page-count",
      `ページ ${counts.pageNumber}　誤り ${counts.errors} / 未解釈 ${counts.uninterpreted} / 参照待ち ${counts.referenceWaiting}`
    );
  }
}

function renderHistory() {
  historyCount.textContent = String(session.correctionHistory.length);
  correctionHistory.replaceChildren();
  if (session.correctionHistory.length === 0) {
    appendText(correctionHistory, "li", "empty-state", "訂正履歴はありません。");
    return;
  }

  for (const item of session.correctionHistory) {
    const entry = document.createElement("li");
    appendText(entry, "time", "", item.timestamp);
    const actor = item.changedBy === "ai(承認つき)" ? "AI（承認つき）" : "人間";
    appendText(entry, "span", "", ` · ${actor} · ページ${item.pageNumber} 入力行${item.pageLine}`);
    appendText(entry, "pre", "history-source", `前: ${item.before}\n後: ${item.after}`);
    correctionHistory.append(entry);
  }
}

function renderAnalysis() {
  analysis = session.analysis;
  parsedRows.replaceChildren();

  if (analysis.rows.length === 0) {
    appendText(parsedRows, "p", "empty-state", "ページを入力し「区切り」を押すと、行ごとの解釈を表示します。");
  }

  for (const row of analysis.rows) {
    const card = document.createElement("article");
    card.className = "row-card";
    card.dataset.status = row.status;
    const meta = document.createElement("div");
    meta.className = "row-meta";
    appendText(meta, "span", "", `ページ ${row.pageNumber} / 入力行 ${row.pageLine} / BASIC行 ${row.lineNumber ?? "不明"}`);
    appendText(meta, "span", "row-status", row.status);
    card.append(meta);

    if (editingKey === `${row.pageNumber}:${row.pageLine}`) {
      const form = document.createElement("form");
      form.className = "correction-form";
      const input = document.createElement("input");
      input.className = "correction-input";
      input.type = "text";
      input.value = row.sourceText;
      input.setAttribute("aria-label", `ページ${row.pageNumber} 入力行${row.pageLine}の訂正内容`);
      form.append(input);
      const actions = document.createElement("div");
      actions.className = "button-row";
      const save = document.createElement("button");
      save.type = "submit";
      save.textContent = "訂正を反映";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "secondary";
      cancel.textContent = "キャンセル";
      actions.append(save, cancel);
      form.append(actions);
      form.addEventListener("submit", event => {
        event.preventDefault();
        session = correctSourceLine(session, row.pageNumber, row.pageLine, input.value);
        editingKey = null;
        render();
        scheduleSave({ immediate: true });
      });
      cancel.addEventListener("click", () => {
        editingKey = null;
        renderAnalysis();
      });
      card.append(form);
    } else {
      appendText(card, "p", "row-source", row.sourceText);
      if (row.reasons.length) appendText(card, "p", "row-reason", row.reasons.join(" "));
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "correction-button secondary";
      edit.textContent = "訂正";
      edit.disabled = editingPageNumber !== null;
      edit.addEventListener("click", () => {
        editingKey = `${row.pageNumber}:${row.pageLine}`;
        renderAnalysis();
        parsedRows.querySelector(".correction-input")?.focus();
      });
      card.append(edit);
    }

    parsedRows.append(card);
  }

  errorCount.textContent = String(analysis.counts.errors);
  uninterpretedCount.textContent = String(analysis.counts.uninterpreted);
  waitingCount.textContent = String(analysis.counts.referenceWaiting);

  const signal = getProgramSignal(analysis);
  app.dataset.state = signal.state;
  overallStatus.textContent = signal.label;

  completeStatus.textContent = session.complete
    ? "完成：未解決の参照を誤りとして確定しました。入力すると再解析に戻ります。"
    : editingPageNumber !== null
      ? `ページ ${editingPageNumber} のRawを編集中です。保存するとそのページを再解析します。`
      : `入力中：ページ ${session.pages.length + 1} は未区切りです。`;
  completeStatus.dataset.complete = String(session.complete);
  runButton.disabled = session.pages.length === 0 || editingPageNumber !== null;
  renderPages();
  renderHistory();
}

function renderPageEditor() {
  const editing = editingPageNumber !== null;
  sourceLabel.textContent = editing
    ? `ページ ${editingPageNumber} のRawを再編集`
    : `次のページを入力（ページ ${session.pages.length + 1}）`;
  sourceHelp.textContent = editing
    ? "保存すると同じページを更新し、Rawから再解析します。"
    : "行番号の順序は自由です。入力したページは「区切り」で解析します。";
  delimiterButton.textContent = editing ? "このページを更新して再解析" : "区切り";
  cancelPageEditButton.hidden = !editing;
}

function render() {
  source.value = session.draft;
  renderPageEditor();
  renderAnalysis();
}

function scheduleSave({ immediate = false } = {}) {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const persist = () => {
    const snapshot = session;
    saveStatus.textContent = "ブラウザー内に保存中…";
    saveQueue = saveQueue
      .then(() => saveProject(snapshot))
      .then(() => {
        saveStatus.textContent = `ブラウザー内に保存済み（${new Date().toLocaleTimeString()}）`;
      })
      .catch(error => {
        saveStatus.textContent = `ブラウザー内に保存できませんでした: ${error.message} JSONを書き出してください。`;
      });
  };
  if (immediate) persist();
  else saveTimer = setTimeout(persist, 300);
}

function beginPageEdit(page) {
  if (editingPageNumber !== null) return;
  editingKey = null;
  editingPageNumber = page.pageNumber;
  source.value = page.raw;
  renderPageEditor();
  renderAnalysis();
}

function savePageEdit() {
  if (editingPageNumber === null) return;
  const pageNumber = editingPageNumber;
  session = replacePage(session, pageNumber, source.value);
  editingPageNumber = null;
  renderPageEditor();
  scheduleSave({ immediate: true });
}

function setRunning(running) {
  stopButton.disabled = !running;
  source.disabled = running;
  delimiterButton.disabled = running;
  completeButton.disabled = running;
  cancelPageEditButton.disabled = running;
  parsedRows.querySelectorAll("button").forEach(button => {
    button.disabled = running;
  });
  if (!running) runButton.disabled = session.pages.length === 0;
}

function addLogEntry(event) {
  const entry = document.createElement("article");
  entry.className = "log-entry";
  entry.dataset.type = event.type;
  const title = event.type === "skipped"
    ? `#${event.step} · 入力行${event.row.sourceLine} / BASIC行${event.row.lineNumber} · ${event.label}`
    : `#${event.step} · 入力行${event.row.sourceLine} / BASIC行${event.row.lineNumber} · ${event.type === "print" ? "PRINT" : `GOTO ${event.targetLine}`}`;
  appendText(entry, "p", "row-meta", title);
  appendText(entry, "p", "log-source", event.row.sourceText);
  if (event.type === "print") appendText(entry, "p", "log-detail", event.value);
  executionLog.append(entry);

  while (executionLog.children.length > 200) executionLog.firstElementChild.remove();
  executionLog.scrollTop = executionLog.scrollHeight;
}

function showStopCandidate(reason) {
  pendingStopReason = reason;
  stopLocations.replaceChildren();
  suppressForRun.checked = false;
  suppressChoice.hidden = !reason.atCap;

  if (reason.type === "skippedMajority") {
    const percentage = Math.round(reason.skippedRatio * 100);
    stopReason.textContent =
      `ステップ${reason.step}：直近${reason.observedSteps}ステップ中${reason.skippedCount}ステップ（${percentage}%）で、未解釈・誤り・重複の行を飛ばしました。`;
    const shownRows = reason.rows.slice(0, 5);
    for (const row of shownRows) {
      const location = `ページ${row.pageNumber}・入力行${row.pageLine}・BASIC行${row.lineNumber ?? "不明"}（${row.status}）`;
      appendText(stopLocations, "li", "", row.reason ? `${location}：${row.reason}` : location);
    }
    if (reason.rows.length > shownRows.length) {
      appendText(stopLocations, "li", "", `ほか${reason.rows.length - shownRows.length}行`);
    }
  } else {
    stopReason.textContent =
      `ステップ${reason.step}：${reason.stepsWithoutOutput}ステップ連続でPRINT出力がありません。`;
    if (reason.location) {
      appendText(
        stopLocations,
        "li",
        "",
        `直近の位置：ページ${reason.location.pageNumber}・入力行${reason.location.pageLine}・BASIC行${reason.location.lineNumber}`
      );
    }
  }
  if (!stopDialog.open) stopDialog.showModal();
}

function resolveStopDecision(decision) {
  if (!pendingStopReason) return;
  worker.postMessage({
    type: "resolve-stop",
    decision,
    suppressForRun: decision === "continue" && suppressForRun.checked
  });
  if (stopDialog.open) stopDialog.close();
  pendingStopReason = null;
}

function updateSuppressionStatus(suppressedReasons = {}) {
  const activeReasons = [];
  if (suppressedReasons.skippedMajority) activeReasons.push("飛ばした行が多い");
  if (suppressedReasons.noOutput) activeReasons.push("PRINT出力がない");
  suppressionStatus.hidden = activeReasons.length === 0;
  suppressionStatus.textContent = activeReasons.length
    ? `自動確認を抑止中（この実行のみ）：${activeReasons.join("、")}`
    : "";
}

source.addEventListener("input", () => {
  if (editingPageNumber !== null) return;
  session = updateDraft(session, source.value);
  renderAnalysis();
  scheduleSave();
});

delimiterButton.addEventListener("click", () => {
  if (editingPageNumber !== null) {
    savePageEdit();
  } else {
    session = commitPage(session);
  }
  editingKey = null;
  render();
  scheduleSave({ immediate: true });
});

completeButton.addEventListener("click", () => {
  if (editingPageNumber !== null) savePageEdit();
  session = completeProgram(session);
  editingKey = null;
  render();
  scheduleSave({ immediate: true });
});

cancelPageEditButton.addEventListener("click", () => {
  editingPageNumber = null;
  render();
});

runButton.addEventListener("click", () => {
  if (session.pages.length === 0) return;
  executionLog.replaceChildren();
  monitorScreen.textContent = "";
  stepCount.textContent = "0";
  updateSuppressionStatus();
  worker.postMessage({ type: "run", analysis });
  runButton.disabled = true;
  setRunning(true);
});

stopButton.addEventListener("click", () => worker.postMessage({ type: "stop" }));
document.querySelector("#continue-execution-button").addEventListener("click", () => {
  resolveStopDecision("continue");
});
document.querySelector("#stop-execution-button").addEventListener("click", () => {
  resolveStopDecision("stop");
});
stopDialog.addEventListener("cancel", event => event.preventDefault());
document.querySelector("#clear-output-button").addEventListener("click", () => {
  executionLog.replaceChildren();
  monitorScreen.textContent = "";
  stepCount.textContent = "0";
});

worker.addEventListener("message", ({ data }) => {
  if (data.type === "started") return;
  if (data.type === "suppression-state") {
    updateSuppressionStatus(data.suppressedReasons);
    return;
  }
  if (data.type === "stop-candidate") {
    showStopCandidate(data.reason);
    return;
  }
  if (data.type === "event") {
    stepCount.textContent = String(data.steps);
    addLogEntry(data.event);
    if (data.event.type === "print") {
      monitorScreen.textContent += `${data.event.value}\n`;
      monitorScreen.scrollTop = monitorScreen.scrollHeight;
    }
    return;
  }
  if (data.type === "finished" || data.type === "stopped") {
    stepCount.textContent = String(data.steps);
    if (stopDialog.open) stopDialog.close();
    pendingStopReason = null;
    updateSuppressionStatus();
    setRunning(false);
  }
});

worker.addEventListener("error", event => {
  appendText(executionLog, "p", "row-reason", `実行Workerでエラーが発生しました: ${event.message}`);
  setRunning(false);
});

exportProjectButton.addEventListener("click", () => {
  try {
    const exportSession = editingPageNumber === null
      ? session
      : replacePage(session, editingPageNumber, source.value);
    const blob = new Blob([serializeProject(exportSession)], {
      type: "application/json;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `new8bitpc-project-${new Date().toISOString().replaceAll(":", "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    saveStatus.textContent = "プロジェクトJSONを書き出しました。UTF-8・形式バージョン1です。";
  } catch (error) {
    saveStatus.textContent = `JSONを書き出せませんでした: ${error.message}`;
  }
});

importProjectButton.addEventListener("click", () => importProjectFile.click());
importProjectFile.addEventListener("change", async () => {
  const file = importProjectFile.files?.[0];
  importProjectFile.value = "";
  if (!file) return;

  try {
    const bytes = await file.arrayBuffer();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const imported = parseProject(text);
    if (!window.confirm("現在のRaw・未区切り入力・訂正履歴を、選択したJSONの内容で置き換えます。よろしいですか？")) {
      return;
    }
    session = imported.session;
    editingKey = null;
    editingPageNumber = null;
    executionLog.replaceChildren();
    monitorScreen.textContent = "";
    stepCount.textContent = "0";
    render();
    scheduleSave({ immediate: true });
    saveStatus.textContent = "JSONを読み込み、ブラウザー内へ保存しました。";
  } catch (error) {
    saveStatus.textContent = `JSONを読み込めませんでした: ${error.message}`;
  }
});

async function initialize() {
  app.inert = true;
  try {
    const saved = await loadProject();
    if (saved) {
      session = saved.session;
      saveStatus.textContent = saved.savedAt
        ? `ブラウザー内の保存データを読み込みました（${saved.savedAt}）。`
        : "ブラウザー内の保存データを読み込みました。";
    } else {
      await saveProject(session);
      saveStatus.textContent = "新しいプロジェクトをブラウザー内へ保存しました。";
    }
  } catch (error) {
    saveStatus.textContent = `ブラウザー内の保存データを読み込めませんでした: ${error.message} JSONの読み込み・書き出しは利用できます。`;
  }
  render();
  app.inert = false;
  if (!saveStatus.textContent.startsWith("ブラウザー内の保存データを読み込めませんでした:")) {
    scheduleSave({ immediate: true });
  }
}

initialize();
