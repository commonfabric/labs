// `Deno.FsFile` methods `@deno/shim-deno` leaves unimplemented: `sync`,
// `syncSync`, and the advisory locks (`lock`, `lockSync`, `unlock`,
// `unlockSync`).
//
// Node has no `flock()`, so a lock here excludes only other `FsFile`s in this
// process, keyed by the file's device and inode, as `flock()` treats two
// descriptors of one file. Another process is not excluded. Where Deno's
// `lockSync()` would block forever on a lock this thread already holds
// through another descriptor, this one throws instead; `lock()` waits for the
// holder to unlock or close.

import * as fs from "node:fs";

/** Per-inode lock state: an exclusive holder, or shared holders, and waiters. */
const locks = new Map();

/** The lock key and mode each locked file holds. */
const held = new WeakMap();

function keyOf(file) {
  const stat = fs.fstatSync(file.rid);
  return `${stat.dev}:${stat.ino}`;
}

function stateFor(key) {
  let state = locks.get(key);
  if (!state) {
    state = { exclusive: null, shared: new Set(), waiters: [] };
    locks.set(key, state);
  }
  return state;
}

function canAcquire(state, file, exclusive) {
  const others = [...state.shared].some((f) => f !== file);
  if (state.exclusive && state.exclusive !== file) return false;
  return exclusive ? !others : true;
}

function acquire(state, key, file, exclusive) {
  release(file);
  if (exclusive) state.exclusive = file;
  else state.shared.add(file);
  held.set(file, { key, exclusive });
}

function release(file) {
  const holding = held.get(file);
  if (!holding) return;
  held.delete(file);
  const state = locks.get(holding.key);
  if (state.exclusive === file) state.exclusive = null;
  state.shared.delete(file);
  const waiters = state.waiters.splice(0);
  for (const wake of waiters) wake();
  if (!state.exclusive && state.shared.size === 0 && !state.waiters.length) {
    locks.delete(holding.key);
  }
}

const proto = globalThis.Deno.FsFile.prototype;
const close = proto.close;

proto.lockSync = function lockSync(exclusive = false) {
  const key = keyOf(this);
  const state = stateFor(key);
  if (!canAcquire(state, this, exclusive)) {
    throw new Error(
      "Deno.FsFile.lockSync: the file is locked through another descriptor " +
        "in this process, which would block forever",
    );
  }
  acquire(state, key, this, exclusive);
};

proto.lock = async function lock(exclusive = false) {
  const key = keyOf(this);
  for (;;) {
    const state = stateFor(key);
    if (canAcquire(state, this, exclusive)) {
      acquire(state, key, this, exclusive);
      return;
    }
    await new Promise((resolve) => state.waiters.push(resolve));
  }
};

proto.unlockSync = function unlockSync() {
  release(this);
};

proto.unlock = function unlock() {
  release(this);
  return Promise.resolve();
};

proto.syncSync = function syncSync() {
  fs.fsyncSync(this.rid);
};

proto.sync = function sync() {
  return new Promise((resolve, reject) => {
    fs.fsync(this.rid, (error) => error ? reject(error) : resolve());
  });
};

proto.close = function closeAndUnlock() {
  release(this);
  return close.call(this);
};
