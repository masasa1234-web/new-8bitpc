import test from "node:test";
import assert from "node:assert/strict";
import { analyzeProgram } from "../src/basic.js";

test("stopping during INPUT wait clears the pending request for a rerun", async t => {
  const previousSelf = globalThis.self;
  const listeners = new Map();
  const messages = [];
  globalThis.self = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    postMessage(message) {
      messages.push(message);
    }
  };
  t.after(() => {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  });

  const workerUrl = new URL("../app/execution-worker.js", import.meta.url);
  await import(`${workerUrl.href}?test=${Date.now()}`);
  const send = data => listeners.get("message")({ data });
  const waitFor = async (fromIndex, predicate) => {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(
        (message, messageIndex) => messageIndex >= fromIndex && predicate(message)
      );
      if (index >= 0) return { index, message: messages[index] };
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error("Timed out waiting for the worker message");
  };
  const analysis = analyzeProgram("10 INPUT A\n20 END");

  send({ type: "run", analysis });
  const firstWait = await waitFor(0, message => message.type === "input-wait");
  send({ type: "stop" });
  const stopped = await waitFor(firstWait.index + 1, message => message.type === "stopped");
  assert.equal(stopped.message.reason, "manual");

  const rerunStart = messages.length;
  send({ type: "run", analysis });
  const rerunWait = await waitFor(rerunStart, message => message.type === "input-wait");
  assert.equal(
    messages.slice(rerunStart, rerunWait.index + 1)
      .filter(message => message.type === "input-wait").length,
    1
  );
  assert.equal(
    messages.slice(rerunStart).some(message =>
      message.type === "input-complete" || message.type === "input-invalid"
    ),
    false
  );
  send({ type: "stop" });
});
