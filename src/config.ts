import path from 'path';
import 'dotenv/config';

export const WORKSPACE_DIR: string = path.resolve('./workspaces');
export let TARGET_REPO_PATH: string = path.join(WORKSPACE_DIR, process.env.GITHUB_REPO as string);

export function setActiveProject(repoName: string) {
    TARGET_REPO_PATH = path.join(WORKSPACE_DIR, repoName);
    process.env.GITHUB_REPO = repoName;
}