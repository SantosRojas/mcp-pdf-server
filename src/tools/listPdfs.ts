import { defaultWorkspace, type WorkspaceInfo } from '../runtime/workspace.js';
import { listPdfFiles, type ListPdfsOptions } from '../utils/files.js';

export async function listPdfs(input: ListPdfsOptions, workspace: WorkspaceInfo = defaultWorkspace()): Promise<Record<string, unknown>> {
  const result = await listPdfFiles(workspace, input);
  return {
    success: true,
    count: result.files.length,
    truncated: result.truncated,
    scannedRoots: result.scannedRoots,
    files: result.files
  };
}
