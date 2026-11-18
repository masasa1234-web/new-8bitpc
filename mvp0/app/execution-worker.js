import { advanceExecution, createExecutionState } from "../src/basic.js";

let runId = 0;
let active = false;
let currentSteps = 0;

self.addEventListener("message", async ({ data }) => {
  if (data.type === "stop") {
    active = false;
    self.postMessage({ type: "stopped", steps: currentSteps });
    return;
  }

  if (data.type !== "run") return;

  active = true;
  const thisRun = ++runId;
  let state = createExecutionState();
  currentSteps = 0;
  self.postMessage({ type: "started" });

  while (active && thisRun === runId) {
    const result = advanceExecution(data.analysis, state);
    state = result.state;
    currentSteps = state.steps;

    if (!result.event) {
      active = false;
      self.postMessage({ type: "finished", steps: state.steps });
      return;
    }

    self.postMessage({ type: "event", event: result.event, steps: state.steps });
    await new Promise(resolve => setTimeout(resolve, 0));
  }
});
