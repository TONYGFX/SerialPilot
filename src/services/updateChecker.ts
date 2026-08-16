/**
 * Checks public Gitea releases first, then falls back to GitHub without downloading anything.
 * Both sources expose the stable release API; the local LAN activity RSS feed is
 * deliberately excluded because it is not a release manifest for end users.
 */

import { LATEST_RELEASE_API_URLS, PROJECT_RELEASES_URL } from "../appInfo";

export type ReleaseInfo = {
  version: string;
  releaseUrl: string;
  publishedAt?: string;
};

export type UpdateCheckResult = {
  available: boolean;
  release: ReleaseInfo;
};

export type UpdateCheckStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date"; release: ReleaseInfo }
  | { state: "available"; release: ReleaseInfo }
  | { state: "failed" };

type FetchResponse = Pick<Response, "ok" | "status" | "json">;
export type ReleaseFetcher = (input: string, init?: RequestInit) => Promise<FetchResponse>;

type VersionParts = {
  numbers: number[];
  preRelease?: string;
};

/**
 * Queries the configured public release channels for the latest stable release.
 *
 * @param currentVersion Version bundled with the running application.
 * @param fetchRelease Injectable request function used by tests.
 * @returns The release metadata and whether it is newer than `currentVersion`.
 * @throws When the release service cannot provide a valid stable release.
 */
export async function checkForUpdate(currentVersion: string, fetchRelease: ReleaseFetcher = fetch): Promise<UpdateCheckResult> {
  let lastFailure: unknown;
  for (const releaseApiUrl of LATEST_RELEASE_API_URLS) {
    try {
      const release = await fetchLatestRelease(releaseApiUrl, fetchRelease);
      return { available: compareVersions(release.version, currentVersion) > 0, release };
    } catch (cause) {
      lastFailure = cause;
    }
  }
  throw lastFailure instanceof Error ? lastFailure : new Error("No release channel is available");
}

async function fetchLatestRelease(releaseApiUrl: string, fetchRelease: ReleaseFetcher): Promise<ReleaseInfo> {
  const response = await fetchRelease(releaseApiUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Release service returned HTTP ${response.status}`);
  const release = parseRelease(await response.json());
  return release;
}

/**
 * Compares two semantic versions, accepting an optional leading `v`.
 *
 * @param left First version.
 * @param right Second version.
 * @returns A positive value when `left` is newer, zero when equal, otherwise negative.
 * @throws When either value is not a supported semantic version.
 */
export function compareVersions(left: string, right: string): number {
  const leftParts = requireVersion(left);
  const rightParts = requireVersion(right);
  for (let index = 0; index < leftParts.numbers.length; index += 1) {
    const difference = leftParts.numbers[index] - rightParts.numbers[index];
    if (difference !== 0) return difference;
  }
  return comparePreRelease(leftParts.preRelease, rightParts.preRelease);
}

function requireVersion(value: string): VersionParts {
  const parsed = parseVersion(value);
  if (!parsed) throw new Error(`Unsupported version: ${value}`);
  return parsed;
}

function parseRelease(value: unknown): ReleaseInfo {
  if (!isRecord(value) || typeof value.tag_name !== "string" || value.draft === true || value.prerelease === true) {
    throw new Error("Release service returned an invalid stable release");
  }
  const version = normalizeVersion(value.tag_name);
  if (!version) throw new Error("Release tag is not a semantic version");
  return {
    version,
    releaseUrl: typeof value.html_url === "string" ? value.html_url : PROJECT_RELEASES_URL,
    publishedAt: typeof value.published_at === "string" ? value.published_at : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeVersion(value: string): string | undefined {
  const trimmed = value.trim();
  return parseVersion(trimmed) ? trimmed.replace(/^v/i, "") : undefined;
}

function parseVersion(value: string): VersionParts | undefined {
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return undefined;
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], preRelease: match[4] };
}

function comparePreRelease(left?: string, right?: string): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const largestLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < largestLength; index += 1) {
    const difference = comparePreReleasePart(leftParts[index], rightParts[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

function comparePreReleasePart(left?: string, right?: string): number {
  if (left === right) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined;
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
  if (leftNumber !== undefined) return -1;
  if (rightNumber !== undefined) return 1;
  return left.localeCompare(right);
}
