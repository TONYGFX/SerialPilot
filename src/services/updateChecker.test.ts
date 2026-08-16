/**
 * Verifies release parsing and version comparison without contacting GitHub.
 * The update settings must never show a false positive because a malformed
 * remote response was accepted as a release.
 */

import { describe, expect, it } from "vitest";
import { GITEA_LATEST_RELEASE_API_URL, GITHUB_LATEST_RELEASE_API_URL, projectReleaseUrl } from "../appInfo";
import { checkForUpdate, compareVersions, type ReleaseFetcher } from "./updateChecker";

function releaseFetcher(body: unknown): ReleaseFetcher {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

describe("updateChecker", () => {
  it("recognizes a newer v-prefixed stable release", async () => {
    const result = await checkForUpdate("0.1.2", releaseFetcher({ tag_name: "v0.2.0", html_url: "https://example.test/release" }));
    expect(result).toEqual({ available: true, release: { version: "0.2.0", releaseUrl: projectReleaseUrl("v0.2.0"), publishedAt: undefined } });
  });

  it("does not offer the running release as an update", async () => {
    const result = await checkForUpdate("0.1.2", releaseFetcher({ tag_name: "0.1.2", html_url: "https://example.test/release" }));
    expect(result.available).toBe(false);
  });

  it("falls back to GitHub when the primary Gitea endpoint is unavailable", async () => {
    const requestedUrls: string[] = [];
    const fetchRelease: ReleaseFetcher = async (url) => {
      requestedUrls.push(url);
      if (url === GITEA_LATEST_RELEASE_API_URL) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ tag_name: "0.1.3", html_url: "https://example.test/release" }) };
    };

    const result = await checkForUpdate("0.1.2", fetchRelease);
    expect(result.available).toBe(true);
    expect(requestedUrls).toEqual([GITEA_LATEST_RELEASE_API_URL, GITHUB_LATEST_RELEASE_API_URL]);
  });

  it("orders a final release after its prerelease", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
  });

  it("rejects a malformed release response", async () => {
    await expect(checkForUpdate("0.1.2", releaseFetcher({ tag_name: "latest" }))).rejects.toThrow("semantic version");
  });
});
