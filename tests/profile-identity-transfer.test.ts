import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The profile is the learned part of a person: the preferences, the patterns,
// the workflows. It follows the person, not the machine - so the identity has
// to be movable to another PC, and a target that is already taken must be
// refused rather than merged.

describe("profile identity transfer", () => {
  let dir: string | null = null;

  afterEach(async () => {
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    await tursoConnectionManager.closeAll();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  async function fresh() {
    dir = mkdtempSync(join(tmpdir(), "profile-transfer-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = dir;
    // The profile may live on a remote store; the transfer works on the local
    // identity table, so the test keeps it local.
    (CONFIG.remoteStorage as any).enabled = false;
    const { UserProfileManager } =
      await import("../src/services/user-profile/user-profile-manager.js");
    return new UserProfileManager();
  }

  const emptyProfile = () => ({ preferences: [], patterns: [], workflows: [] }) as any;

  it("moves the profile to another identity", async () => {
    const manager = await fresh();
    await manager.createProfile(
      "old-pc@local",
      "Owner",
      "owner",
      "old-pc@local",
      emptyProfile(),
      3
    );
    expect((await manager.getActiveProfile("old-pc@local"))?.userId).toBe("old-pc@local");

    const moved = await manager.transferIdentity("old-pc@local", "new-pc@local");
    expect(moved.moved).toBe(1);
    expect(await manager.getActiveProfile("old-pc@local")).toBeNull();
    expect((await manager.getActiveProfile("new-pc@local"))?.userId).toBe("new-pc@local");
  });

  it("refuses a target that already has a profile", async () => {
    const manager = await fresh();
    await manager.createProfile(
      "old-pc@local",
      "Owner",
      "owner",
      "old-pc@local",
      emptyProfile(),
      3
    );
    await manager.createProfile(
      "third-pc@local",
      "Owner",
      "owner",
      "third-pc@local",
      emptyProfile(),
      1
    );

    await expect(manager.transferIdentity("old-pc@local", "third-pc@local")).rejects.toThrow();
    // The refused transfer changed nothing.
    expect((await manager.getActiveProfile("old-pc@local"))?.userId).toBe("old-pc@local");
  });

  it("refuses an unknown source and the same identity twice", async () => {
    const manager = await fresh();
    await expect(manager.transferIdentity("nobody@local", "new-pc@local")).rejects.toThrow();
    await expect(manager.transferIdentity("same@local", "same@local")).rejects.toThrow();
  });
});
