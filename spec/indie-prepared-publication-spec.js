const timers = require("node:timers");

describe("Indie prepared publication integration", () => {
  const file = "/prepared-indie.py";
  const otherFile = "/prepared-other.py";
  let registry, delegate, updates, hooks, linter, pending;
  const message = (excerpt, path = file) => ({
    severity: "warning",
    excerpt,
    location: {
      file: path,
      position: [
        [0, 0],
        [0, 1],
      ],
    },
  });
  const until = async (condition) => {
    for (let turn = 0; turn < 500; turn++) {
      if (condition()) return;
      await new Promise((resolve) => timers.setImmediate(resolve));
    }
    throw new Error("The publication did not reach its preparation hook");
  };
  const start = (messages, options) => {
    const result = delegate.setMessagesAsync(file, messages, options);
    pending.push(result);
    return result;
  };
  const finish = (index, token = Object.freeze({})) => {
    hooks[index].resolve(token);
    return token;
  };

  beforeEach(() => {
    jasmine.useRealClock();
    pending = [];
    hooks = [];
    updates = [];
    const IndieRegistry = require("../lib/indie-registry");
    registry = new IndieRegistry(
      (event, work) =>
        new Promise((resolve, reject) => {
          hooks.push({ event, work, resolve, reject });
        }),
    );
    delegate = registry.register({ name: "prepared integration" }, 2);
    registry.onDidUpdate((event) => updates.push(event));
  });

  afterEach(async () => {
    registry.dispose();
    linter?.dispose();
    linter = null;
    for (const hook of hooks) hook.resolve(null);
    await Promise.allSettled(pending);
  });

  it("hands the same combined snapshot, affected files and token through the registry", async () => {
    delegate.setMessages(otherFile, [message("other", otherFile)]);
    updates.length = 0;
    const work = start([message("new")]);
    await until(() => hooks.length === 1);
    expect(updates.length).toBe(0);
    expect(delegate.getMessages().map((item) => item.excerpt)).toEqual(["other"]);
    expect(hooks[0].event.linter).toBe(delegate);
    expect(hooks[0].work.current()).toBeTrue();
    const token = finish(0);
    expect(await work).toBeTrue();
    expect(updates.length).toBe(1);
    expect(updates[0].messages).toBe(hooks[0].event.messages);
    expect(updates[0].affectedFiles).toBe(hooks[0].event.affectedFiles);
    expect(updates[0].preparation).toBe(token);
    expect(updates[0].messages.map((item) => item.excerpt)).toEqual(["other", "new"]);
    expect(Object.keys(updates[0].messages)).toEqual(["0", "1"]);
  });

  it("cancels during the hook without publishing its prepared snapshot", async () => {
    const controller = new AbortController();
    const work = start([message("cancelled")], { signal: controller.signal });
    await until(() => hooks.length === 1);
    controller.abort();
    expect(hooks[0].work.current()).toBeFalse();
    finish(0);
    expect(await work).toBeFalse();
    expect(delegate.getMessages()).toEqual([]);
    expect(updates).toEqual([]);
    expect(delegate.pendingPreparations.size).toBe(0);
  });

  it("keeps a newer synchronous clear authoritative over a pending hook", async () => {
    const work = start([message("cancelled")]);
    await until(() => hooks.length === 1);
    delegate.setMessages(file, []);
    expect(hooks[0].work.current()).toBeFalse();
    finish(0);
    expect(await work).toBeFalse();
    expect(updates.length).toBe(1);
    expect(updates[0].messages).toEqual([]);
    expect(updates[0].preparation).toBeUndefined();
  });

  it("reprepares after another file changes while the combined snapshot is pending", async () => {
    delegate.setMessages(otherFile, [message("old other", otherFile)]);
    const work = start([message("new")]);
    await until(() => hooks.length === 1);
    delegate.setMessages(otherFile, [message("latest other", otherFile)]);
    const oldToken = finish(0);
    await until(() => hooks.length === 2);
    expect(hooks[1].event.messages).not.toBe(hooks[0].event.messages);
    expect(hooks[1].event.messages.map((item) => item.excerpt)).toEqual(["latest other", "new"]);
    const token = finish(1);
    expect(await work).toBeTrue();
    expect(updates.at(-1).preparation).toBe(token);
    expect(updates.every((event) => event.preparation !== oldToken)).toBeTrue();
    expect(delegate.getMessages().map((item) => item.excerpt)).toEqual(["latest other", "new"]);
  });

  it("reprepares when another file is removed during preparation", async () => {
    delegate.setMessages(otherFile, [message("removed", otherFile)]);
    const work = start([message("new")]);
    await until(() => hooks.length === 1);
    delegate.deleteFilePath(otherFile);
    finish(0);
    await until(() => hooks.length === 2);
    expect(hooks[1].event.messages.map((item) => item.excerpt)).toEqual(["new"]);
    finish(1);
    expect(await work).toBeTrue();
    expect(delegate.getMessages().map((item) => item.excerpt)).toEqual(["new"]);
  });

  it("propagates hook failure without committing and permits a later publication", async () => {
    delegate.setMessages(file, [message("old")]);
    updates.length = 0;
    const work = start([message("failed")]);
    const failure = new Error("preparation failed");
    const observed = work.catch((error) => error);
    await until(() => hooks.length === 1);
    hooks[0].reject(failure);
    expect(await observed).toBe(failure);
    expect(delegate.getMessages().map((item) => item.excerpt)).toEqual(["old"]);
    expect(delegate.pendingPreparations.size).toBe(0);
    expect(updates).toEqual([]);
    const next = start([message("recovered")]);
    await until(() => hooks.length === 2);
    finish(1);
    expect(await next).toBeTrue();
    expect(delegate.getMessages().map((item) => item.excerpt)).toEqual(["recovered"]);
  });

  it("retires a hook when its delegate and registry are disposed", async () => {
    const work = start([message("retired")]);
    await until(() => hooks.length === 1);
    registry.dispose();
    expect(hooks[0].work.current()).toBeFalse();
    finish(0);
    expect(await work).toBeFalse();
    expect(updates).toEqual([]);
    expect(delegate.getMessages()).toEqual([]);
    expect(delegate.pendingPreparations.size).toBe(0);
  });

  it("keeps the synchronous API synchronous and does not invoke preparation", () => {
    delegate.setMessages(file, [message("sync")]);
    expect(hooks).toEqual([]);
    expect(updates.length).toBe(1);
    expect(updates[0].messages[0].excerpt).toBe("sync");
    expect(updates[0].preparation).toBeUndefined();
  });

  it("accepts a null preparation as the explicit synchronous fallback", async () => {
    const work = start([message("fallback")]);
    await until(() => hooks.length === 1);
    finish(0, null);
    expect(await work).toBeTrue();
    expect(updates[0].preparation).toBeUndefined();
    expect(delegate.getMessages()[0].excerpt).toBe("fallback");
  });

  it("uses the prepared diff across the real bootstrap and message registry", async () => {
    linter = new (require("../lib/bootstrap").Linter)();
    const indie = linter.addIndie({ name: "bootstrap prepared integration" });
    indie.setMessages(file, [message("old")]);
    const helpers = require("../lib/helpers");
    spyOn(helpers, "flagMessages").and.callThrough();
    spyOn(linter.registryMessages, "prepare").and.callThrough();
    spyOn(linter.registryMessages, "set").and.callThrough();
    const work = indie.setMessagesAsync(file, [message("new")]);
    pending.push(work);
    expect(await work).toBeTrue();
    expect(linter.registryMessages.prepare).toHaveBeenCalledTimes(1);
    const prepared = linter.registryMessages.prepare.calls.mostRecent().args[0];
    const published = linter.registryMessages.set.calls.mostRecent().args[0];
    expect(published.messages).toBe(prepared.messages);
    expect(published.affectedFiles).toBe(prepared.affectedFiles);
    expect(published.preparation).toBeTruthy();
    expect(helpers.flagMessages).not.toHaveBeenCalled();
    expect(linter.registryMessages.messages.map((item) => item.excerpt)).toEqual(["new"]);
  });
});
