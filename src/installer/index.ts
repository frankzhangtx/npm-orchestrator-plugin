export type InstallerCommand = "init" | "doctor" | "upgrade" | "uninstall";

export interface InstallerRequest {
  command: InstallerCommand;
  targetDirectory: string;
}
