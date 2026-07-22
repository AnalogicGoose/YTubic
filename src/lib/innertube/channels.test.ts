import { describe, expect, it } from "vitest";
import { parseAccountSwitcher, resolveAccountSigninUrl } from "./channels";

/**
 * Trimmed-down shape of a real `account/accounts_list` response: one
 * personal channel (no pageIdToken), one brand channel (with pageIdToken),
 * identity-switch tokens for both, and one non-identity row to skip.
 */
const SWITCHER_FIXTURE = {
  data: {
    actions: [
      {
        getMultiPageMenuAction: {
          menu: {
            multiPageMenuRenderer: {
              sections: [
                {
                  accountSectionListRenderer: {
                    contents: [
                      {
                        accountItemSectionRenderer: {
                          contents: [
                            {
                              accountItem: {
                                accountName: { simpleText: "George" },
                                accountPhoto: {
                                  thumbnails: [
                                    { url: "https://p/a=s48", width: 48 },
                                    { url: "https://p/a=s88", width: 88 },
                                  ],
                                },
                                isSelected: true,
                                accountByline: {
                                  simpleText: "george@gmail.com",
                                },
                                serviceEndpoint: {
                                  selectActiveIdentityEndpoint: {
                                    supportedTokens: [
                                      {
                                        accountStateToken: { hasChannel: true },
                                      },
                                      {
                                        accountSigninToken: {
                                          signinUrl:
                                            "/signin?action_handle_signin=true&authuser=0&next=%2F",
                                        },
                                      },
                                      {
                                        offlineCacheKeyToken: {
                                          clientCacheKey: "k1",
                                        },
                                      },
                                    ],
                                  },
                                },
                              },
                            },
                            {
                              accountItem: {
                                accountName: {
                                  runs: [{ text: "Band Channel" }],
                                },
                                accountPhoto: {
                                  thumbnails: [{ url: "https://p/b=s88" }],
                                },
                                isSelected: false,
                                accountByline: { simpleText: "Brand Account" },
                                serviceEndpoint: {
                                  selectActiveIdentityEndpoint: {
                                    supportedTokens: [
                                      {
                                        pageIdToken: {
                                          pageId: "108031863270526872265",
                                        },
                                      },
                                      {
                                        accountSigninToken: {
                                          signinUrl:
                                            "https://www.youtube.com/signin?action_handle_signin=true&authuser=0&pageid=108031863270526872265&next=%2F",
                                        },
                                      },
                                      {
                                        offlineCacheKeyToken: {
                                          clientCacheKey: "k2",
                                        },
                                      },
                                    ],
                                  },
                                },
                              },
                            },
                            {
                              // "Add account" style row: no select endpoint.
                              accountItem: {
                                accountName: { simpleText: "Add account" },
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    ],
  },
};

describe("resolveAccountSigninUrl", () => {
  it("resolves YouTube's root-relative signin URL", () => {
    expect(
      resolveAccountSigninUrl(
        "/signin?action_handle_signin=true&authuser=0&next=%2F",
      ),
    ).toBe(
      "https://www.youtube.com/signin?action_handle_signin=true&authuser=0&next=%2F",
    );
  });

  it("accepts protocol-relative and absolute HTTPS forms", () => {
    expect(resolveAccountSigninUrl("//www.youtube.com/signin?pageid=123")).toBe(
      "https://www.youtube.com/signin?pageid=123",
    );
    expect(
      resolveAccountSigninUrl(
        "https://www.youtube.com/signin?pageid=123&authuser=0",
      ),
    ).toBe("https://www.youtube.com/signin?pageid=123&authuser=0");
  });

  it("preserves the query as an opaque server-issued value", () => {
    const raw =
      "/signin?next=https%3A%2F%2Fevil.example%2Fa%3Fb%3D1&pageid=123%2B456";
    expect(resolveAccountSigninUrl(raw)).toBe(`https://www.youtube.com${raw}`);
  });

  it.each([
    "http://www.youtube.com/signin?pageid=123",
    "https://youtube.com/signin?pageid=123",
    "https://music.youtube.com/signin?pageid=123",
    "https://www.youtube.com.evil.example/signin?pageid=123",
    "https://www.youtube.com:444/signin?pageid=123",
    "https://user@www.youtube.com/signin?pageid=123",
    "https://www.youtube.com/signin/?pageid=123",
    "https://www.youtube.com/watch?pageid=123",
    "https://www.youtube.com/signin?pageid=123#fragment",
    "javascript:alert(1)",
    " /signin?pageid=123",
    "",
  ])("rejects an untrusted signin URL: %s", (raw) => {
    expect(resolveAccountSigninUrl(raw)).toBeNull();
  });
});

describe("parseAccountSwitcher", () => {
  const channels = parseAccountSwitcher(SWITCHER_FIXTURE);

  it("finds both identities and skips non-identity rows", () => {
    expect(channels).toHaveLength(2);
  });

  it("maps the personal channel with a null pageId", () => {
    expect(channels[0]).toEqual({
      pageId: null,
      signinUrl:
        "https://www.youtube.com/signin?action_handle_signin=true&authuser=0&next=%2F",
      name: "George",
      photoUrl: "https://p/a=s88",
      byline: "george@gmail.com",
      selected: true,
    });
  });

  it("maps the brand channel with its pageId", () => {
    expect(channels[1]).toEqual({
      pageId: "108031863270526872265",
      signinUrl:
        "https://www.youtube.com/signin?action_handle_signin=true&authuser=0&pageid=108031863270526872265&next=%2F",
      name: "Band Channel",
      photoUrl: "https://p/b=s88",
      byline: "Brand Account",
      selected: false,
    });
  });

  it("returns [] for garbage input", () => {
    expect(parseAccountSwitcher(null)).toEqual([]);
    expect(parseAccountSwitcher({ data: {} })).toEqual([]);
    expect(parseAccountSwitcher("nope")).toEqual([]);
  });

  it("keeps an identity but rejects its malformed signin token", () => {
    const fixture = {
      accountItem: {
        accountName: { simpleText: "Unsafe token" },
        serviceEndpoint: {
          selectActiveIdentityEndpoint: {
            supportedTokens: [
              { pageIdToken: { pageId: "123" } },
              {
                accountSigninToken: {
                  signinUrl: "https://evil.example/signin?pageid=123",
                },
              },
            ],
          },
        },
      },
    };

    expect(parseAccountSwitcher(fixture)).toEqual([
      {
        pageId: "123",
        signinUrl: null,
        name: "Unsafe token",
        photoUrl: undefined,
        byline: undefined,
        selected: false,
      },
    ]);
  });
});
