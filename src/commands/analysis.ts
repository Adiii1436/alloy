import * as vscode from 'vscode';
import * as path from 'path';
import { GlobalState } from '../globalState';
import { AnalysisIntent } from '../types';
import { getLLMConfig, callLlm } from '../services/llm';
import { getTerminalOutput, getDiagnosticsData, getReferencedCode, applyFix, showDiffView, applyCompositeFix } from '../utils/vscodeUtils';
import { getWebviewContent } from '../ui/webview';

function compressLog(text: string): string {
    const MAX_LENGTH = 2000;
    if (text.length <= MAX_LENGTH) return text;
    return `${text.substring(0, 800)}\n\n... [${text.length - 1800} chars truncated] ...\n\n${text.substring(text.length - 1000)}`;
}

function extractLatestOutput(fullText: string): string {
    if (!fullText) return "";
    const lines = fullText.split(/\r?\n/);
    if (lines.length < 2) return fullText;
    const promptRegex = /^(PS .*>|.+@.+:.+[#$]|➜.+|bash-.*\$|[a-zA-Z]:\\.*>)/;

    let lastPromptIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim().length > 0 && promptRegex.test(lines[i])) {
            if (lastPromptIndex === -1) lastPromptIndex = i;
            else return lines.slice(i + 1).join('\n');
        }
    }
    return lines.slice(-30).join('\n');
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

    const sourceCode = document.getText();
    if (GlobalState.statusBarItem) {
        GlobalState.statusBarItem.text = `$(sync~spin) Alloy: Analyzing...`;
        GlobalState.statusBarItem.show();
    }

    try {
        if (GlobalState.indexer && (Date.now() - GlobalState.lastIndexTime > 5 * 60 * 1000)) {
            await GlobalState.indexer.refreshIndex();
            GlobalState.lastIndexTime = Date.now();
        }

        let combinedErrorLog = "";
        let targetUri = document.uri;
        let extraContext = "";

        if (intent === 'fix') {
            const fullLog = await getTerminalOutput();
            const terminalOutput = compressLog(extractLatestOutput(fullLog));

            // Scan for errors in ALL files (Global Diagnostics)
            const diagnosticsOutput = getDiagnosticsData();
            combinedErrorLog = terminalOutput + "\n" + diagnosticsOutput;

            // Try to identify the broken file from stack trace
            let referencedFile = await getReferencedCode(terminalOutput);
            if (referencedFile) {
                targetUri = vscode.Uri.file(referencedFile.fullPath);
                extraContext += `\nBROKEN FILE (${referencedFile.filename}):\n${referencedFile.content}\n`;
            }
        }

        if (GlobalState.indexer) {
            const query = intent === 'fix' ? combinedErrorLog : sourceCode;
            const retrievedContext = await GlobalState.indexer.findRelevantContext(query + "\n" + sourceCode);
            if (retrievedContext.length > 50) {
                extraContext += `\n\n=== RELEVANT PROJECT FILES ===\n${retrievedContext}\n`;
            }
        }

        const fullContext = `
        ACTIVE FILE (${path.basename(document.fileName)}):
        ${sourceCode}

        ${extraContext}
        
        ${intent === 'fix' ? `ERROR LOGS:\n${combinedErrorLog}` : ''}
        `;

        const aiResponse = await callLlm(config, fullContext, intent);

        if (intent === 'explain') {
            const panel = vscode.window.createWebviewPanel('aiOutput', 'Alloy Insights', vscode.ViewColumn.Beside, {});
            panel.webview.html = getWebviewContent('Explanation', aiResponse.explanation);
        }
        else if (intent === 'optimize') {
            if (aiResponse.fixes.length > 0) {
                await showDiffView(targetUri, aiResponse.fixes[0].newContent);
            } else {
                const panel = vscode.window.createWebviewPanel('aiOutput', 'Optimization', vscode.ViewColumn.Beside, {});
                panel.webview.html = getWebviewContent('Optimization Advice', aiResponse.explanation);
            }
        }
        else if (intent === 'fix') {
            if (aiResponse.fixes.length > 0) {
                const fileList = aiResponse.fixes.map(f => path.basename(f.filePath)).join(', ');

                const fixAction = await vscode.window.showQuickPick(
                    ['Apply Fixes'],
                    { placeHolder: `Fixes found for: ${fileList}. Apply?` }
                );

                if (fixAction === 'Apply Fixes') {
                    await applyCompositeFix(aiResponse.fixes);
                }
            } else {
                vscode.window.showWarningMessage('Alloy: AI could not generate a code fix.');
            }
        }

    } catch (error) {
        vscode.window.showErrorMessage('Alloy Error: ' + error);
        console.error(error);
    } finally {
        if (GlobalState.statusBarItem) GlobalState.statusBarItem.hide();
    }
}