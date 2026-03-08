import path from 'path';
import 'dotenv/config';

export const WORKSPACE_DIR: string = path.resolve('./workspaces');

// 🧠 Cambiamos 'const' por 'let' para poder modificarlo en vivo
export let TARGET_REPO_PATH: string = path.join(WORKSPACE_DIR, process.env.GITHUB_REPO as string);

// 🔄 Nueva función para que Jarvis cambie de proyecto sobre la marcha
export function setActiveProject(repoName: string) {
    TARGET_REPO_PATH = path.join(WORKSPACE_DIR, repoName);
    process.env.GITHUB_REPO = repoName; // Actualizamos la memoria
}