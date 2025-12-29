import * as vscode from 'vscode';
import * as path from 'path';
import { GlobalState } from '../globalState';
import { AnalysisIntent } from '../types';
import { getLLMConfig, callLlm } from '../services/llm';
import { getTerminalOutput, getDiagnosticsData, getReferencedCode, applyFix, showDiffView } from '../utils/vscodeUtils';
import { getWebviewContent } from '../ui/webview';

export async function runAnalysisFlow(intent: AnalysisIntent) {
    const config = await getLLMConfig();
    if (!config) return;

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active code editor found.');
        return;
    }
    const document = editor.document;
    const sourceCode = document.getText();
    const actionMsg = intent === 'fix' ? 'Fixing' : intent === 'optimize' ? 'Optimizing' : 'Explaining';
    GlobalState.statusBarItem.text = `$(sync~spin) Alloy: ${actionMsg}...`;
    GlobalState.statusBarItem.show();

    try {
        if (GlobalState.indexer && (Date.now() - GlobalState.lastIndexTime > 5 * 60 * 1000)) {
            await GlobalState.indexer.refreshIndex();
            GlobalState.lastIndexTime = Date.now();
        }

        let terminalOutput = "";
        let diagnosticsOutput = "";
        let combinedErrorLog = "";
        let targetUri = document.uri;
        let extraContext = "";

        if (intent === 'fix') {
            terminalOutput = await getTerminalOutput();
            if (terminalOutput.length > 5000) terminalOutput = terminalOutput.substring(terminalOutput.length - 5000);
            diagnosticsOutput = getDiagnosticsData(document.uri);
            combinedErrorLog = terminalOutput + "\n" + diagnosticsOutput;

            let referencedFile = await getReferencedCode(terminalOutput);
            if (!referencedFile) {
                const allDiagnostics = vscode.languages.getDiagnostics();
                for (const [uri, diagnostics] of allDiagnostics) {
                    if (diagnostics.some(d => d.severity === vscode.DiagnosticSeverity.Error)) {
                        try {
                            const doc = await vscode.workspace.openTextDocument(uri);
                            referencedFile = { filename: path.basename(uri.fsPath), fullPath: uri.fsPath, content: doc.getText() };
                            break;
                        } catch (e) { }
                    }
                }
            }
            if (referencedFile) {
                vscode.window.showInformationMessage(`🧠 Analyzed context from: ${referencedFile.filename}`);
                targetUri = vscode.Uri.file(referencedFile.fullPath);
                extraContext += `\nBROKEN FILE CONTENT (${referencedFile.filename}):\n${referencedFile.content}\n`;
            }
        }

        if (GlobalState.indexer) {
            const query = intent === 'fix' ? combinedErrorLog : sourceCode;
            const retrievedContext = await GlobalState.indexer.findRelevantContext(query + "\n" + sourceCode);
            if (retrievedContext.length > 50) extraContext += `\n\n=== RELEVANT PROJECT FILES ===\n${retrievedContext}\n`;
        }

        const fullContext = `CURRENT ACTIVE FILE (${path.basename(document.fileName)}):\n${sourceCode}\n${extraContext}\n${intent === 'fix' ? `TERMINAL / ERROR LOGS:\n${combinedErrorLog}` : ''}`;
        const aiResponse = await callLlm(config, fullContext, intent);

        if (intent === 'explain') {
            const panel = vscode.window.createWebviewPanel('aiOutput', 'Alloy Insights', vscode.ViewColumn.Beside, {});
            panel.webview.html = getWebviewContent('Code Explanation', aiResponse.explanation);
        } else if (intent === 'optimize') {
            if (aiResponse.fixedCode) await showDiffView(targetUri, aiResponse.fixedCode);
            else {
                vscode.window.showInformationMessage('AI suggestions included in explanation panel.');
                const panel = vscode.window.createWebviewPanel('aiOutput', 'Optimization Tips', vscode.ViewColumn.Beside, {});
                panel.webview.html = getWebviewContent('Optimization Advice', aiResponse.explanation);
            }
        } else if (intent === 'fix') {
            if (aiResponse.filePath && aiResponse.filePath.toLowerCase() !== 'unknown') {
                const aiFileName = path.basename(aiResponse.filePath);
                if (aiFileName !== path.basename(targetUri.fsPath)) {
                    const files = await vscode.workspace.findFiles(`**/${aiFileName}`, '**/node_modules/**', 1);
                    if (files.length > 0) targetUri = files[0];
                }
            }
            const fixAction = await vscode.window.showQuickPick(['Directly Apply Fix', 'Verify Fix First'], { placeHolder: 'Fix found. Proceed?' });
            if (fixAction === 'Directly Apply Fix') await applyFix(targetUri, aiResponse.fixedCode);
            else if (fixAction === 'Verify Fix First') await showDiffView(targetUri, aiResponse.fixedCode);
        }
    } catch (error) {
        vscode.window.showErrorMessage('Alloy Error: ' + error);
        console.error(error);
    } finally {
        GlobalState.statusBarItem.hide();
    }
}