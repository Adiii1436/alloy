import * as vscode from 'vscode';
import * as path from 'path';

export async function getTerminalOutput(): Promise<string> {
    await vscode.commands.executeCommand('workbench.action.terminal.focus');
    await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
    await new Promise(resolve => setTimeout(resolve, 500));
    return await vscode.env.clipboard.readText();
}

export function getDiagnosticsData(uri: vscode.Uri): string {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning);

    if (errors.length === 0) return "";

    return errors.map(d =>
        `[${vscode.DiagnosticSeverity[d.severity]}] Line ${d.range.start.line + 1}: ${d.message} (Code: ${d.code})`
    ).join('\n');
}

export async function getReferencedCode(terminalLog: string): Promise<{ filename: string, fullPath: string, content: string } | null> {
    const patterns = [
        /File\s+"([^"]+)",\s+line\s+\d+/,
        /([a-zA-Z0-9_\-\\\/.]+\.(?:ts|js|rs|go|cpp|c|h|java))\(\d+,\d+\)/,
        /at\s+.*\(([^:]+):\d+:\d+\)/,
        /([a-zA-Z0-9_\-\\\/.]+\.(?:rs|go|py|ts|js)):\d+:\d+/
    ];
    let match = null;
    for (const p of patterns) {
        match = terminalLog.match(p);
        if (match && match[1]) break;
    }
    if (match && match[1]) {
        try {
            let targetFile = match[1];
            if (!path.isAbsolute(targetFile)) {
                const foundFiles = await vscode.workspace.findFiles(`**/${path.basename(targetFile)}`, '**/node_modules/**', 1);
                if (foundFiles.length > 0) targetFile = foundFiles[0].fsPath;
            }
            const doc = await vscode.workspace.openTextDocument(targetFile);
            return { filename: path.basename(targetFile), fullPath: targetFile, content: doc.getText() };
        } catch (e) { return null; }
    }
    return null;
}

export async function applyFix(uri: vscode.Uri, newCode: string) {
    const edit = new vscode.WorkspaceEdit();
    const doc = await vscode.workspace.openTextDocument(uri);
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), newCode);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
}

export async function showDiffView(originalUri: vscode.Uri, newCode: string) {
    const doc = await vscode.workspace.openTextDocument(originalUri);
    const newDoc = await vscode.workspace.openTextDocument({ content: newCode, language: doc.languageId });
    await vscode.commands.executeCommand('vscode.diff', originalUri, newDoc.uri, 'Original ↔ AI Fix');
}