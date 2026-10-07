import assert from "node:assert/strict";
import test from "node:test";
import { buildFactoryProjectActivity, buildProjectRepositoryActivity } from "../project-activity.mjs";

test("factory project activity groups jobs, progress and todos by day and worker", () => {
  const today = new Date().toISOString();
  const project = {
    progress: [{ updatedAt: today, owner: "牛来" }],
    todos: [{ updatedAt: today, owner: "派派" }],
  };
  const report = buildFactoryProjectActivity(project, [
    { updatedAt: today, worker: "牛来" },
    { createdAt: today, worker: "柯南" },
  ]);
  assert.equal(report.total, 4);
  assert.equal(report.days.at(-1).count, 4);
  assert.deepEqual(report.contributors.map((item) => [item.name, item.total]), [
    ["牛来", 2],
    ["柯南", 1],
    ["派派", 1],
  ]);
});

test("repository activity exposes configured GitHub links without requiring a local clone", () => {
  const report = buildProjectRepositoryActivity({
    links: [{ type: "repo", ref: "https://github.com/tettat/ox-factory-pi-extension.git" }],
  }, { baseDir: process.cwd() });
  assert.equal(report.available, false);
  assert.deepEqual(report.remoteUrls, ["https://github.com/tettat/ox-factory-pi-extension"]);
  assert.equal(report.localBranches.total, 0);
  assert.equal(report.mainline.total, 0);
});
