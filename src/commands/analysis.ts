import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { GlobalState } from '../globalState';
import { AnalysisIntent } from '../types';
import { getLLMConfig, callLlm } from '../services/llm';
import { getTerminalOutput, getDiagnosticsData, getReferencedCode, applyCompositeFix } from '../utils/vscodeUtils';

// --- HELPER: Execute Command with Timeout & Interactive Handling ---
async function runProjectCommand(command: string, cwd: string): Promise<{ output: string, hasError: boolean }> {
    return new Promise((resolve) => {
        const channel = vscode.window.createOutputChannel("Alloy Runner");
        channel.show();
        channel.appendLine(`> Running: ${command}\n`);

        let collectedOutput = "";
        let isResolved = false;

        // 1. Parse command and arguments for spawn
        const args = command.split(' ');
        const cmd = args.shift() || '';

        // 2. Spawn process (allows streaming output)
        const child = cp.spawn(cmd, args, { cwd, shell: true });

        // 3. Collect Data
        child.stdout.on('data', (data) => {
            const chunk = data.toString();
            collectedOutput += chunk;
            channel.append(chunk);
        });

        child.stderr.on('data', (data) => {
            const chunk = data.toString();
            collectedOutput += chunk;
            channel.append(chunk);
        });

        // 4. Handle Process Exit (Normal Completion)
        child.on('close', (code) => {
            if (isResolved) return;
            isResolved = true;

            const hasError = code !== 0 || checkForErrorKeywords(collectedOutput);

            if (hasError) {
                channel.appendLine(`\n[Process exited with code ${code}. Errors detected.]`);
                resolve({ output: collectedOutput, hasError: true });
            } else {
                channel.appendLine(`\n[Process finished successfully.]`);
                resolve({ output: collectedOutput, hasError: false });
            }
        });

        // 5. Handle Errors (e.g., command not found)
        child.on('error', (err) => {
            if (isResolved) return;
            isResolved = true;
            channel.appendLine(`\n[Failed to start process: ${err.message}]`);
            resolve({ output: collectedOutput + `\nSpawn Error: ${err.message}`, hasError: true });
        });

        // 6. TIMEOUT / INTERACTIVE TRAP HANDLING
        // If the process runs for > 5 seconds, we assume it's interactive (waiting for input) or a server.
        // We kill it and check if any errors occurred during startup.
        setTimeout(() => {
            if (!isResolved && !child.killed) {
                isResolved = true; // Prevent the 'close' listener from resolving again

                // Check if the output so far contains errors (e.g. crash before hang)
                const likelyCrash = checkForErrorKeywords(collectedOutput);

                if (likelyCrash) {
                    channel.appendLine(`\n[Timeout: Errors detected in output. Treating as crash.]`);
                    child.kill();
                    resolve({ output: collectedOutput, hasError: true });
                } else {
                    // Safe handling for Interactive Scripts / Servers
                    channel.appendLine(`\n[Timeout: Process is interactive or long-running. Stopping safely.]`);
                    channel.appendLine(`[Status: App appears to have started without immediate errors.]`);
                    child.kill();
                    resolve({ output: collectedOutput, hasError: false });
                }
            }
        }, 5000); // 5 Second Timeout
    });
}

// Helper: fast scan for Python/JS/General error keywords
function checkForErrorKeywords(text: string): boolean {
    const lower = text.toLowerCase();
    // Exclude common false positives if necessary, but these are strong signals
    return (
        lower.includes('traceback (most recent call last)') || // Python
        lower.includes('referenceerror:') || // JS
        lower.includes('typeerror:') || // JS/Python
        lower.includes('syntaxerror:') || // Generic
        lower.includes('uncaught exception') || // Generic
        (lower.includes('error:') && !lower.includes('0 error')) // Generic "Error:" but skipping "0 errors" summary
    );
}

function compressLog(text: string): string {
    const MAX_LENGTH = 3000;
    if (text.length <= MAX_LENGTH) return text;
    return `${text.substring(0, 1000)}\n\n... [${text.length - 2000} chars truncated] ...\n\n${text.substring(text.length - 1000)}`;
}

function extractLatestOutput(fullText: string): string {
    if (!fullText) return "";
    const lines = fullText.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) return fullText;
    return lines.slice(-50).join('\n');
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
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath || path.dirname(document.fileName);

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
        let extraContext = "";
        let userDescription = "";
        let relevantFiles: string[] = [document.fileName];

        // --- 1. GATHER CONTEXT / RUN COMMANDS ---
        if (intent === 'fix') {
            const diagnosticsOutput = getDiagnosticsData();

            const fullLog = await getTerminalOutput();
            let terminalOutput = extractLatestOutput(fullLog);

            const hasDiagnostics = diagnosticsOutput.length > 20;
            const hasTerminalError = checkForErrorKeywords(terminalOutput);

            // INTERACTIVE FLOW
            if (!hasDiagnostics && !hasTerminalError) {
                const action = await vscode.window.showQuickPick(
                    ['Run a Command', 'Use Current Terminal Output'],
                    {
                        placeHolder: 'No obvious errors detected. How should we proceed?',
                        title: 'Alloy Debugger'
                    }
                );

                if (action === 'Run a Command') {
                    const command = await vscode.window.showInputBox({
                        prompt: 'Enter command to reproduce the issue',
                        placeHolder: 'e.g., npm start, python main.py'
                    });

                    if (command) {
                        if (GlobalState.agentChatProvider) {
                            GlobalState.agentChatProvider.addInteraction(`Running command: ${command}...`, [], "Executing in background (5s timeout)...", "");
                        }

                        // Run with the new timeout/spawn logic
                        const result = await runProjectCommand(command, workspaceRoot);

                        // Check Result
                        if (!result.hasError) {
                            vscode.window.showInformationMessage(`Command finished. No crashes detected.`);
                            if (GlobalState.agentChatProvider) {
                                GlobalState.agentChatProvider.addInteraction("Status Check", [], "✅ Command finished (or is running interactively) without immediate errors.", result.output);
                            }
                            if (GlobalState.statusBarItem) GlobalState.statusBarItem.hide();
                            return; // STOP: No valid error to fix
                        }

                        terminalOutput = result.output;
                    }
                }
            }

            combinedErrorLog = compressLog(terminalOutput) + "\n" + diagnosticsOutput;

            if (combinedErrorLog.length < 50) {
                userDescription = await vscode.window.showInputBox({
                    title: "Describe the Bug",
                    placeHolder: "e.g., 'The app crashes when I click Login'",
                    prompt: "Logs are empty. Please describe the issue manually."
                }) || "";
                if (!userDescription) return;
            }

            let referencedFile = await getReferencedCode(terminalOutput);
            if (referencedFile) {
                extraContext += `\nBROKEN FILE (${referencedFile.filename}):\n${referencedFile.content}\n`;
                if (!relevantFiles.includes(referencedFile.fullPath)) {
                    relevantFiles.push(referencedFile.fullPath);
                }
            }
        }

        // --- 2. INDEXER SEARCH ---
        if (GlobalState.indexer) {
            let query = sourceCode;
            if (intent === 'fix') query = `${userDescription}\n${combinedErrorLog}`;
            else if (intent === 'explain') query = `Explain logic: ${path.basename(document.fileName)}`;

            const indexResult = await GlobalState.indexer.findRelevantContext(query + "\n" + sourceCode);

            if (indexResult.context.length > 50) {
                extraContext += `\n\n=== RELEVANT PROJECT FILES ===\n${indexResult.context}\n`;
            }

            indexResult.files.forEach(f => {
                if (!relevantFiles.includes(f)) relevantFiles.push(f);
            });
        }

        const fullContext = `
        ACTIVE FILE (${path.basename(document.fileName)}):
        ${sourceCode}

        ${extraContext}

        ${intent === 'fix' ? `USER DESCRIPTION:\n${userDescription}\n\nERROR LOGS:\n${combinedErrorLog}` : ''}
        `;

        // --- 3. EXECUTE LLM ---
        const aiResponse = await callLlm(config, fullContext, intent);

        // --- 4. UNIFIED CHAT OUTPUT ---
        if (GlobalState.agentChatProvider) {
            let displayQuery = "";
            switch (intent) {
                case 'fix':
                    displayQuery = userDescription ? `Fix: ${userDescription}` : (combinedErrorLog.length > 20 ? `Fix Error: ${combinedErrorLog.substring(0, 50)}...` : "Fix last error");
                    break;
                case 'explain':
                    displayQuery = `Explain ${path.basename(document.fileName)}`;
                    break;
            }

            const relativeFiles = relevantFiles.map(f => vscode.workspace.asRelativePath(f));

            GlobalState.agentChatProvider.addInteraction(
                displayQuery,
                relativeFiles,
                aiResponse.explanation,
                fullContext
            );
        }

        // --- 5. HANDLE CODE CHANGES ---
        if (intent === 'fix') {
            if (aiResponse.fixes.length > 0) {
                const fileList = aiResponse.fixes.map(f => path.basename(f.filePath)).join(', ');

                const fixAction = await vscode.window.showQuickPick(
                    ['Apply Changes'],
                    { placeHolder: `Alloy suggested changes for: ${fileList}. Apply?` }
                );

                if (fixAction === 'Apply Changes') {
                    await applyCompositeFix(aiResponse.fixes);
                }
            } else {
                vscode.window.showWarningMessage('Alloy: AI could not generate a code fix.');
            }
        }

    } catch (error: any) {
        vscode.window.showErrorMessage('Alloy Error: ' + error.message);
        console.error(error);
    } finally {
        if (GlobalState.statusBarItem) GlobalState.statusBarItem.hide();
    }
}