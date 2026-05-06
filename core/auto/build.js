import fs from "fs";

// JSON 読み込み
const load = (path) => JSON.parse(fs.readFileSync(path, "utf-8"));
const save = (path, data) => fs.writeFileSync(path, JSON.stringify(data, null, 2));

// パス
const driftPath = "whiteboard/drift.json";
const fragmentPath = "whiteboard/fragment_pool.json";
const bridgePath = "whiteboard/tune_bridge.json";

// 1. drift を読み込む
const drift = load(driftPath);
const driftValue = drift.variance ?? 0.1;

// 2. fragment_pool を読み込む
const fragmentPool = load(fragmentPath);

// drift に応じて fragment を自動追加
if (driftValue > 0.15) {
  fragmentPool.fragments.push({
    id: `culture_auto_${Date.now()}`,
    type: "culture",
    purity: 0.55,
    weight: 0.15,
    origin: "auto_build",
    note: "自動生成された文化的残滓"
  });
}

// 3. tune_bridge を読み込む
const bridge = load(bridgePath);

// fragment の純度平均を計算
const purityAvg =
  fragmentPool.fragments.reduce((a, f) => a + f.purity, 0) /
  fragmentPool.fragments.length;

// Tune の出現条件を自動調整
bridge.tune_presence_conditions.required_purity_avg = purityAvg * 0.9;

// 4. 保存
save(fragmentPath, fragmentPool);
save(bridgePath, bridge);

console.log("auto-build completed.");
