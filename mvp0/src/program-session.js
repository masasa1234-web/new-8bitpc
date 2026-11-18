import { analyzePages, RowStatus } from "./basic.js";

function buildSession(pages, draft, complete, correctionHistory) {
  return {
    pages,
    draft,
    complete,
    correctionHistory,
    analysis: analyzePages(pages.map(page => page.raw), { complete })
  };
}

export function restoreProgramSession({ pages, draft = "", complete = false, correctionHistory = [] }) {
  const restoredPages = pages.map((page, index) => ({
    pageNumber: index + 1,
    raw: page.raw
  }));
  const restoredHistory = correctionHistory.map(item => ({
    timestamp: item.timestamp,
    pageNumber: item.pageNumber,
    pageLine: item.pageLine,
    before: item.before,
    after: item.after,
    changedBy: item.changedBy ?? "human"
  }));
  return buildSession(restoredPages, draft, complete, restoredHistory);
}

export function createProgramSession(initialDraft = "") {
  return buildSession([], initialDraft, false, []);
}

export function updateDraft(session, draft) {
  return buildSession(session.pages, draft, false, session.correctionHistory);
}

export function commitPage(session) {
  if (session.draft.length === 0) return session;
  const pages = [...session.pages, {
    pageNumber: session.pages.length + 1,
    raw: session.draft
  }];
  return buildSession(pages, "", false, session.correctionHistory);
}

function lineText(line) {
  return line.replace(/(\r\n|\n|\r)$/, "");
}

function lineEnding(line) {
  return /(\r\n|\n|\r)$/.exec(line)?.[0] ?? "";
}

function findUnchangedLines(before, after) {
  const lengths = Array.from(
    { length: before.length + 1 },
    () => new Uint32Array(after.length + 1)
  );

  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lengths[beforeIndex][afterIndex] = before[beforeIndex] === after[afterIndex]
        ? lengths[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(lengths[beforeIndex + 1][afterIndex], lengths[beforeIndex][afterIndex + 1]);
    }
  }

  const matches = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length && afterIndex < after.length) {
    if (before[beforeIndex] === after[afterIndex]) {
      matches.push({ beforeIndex, afterIndex });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (lengths[beforeIndex + 1][afterIndex] >= lengths[beforeIndex][afterIndex + 1]) {
      beforeIndex += 1;
    } else {
      afterIndex += 1;
    }
  }
  return matches;
}

export function replacePage(session, pageNumber, raw, timestamp = new Date().toISOString(), changedBy = "human") {
  const pageIndex = session.pages.findIndex(page => page.pageNumber === pageNumber);
  if (pageIndex === -1) throw new RangeError(`ページ${pageNumber}が見つかりません。`);
  const page = session.pages[pageIndex];
  const beforeRawLines = splitLinesWithEndings(page.raw);
  const afterRawLines = splitLinesWithEndings(raw);
  const beforeLines = beforeRawLines.map(lineText);
  const afterLines = afterRawLines.map(lineText);
  const matches = findUnchangedLines(beforeLines, afterLines);
  for (const match of matches) {
    afterRawLines[match.afterIndex] =
      `${afterLines[match.afterIndex]}${lineEnding(beforeRawLines[match.beforeIndex])}`;
  }
  const preservedRaw = afterRawLines.join("");
  if (page.raw === preservedRaw) {
    return buildSession(session.pages, session.draft, false, session.correctionHistory);
  }

  const history = [...session.correctionHistory];

  const recordUnmatchedLines = (beforeEnd, afterEnd, beforeStart, afterStart) => {
    const changedLineCount = Math.min(beforeEnd - beforeStart, afterEnd - afterStart);
    for (let offset = 0; offset < changedLineCount; offset += 1) {
      history.push({
        timestamp,
        pageNumber,
        pageLine: beforeStart + offset + 1,
        before: beforeLines[beforeStart + offset],
        after: afterLines[afterStart + offset],
        changedBy
      });
    }
    for (let index = beforeStart + changedLineCount; index < beforeEnd; index += 1) {
      history.push({
        timestamp,
        pageNumber,
        pageLine: index + 1,
        before: beforeLines[index],
        after: "",
        changedBy
      });
    }
    for (let index = afterStart + changedLineCount; index < afterEnd; index += 1) {
      history.push({
        timestamp,
        pageNumber,
        pageLine: index + 1,
        before: "",
        after: afterLines[index],
        changedBy
      });
    }
  };

  let beforeStart = 0;
  let afterStart = 0;
  for (const match of [...matches, { beforeIndex: beforeLines.length, afterIndex: afterLines.length }]) {
    recordUnmatchedLines(match.beforeIndex, match.afterIndex, beforeStart, afterStart);
    beforeStart = match.beforeIndex + 1;
    afterStart = match.afterIndex + 1;
  }

  const pages = session.pages.map((item, index) =>
    index === pageIndex ? { ...item, raw: preservedRaw } : item
  );
  return buildSession(pages, session.draft, false, history);
}

export function completeProgram(session) {
  const committed = commitPage(session);
  return buildSession(committed.pages, "", true, committed.correctionHistory);
}

export function getProgramSignal(analysis) {
  if (analysis.counts.errors > 0) return { state: "warning", label: "警告" };
  if (analysis.counts.uninterpreted > 0 || analysis.counts.referenceWaiting > 0) {
    return { state: "attention", label: "注意" };
  }
  return { state: "normal", label: "通常" };
}

export function getDelimiterAttention(analysis, pageNumber) {
  const rows = analysis.rows.filter(row => row.pageNumber === pageNumber);
  const total = rows.length;
  const uninterpreted = rows.filter(row => row.status === RowStatus.uninterpreted).length;
  if (total === 0 || (uninterpreted !== total && (total < 5 || uninterpreted <= total / 2))) {
    return null;
  }
  return { pageNumber, total, uninterpreted };
}

function splitLinesWithEndings(raw) {
  const parts = raw.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [];
  return parts.filter(part => part.length > 0);
}

export function correctSourceLine(session, pageNumber, pageLine, correctedText, timestamp = new Date().toISOString(), changedBy = "human") {
  const pageIndex = session.pages.findIndex(page => page.pageNumber === pageNumber);
  if (pageIndex === -1) throw new RangeError(`ページ${pageNumber}が見つかりません。`);

  const page = session.pages[pageIndex];
  const lines = splitLinesWithEndings(page.raw);
  if (!Number.isInteger(pageLine) || pageLine < 1 || pageLine > lines.length) {
    throw new RangeError(`ページ${pageNumber}の入力行${pageLine}が見つかりません。`);
  }

  const previous = lines[pageLine - 1];
  const ending = /(\r\n|\n|\r)$/.exec(previous)?.[0] ?? "";
  const before = previous.slice(0, previous.length - ending.length);
  if (before === correctedText) return session;

  lines[pageLine - 1] = `${correctedText}${ending}`;
  const pages = session.pages.map((item, index) =>
    index === pageIndex ? { ...item, raw: lines.join("") } : item
  );
  const correction = {
    timestamp,
    pageNumber,
    pageLine,
    before,
    after: correctedText,
    changedBy
  };
  return buildSession(pages, session.draft, false, [...session.correctionHistory, correction]);
}
