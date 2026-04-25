import { isTrustedRedirectHost } from "./login-qr.js";

describe("isTrustedRedirectHost", () => {
  it("accepts exact trusted host", () => {
    expect(isTrustedRedirectHost("ilinkai.weixin.qq.com")).toBe(true);
  });

  it("accepts trusted subdomain suffix", () => {
    expect(isTrustedRedirectHost("idc1.weixin.qq.com")).toBe(true);
  });

  it("rejects blank host", () => {
    expect(isTrustedRedirectHost("   ")).toBe(false);
  });

  it("rejects host containing path", () => {
    expect(isTrustedRedirectHost("idc1.weixin.qq.com/path")).toBe(false);
  });

  it("rejects host containing protocol", () => {
    expect(isTrustedRedirectHost("https://idc1.weixin.qq.com")).toBe(false);
  });

  it("rejects untrusted domain", () => {
    expect(isTrustedRedirectHost("evil.example.com")).toBe(false);
  });

  it("rejects fake suffix overlap", () => {
    expect(isTrustedRedirectHost("weixin.qq.com.evil.com")).toBe(false);
  });
});
