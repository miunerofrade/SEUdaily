import {
  LocalFilesystem,
  Workspace,
  WORKSPACE_TOOLS,
} from "@mastra/core/workspace";

import { createCommandSandbox } from "./native-command-sandbox.js";
import { projectRoot, sandboxWorkspaceRoot } from "./runtime-paths.js";

const commandTimeout = Number.parseInt(
  process.env.CVSTREAM_WORKSPACE_COMMAND_TIMEOUT_MS ?? "120000",
  10,
);

const timeout = Number.isFinite(commandTimeout) && commandTimeout > 0
  ? commandTimeout
  : 120_000;

export const commandSandboxSelection = createCommandSandbox({
  id: "cvstream-native-command-runtime",
  projectRoot,
  workingDirectory: sandboxWorkspaceRoot,
  timeout,
});

export const cvstreamWorkspace = new Workspace({
  id: "cvstream-project-workspace",
  name: "SEUdaily project workspace",
  filesystem: new LocalFilesystem({
    id: "cvstream-project-files",
    basePath: projectRoot,
    contained: true,
  }),
  sandbox: commandSandboxSelection.sandbox,
  tools: {
    enabled: true,
    requireApproval: false,
    [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: {
      maxOutputTokens: 3_000,
      maxMediaBytes: 5 * 1024 * 1024,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: { maxOutputTokens: 2_000 },
    [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: { maxOutputTokens: 1_000 },
    [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { maxOutputTokens: 2_000 },
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
      requireApproval: true,
      requireReadBeforeWrite: true,
      maxOutputTokens: 1_000,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
      requireApproval: true,
      requireReadBeforeWrite: true,
      maxOutputTokens: 1_000,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: {
      requireApproval: true,
      maxOutputTokens: 1_000,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: { enabled: false },
    [WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT]: { enabled: false },
    [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
      requireApproval: true,
      maxOutputTokens: 2_500,
    },
    [WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT]: { maxOutputTokens: 2_000 },
    [WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS]: {
      requireApproval: true,
      maxOutputTokens: 1_000,
    },
  },
});
