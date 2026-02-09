import * as vscode from 'vscode';
import * as path from 'path';

const SYSTEM_IGNORES = [
    'node_modules', 'bower_components',
    '.venv', 'venv', 'env', '__pycache__',
    'target', 'build', 'dist', 'out', 'bin', 'obj', 'vendor',
    '.git', '.svn', '.hg', '.vscode', '.idea'
];

export async function getTerminalOutput(): Promise<string> {
    // ROBUSTNESS: Save user's current clipboard content
    const previousClipboard = await vscode.env.clipboard.readText();

    try {
        await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
        await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
        await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
        const terminalText = await vscode.env.clipboard.readText();
        return terminalText;
    } catch (e) {
        console.error("Failed to read terminal:", e);
        return "";
    } finally {
        // ROBUSTNESS: Restore user's clipboard content
        await vscode.env.clipboard.writeText(previousClipboard);
    }
}

export function getDiagnosticsData(uri?: vscode.Uri): string {
    // ... [Keep existing getDiagnosticsData implementation] ...
    let report = "";
    const MAX_ERRORS_PER_FILE = 5;

    if (uri) {
        const diagnostics = vscode.languages.getDiagnostics(uri);
        const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
        if (errors.length > 0) {
            const limited = errors.slice(0, MAX_ERRORS_PER_FILE);
            report += limited.map(d => `Line ${d.range.start.line + 1}: ${d.message}`).join('\n');
            if (errors.length > MAX_ERRORS_PER_FILE) report += `\n...and ${errors.length - MAX_ERRORS_PER_FILE} more errors.`;
        }
    } else {
        const allDiagnostics = vscode.languages.getDiagnostics();

        for (const [docUri, diags] of allDiagnostics) {
            const pathSegments = docUri.fsPath.split(path.sep);
            if (pathSegments.some(seg => SYSTEM_IGNORES.includes(seg))) continue;

            const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
            if (errors.length > 0) {
                const filename = path.basename(docUri.fsPath);
                report += `\nFYI - ERRORS IN FILE: ${filename}\n`;
                const limited = errors.slice(0, MAX_ERRORS_PER_FILE);
                report += limited.map(d => `Line ${d.range.start.line + 1}: ${d.message}`).join('\n');
                if (errors.length > MAX_ERRORS_PER_FILE) report += `\n...and ${errors.length - MAX_ERRORS_PER_FILE} more errors.`;
            }
        }
    }
    return report;
}

export async function applyCompositeFix(fixes: { filePath: string, newContent: string }[]) {
    const edit = new vscode.WorkspaceEdit();
    const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (!workspacePath) return;

    for (const fix of fixes) {
        let targetPath = fix.filePath;

        // ROBUSTNESS: Normalize paths to prevent issues with ../ or mixed separators
        targetPath = path.normalize(targetPath);

        if (!path.isAbsolute(targetPath)) {
            targetPath = path.join(workspacePath, targetPath);
        }

        const uri = vscode.Uri.file(targetPath);

        // Safe check if file exists, if not, creates it
        edit.createFile(uri, { ignoreIfExists: true, overwrite: true });

        // We use full replace as that's safer for AI generated code than calculating diffs
        const fullRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(999999, 0));
        edit.replace(uri, fullRange, fix.newContent);
    }

    await vscode.workspace.applyEdit(edit);
    vscode.window.showInformationMessage(`Applied changes to ${fixes.length} files.`);
}

// ... [Keep getReferencedCode, showDiffView, applyFix] ...
export async function getReferencedCode(log: string): Promise<{ filename: string, fullPath: string, content: string } | null> {
    const match = /([\w\-\/\\.]+\.\w+)(?::\d+)?/.exec(log);
    if (match) {
        const filename = match[1];
        const files = await vscode.workspace.findFiles(`**/${path.basename(filename)}`, '**/node_modules/**', 1);
        if (files.length > 0) {
            const doc = await vscode.workspace.openTextDocument(files[0]);
            return { filename: path.basename(files[0].fsPath), fullPath: files[0].fsPath, content: doc.getText() };
        }
    }
    return null;
}

export async function showDiffView(uri: vscode.Uri, newContent: string) {
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const languageId = doc.languageId;

        const newDoc = await vscode.workspace.openTextDocument({
            content: newContent,
            language: languageId
        });

        await vscode.commands.executeCommand(
            'vscode.diff',
            uri,
            newDoc.uri,
            `Alloy Optimization: ${path.basename(uri.fsPath)} ↔ Proposed Change`
        );

    } catch (error) {
        vscode.window.showErrorMessage(`Failed to open diff view: ${error}`);
    }
}

export async function applyFix(uri: vscode.Uri, newContent: string) {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(999999, 0));
    edit.replace(uri, fullRange, newContent);
    await vscode.workspace.applyEdit(edit);
}