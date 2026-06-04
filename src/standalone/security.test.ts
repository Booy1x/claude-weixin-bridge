import { describe, it, expect } from "vitest";

import {
  resolveAllowlist,
  isSenderAllowed,
  isValidPermissionMode,
} from "./security.js";

describe("resolveAllowlist", () => {
  it("opens access (unconfigured) when no env entries and no owner", () => {
    const list = resolveAllowlist([], undefined);
    expect(list.allowAll).toBe(true);
    expect(list.openReason).toBe("unconfigured");
    expect(isSenderAllowed(list, "anyone")).toBe(true);
  });

  it("locks to the owner when only an owner id is known", () => {
    const list = resolveAllowlist([], "owner-1");
    expect(list.allowAll).toBe(false);
    expect(isSenderAllowed(list, "owner-1")).toBe(true);
    expect(isSenderAllowed(list, "stranger")).toBe(false);
  });

  it("merges env entries with the owner id and trims blanks", () => {
    const list = resolveAllowlist([" u1 ", "", "u2"], "owner-1");
    expect(list.allowAll).toBe(false);
    expect(list.allowed).toEqual(new Set(["u1", "u2", "owner-1"]));
  });

  it("treats * as an explicit allow-all even when an owner is set", () => {
    const list = resolveAllowlist(["*"], "owner-1");
    expect(list.allowAll).toBe(true);
    expect(list.openReason).toBe("explicit");
    expect(isSenderAllowed(list, "stranger")).toBe(true);
  });
});

describe("isValidPermissionMode", () => {
  it("accepts known Claude permission modes", () => {
    expect(isValidPermissionMode("default")).toBe(true);
    expect(isValidPermissionMode("acceptEdits")).toBe(true);
    expect(isValidPermissionMode("bypassPermissions")).toBe(true);
  });

  it("rejects unknown modes", () => {
    expect(isValidPermissionMode("yolo")).toBe(false);
    expect(isValidPermissionMode("")).toBe(false);
  });
});
