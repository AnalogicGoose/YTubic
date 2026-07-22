import { describe, expect, it } from "vitest";
import { WHATS_NEW, type WhatsNewEntry } from "@/lib/whats-new";
import {
  hasAuthoredReleaseNotes,
  resolveWhatsNewEntry,
  sectionsFromMarkdown,
  stripReleaseBoilerplate,
  versionFromTag,
  whatsNewVersionToShow,
} from "@/lib/whats-new-remote";

/** Exactly what `.github/workflows/release.yml` writes today. */
const CI_BOILERPLATE =
  "See the assets below to download and install this version.";
const CI_BOILERPLATE_MACOS = `${CI_BOILERPLATE} macOS builds are ad-hoc signed and may require a Gatekeeper override on first launch.`;

const remote = (version: string): WhatsNewEntry => ({
  version,
  date: "July 2026",
  sections: [{ heading: "From GitHub", items: ["Something real"] }],
});

describe("versionFromTag", () => {
  it("accepts both tag spellings", () => {
    expect(versionFromTag("v0.4.7")).toBe("0.4.7");
    expect(versionFromTag("0.4.7")).toBe("0.4.7");
    expect(versionFromTag(" v1.0.0 ")).toBe("1.0.0");
  });
});

describe("sectionsFromMarkdown", () => {
  it("maps headings and bullets onto the dialog's shape", () => {
    expect(
      sectionsFromMarkdown(
        "## Playback\n- Fixed autoplay\n- Fixed seeking\n\n## Offline\n* Downloads retry",
      ),
    ).toEqual([
      { heading: "Playback", items: ["Fixed autoplay", "Fixed seeking"] },
      { heading: "Offline", items: ["Downloads retry"] },
    ]);
  });

  it("keeps prose that precedes bullets under the same heading", () => {
    expect(
      sectionsFromMarkdown("## Notes\nRead this first.\n\n- Then this"),
    ).toEqual([
      { heading: "Notes", body: "Read this first." },
      { items: ["Then this"] },
    ]);
  });

  it("reduces inline markdown to plain text", () => {
    const [section] = sectionsFromMarkdown(
      "- **Bold** and _italic_ and `code` and [a link](https://example.com)",
    );
    expect(section.items).toEqual(["Bold and italic and code and a link"]);
  });

  it("renders GitHub's auto-generated changelog", () => {
    expect(
      sectionsFromMarkdown(
        "## What's Changed\n* Fix seeking by @osgamerxd in https://github.com/o/r/pull/12\n\n**Full Changelog**: https://github.com/o/r/compare/v0.4.6...v0.4.7",
      ),
    ).toEqual([
      {
        heading: "What's Changed",
        items: ["Fix seeking by @osgamerxd in https://github.com/o/r/pull/12"],
      },
      {
        body: "Full Changelog: https://github.com/o/r/compare/v0.4.6...v0.4.7",
      },
    ]);
  });

  it("keeps blocks in the order the release wrote them", () => {
    expect(
      sectionsFromMarkdown("## Notes\n- First\n\nClosing remark.\n\n- Later"),
    ).toEqual([
      { heading: "Notes", items: ["First"] },
      { body: "Closing remark." },
      { items: ["Later"] },
    ]);
  });

  it("never emits markup for a release body", () => {
    // Release bodies are remote text. Whatever they contain must survive as
    // inert plain strings; the dialog renders them as React text nodes.
    const sections = sectionsFromMarkdown(
      "- <img src=x onerror=alert(1)> and <b>bold</b>",
    );
    const rendered = JSON.stringify(sections);
    expect(rendered).not.toContain("<img");
    expect(rendered).not.toContain("<b>");
    expect(rendered).not.toContain("onerror");
  });

  it("drops headings left empty and ignores rules and comments", () => {
    expect(sectionsFromMarkdown("## Empty\n\n---\n\n<!-- hidden -->")).toEqual(
      [],
    );
    expect(sectionsFromMarkdown("")).toEqual([]);
  });

  it("treats numbered lists and quotes as content", () => {
    expect(sectionsFromMarkdown("1. First\n2. Second")).toEqual([
      { heading: undefined, items: ["First", "Second"] },
    ]);
    expect(sectionsFromMarkdown("> Heads up")).toEqual([
      { heading: undefined, body: "Heads up" },
    ]);
  });
});

describe("hasAuthoredReleaseNotes", () => {
  it("rejects the workflow's boilerplate as release notes", () => {
    // Every release published so far has exactly this body, so treating it as
    // notes would replace the bundled entries with a download instruction.
    expect(hasAuthoredReleaseNotes(CI_BOILERPLATE)).toBe(false);
    expect(hasAuthoredReleaseNotes(CI_BOILERPLATE_MACOS)).toBe(false);
    expect(hasAuthoredReleaseNotes("")).toBe(false);
    expect(hasAuthoredReleaseNotes("   \n\n  ")).toBe(false);
  });

  it("accepts a body once anything real is written alongside it", () => {
    expect(
      hasAuthoredReleaseNotes(
        `## Fixes\n- Autoplay works\n\n${CI_BOILERPLATE}`,
      ),
    ).toBe(true);
    expect(stripReleaseBoilerplate(CI_BOILERPLATE).trim()).toBe("");
  });
});

describe("resolveWhatsNewEntry", () => {
  const bundled = WHATS_NEW[0];

  it("prefers what GitHub says for that version", () => {
    const entry = resolveWhatsNewEntry(bundled.version, [
      remote(bundled.version),
    ]);
    expect(entry?.sections[0].heading).toBe("From GitHub");
  });

  it("falls back to the bundled entry when GitHub has no notes for it", () => {
    // The release exists but its body was only boilerplate, so it never
    // became an entry — the bundled copy has to cover that version.
    expect(resolveWhatsNewEntry(bundled.version, [remote("9.9.9")])).toBe(
      bundled,
    );
  });

  it("falls back while the fetch is unresolved or offline", () => {
    expect(resolveWhatsNewEntry(bundled.version, undefined)).toBe(bundled);
    expect(resolveWhatsNewEntry(bundled.version, [])).toBe(bundled);
  });

  it("returns nothing for a version neither source describes", () => {
    expect(resolveWhatsNewEntry("9.9.9", [])).toBeUndefined();
  });

  it("takes the newest release when no version is requested", () => {
    expect(
      resolveWhatsNewEntry(null, [remote("9.9.9"), remote("9.9.8")])?.version,
    ).toBe("9.9.9");
    expect(resolveWhatsNewEntry(null, undefined)).toBe(bundled);
  });
});

describe("whatsNewVersionToShow", () => {
  it("shows the running version when either source describes it", () => {
    expect(whatsNewVersionToShow("9.9.9", [remote("9.9.9")])).toBe("9.9.9");
    expect(whatsNewVersionToShow(WHATS_NEW[0].version, [])).toBe(
      WHATS_NEW[0].version,
    );
  });

  it("falls back to the newest notes for an undescribed version", () => {
    // Dev builds and versions published before the notes existed land here.
    expect(whatsNewVersionToShow("9.9.9", [remote("1.2.3")])).toBe("1.2.3");
    expect(whatsNewVersionToShow(null, undefined)).toBe(WHATS_NEW[0].version);
  });
});
