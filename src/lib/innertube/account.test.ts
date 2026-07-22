import { describe, expect, it } from "vitest";
import { detectPremiumStatusFromMenu } from "@/lib/innertube/account";
import type { YtNode } from "@/lib/innertube/shared";

function menu(labels: string[], signedIn = true): YtNode {
  return {
    actions: [
      {
        openPopupAction: {
          popup: {
            multiPageMenuRenderer: {
              header: signedIn
                ? { activeAccountHeaderRenderer: { accountName: "Listener" } }
                : {},
              sections: labels.map((label) => ({
                multiPageMenuSectionRenderer: {
                  items: [
                    { compactLinkRenderer: { text: { simpleText: label } } },
                  ],
                },
              })),
            },
          },
        },
      },
    ],
  };
}

describe("Premium account-menu classification", () => {
  it("recognizes an explicit Free-account upsell", () => {
    expect(detectPremiumStatusFromMenu(menu(["Get Music Premium now"]))).toBe(
      "free",
    );
  });

  it("recognizes positive membership evidence", () => {
    expect(
      detectPremiumStatusFromMenu(
        menu(["Manage your Music Premium membership"]),
      ),
    ).toBe("premium");
  });

  it("recognizes localized membership evidence", () => {
    expect(
      detectPremiumStatusFromMenu(
        menu(["Gestionar tu membresía de Music Premium"]),
      ),
    ).toBe("premium");
  });

  it.each([
    ["an unrecognized branded upsell", ["Premium features"]],
    ["an expired trial", ["Your Music Premium trial has ended"]],
    ["a Spanish upsell", ["Obtén Music Premium"]],
  ])("recognizes a Free account from %s", (_label, labels) => {
    expect(detectPremiumStatusFromMenu(menu(labels))).toBe("free");
  });

  it("recognizes the signed-in Premium menu by its missing upsell", () => {
    expect(detectPremiumStatusFromMenu(menu([]))).toBe("premium");
  });

  it("does not classify an anonymous menu", () => {
    expect(
      detectPremiumStatusFromMenu(
        menu(["Manage your Music Premium membership"], false),
      ),
    ).toBeNull();
  });
});
