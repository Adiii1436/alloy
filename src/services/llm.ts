import * as vscode from 'vscode';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { GlobalState } from '../globalState';
import { LLMConfig, AIProvider, AnalysisIntent, AIResponse, FileChange } from '../types';

export async function getLLMConfig(): Promise<LLMConfig | null> {
    let provider = GlobalState.context.globalState.get<AIProvider>('selected_provider');
    if (!provider) {
        const choice = await vscode.window.showQuickPick(['Google Gemini', 'OpenAI'], { placeHolder: 'Select your AI Provider' });
        if (!choice) return null;
        provider = choice as AIProvider;
        await GlobalState.context.globalState.update('selected_provider', provider);
    }

    const keyStorageName = provider === 'Google Gemini' ? 'gemini_key' : 'openai_key';
    let apiKey = GlobalState.context.globalState.get<string>(keyStorageName);
    if (!apiKey) {
        apiKey = await vscode.window.showInputBox({ prompt: `Enter your ${provider} API Key`, password: true });
        if (!apiKey) return null;
        await GlobalState.context.globalState.update(keyStorageName, apiKey);
    }

    const modelStorageName = provider === 'Google Gemini' ? 'gemini_model' : 'openai_model';
    let modelName = GlobalState.context.globalState.get<string>(modelStorageName);
    if (!modelName) {
        modelName = provider === 'Google Gemini' ? 'gemini-2.5-flash' : 'gpt-4o';
        await GlobalState.context.globalState.update(modelStorageName, modelName);
    }

    return { provider, apiKey, modelName };
}

export async function callLlm(config: LLMConfig, prompt: string, intent: AnalysisIntent): Promise<AIResponse> {

    const BASE_ROLE = "You are Alloy, an advanced AI Pair Debugger.";

    const CODE_FORMAT_INSTRUCTION = `
    CRITICAL INSTRUCTION:
    You are working in a real file system.
    If you need to edit multiple files, provide a block for EACH file.

    RESPONSE FORMAT:
    For every file change, use this EXACT format:

    <<<<FILE: path/to/file.ext>>>>
    [FULL SOURCE CODE HERE]
    <<<<END>>>>

    <<<<FILE: path/to/file.ext>>>>
    [FULL SOURCE CODE HERE]
    <<<<END>>>>

    RULES FOR THE CODE BLOCK:
    1. Provide the FULL content of the file. DO NOT skip lines.
    2. Inside <<<<FILE>>>> and <<<<END>>>>, contain ONLY valid code.
    3. DO NOT write "Here is the code:" or markdown backticks (\`\`\`) inside the block.
    `;

    let systemInstruction = "";

    switch (intent) {
        case 'fix':
            systemInstruction = `
            ${BASE_ROLE}
            Your goal is to FIX bugs, resolve errors, or handle crashes.

            INSTRUCTIONS:
            1. Analyze the provided error logs and source code.
            2. Identify the root cause.
            3. Provide a COMPLETE fix for all affected files.
            4. Start your response with a concise summary of the bug (1-2 sentences).

            ${CODE_FORMAT_INSTRUCTION}
            `;
            break;

        case 'optimize':
            systemInstruction = `
            ${BASE_ROLE}
            Your goal is to OPTIMIZE code for performance, readability, and best practices.

            INSTRUCTIONS:
            1. Improve Time or Space complexity where possible.
            2. Refactor for cleaner logic and better naming.
            3. Remove redundant code.
            4. DO NOT change the core functionality, only improve the implementation.
            5. MINIMIZE explanation. The user wants to see the code Diff immediately.

            ${CODE_FORMAT_INSTRUCTION}
            `;
            break;

        case 'explain':
            systemInstruction = `
            ${BASE_ROLE}
            Your goal is to EXPLAIN the provided code clearly and educationally.

            INSTRUCTIONS:
            1. Target your explanation to a professional developer.
            2. Break down complex logic.
            3. Explain *why* the code is written this way.
            4. Use Markdown formatting (Bold, Lists, Code Blocks) for readability.
            5. Do NOT use the special <<<<FILE>>>> format unless providing a specific refactoring example.
            `;
            break;
    }

    let responseText = "";
    try {
        if (config.provider === 'Google Gemini') {
            const genAI = new GoogleGenerativeAI(config.apiKey);
            const model = genAI.getGenerativeModel({ model: config.modelName, systemInstruction });
            const result = await model.generateContent(prompt);
            responseText = result.response.text();
        } else {
            const openai = new OpenAI({ apiKey: config.apiKey });
            const completion = await openai.chat.completions.create({
                messages: [
                    { role: "system", content: systemInstruction },
                    { role: "user", content: prompt }
                ],
                model: config.modelName,
            });
            responseText = completion.choices[0]?.message?.content || "";
        }
    } catch (e: any) {
        if (e.toString().includes('401') || e.toString().includes('invalid api key')) {
            GlobalState.context.globalState.update(config.provider === 'Google Gemini' ? 'gemini_key' : 'openai_key', undefined);
        }
        throw new Error(`${config.provider} API Failed: ${e.message}`);
    }

    return parseBlockResponse(responseText);
}

function parseBlockResponse(text: string): AIResponse {
    const fixes: FileChange[] = [];
    const explanationParts: string[] = [];

    const fileBlockRegex = /<<<<FILE:\s*([^\n>]+)>>>>([\s\S]*?)<<<<END>>>>/g;

    let lastIndex = 0;
    let match;

    while ((match = fileBlockRegex.exec(text)) !== null) {
        // Capture text occurring BEFORE this code block as part of the explanation
        if (match.index > lastIndex) {
            explanationParts.push(text.substring(lastIndex, match.index).trim());
        }

        const rawPath = match[1].trim();
        const content = match[2].trim();

        fixes.push({
            filePath: rawPath,
            newContent: content
        });

        lastIndex = match.index + match[0].length;
    }

    // Capture any remaining explanation text after the last code block
    if (lastIndex < text.length) {
        explanationParts.push(text.substring(lastIndex).trim());
    }

    // Legacy fallback for single-file responses (just in case)
    if (fixes.length === 0) {
        const legacyCode = text.split('<<<<CODE>>>>')[1];
        if (legacyCode) {
            fixes.push({
                filePath: "ActiveFile",
                newContent: legacyCode.split('<<<<')[0].trim()
            });
        }
    }

    return {
        explanation: explanationParts.join('\n\n') || text,
        fixes
    };
}