import { restoreProgramSession } from "./program-session.js";

export const PROJECT_FORMAT = "new8bitpc-mvp-project";
export const PROJECT_FORMAT_VERSION = 1;

const DATABASE_NAME = "new8bitpc-mvp";
const DATABASE_VERSION = 1;
const STORE_NAME = "projects";
const PROJECT_KEY = "active";

function assertString(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label}は文字列である必要があります。`);
}

function validateProject(project) {
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    throw new TypeError("プロジェクトデータの形式が不正です。");
  }
  if (project.format !== PROJECT_FORMAT) {
    throw new TypeError("New8bitPCのプロジェクトJSONではありません。");
  }
  if (project.formatVersion !== PROJECT_FORMAT_VERSION) {
    throw new TypeError(`未対応のデータ形式バージョンです: ${project.formatVersion}`);
  }

  const session = project.session;
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    throw new TypeError("セッションデータがありません。");
  }
  if (!Array.isArray(session.pages)) throw new TypeError("ページ一覧の形式が不正です。");
  session.pages.forEach((page, index) => {
    if (!page || typeof page !== "object" || page.pageNumber !== index + 1) {
      throw new TypeError(`ページ${index + 1}の番号または形式が不正です。`);
    }
    assertString(page.raw, `ページ${index + 1}のRaw`);
  });
  assertString(session.draft, "未区切り入力");
  if (typeof session.complete !== "boolean") {
    throw new TypeError("完成状態の形式が不正です。");
  }
  if (!Array.isArray(session.correctionHistory)) {
    throw new TypeError("訂正履歴の形式が不正です。");
  }
  session.correctionHistory.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`訂正履歴${index + 1}の形式が不正です。`);
    }
    if (typeof item.timestamp !== "string" ||
        !Number.isInteger(item.pageNumber) || item.pageNumber < 1 ||
        !Number.isInteger(item.pageLine) || item.pageLine < 1) {
      throw new TypeError(`訂正履歴${index + 1}の日時または位置が不正です。`);
    }
    assertString(item.before, `訂正履歴${index + 1}の変更前`);
    assertString(item.after, `訂正履歴${index + 1}の変更後`);
    if (!["human", "ai(承認つき)"].includes(item.changedBy ?? "human")) {
      throw new TypeError(`訂正履歴${index + 1}の変更者が不正です。`);
    }
  });
}

export function createProjectData(session, savedAt = new Date().toISOString()) {
  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    savedAt,
    session: {
      pages: session.pages.map(page => ({
        pageNumber: page.pageNumber,
        raw: page.raw
      })),
      draft: session.draft,
      complete: session.complete,
      correctionHistory: session.correctionHistory.map(item => ({
        timestamp: item.timestamp,
        pageNumber: item.pageNumber,
        pageLine: item.pageLine,
        before: item.before,
        after: item.after,
        changedBy: item.changedBy ?? "human"
      }))
    }
  };
}

export function serializeProject(session, savedAt) {
  const project = createProjectData(session, savedAt);
  validateProject(project);
  return `${JSON.stringify(project, null, 2)}\n`;
}

export function parseProject(text) {
  assertString(text, "JSONデータ");
  const project = JSON.parse(text);
  validateProject(project);
  return {
    savedAt: project.savedAt ?? null,
    session: restoreProgramSession(project.session)
  };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("このブラウザーではIndexedDBを利用できません。JSONへ書き出して保存してください。"));
      return;
    }

    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("保存領域を開けませんでした。")), { once: true });
    request.addEventListener("blocked", () => reject(new Error("別のタブが保存領域の更新を妨げています。")), { once: true });
  });
}

async function withStore(mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    let result;
    try {
      result = operation(store);
    } catch (error) {
      database.close();
      reject(error);
      return;
    }
    transaction.addEventListener("complete", () => {
      database.close();
      resolve(result?.result);
    }, { once: true });
    transaction.addEventListener("abort", () => {
      database.close();
      reject(transaction.error ?? new Error("保存処理が中断されました。"));
    }, { once: true });
    transaction.addEventListener("error", () => {
      database.close();
      reject(transaction.error ?? new Error("保存処理に失敗しました。"));
    }, { once: true });
  });
}

export async function saveProject(session) {
  const project = createProjectData(session);
  validateProject(project);
  await withStore("readwrite", store => store.put(project, PROJECT_KEY));
}

export async function loadProject() {
  const project = await withStore("readonly", store => store.get(PROJECT_KEY));
  if (project === undefined) return null;
  validateProject(project);
  return {
    savedAt: project.savedAt ?? null,
    session: restoreProgramSession(project.session)
  };
}

export async function deleteSavedProject() {
  await withStore("readwrite", store => store.delete(PROJECT_KEY));
}
