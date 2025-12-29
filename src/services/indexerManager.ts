import * as vscode from 'vscode';
import { CodebaseIndexer } from './merkle';
import { GlobalState } from '../globalState';

export async function initializeIndexer(force = false) {
    if (!vscode.workspace.workspaceFolders) return;
    const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const customIgnores = GlobalState.context.workspaceState.get<string[]>('custom_ignores', []);
    GlobalState.indexer = new CodebaseIndexer(rootPath, customIgnores);

    if (force) {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Rebuilding Codebase Index...",
            cancellable: false
        }, async () => { await GlobalState.indexer?.refreshIndex(); });
        vscode.window.showInformationMessage('✅ Codebase Index rebuilt.');
    } else {
        vscode.window.setStatusBarMessage("AI: Indexing Codebase...", 3000);
        GlobalState.indexer.refreshIndex().then(() => { GlobalState.lastIndexTime = Date.now(); });
    }
}