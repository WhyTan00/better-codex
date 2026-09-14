import test from "node:test";
import assert from "node:assert/strict";
import {
  assertConnectionState,
  createCacheSnapshot,
  isNewerVersion,
} from "../src/index.mjs";

test("cache snapshots are bounded and versionable", () => {
  const snapshot = createCacheSnapshot({ version: 4, pinnedCount: 2 });
  assert.equal(snapshot.version, 4);
  assert.equal(snapshot.pinnedCount, 2);
  assert.equal(isNewerVersion(5, snapshot.version), true);
  assert.equal(isNewerVersion(4, snapshot.version), false);
});

test("connection states are explicit", () => {
  assert.equal(assertConnectionState("connected"), "connected");
  assert.throws(() => assertConnectionState("maybe"), /Unknown connection state/);
});
