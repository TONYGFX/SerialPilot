/**
 * Contains public application identity and release-channel constants.
 * Keeping these values in one module prevents the settings UI and update
 * checker from reporting different versions or project links.
 */

/** Version displayed by the desktop application and used for update checks. */
export const APP_VERSION = "0.1.2";

/** Public project home page opened from the About settings page. */
export const PROJECT_GITHUB_URL = "https://github.com/TONYGFX/SerialPilot";

/** Public release list used when an update is available. */
export const PROJECT_RELEASES_URL = `${PROJECT_GITHUB_URL}/releases`;

/** GitHub API endpoint that returns the newest stable public release. */
export const LATEST_RELEASE_API_URL = "https://api.github.com/repos/TONYGFX/SerialPilot/releases/latest";
