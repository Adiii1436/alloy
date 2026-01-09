import * as vscode from 'vscode';
import * as path from 'path';
import { GlobalState } from '../globalState';
import { AnalysisIntent } from '../types';
import { getLLMConfig, callLlm } from '../services/llm';
import { getTerminalOutput, getDiagnosticsData, getReferencedCode, applyFix, showDiffView } from '../utils/vscodeUtils';
import { getWebviewContent } from '../ui/webview';

function compressLog(text: string): string {
    const MAX_LENGTH = 2000;

    if (text.length <= MAX_LENGTH) return text;

    const head = text.substring(0, 800);
    const tail = text.substring(text.length - 1000);

    return `${head}\n\n... [${text.length - 1800} chars of logs truncated by Alloy] ...\n\n${tail}`;
}

function extractLatestOutput(fullText: string): string {
    if (!fullText) return "";
    const lines = fullText.split(/\r?\n/);
    if (lines.length < 2) return fullText;

    const promptRegex = /^(PS .*>|.+@.+:.+[#$]|➜.+|bash-.*\$|[a-zA-Z]:\\.*>)/;

    let lastPromptIndex = -1;
    let previousPromptIndex = -1;

    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.length > 0 && promptRegex.test(line)) {
            if (lastPromptIndex === -1) {
                lastPromptIndex = i;
            } else {
                previousPromptIndex = i;
                break;
            }
        }
    }

    if (previousPromptIndex !== -1) {
        return lines.slice(previousPromptIndex + 1).join('\n');
    }
    return lines.slice(-30).join('\n');
}

function hasTerminalError(text: string): boolean {
    if (!text) return false;
    const lowerText = text.toLowerCase();

    const errorKeywords = [
        'error', 'exception', 'traceback', 'failed', 'fatal', 'panic', 'crash', 'abort',
        'undefined', 'uncaught', 'typeerror', 'referenceerror', 'syntaxerror',
        'segmentation fault', 'segfault', 'core dumped', 'exit status 1',
        'ora-', 'sql state', 'build failed', 'err!', 'exited with code',
        'keyboardinterrupt', 'systemexit'
    ];

    const hasKeyword = errorKeywords.some(keyword => lowerText.includes(keyword));
    const hasStackTrace = /[\w\-]+\.[a-zA-Z0-9]{1,5}[:,\s]+(line\s+)?\d+/.test(text);

    return hasKeyword || hasStackTrace;
}

export async function runAnalysisFlow(intent: AnalysisIntent) {
    const config = await getLLMConfig();
    if (!config) return;

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active code editor found.');
        return;
    }
    const document = editor.document;

    if (intent === 'fix') {
        const allDiagnostics = vscode.languages.getDiagnostics();
        const hasProblems = allDiagnostics.some(([uri, diags]) =>
            diags.some(d => d.severity === vscode.DiagnosticSeverity.Error)
        );

        const fullTerminalOutput = await getTerminalOutput();
        const latestOutput = extractLatestOutput(fullTerminalOutput);
        const hasTerminalContent = hasTerminalError(latestOutput);

        if (!hasProblems && !hasTerminalContent) {
            vscode.window.showWarningMessage('Alloy: No active crashes detected in the last run.');
            return;
        }
    }

    const sourceCode = document.getText();
    const actionMsg = intent === 'fix' ? 'Fixing' : intent === 'optimize' ? 'Optimizing' : 'Explaining';

    if (GlobalState.statusBarItem) {
        GlobalState.statusBarItem.text = `$(sync~spin) Alloy: ${actionMsg}...`;
        GlobalState.statusBarItem.show();
    }

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
            // 1. Get RAW content
            const fullLog = await getTerminalOutput();

            let rawLatest = extractLatestOutput(fullLog);
            if (rawLatest.length < 50) rawLatest = fullLog.substring(fullLog.length - 2000);

            terminalOutput = compressLog(rawLatest);

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
            if (retrievedContext.length > 50) {
                extraContext += `\n\n=== RELEVANT PROJECT FILES (Auto-Detected) ===\n${retrievedContext}\n`;
            }
        }

        const fullContext = `
        CURRENT ACTIVE FILE (${path.basename(document.fileName)}):
        ${sourceCode}

        ${extraContext}
        
        ${intent === 'fix' ? `TERMINAL / ERROR LOGS:\n${combinedErrorLog}` : ''}
        `;

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
        if (GlobalState.statusBarItem) GlobalState.statusBarItem.hide();
    }
}