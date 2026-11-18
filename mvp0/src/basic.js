export const RowStatus = Object.freeze({
  understood: "理解済み",
  error: "誤り",
  uninterpreted: "未解釈",
  referenceWaiting: "参照待ち"
});

function parseStatement(text) {
  const commandMatch = /^([A-Za-z]+)/.exec(text.trimStart());
  if (!commandMatch) {
    return {
      status: RowStatus.error,
      reason: "命令の書式を読み取れません。"
    };
  }

  const commandText = commandMatch[1];
  const command = commandText.toUpperCase();
  const argument = text.trimStart().slice(commandText.length).trim();

  if (command === "PRINT") {
    if (!argument) {
      return { status: RowStatus.error, reason: "PRINTの内容がありません。" };
    }
    if (/^"(?:[^"]|"")*"$/.test(argument)) {
      return {
        status: RowStatus.understood,
        instruction: { type: "print", value: argument.slice(1, -1).replaceAll('""', '"') }
      };
    }
    if (argument.startsWith('"')) {
      return { status: RowStatus.error, reason: "PRINTの文字列リテラルが閉じていません。" };
    }
    return {
      status: RowStatus.uninterpreted,
      reason: "0段階ではPRINTの文字列リテラル以外は未対応です。"
    };
  }

  if (command === "GOTO") {
    if (!/^\d+$/.test(argument)) {
      return { status: RowStatus.error, reason: "GOTOの行番号が不正です。" };
    }
    const targetLine = Number(argument);
    if (!Number.isSafeInteger(targetLine)) {
      return { status: RowStatus.error, reason: "GOTOの行番号が安全な整数の範囲外です。" };
    }
    return {
      status: RowStatus.understood,
      instruction: { type: "goto", targetLine }
    };
  }

  return {
    status: RowStatus.uninterpreted,
    reason: `命令「${commandText}」は0段階では未対応です。`
  };
}

function parseRow(sourceText, sourceLine, pageNumber, pageLine) {
  if (!sourceText.trim()) return null;

  const match = /^\s*(\d+)([\s\S]*)$/.exec(sourceText);
  if (!match) {
    return {
      sourceLine,
      pageNumber,
      pageLine,
      sourceText,
      lineNumber: null,
      status: RowStatus.error,
      reasons: ["行番号が不正です。"],
      duplicate: false,
      instruction: null
    };
  }

  const lineNumber = Number(match[1]);
  if (!Number.isSafeInteger(lineNumber)) {
    return {
      sourceLine,
      pageNumber,
      pageLine,
      sourceText,
      lineNumber: null,
      status: RowStatus.error,
      reasons: ["行番号が安全な整数の範囲外です。"],
      duplicate: false,
      instruction: null
    };
  }

  const statement = match[2].trimStart();
  if (!statement.trim()) {
    return {
      sourceLine,
      pageNumber,
      pageLine,
      sourceText,
      lineNumber,
      status: RowStatus.error,
      reasons: ["行番号の後に命令がありません。"],
      duplicate: false,
      instruction: null
    };
  }

  const parsed = parseStatement(statement);
  return {
    sourceLine,
    pageNumber,
    pageLine,
    sourceText,
    lineNumber,
    status: parsed.status,
    reasons: parsed.reason ? [parsed.reason] : [],
    duplicate: false,
    instruction: parsed.instruction ?? null,
    jumpTargetSourceLine: null
  };
}

function getSourceLines(raw) {
  if (raw.length === 0) return [];
  const lines = raw.split(/\r\n|\n|\r/);
  if (/(\r\n|\n|\r)$/.test(raw)) lines.pop();
  return lines;
}

function analyzePagesInternal(pages, { complete = false } = {}) {
  let sourceLine = 0;
  const rows = [];
  for (const page of pages) {
    const lines = getSourceLines(page.raw);
    lines.forEach((text, index) => {
      const row = parseRow(text, sourceLine + index + 1, page.pageNumber, index + 1);
      if (row) rows.push(row);
    });
    sourceLine += lines.length;
  }

  const rowsByNumber = new Map();

  for (const row of rows) {
    if (row.lineNumber === null) continue;
    const group = rowsByNumber.get(row.lineNumber) ?? [];
    group.push(row);
    rowsByNumber.set(row.lineNumber, group);
  }

  for (const [lineNumber, group] of rowsByNumber) {
    if (group.length < 2) continue;
    const sourcePositions = group.map(row => `入力行${row.sourceLine}`).join("、");
    const pagePositions = group
      .map(row => `ページ${row.pageNumber}の入力行${row.pageLine}`)
      .join("、");
    for (const row of group) {
      row.duplicate = true;
      row.status = RowStatus.error;
      row.reasons.push(`行番号${lineNumber}が重複しています（${sourcePositions}；${pagePositions}）。`);
    }
  }

  for (const row of rows) {
    if (row.status !== RowStatus.understood || row.instruction?.type !== "goto") continue;
    const targets = rowsByNumber.get(row.instruction.targetLine) ?? [];
    if (targets.length > 1) {
      row.status = RowStatus.error;
      row.reasons.push(`ジャンプ先の行番号${row.instruction.targetLine}が重複しているため、参照先を特定できません。`);
    } else if (targets.length === 0) {
      if (complete) {
        row.status = RowStatus.error;
        row.reasons.push(`ジャンプ先の行番号${row.instruction.targetLine}がありません。`);
      } else {
        row.status = RowStatus.referenceWaiting;
        row.reasons.push(`ジャンプ先の行番号${row.instruction.targetLine}を待っています。`);
      }
    } else {
      row.jumpTargetSourceLine = targets[0].sourceLine;
    }
  }

  const timeline = rows
    .filter(row => row.lineNumber !== null)
    .toSorted((left, right) => left.lineNumber - right.lineNumber || left.sourceLine - right.sourceLine)
    .map(row => ({ ...row }));
  const executable = timeline
    .filter(row => row.status === RowStatus.understood)
    .map(row => ({
      sourceLine: row.sourceLine,
      lineNumber: row.lineNumber,
      instruction: row.instruction,
      jumpTargetSourceLine: row.jumpTargetSourceLine
    }));

  const counts = {
    errors: rows.filter(row => row.status === RowStatus.error).length,
    uninterpreted: rows.filter(row => row.status === RowStatus.uninterpreted).length,
    referenceWaiting: rows.filter(row => row.status === RowStatus.referenceWaiting).length
  };

  const pageCounts = pages.map(page => {
    const pageRows = rows.filter(row => row.pageNumber === page.pageNumber);
    return {
      pageNumber: page.pageNumber,
      errors: pageRows.filter(row => row.status === RowStatus.error).length,
      uninterpreted: pageRows.filter(row => row.status === RowStatus.uninterpreted).length,
      referenceWaiting: pageRows.filter(row => row.status === RowStatus.referenceWaiting).length
    };
  });

  return {
    rawPages: pages.map(page => page.raw),
    complete,
    rows,
    counts,
    pageCounts,
    timeline,
    executable,
    patchCandidates: []
  };
}

export function analyzePages(pages, options = {}) {
  return analyzePagesInternal(
    pages.map((raw, index) => ({ pageNumber: index + 1, raw })),
    options
  );
}

export function analyzeProgram(raw, options = {}) {
  const analysis = analyzePagesInternal([{ pageNumber: 1, raw }], options);
  return { raw, ...analysis };
}

export function createExecutionState() {
  return { position: 0, steps: 0, done: false };
}

export function advanceExecution(analysis, state) {
  if (state.done || state.position >= analysis.timeline.length) {
    return { state: { ...state, done: true }, event: null };
  }

  const row = analysis.timeline[state.position];
  const steps = state.steps + 1;
  let position = state.position + 1;
  let event;

  if (row.status !== RowStatus.understood) {
    const label = row.duplicate
      ? "重複のため実行対象外"
      : `${row.status}：${row.reasons.join(" ")}`;
    event = { type: "skipped", row, label, step: steps };
  } else if (row.instruction.type === "print") {
    event = { type: "print", row, value: row.instruction.value, step: steps };
  } else {
    event = {
      type: "goto",
      row,
      targetLine: row.instruction.targetLine,
      step: steps
    };
    const targetPosition = analysis.timeline.findIndex(
      target => target.sourceLine === row.jumpTargetSourceLine
    );
    if (targetPosition !== -1) position = targetPosition;
  }

  return {
    state: { position, steps, done: false },
    event
  };
}

/**
 * @typedef {Object} AiPort
 * @property {(request: { raw: string, rows: object[] }) => Promise<object[]>} proposePatches
 */
