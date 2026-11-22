export const DEFAULT_STOP_SETTINGS = Object.freeze({
  skippedRatioThreshold: 0.5,
  minimumObservedSteps: 10,
  skippedWindowSteps: 20,
  noOutputSteps: 500,
  maxSkippedRecheckSteps: 160,
  maxNoOutputRecheckSteps: 4000
});

function isCountedSkip(row, complete) {
  if (row.status === "参照待ち" && !complete) return false;
  return row.status === "未解釈" || row.status === "誤り" || row.duplicate;
}

function describeSkippedRows(window) {
  const rows = new Map();
  for (const item of window) {
    if (!item.skipped) continue;
    const row = item.event.row;
    const key = `${row.pageNumber}:${row.pageLine}:${row.lineNumber}`;
    if (!rows.has(key)) {
      rows.set(key, {
        pageNumber: row.pageNumber,
        pageLine: row.pageLine,
        lineNumber: row.lineNumber,
        status: row.status,
        reason: row.reasons.join(" ")
      });
    }
  }
  return [...rows.values()];
}

export function createStopPolicyState(settings = DEFAULT_STOP_SETTINGS) {
  return {
    steps: 0,
    stepsSinceOutput: 0,
    skippedWindow: [],
    skippedRecheckSteps: settings.skippedWindowSteps,
    noOutputRecheckSteps: settings.noOutputSteps,
    nextSkippedCheckAt: settings.minimumObservedSteps,
    nextNoOutputCheckAt: settings.noOutputSteps,
    suppressedReasons: {
      skippedMajority: false,
      noOutput: false
    }
  };
}

export function observeExecutionStep(previous, event, complete, settings = DEFAULT_STOP_SETTINGS) {
  const steps = previous.steps + 1;
  const countedSkip = event.type === "skipped" && isCountedSkip(event.row, complete);
  const skippedWindow = [
    ...previous.skippedWindow,
    { event, skipped: countedSkip, counted: !(event.row?.status === "参照待ち" && !complete) }
  ].slice(-settings.skippedWindowSteps);
  const countedWindow = skippedWindow.filter(item => item.counted);
  const skippedCount = countedWindow.filter(item => item.skipped).length;
  const skippedRatio = countedWindow.length === 0 ? 0 : skippedCount / countedWindow.length;
  const highSkipRate =
    countedWindow.length >= settings.minimumObservedSteps &&
    skippedRatio >= settings.skippedRatioThreshold;

  let noOutputRecheckSteps = previous.noOutputRecheckSteps;
  let nextNoOutputCheckAt = previous.nextNoOutputCheckAt;
  const clearsNoOutputCounter =
    event.type === "print" || event.type === "cls" || event.type === "input-wait";
  const stepsSinceOutput = clearsNoOutputCounter ? 0 : previous.stepsSinceOutput + 1;
  if (clearsNoOutputCounter) {
    noOutputRecheckSteps = settings.noOutputSteps;
    nextNoOutputCheckAt = steps + settings.noOutputSteps;
  }

  const state = {
    ...previous,
    steps,
    stepsSinceOutput,
    skippedWindow,
    noOutputRecheckSteps,
    nextNoOutputCheckAt
  };

  if (!highSkipRate) {
    state.skippedRecheckSteps = settings.skippedWindowSteps;
    state.nextSkippedCheckAt = countedWindow.length < settings.minimumObservedSteps
      ? settings.minimumObservedSteps
      : steps + settings.skippedWindowSteps;
  } else if (
    !state.suppressedReasons.skippedMajority &&
    steps >= state.nextSkippedCheckAt
  ) {
    return {
      state,
      stop: {
        type: "skippedMajority",
        step: steps,
        observedSteps: countedWindow.length,
        skippedCount,
        skippedRatio,
        rows: describeSkippedRows(skippedWindow),
        recheckInterval: state.skippedRecheckSteps,
        atCap: state.skippedRecheckSteps >= settings.maxSkippedRecheckSteps
      }
    };
  }

  if (
    !state.suppressedReasons.noOutput &&
    steps >= state.nextNoOutputCheckAt
  ) {
    const latest = event.row;
    return {
      state,
      stop: {
        type: "noOutput",
        step: steps,
        stepsWithoutOutput: state.stepsSinceOutput,
        recheckInterval: state.noOutputRecheckSteps,
        atCap: state.noOutputRecheckSteps >= settings.maxNoOutputRecheckSteps,
        location: latest ? {
          pageNumber: latest.pageNumber,
          pageLine: latest.pageLine,
          lineNumber: latest.lineNumber
        } : null
      }
    };
  }

  return { state, stop: null };
}

export function continueAfterStop(previous, stop, suppressForRun, settings = DEFAULT_STOP_SETTINGS) {
  const state = {
    ...previous,
    suppressedReasons: { ...previous.suppressedReasons }
  };

  if (stop.type === "skippedMajority") {
    if (suppressForRun) {
      state.suppressedReasons.skippedMajority = true;
    } else {
      state.skippedRecheckSteps = Math.min(
        state.skippedRecheckSteps * 2,
        settings.maxSkippedRecheckSteps
      );
      state.nextSkippedCheckAt = state.steps + state.skippedRecheckSteps;
    }
  } else if (stop.type === "noOutput") {
    if (suppressForRun) {
      state.suppressedReasons.noOutput = true;
    } else {
      state.noOutputRecheckSteps = Math.min(
        state.noOutputRecheckSteps * 2,
        settings.maxNoOutputRecheckSteps
      );
      state.nextNoOutputCheckAt = state.steps + state.noOutputRecheckSteps;
    }
  }
  return state;
}
