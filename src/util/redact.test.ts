import { redactBody, redactToken, redactUrl, truncate } from "./redact.js";

describe("truncate", () => {
  it("returns empty string for undefined", () => {
    expect(truncate(undefined, 10)).toBe("");
  });

  it("keeps short strings unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates long strings with length suffix", () => {
    expect(truncate("abcdefghij", 4)).toBe("abcd…(len=10)");
  });
});

describe("redactToken", () => {
  it("returns placeholder for empty token", () => {
    expect(redactToken(undefined)).toBe("(none)");
  });

  it("masks short token fully", () => {
    expect(redactToken("abc", 6)).toBe("****(len=3)");
  });

  it("shows prefix and length for long token", () => {
    expect(redactToken("abcdefghijk", 4)).toBe("abcd…(len=11)");
  });
});

describe("redactBody", () => {
  it("redacts sensitive fields case-insensitively", () => {
    const input = '{"token":"abc","Authorization":"Bearer 123","safe":"ok"}';
    const out = redactBody(input, 1000);
    expect(out).toContain('"token":"<redacted>"');
    expect(out).toContain('"Authorization":"<redacted>"');
    expect(out).toContain('"safe":"ok"');
  });

  it("returns empty marker for empty body", () => {
    expect(redactBody(undefined)).toBe("(empty)");
  });
});

describe("redactUrl", () => {
  it("strips query string", () => {
    expect(redactUrl("https://example.com/a/b?x=1&y=2")).toBe("https://example.com/a/b?<redacted>");
  });

  it("returns original URL when no query", () => {
    expect(redactUrl("https://example.com/a/b")).toBe("https://example.com/a/b");
  });

  it("falls back to truncate for invalid url", () => {
    expect(redactUrl("not a url")).toBe("not a url");
  });
});

describe("redactBody truncation", () => {
  it("truncates long body with total length", () => {
    const body = '{"safe":"1234567890"}';
    expect(redactBody(body, 8)).toBe('{"safe":…(truncated, totalLen=21)');
  });
});
