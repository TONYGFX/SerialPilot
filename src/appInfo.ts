/**
 * Contains public application identity and release-channel constants.
 * Keeping these values in one module prevents the settings UI and update
 * checker from reporting different versions or project links.
 */

/** Version displayed by the desktop application and used for update checks. */
export const APP_VERSION = "0.1.2";

/** Public project home page opened from the About settings page. */
export const PROJECT_GITHUB_URL = "https://github.com/TONYGFX/SerialPilot";

/** Public release list for the SerialPilot project. */
export const PROJECT_RELEASES_URL = `${PROJECT_GITHUB_URL}/releases`;

/**
 * Creates the public GitHub Release URL for an exact mirrored release tag.
 *
 * @param releaseTag Tag returned by the Gitea or GitHub Release API.
 * @returns GitHub page for the corresponding published release.
 */
export function projectReleaseUrl(releaseTag: string): string {
  return `${PROJECT_RELEASES_URL}/tag/${encodeURIComponent(releaseTag)}`;
}

/** Primary public Gitea release endpoint for clients that cannot reach GitHub reliably. */
export const GITEA_LATEST_RELEASE_API_URL = "https://git.tonygfx.cn/api/v1/repos/tonygfx/SerialPilot/releases/latest";

/** Fallback public GitHub release endpoint when the Gitea endpoint is unavailable. */
export const GITHUB_LATEST_RELEASE_API_URL = "https://api.github.com/repos/TONYGFX/SerialPilot/releases/latest";

/** Ordered release sources. Both endpoints must remain public and read-only. */
export const LATEST_RELEASE_API_URLS = [GITEA_LATEST_RELEASE_API_URL, GITHUB_LATEST_RELEASE_API_URL] as const;
