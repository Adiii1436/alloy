import * as vscode from 'vscode';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GlobalState } from '../globalState';
import { LLMConfig, AIProvider, AnalysisIntent, AIResponse, FileChange } from '../types';

const BASE_ROLE = "You are Alloy, an expert AI Coding Agent inside VS Code.";

const CODE_FORMAT_INSTRUCTION = `
CRITICAL INSTRUCTION:
You have access to the file system.
1. SEARCH: If you don't see the code you need, search for it using:
<<<<SEARCH: query>>>>

2. EDIT: To edit a file, provide the full new content in this block:
<<<<FILE: path/to/file.ext>>>>
[FULL SOURCE CODE HERE]
<<<<END>>>>

3. IMPORTANT: Do NOT wrap the '<<<<' blocks in markdown code fences (like \`\`\`). Output them raw.
`;

export async function getLLMConfig(): Promise<LLMConfig | null> {
    let provider = GlobalState.context.globalState.get<AIProvider>('selected_provider');
    if (!provider) {
        const choice = await vscode.window.showQuickPick(
            ['Google Gemini', 'OpenAI', 'Claude'],
            { placeHolder: 'Select your AI Provider' }
        );
        if (!choice) return null;
        provider = choice as AIProvider;
        await GlobalState.context.globalState.update('selected_provider', provider);
    }

    let modelStorageName = provider === 'Google Gemini' ? 'gemini_model' : provider === 'OpenAI' ? 'openai_model' : 'claude_model';
    let defaultModel = provider === 'Google Gemini' ? 'gemini-2.0-flash' : provider === 'OpenAI' ? 'gpt-4o' : 'claude-3-5-sonnet-20240620';
    let modelName = GlobalState.context.globalState.get<string>(modelStorageName);

    if (!modelName) {
        modelName = defaultModel;
        await GlobalState.context.globalState.update(modelStorageName, modelName);
    }

    let keyStorageName = '';
    if (provider === 'Google Gemini') keyStorageName = 'gemini_key';
    else if (provider === 'OpenAI') keyStorageName = 'openai_key';
    else keyStorageName = 'anthropic_key';

    let apiKey = GlobalState.context.globalState.get<string>(keyStorageName);
    if (!apiKey) {
        apiKey = await vscode.window.showInputBox({
            prompt: `Enter your ${provider} API Key`,
            password: true,
            placeHolder: 'sk-...'
        });
        if (!apiKey) return null;
        await GlobalState.context.globalState.update(keyStorageName, apiKey);
    }

    return { provider, apiKey, modelName };
}

export interface AgentResponse extends AIResponse {
    searchQuery?: string;
}

export async function callLlm(config: LLMConfig, prompt: string, intent: AnalysisIntent | 'agent'): Promise<AgentResponse> {
    let systemInstruction = "";
    switch (intent) {
        case 'agent':
            systemInstruction = `
            ${BASE_ROLE}
            You are an autonomous coding agent.
            RULES:
            1. BE CONCISE.
            2. To edit/fix, YOU MUST output a <<<<FILE>>>> block.
            3. Use <<<<SEARCH: ...>>>> if needed.
            ${CODE_FORMAT_INSTRUCTION}
            `;
            break;
        case 'fix':
            systemInstruction = `${BASE_ROLE}\nYour goal is to FIX bugs.\n${CODE_FORMAT_INSTRUCTION}`;
            break;
        case 'explain':
            systemInstruction = `${BASE_ROLE}\nExplain the provided code clearly to a developer.\nUse Markdown.`;
            break;
    }

    let responseText = "";
    try {
        if (config.provider === 'Google Gemini') {
            const genAI = new GoogleGenerativeAI(config.apiKey);
            const model = genAI.getGenerativeModel({ model: config.modelName, systemInstruction });
            const result = await model.generateContent(prompt);
            responseText = result.response.text();
        }
        else if (config.provider === 'OpenAI') {
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
        else if (config.provider === 'Claude') {
            const anthropic = new Anthropic({ apiKey: config.apiKey });
            const message = await anthropic.messages.create({
                model: config.modelName,
                max_tokens: 4096,
                system: systemInstruction,
                messages: [{ role: "user", content: prompt }]
            });
            if (message.content[0].type === 'text') {
                responseText = message.content[0].text;
            }
        }
    } catch (e: any) {
        throw new Error(`${config.provider} API Failed: ${e.message}`);
    }

    return parseBlockResponse(responseText);
}

function parseBlockResponse(text: string): AgentResponse {
    const cleanedText = text.replace(/```\w*\n?<<<<FILE:/g, '<<<<FILE:')
        .replace(/<<<<END>>>>\n?```/g, '<<<<END>>>>')
        .replace(/```\w*\n?<<<<SEARCH:/g, '<<<<SEARCH:')
        .replace(/>>>>\n?```/g, '>>>>');

    const fixes: FileChange[] = [];
    const explanationParts: string[] = [];
    let searchQuery: string | undefined;

    // 1. Parse Search Tool
    const searchMatch = /<<<<SEARCH:\s*(.+?)>>>>/.exec(cleanedText);
    if (searchMatch) {
        searchQuery = searchMatch[1].trim();
    }

    const fileBlockRegex = /<<<<FILE:\s*([^\n>]+)>>>>([\s\S]*?)<<<<END>>>>/g;
    let lastIndex = 0;
    let match;

    let processingText = cleanedText;
    if (searchQuery) {
        // Remove search tag for explanation display
        processingText = processingText.replace(searchMatch![0], '');
    }

    while ((match = fileBlockRegex.exec(processingText)) !== null) {
        // Text before the block is explanation
        if (match.index > lastIndex) {
            explanationParts.push(processingText.substring(lastIndex, match.index).trim());
        }
        fixes.push({
            filePath: match[1].trim(),
            newContent: match[2].trim()
        });
        lastIndex = match.index + match[0].length;
    }

    // Capture remaining text after last block
    if (lastIndex < processingText.length) {
        explanationParts.push(processingText.substring(lastIndex).trim());
    }

    return {
        explanation: explanationParts.join('\n\n').trim(),
        fixes,
        searchQuery
    };
}