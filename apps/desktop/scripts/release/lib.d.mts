export interface PackageVersion {
  file: string;
  name: string;
  version: string;
}

export interface ReleaseFile {
  name: string;
  path: string;
  size: number;
  sha256: string;
}

export function versionFromTag(tag: string): string;
export function packageVersions(root: string): Promise<PackageVersion[]>;
export function versionMismatches(versions: PackageVersion[], expected: string): PackageVersion[];
export function sha256(file: string): Promise<string>;
export function releaseFiles(dir: string, version: string): Promise<ReleaseFile[]>;
export function checksumFile(files: Pick<ReleaseFile, 'name' | 'sha256'>[]): string;
export function releaseNotes(options: {
  version: string;
  signing: 'signed' | 'unsigned';
  files: Pick<ReleaseFile, 'name' | 'size' | 'sha256'>[];
  changes?: string[];
  previousTag?: string;
}): string;
