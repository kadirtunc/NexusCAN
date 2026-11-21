/** DTO mirrors of src-tauri update-check (contract: planning/contracts/update-check-v1.md §3). camelCase 1:1. */
export interface ReleaseInfoDto {
  tag: string;
  name: string;
  version: string;
  build: number;
  /** ISO-8601 (GitHub). */
  publishedAt: string;
  notesMarkdown: string;
  htmlUrl: string;
}

export interface UpdateCheckDto {
  currentVersion: string;
  /** null = dev build (no embedded build number). */
  currentBuild: number | null;
  updateAvailable: boolean;
  latest: ReleaseInfoDto | null;
  /** Newer than current, newest first, max 10 (dev build: only `latest`). */
  newerReleases: ReleaseInfoDto[];
  releasesPageUrl: string;
}

/** Installed version; `build` null = dev build. */
export interface AppVersionDto {
  version: string;
  build: number | null;
}

export interface OpenReleasePageArgs {
  url?: string;
}
