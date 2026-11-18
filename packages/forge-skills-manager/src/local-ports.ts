import type * as Local from "./core.js";

export type InstallationRecordPort = Pick<typeof Local, "checkedRepositoryRootDefinition" | "projectRootForRecord" | "userRoots">;
export type InstallationPort = InstallationRecordPort & Pick<typeof Local,
  "createWorkspaceIndex" | "deleteSkill" | "importUploadedSkill" | "listTrash" | "managerHomePath" |
  "permanentlyDeleteTrash" | "readManagerState" | "resolveWorkspaceTarget" | "restoreTrash" | "setSkillEnabled" | "trashRootPath">;
export type HttpLocalPort = Pick<typeof Local,
  "getEntryLocation" | "setEntryLocation" | "state" | "setSkillEnabled" | "setSourceEnabled" |
  "createCategory" | "renameCategory" | "deleteCategory" | "assignSkillCategory" | "moveSkillInCategory" |
  "setCategoryEnabled" | "setSkillNote" | "importSkill" | "importUploadedSkill" | "browseDirectories" |
  "createSkill" | "skillDetail" | "userRoots" | "setRootPath" | "addCustomSources" | "updateCustomSource" |
  "removeCustomSource" | "scanCustomSourceCandidates" | "projectRoots" | "resolveWorkspaceTarget" | "listWorkspaces" | "workspaceSkills">;
